#!/usr/bin/env node

/**
 * Check completed conversations to see why they weren't transferred
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

async function checkCompletedConversations() {
  console.log('\n🔍 Checking completed conversations for transfer eligibility...\n');
  
  try {
    // Get completed conversations
    const completed = await query(`
      SELECT 
        id, call_control_id, from_number, to_number, 
        start_time, end_time, duration, cost, status, 
        hangup_cause, created_at,
        messages, cost_breakdown
      FROM conversations 
      WHERE status = 'completed'
      ORDER BY start_time DESC
    `);
    
    console.log(`📊 Found ${completed.rows.length} completed conversations\n`);
    
    for (const conv of completed.rows) {
      const messages = conv.messages || [];
      
      console.log(`${'='.repeat(80)}`);
      console.log(`Call Control ID: ${conv.call_control_id}`);
      console.log(`From: ${conv.from_number} -> To: ${conv.to_number}`);
      console.log(`Duration: ${conv.duration}s`);
      console.log(`Hangup Cause: ${conv.hangup_cause || 'N/A'}`);
      console.log(`Total Messages: ${messages.length}\n`);
      
      // Check for qualification keywords
      const qualificationKeywords = {
        alzheimer: [],
        hospice: [],
        age: [],
        bank: [],
        verified: []
      };
      
      messages.forEach(m => {
        const text = (m.text || '').toLowerCase();
        if (text.includes('alzheimer') || text.includes('dementia')) {
          qualificationKeywords.alzheimer.push(m);
        }
        if (text.includes('hospice')) {
          qualificationKeywords.hospice.push(m);
        }
        if (text.includes('age') || text.includes('old') || text.includes('year')) {
          qualificationKeywords.age.push(m);
        }
        if (text.includes('bank') || text.includes('checking') || text.includes('savings') || text.includes('account')) {
          qualificationKeywords.bank.push(m);
        }
        if (text.includes('verify') || text.includes('confirm') || text.includes('name')) {
          qualificationKeywords.verified.push(m);
        }
      });
      
      console.log('Qualification Indicators:');
      console.log(`   Alzheimer/Dementia: ${qualificationKeywords.alzheimer.length > 0 ? '✅' : '❌'} (${qualificationKeywords.alzheimer.length} mentions)`);
      console.log(`   Hospice: ${qualificationKeywords.hospice.length > 0 ? '✅' : '❌'} (${qualificationKeywords.hospice.length} mentions)`);
      console.log(`   Age: ${qualificationKeywords.age.length > 0 ? '✅' : '❌'} (${qualificationKeywords.age.length} mentions)`);
      console.log(`   Bank Account: ${qualificationKeywords.bank.length > 0 ? '✅' : '❌'} (${qualificationKeywords.bank.length} mentions)`);
      console.log(`   Verified Info: ${qualificationKeywords.verified.length > 0 ? '✅' : '❌'} (${qualificationKeywords.verified.length} mentions)`);
      
      // Check for transfer-related messages
      const transferMessages = messages.filter(m => 
        m.text && (
          m.text.toLowerCase().includes('transfer') ||
          m.text.toLowerCase().includes('sound good') ||
          m.text.toLowerCase().includes('connect you') ||
          m.text.toLowerCase().includes('agent')
        )
      );
      
      if (transferMessages.length > 0) {
        console.log(`\n⚠️  Transfer-related messages found (${transferMessages.length}):`);
        transferMessages.forEach(m => {
          console.log(`   [${m.speaker}] ${m.text}`);
        });
      }
      
      // Check conversation stages
      const stages = messages.map(m => m.stage).filter(s => s);
      const uniqueStages = [...new Set(stages)];
      if (uniqueStages.length > 0) {
        console.log(`\nConversation Stages: ${uniqueStages.join(' -> ')}`);
      }
      
      // Show last few messages
      console.log(`\nLast 5 messages:`);
      messages.slice(-5).forEach((m, idx) => {
        console.log(`   ${idx + 1}. [${m.speaker}] ${m.text || '(no text)'}`);
      });
      
      console.log('');
    }
    
  } catch (error) {
    console.error('❌ Error checking conversations:', error);
    throw error;
  }
}

// Run the check
checkCompletedConversations()
  .then(() => {
    console.log('\n✅ Check complete\n');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Check failed:', error);
    process.exit(1);
  });


