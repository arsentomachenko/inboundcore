#!/usr/bin/env node

/**
 * Check conversation logs for a specific phone number
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

async function findConversations(phoneNumber) {
  const normalizedPhone = phoneNumber.replace(/[^0-9]/g, '');
  console.log(`\n🔍 Searching for phone: ${phoneNumber}`);
  console.log(`   Normalized: ${normalizedPhone}\n`);
  
  try {
    const result = await query(
      `SELECT 
        id, call_control_id, from_number, to_number, 
        start_time, end_time, duration, cost, status, 
        hangup_cause, created_at,
        messages, cost_breakdown
      FROM conversations 
      WHERE REGEXP_REPLACE(from_number, '[^0-9]', '', 'g') = $1
         OR REGEXP_REPLACE(to_number, '[^0-9]', '', 'g') = $1
      ORDER BY start_time DESC
      LIMIT 10`,
      [normalizedPhone]
    );
    
    console.log(`📞 Found ${result.rows.length} conversation(s)\n`);
    
    if (result.rows.length === 0) {
      console.log('   No conversations found for this phone number.');
      return;
    }
    
    result.rows.forEach((conv, idx) => {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`📋 Conversation ${idx + 1}`);
      console.log(`${'='.repeat(60)}`);
      console.log(`Call Control ID: ${conv.call_control_id}`);
      console.log(`From Number:     ${conv.from_number || 'N/A'}`);
      console.log(`To Number:       ${conv.to_number || 'N/A'}`);
      console.log(`Status:          ${conv.status || 'N/A'}`);
      console.log(`Duration:         ${conv.duration || 0}s`);
      console.log(`Cost:            $${parseFloat(conv.cost || 0).toFixed(4)}`);
      console.log(`Hangup Cause:    ${conv.hangup_cause || 'N/A'}`);
      console.log(`Created:         ${conv.created_at}`);
      
      if (conv.start_time) {
        const startDate = new Date(parseInt(conv.start_time));
        console.log(`Start Time:      ${startDate.toISOString()}`);
      }
      if (conv.end_time) {
        const endDate = new Date(parseInt(conv.end_time));
        console.log(`End Time:        ${endDate.toISOString()}`);
      }
      
      console.log(`\n💬 Messages (${conv.messages?.length || 0}):`);
      console.log(`${'-'.repeat(60)}`);
      
      if (conv.messages && conv.messages.length > 0) {
        conv.messages.forEach((msg, i) => {
          const speaker = msg.speaker || 'Unknown';
          const text = msg.text || '';
          const timestamp = msg.timestamp ? new Date(msg.timestamp).toISOString() : '';
          console.log(`\n[${i+1}] ${speaker}${timestamp ? ' (' + timestamp + ')' : ''}:`);
          console.log(`    ${text}`);
        });
      } else {
        console.log('   (No messages recorded)');
      }
      
      if (conv.cost_breakdown && Object.keys(conv.cost_breakdown).length > 0) {
        console.log(`\n💰 Cost Breakdown:`);
        console.log(JSON.stringify(conv.cost_breakdown, null, 2));
      }
    });
    
    console.log(`\n${'='.repeat(60)}\n`);
    
  } catch (error) {
    console.error('❌ Error querying database:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Get phone number from command line argument
const phoneNumber = process.argv[2];

if (!phoneNumber) {
  console.error('Usage: node checkConversation.js <phone_number>');
  console.error('Example: node checkConversation.js "+1 (317) 728-8336"');
  process.exit(1);
}

findConversations(phoneNumber)
  .then(() => process.exit(0))
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

