/**
 * Script to analyze calls in database and find issues with transfers
 * Specifically looking for calls over 1600 seconds without transfers
 */

// Load environment variables if .env exists
try {
  require('dotenv').config();
} catch (e) {
  // dotenv not available, environment variables should be set externally
}

const { query } = require('./backend/config/database');

async function analyzeCalls() {
  try {
    console.log('🔍 Analyzing calls in database...\n');

    // Find all calls over 1600 seconds
    console.log('📊 Finding calls with duration > 1600 seconds...');
    const longCalls = await query(`
      SELECT 
        c.call_control_id,
        c.from_number,
        c.to_number,
        c.start_time,
        c.end_time,
        c.duration,
        c.status,
        c.hangup_cause,
        c.messages,
        c.cost_breakdown,
        co.telnyx_transfer_cost,
        co.duration_seconds as cost_duration_seconds
      FROM conversations c
      LEFT JOIN costs co ON c.call_control_id = co.call_control_id
      WHERE c.duration > 1600
      ORDER BY c.duration DESC
    `);

    console.log(`\n✅ Found ${longCalls.rows.length} calls over 1600 seconds\n`);

    if (longCalls.rows.length === 0) {
      console.log('No calls found over 1600 seconds.');
      return;
    }

    // Analyze each call
    for (const call of longCalls.rows) {
      console.log('='.repeat(80));
      console.log(`📞 Call Control ID: ${call.call_control_id}`);
      console.log(`   From: ${call.from_number} -> To: ${call.to_number}`);
      console.log(`   Duration: ${call.duration} seconds (${(call.duration / 60).toFixed(2)} minutes)`);
      console.log(`   Status: ${call.status}`);
      console.log(`   Hangup Cause: ${call.hangup_cause || 'N/A'}`);
      
      // Check transfer status
      const hasTransferCost = call.telnyx_transfer_cost > 0;
      const isTransferredStatus = call.status === 'transferred';
      
      console.log(`\n   🔍 Transfer Analysis:`);
      console.log(`      - Status = 'transferred': ${isTransferredStatus}`);
      console.log(`      - Transfer Cost > 0: ${hasTransferCost} ($${call.telnyx_transfer_cost || 0})`);
      
      // Check messages for transfer indicators
      const messages = call.messages || [];
      const hasTransferMessage = messages.some(m => 
        m.text && (
          m.text.includes('transfer') || 
          m.text.includes('Transfer') ||
          m.text.includes('bridged') ||
          m.text.includes('Bridged')
        )
      );
      console.log(`      - Transfer message in conversation: ${hasTransferMessage}`);
      
      // Check cost breakdown
      const costBreakdown = call.cost_breakdown || {};
      const telnyxTransferCost = costBreakdown.details?.telnyx?.transferCost || 0;
      console.log(`      - Transfer cost in breakdown: $${telnyxTransferCost}`);
      
      // Check if call was bridged (look for call.bridged webhook)
      const bridgedCheck = await query(`
        SELECT COUNT(*) as count
        FROM transferred_calls
        WHERE call_control_id = $1
      `, [call.call_control_id]);
      
      const hasBridgedRecord = parseInt(bridgedCheck.rows[0].count) > 0;
      console.log(`      - Bridged record in transferred_calls: ${hasBridgedRecord}`);
      
      // Determine if transfer should have happened
      const shouldHaveTransferred = call.duration > 1600 && !isTransferredStatus && !hasTransferCost;
      
      if (shouldHaveTransferred) {
        console.log(`\n   ⚠️  ISSUE DETECTED: Call is over 1600 seconds but NO TRANSFER detected!`);
        console.log(`      - Duration: ${call.duration}s`);
        console.log(`      - Status: ${call.status} (should be 'transferred')`);
        console.log(`      - Transfer Cost: $${call.telnyx_transfer_cost || 0} (should be > 0)`);
      }
      
      // Show message count
      console.log(`\n   💬 Conversation:`);
      console.log(`      - Total messages: ${messages.length}`);
      const aiMessages = messages.filter(m => m.speaker === 'AI' || m.speaker === 'System').length;
      const leadMessages = messages.filter(m => m.speaker === 'Lead').length;
      console.log(`      - AI/System messages: ${aiMessages}`);
      console.log(`      - Lead messages: ${leadMessages}`);
      
      // Show last few messages
      if (messages.length > 0) {
        console.log(`\n   📝 Last 5 messages:`);
        const lastMessages = messages.slice(-5);
        lastMessages.forEach((msg, idx) => {
          const preview = msg.text.length > 100 ? msg.text.substring(0, 100) + '...' : msg.text;
          console.log(`      ${idx + 1}. [${msg.speaker}] ${preview}`);
        });
      }
      
      console.log('');
    }

    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('📊 SUMMARY');
    console.log('='.repeat(80));
    
    const transferredCount = longCalls.rows.filter(c => c.status === 'transferred').length;
    const withTransferCost = longCalls.rows.filter(c => c.telnyx_transfer_cost > 0).length;
    const missingTransfer = longCalls.rows.filter(c => 
      c.duration > 1600 && c.status !== 'transferred' && (c.telnyx_transfer_cost || 0) === 0
    ).length;
    
    console.log(`Total calls > 1600s: ${longCalls.rows.length}`);
    console.log(`Calls with status='transferred': ${transferredCount}`);
    console.log(`Calls with transfer_cost > 0: ${withTransferCost}`);
    console.log(`⚠️  Calls missing transfer (issue): ${missingTransfer}`);
    
    if (missingTransfer > 0) {
      console.log(`\n❌ ISSUE FOUND: ${missingTransfer} call(s) over 1600 seconds without transfer!`);
      console.log(`   These calls should have been transferred but weren't.`);
    }

  } catch (error) {
    console.error('❌ Error analyzing calls:', error);
    throw error;
  }
}

// Run analysis
analyzeCalls()
  .then(() => {
    console.log('\n✅ Analysis complete');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Analysis failed:', error);
    process.exit(1);
  });

