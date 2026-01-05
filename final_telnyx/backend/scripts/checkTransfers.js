#!/usr/bin/env node

/**
 * Check conversation history from database and analyze why transfers aren't happening
 */

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

async function analyzeTransfers() {
  console.log('\n🔍 Analyzing conversation history for transfer issues...\n');
  
  try {
    // Get all conversations
    const allConversations = await query(`
      SELECT 
        id, call_control_id, from_number, to_number, 
        start_time, end_time, duration, cost, status, 
        hangup_cause, created_at,
        messages, cost_breakdown
      FROM conversations 
      ORDER BY start_time DESC
      LIMIT 100
    `);
    
    console.log(`📊 Total conversations found: ${allConversations.rows.length}\n`);
    
    // Analyze conversations
    let transferredCount = 0;
    let transferConfirmationCount = 0;
    let completedCount = 0;
    let noResponseCount = 0;
    let voicemailCount = 0;
    let otherCount = 0;
    
    const transferIssues = [];
    
    for (const conv of allConversations.rows) {
      const messages = conv.messages || [];
      const status = conv.status || 'unknown';
      
      // Count by status
      if (status === 'transferred') {
        transferredCount++;
      } else if (status === 'completed') {
        completedCount++;
      } else if (status === 'no_response') {
        noResponseCount++;
      } else if (status === 'voicemail') {
        voicemailCount++;
      } else {
        otherCount++;
      }
      
      // Check for transfer-related messages
      const hasTransferConfirmation = messages.some(m => 
        m.text && (
          m.text.toLowerCase().includes('transfer') ||
          m.text.toLowerCase().includes('sound good') ||
          m.text.toLowerCase().includes('connect you')
        )
      );
      
      // Check for transfer_confirmation stage in messages
      const hasTransferStage = messages.some(m => 
        m.stage && m.stage.includes('transfer_confirmation')
      );
      
      if (hasTransferConfirmation || hasTransferStage) {
        transferConfirmationCount++;
        
        // If it has transfer confirmation but wasn't transferred, it's an issue
        if (status !== 'transferred') {
          transferIssues.push({
            callControlId: conv.call_control_id,
            status: status,
            fromNumber: conv.from_number,
            toNumber: conv.to_number,
            duration: conv.duration,
            hangupCause: conv.hangup_cause,
            messages: messages.filter(m => 
              m.text && (
                m.text.toLowerCase().includes('transfer') ||
                m.text.toLowerCase().includes('sound good') ||
                m.text.toLowerCase().includes('connect you')
              )
            ),
            allMessages: messages.length
          });
        }
      }
    }
    
    console.log('📈 Status Breakdown:');
    console.log(`   ✅ Transferred: ${transferredCount}`);
    console.log(`   ✅ Completed: ${completedCount}`);
    console.log(`   ❌ No Response: ${noResponseCount}`);
    console.log(`   📞 Voicemail: ${voicemailCount}`);
    console.log(`   ❓ Other: ${otherCount}`);
    console.log(`\n🔗 Transfer Confirmations Found: ${transferConfirmationCount}`);
    console.log(`   ⚠️  Failed Transfers (confirmed but not transferred): ${transferIssues.length}\n`);
    
    if (transferIssues.length > 0) {
      console.log('🚨 TRANSFER ISSUES DETECTED:\n');
      transferIssues.forEach((issue, idx) => {
        console.log(`${'='.repeat(80)}`);
        console.log(`Issue #${idx + 1}:`);
        console.log(`   Call Control ID: ${issue.callControlId}`);
        console.log(`   Status: ${issue.status}`);
        console.log(`   From: ${issue.fromNumber} -> To: ${issue.toNumber}`);
        console.log(`   Duration: ${issue.duration}s`);
        console.log(`   Hangup Cause: ${issue.hangupCause || 'N/A'}`);
        console.log(`   Total Messages: ${issue.allMessages}`);
        console.log(`   Transfer-related messages:`);
        issue.messages.forEach(m => {
          console.log(`      [${m.speaker}] ${m.text}`);
        });
        console.log('');
      });
    }
    
    // Check transferred_calls table
    const transferredCalls = await query(`
      SELECT 
        call_control_id, user_id, phone, name, address, 
        from_number, to_number, transferred_at
      FROM transferred_calls 
      ORDER BY transferred_at DESC
      LIMIT 50
    `);
    
    console.log(`\n📋 Transferred Calls Table: ${transferredCalls.rows.length} records\n`);
    
    if (transferredCalls.rows.length > 0) {
      console.log('Recent transfers:');
      transferredCalls.rows.slice(0, 10).forEach((transfer, idx) => {
        console.log(`   ${idx + 1}. ${transfer.name} (${transfer.phone}) - ${new Date(transfer.transferred_at).toLocaleString()}`);
      });
    }
    
    // Check for conversations that should have been transferred
    console.log('\n🔍 Checking conversations with "completed" status that might need transfer...\n');
    const completedConversations = allConversations.rows.filter(c => c.status === 'completed');
    
    let qualifiedButNotTransferred = 0;
    for (const conv of completedConversations) {
      const messages = conv.messages || [];
      // Look for qualification indicators
      const hasQualification = messages.some(m => 
        m.text && (
          m.text.toLowerCase().includes('alzheimer') ||
          m.text.toLowerCase().includes('hospice') ||
          m.text.toLowerCase().includes('bank account') ||
          m.text.toLowerCase().includes('age')
        )
      );
      
      if (hasQualification && messages.length > 5) {
        qualifiedButNotTransferred++;
      }
    }
    
    console.log(`   Conversations that appear qualified but weren't transferred: ${qualifiedButNotTransferred}`);
    
  } catch (error) {
    console.error('❌ Error analyzing transfers:', error);
    throw error;
  }
}

// Run the analysis
analyzeTransfers()
  .then(() => {
    console.log('\n✅ Analysis complete\n');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Analysis failed:', error);
    process.exit(1);
  });


