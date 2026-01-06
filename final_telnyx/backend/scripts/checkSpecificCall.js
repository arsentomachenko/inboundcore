/**
 * Script to check a specific call conversation history from database
 * Usage: node backend/scripts/checkSpecificCall.js
 */

// Try loading .env from multiple locations
const path = require('path');
const envPaths = [
  path.join(__dirname, '../../.env'),
  path.join(__dirname, '../.env'),
  path.join(__dirname, '../../backend/.env')
];

for (const envPath of envPaths) {
  try {
    require('dotenv').config({ path: envPath });
    if (process.env.DB_HOST) break;
  } catch (e) {
    // Continue to next path
  }
}

const { query } = require('../config/database');

async function checkSpecificCall() {
  try {
    const fromNumber = '(423) 818-8668';
    const toNumber = '(785) 643-6358';
    
    // Normalize phone numbers for search (remove formatting)
    const normalizePhone = (phone) => {
      return phone.replace(/\D/g, ''); // Remove all non-digits
    };
    
    const normalizedFrom = normalizePhone(fromNumber);
    const normalizedTo = normalizePhone(toNumber);
    
    console.log(`\n🔍 Searching for call:`);
    console.log(`   From: ${fromNumber} (normalized: ${normalizedFrom})`);
    console.log(`   To: ${toNumber} (normalized: ${normalizedTo})`);
    console.log(`\n`);
    
    // Search for the call - try multiple formats
    const searchQueries = [
      // Exact match with formatting
      `SELECT * FROM conversations 
       WHERE (from_number = $1 OR from_number = $2 OR from_number = $3)
       AND (to_number = $4 OR to_number = $5 OR to_number = $6)
       ORDER BY start_time DESC LIMIT 10`,
      // Normalized match
      `SELECT * FROM conversations 
       WHERE REPLACE(REPLACE(REPLACE(REPLACE(from_number, '(', ''), ')', ''), ' ', ''), '-', '') LIKE $1
       AND REPLACE(REPLACE(REPLACE(REPLACE(to_number, '(', ''), ')', ''), ' ', ''), '-', '') LIKE $2
       ORDER BY start_time DESC LIMIT 10`
    ];
    
    // Try query with normalized phone numbers (using REGEXP_REPLACE like checkConversation.js)
    let result = null;
    
    try {
      const queryResult = await query(
        `SELECT * FROM conversations 
         WHERE REGEXP_REPLACE(from_number, '[^0-9]', '', 'g') = $1
         AND REGEXP_REPLACE(to_number, '[^0-9]', '', 'g') = $2
         ORDER BY start_time DESC LIMIT 10`,
        [normalizedFrom, normalizedTo]
      );
      
      if (queryResult.rows.length > 0) {
        result = queryResult;
        console.log(`✅ Found ${queryResult.rows.length} matching call(s)`);
      }
    } catch (error) {
      console.log(`   Query failed: ${error.message}`);
    }
    
    // If still no results, try a broader search
    if (!result || result.rows.length === 0) {
      console.log(`\n⚠️  No exact match found. Trying broader search...`);
      const broaderResult = await query(
        `SELECT * FROM conversations 
         WHERE (REGEXP_REPLACE(from_number, '[^0-9]', '', 'g') LIKE $1 OR REGEXP_REPLACE(to_number, '[^0-9]', '', 'g') LIKE $1)
         ORDER BY start_time DESC LIMIT 20`,
        [`%${normalizedFrom.slice(-4)}%`] // Last 4 digits
      );
      
      if (broaderResult.rows.length > 0) {
        console.log(`   Found ${broaderResult.rows.length} calls with similar numbers. Showing all:`);
        broaderResult.rows.forEach((row, idx) => {
          console.log(`\n   Call ${idx + 1}:`);
          console.log(`      From: ${row.from_number}`);
          console.log(`      To: ${row.to_number}`);
          console.log(`      Call Control ID: ${row.call_control_id}`);
          console.log(`      Start Time: ${new Date(parseInt(row.start_time)).toISOString()}`);
        });
        
        // Check if any of these match our target
        const matchingCall = broaderResult.rows.find(row => {
          const rowFrom = row.from_number.replace(/\D/g, '');
          const rowTo = row.to_number.replace(/\D/g, '');
          // Handle +1 prefix - remove leading 1 if present
          const normalizedFromClean = normalizedFrom.replace(/^1/, '');
          const normalizedToClean = normalizedTo.replace(/^1/, '');
          const rowFromClean = rowFrom.replace(/^1/, '');
          const rowToClean = rowTo.replace(/^1/, '');
          
          return (rowFromClean === normalizedFromClean && rowToClean === normalizedToClean) ||
                 (rowFromClean === normalizedToClean && rowToClean === normalizedFromClean) ||
                 (rowFrom === normalizedFrom && rowTo === normalizedTo) ||
                 (rowFrom === normalizedTo && rowTo === normalizedFrom);
        });
        
        if (matchingCall) {
          console.log(`\n✅ Found matching call in broader search!`);
          result = { rows: [matchingCall] };
        }
      }
    }
    
    if (!result || result.rows.length === 0) {
      console.log(`\n❌ No call found matching those numbers.`);
      console.log(`\n   Trying to list recent calls to help identify the correct format...`);
      const recentCalls = await query(
        `SELECT call_control_id, from_number, to_number, start_time, status
         FROM conversations 
         ORDER BY start_time DESC LIMIT 10`
      );
      
      if (recentCalls.rows.length > 0) {
        console.log(`\n   Recent calls in database:`);
        recentCalls.rows.forEach((row, idx) => {
          console.log(`   ${idx + 1}. From: ${row.from_number} -> To: ${row.to_number} (${row.status})`);
        });
      }
      return;
    }
    
    // Display the call(s) found
    const call = result.rows[0]; // Get the most recent one
    console.log(`\n📞 Call Details:`);
    console.log(`   Call Control ID: ${call.call_control_id}`);
    console.log(`   From: ${call.from_number}`);
    console.log(`   To: ${call.to_number}`);
    console.log(`   Status: ${call.status}`);
    console.log(`   Start Time: ${new Date(parseInt(call.start_time)).toISOString()}`);
    console.log(`   End Time: ${call.end_time ? new Date(parseInt(call.end_time)).toISOString() : 'N/A'}`);
    console.log(`   Duration: ${call.duration}s`);
    console.log(`   Hangup Cause: ${call.hangup_cause || 'N/A'}`);
    console.log(`   Cost: $${parseFloat(call.cost || 0).toFixed(4)}`);
    
    // Parse and display messages
    let messages = [];
    try {
      messages = typeof call.messages === 'string' ? JSON.parse(call.messages) : call.messages;
    } catch (e) {
      console.log(`   ⚠️  Error parsing messages: ${e.message}`);
    }
    
    console.log(`\n💬 Conversation History (${messages.length} messages):`);
    console.log(`   ${'='.repeat(80)}`);
    
    if (messages.length === 0) {
      console.log(`   ⚠️  No messages found in conversation history`);
    } else {
      messages.forEach((msg, idx) => {
        const timestamp = msg.timestamp ? new Date(msg.timestamp).toISOString() : 'N/A';
        const speaker = msg.speaker || 'Unknown';
        const text = msg.text || '';
        const preview = text.length > 60 ? text.substring(0, 60) + '...' : text;
        console.log(`\n   ${idx + 1}. [${speaker}] ${timestamp}`);
        console.log(`      "${text}"`);
      });
    }
    
    // Analyze workflow compliance
    console.log(`\n\n🔍 Workflow Analysis:`);
    console.log(`   ${'='.repeat(80)}`);
    
    const aiMessages = messages.filter(m => m.speaker === 'AI');
    const leadMessages = messages.filter(m => m.speaker === 'Lead');
    const systemMessages = messages.filter(m => m.speaker === 'System');
    
    console.log(`\n   Message Counts:`);
    console.log(`      AI Messages: ${aiMessages.length}`);
    console.log(`      Lead Messages: ${leadMessages.length}`);
    console.log(`      System Messages: ${systemMessages.length}`);
    
    // Check for issues
    console.log(`\n   Issues Detected:`);
    let issuesFound = false;
    
    // Check for repeated "Got it, thanks!" messages
    const gotItThanksCount = aiMessages.filter(m => 
      m.text && m.text.toLowerCase().includes('got it, thanks')
    ).length;
    
    if (gotItThanksCount > 1) {
      console.log(`      ⚠️  ISSUE: AI repeated "Got it, thanks!" ${gotItThanksCount} times`);
      console.log(`         This suggests the AI is not properly processing user responses`);
      issuesFound = true;
    }
    
    // Check if user hung up during conversation
    if (systemMessages.some(m => m.text && m.text.includes('[User hung up'))) {
      console.log(`      ⚠️  User hung up during conversation`);
      issuesFound = true;
    }
    
    // Check for overlapping speech
    if (messages.some(m => m.text && m.text.includes('[Overlapping speech'))) {
      console.log(`      ⚠️  Overlapping speech detected - may indicate timing issues`);
      issuesFound = true;
    }
    
    // Check workflow steps
    console.log(`\n   Workflow Steps Check:`);
    
    // Step 1: Verification
    const hasVerification = aiMessages.some(m => 
      m.text && (m.text.includes('last name') || m.text.includes('address'))
    );
    console.log(`      ${hasVerification ? '✅' : '❌'} Step 1 - Verification: ${hasVerification ? 'Found' : 'Missing'}`);
    
    // Step 2: Health issue discovery
    const hasHealthIssueQuestion = aiMessages.some(m => 
      m.text && (m.text.includes('health issue') || m.text.includes('didn\'t move forward'))
    );
    console.log(`      ${hasHealthIssueQuestion ? '✅' : '❌'} Step 2 - Health Issue Discovery: ${hasHealthIssueQuestion ? 'Found' : 'Missing'}`);
    
    // Step 3: Qualification questions
    const hasAlzheimersQuestion = aiMessages.some(m => 
      m.text && m.text.includes('Alzheimer')
    );
    const hasHospiceQuestion = aiMessages.some(m => 
      m.text && (m.text.includes('hospice') || m.text.includes('nursing home'))
    );
    const hasAgeQuestion = aiMessages.some(m => 
      m.text && (m.text.includes('between 50 and 78') || m.text.includes('50 and 78'))
    );
    const hasBankQuestion = aiMessages.some(m => 
      m.text && (m.text.includes('checking or savings') || m.text.includes('bank account'))
    );
    
    console.log(`      ${hasAlzheimersQuestion ? '✅' : '❌'} Step 3a - Alzheimer's Question: ${hasAlzheimersQuestion ? 'Found' : 'Missing'}`);
    console.log(`      ${hasHospiceQuestion ? '✅' : '❌'} Step 3b - Hospice Question: ${hasHospiceQuestion ? 'Found' : 'Missing'}`);
    console.log(`      ${hasAgeQuestion ? '✅' : '❌'} Step 3c - Age Question: ${hasAgeQuestion ? 'Found' : 'Missing'}`);
    console.log(`      ${hasBankQuestion ? '✅' : '❌'} Step 3d - Bank Account Question: ${hasBankQuestion ? 'Found' : 'Missing'}`);
    
    if (!issuesFound) {
      console.log(`\n   ✅ No major issues detected`);
    }
    
    // Check message flow
    console.log(`\n   Message Flow Analysis:`);
    let consecutiveAIMessages = 0;
    let maxConsecutiveAI = 0;
    
    messages.forEach((msg, idx) => {
      if (msg.speaker === 'AI') {
        consecutiveAIMessages++;
        maxConsecutiveAI = Math.max(maxConsecutiveAI, consecutiveAIMessages);
      } else {
        consecutiveAIMessages = 0;
      }
    });
    
    if (maxConsecutiveAI > 2) {
      console.log(`      ⚠️  ISSUE: ${maxConsecutiveAI} consecutive AI messages detected`);
      console.log(`         This suggests the AI is responding without waiting for user input`);
      issuesFound = true;
    } else {
      console.log(`      ✅ Message flow appears normal (max consecutive AI: ${maxConsecutiveAI})`);
    }
    
    console.log(`\n${'='.repeat(80)}\n`);
    
  } catch (error) {
    console.error('❌ Error checking call:', error);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

// Run the script
checkSpecificCall();

