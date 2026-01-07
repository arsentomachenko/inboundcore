/**
 * Check a specific no_response call to see what messages it has
 */

const path = require('path');
const fs = require('fs');

// Try loading .env from multiple locations
const envPaths = [
  path.join(__dirname, '../../.env'),
  path.join(__dirname, '../.env'),
  path.join(__dirname, '../../backend/.env')
];

for (const envPath of envPaths) {
  try {
    if (fs.existsSync(envPath)) {
      require('dotenv').config({ path: envPath });
      if (process.env.DB_HOST) break;
    }
  } catch (e) {
    // Continue to next path
  }
}

const { query } = require('../config/database');

async function checkCall(callControlId) {
  try {
    const result = await query(`
      SELECT 
        call_control_id,
        from_number,
        to_number,
        start_time,
        end_time,
        duration,
        messages,
        cost_breakdown,
        hangup_cause,
        status
      FROM conversations
      WHERE call_control_id = $1
    `, [callControlId]);

    if (result.rows.length === 0) {
      console.log(`❌ Call not found: ${callControlId}`);
      return;
    }

    const call = result.rows[0];
    const messages = call.messages || [];
    const costBreakdown = call.cost_breakdown || {};

    console.log(`\n📞 Call: ${call.call_control_id}`);
    console.log(`   Status: ${call.status}`);
    console.log(`   Duration: ${call.duration}s`);
    console.log(`   Hangup cause: ${call.hangup_cause || 'N/A'}`);
    console.log(`   From: ${call.from_number}`);
    console.log(`   To: ${call.to_number}`);
    console.log(`\n💰 Cost Breakdown:`);
    console.log(`   OpenAI API calls: ${costBreakdown?.openai?.apiCalls || 0}`);
    console.log(`   OpenAI cost: $${(costBreakdown?.openai?.cost || 0).toFixed(4)}`);
    console.log(`   Telnyx TTS cost: $${(costBreakdown?.telnyx?.ttsCost || 0).toFixed(4)}`);
    console.log(`   ElevenLabs TTS cost: $${(costBreakdown?.elevenlabs?.ttsCost || 0).toFixed(4)}`);
    console.log(`   ElevenLabs STT cost: $${(costBreakdown?.elevenlabs?.sttCost || 0).toFixed(4)}`);
    console.log(`\n💬 Messages (${messages.length} total):\n`);

    messages.forEach((msg, index) => {
      console.log(`${index + 1}. [${msg.speaker}] ${msg.text}`);
      if (msg.timestamp) {
        const time = new Date(msg.timestamp);
        console.log(`   Time: ${time.toISOString()}`);
      }
      console.log('');
    });

    // Analyze messages
    const aiMessages = messages.filter(m => m.speaker === 'AI');
    const leadMessages = messages.filter(m => m.speaker === 'Lead');
    const systemMessages = messages.filter(m => m.speaker === 'System');

    console.log(`\n📊 Analysis:`);
    console.log(`   AI messages: ${aiMessages.length}`);
    console.log(`   Lead messages: ${leadMessages.length}`);
    console.log(`   System messages: ${systemMessages.length}`);

    if (leadMessages.length > 0) {
      console.log(`\n⚠️  Found ${leadMessages.length} Lead message(s) but call is marked as "no_response"!`);
      leadMessages.forEach((msg, index) => {
        console.log(`   ${index + 1}. "${msg.text.substring(0, 100)}"`);
      });
    }

    // Check for filtered messages
    const filteredMessages = messages.filter(m => 
      m.text && (
        m.text.includes('[Filtered:') ||
        m.text.includes('[Background noise]') ||
        m.text.includes('[Duplicate]') ||
        m.text.includes('[After call end]')
      )
    );

    if (filteredMessages.length > 0) {
      console.log(`\n⚠️  Found ${filteredMessages.length} filtered message(s):`);
      filteredMessages.forEach((msg, index) => {
        console.log(`   ${index + 1}. [${msg.speaker}] "${msg.text.substring(0, 150)}"`);
      });
    }

  } catch (error) {
    console.error('❌ Error:', error);
  }
}

// Get call ID from command line
const callControlId = process.argv[2];

if (!callControlId) {
  console.log('Usage: node checkSpecificNoResponseCall.js <call_control_id>');
  console.log('\nExample:');
  console.log('  node checkSpecificNoResponseCall.js v3:9BMRX1AU5yvkZlUs6Db2o9iVE3eR0R1GXJGijIbiaojqy8PhTBUSog');
  process.exit(1);
}

checkCall(callControlId)
  .then(() => {
    console.log('\n✅ Done');
    process.exit(0);
  })
  .catch(error => {
    console.error('❌ Failed:', error);
    process.exit(1);
  });

