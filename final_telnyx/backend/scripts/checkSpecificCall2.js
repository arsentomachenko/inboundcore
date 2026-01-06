/**
 * Script to check a specific call conversation history from database
 * Usage: node backend/scripts/checkSpecificCall2.js
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
    const fromNumber = '(659) 238-9182';
    const toNumber = '(530) 774-8286';
    
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
    
    // Search for the call
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
    
    // Check for overlapping speech
    const overlappingSpeechCount = messages.filter(m => 
      m.text && m.text.includes('[Overlapping speech')
    ).length;
    
    if (overlappingSpeechCount > 0) {
      console.log(`      ⚠️  ISSUE: ${overlappingSpeechCount} overlapping speech detection(s)`);
      console.log(`         This suggests the AI is speaking while the user is trying to respond`);
      issuesFound = true;
    }
    
    // Check if user hung up quickly
    if (call.duration && call.duration < 30) {
      console.log(`      ⚠️  Call duration is very short (${call.duration}s)`);
      console.log(`         User hung up quickly, possibly due to timing issues`);
      issuesFound = true;
    }
    
    // Check if user hung up without responding
    if (systemMessages.some(m => m.text && m.text.includes('[User hung up'))) {
      console.log(`      ⚠️  User hung up during conversation`);
      const hasUserResponse = leadMessages.some(m => 
        m.text && !m.text.includes('[Overlapping speech') && !m.text.includes('[Background noise]')
      );
      if (!hasUserResponse) {
        console.log(`      ⚠️  ISSUE: User hung up without providing a valid response`);
        console.log(`         This suggests the AI may have started speaking too quickly or user was confused`);
        issuesFound = true;
      }
    }
    
    // Check timing between messages
    console.log(`\n   Timing Analysis:`);
    if (messages.length >= 2) {
      const firstMessage = messages[0];
      const secondMessage = messages[1];
      if (firstMessage.timestamp && secondMessage.timestamp) {
        const timeBetween = secondMessage.timestamp - firstMessage.timestamp;
        console.log(`      Time between first two messages: ${timeBetween}ms (${(timeBetween/1000).toFixed(2)}s)`);
        
        if (timeBetween < 2000 && firstMessage.speaker === 'AI' && secondMessage.speaker === 'AI') {
          console.log(`      ⚠️  ISSUE: AI sent two messages very quickly (< 2s apart)`);
          console.log(`         This may cause the user to feel rushed or confused`);
          issuesFound = true;
        }
      }
      
      // Check time between AI greeting and user response
      const greetingMessage = aiMessages.find(m => m.text && m.text.includes('Nice to meet you'));
      const firstUserMessage = leadMessages[0];
      if (greetingMessage && firstUserMessage && greetingMessage.timestamp && firstUserMessage.timestamp) {
        const timeToFirstResponse = firstUserMessage.timestamp - greetingMessage.timestamp;
        console.log(`      Time from greeting to first user response: ${timeToFirstResponse}ms (${(timeToFirstResponse/1000).toFixed(2)}s)`);
        
        if (timeToFirstResponse < 1000) {
          console.log(`      ⚠️  ISSUE: User responded very quickly (< 1s) after greeting`);
          console.log(`         This may indicate overlapping speech or user trying to interrupt`);
          issuesFound = true;
        }
      }
    }
    
    // Check workflow steps
    console.log(`\n   Workflow Steps Check:`);
    
    // Step 1: Verification
    const hasVerification = aiMessages.some(m => 
      m.text && (m.text.includes('last name') || m.text.includes('address'))
    );
    console.log(`      ${hasVerification ? '✅' : '❌'} Step 1 - Verification: ${hasVerification ? 'Found' : 'Missing'}`);
    
    // Check if verification question was asked
    if (hasVerification) {
      const verificationQuestion = aiMessages.find(m => 
        m.text && (m.text.includes('last name') || m.text.includes('address'))
      );
      const userResponse = leadMessages.find(m => 
        m.timestamp && verificationQuestion && m.timestamp > verificationQuestion.timestamp
      );
      
      if (!userResponse || userResponse.text.includes('[Overlapping speech')) {
        console.log(`      ⚠️  User did not provide a valid response to verification question`);
        console.log(`         Response was: ${userResponse ? userResponse.text : 'None'}`);
        issuesFound = true;
      }
    }
    
    if (!issuesFound) {
      console.log(`\n   ✅ No major issues detected`);
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

