/**
 * Script to analyze "no_response" calls in the database
 * Checks for potential misclassifications where calls might actually have had user responses
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

async function analyzeNoResponseCalls() {
  try {
    console.log('🔍 Analyzing "no_response" calls in database...\n');

    // Get all no_response calls
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
      WHERE status = 'no_response'
      ORDER BY start_time DESC
      LIMIT 1000
    `);

    const calls = result.rows;
    console.log(`📊 Found ${calls.length} "no_response" calls to analyze\n`);

    let suspiciousCalls = [];
    let callsWithFilteredMessages = [];
    let callsWithOpenAICalls = [];
    let callsWithLongDuration = [];
    let callsWithBackgroundNoise = [];
    let callsWithDuplicateMessages = [];

    for (const call of calls) {
      const messages = call.messages || [];
      const costBreakdown = call.cost_breakdown || {};
      const openaiCalls = costBreakdown?.openai?.apiCalls || 0;
      const duration = call.duration || 0;

      // Check for suspicious patterns
      const issues = [];

      // 1. Check if there are OpenAI API calls (indicates user might have responded)
      if (openaiCalls > 0) {
        issues.push(`Has ${openaiCalls} OpenAI API call(s) - suggests user may have responded`);
        callsWithOpenAICalls.push({
          callControlId: call.call_control_id,
          openaiCalls,
          duration,
          messageCount: messages.length
        });
      }

      // 2. Check for filtered messages (user might have responded but was filtered)
      const filteredMessages = messages.filter(m => 
        m.text && (
          m.text.includes('[Filtered:') ||
          m.text.includes('[Background noise]') ||
          m.text.includes('[Duplicate]') ||
          m.text.includes('[After call end]')
        )
      );
      
      if (filteredMessages.length > 0) {
        issues.push(`Has ${filteredMessages.length} filtered message(s) - user may have responded`);
        callsWithFilteredMessages.push({
          callControlId: call.call_control_id,
          filteredCount: filteredMessages.length,
          totalMessages: messages.length,
          filteredMessages: filteredMessages.map(m => m.text.substring(0, 100))
        });
      }

      // 3. Check for background noise messages (might be actual user responses)
      const backgroundNoiseMessages = messages.filter(m => 
        m.text && m.text.includes('[Background noise]')
      );
      
      if (backgroundNoiseMessages.length > 0) {
        callsWithBackgroundNoise.push({
          callControlId: call.call_control_id,
          count: backgroundNoiseMessages.length,
          messages: backgroundNoiseMessages.map(m => m.text.substring(0, 150))
        });
      }

      // 4. Check for duplicate messages (user might have responded multiple times)
      const duplicateMessages = messages.filter(m => 
        m.text && m.text.includes('[Duplicate]')
      );
      
      if (duplicateMessages.length > 0) {
        callsWithDuplicateMessages.push({
          callControlId: call.call_control_id,
          count: duplicateMessages.length
        });
      }

      // 5. Check for long duration calls (unlikely to be true no_response)
      if (duration > 30) {
        issues.push(`Long duration (${duration}s) - unlikely to be true no_response`);
        callsWithLongDuration.push({
          callControlId: call.call_control_id,
          duration,
          messageCount: messages.length,
          openaiCalls
        });
      }

      // 6. Check if there are any Lead messages at all (even if filtered)
      const leadMessages = messages.filter(m => m.speaker === 'Lead');
      if (leadMessages.length > 0 && openaiCalls === 0) {
        issues.push(`Has ${leadMessages.length} Lead message(s) but no OpenAI calls`);
      }

      if (issues.length > 0) {
        suspiciousCalls.push({
          callControlId: call.call_control_id,
          duration,
          messageCount: messages.length,
          openaiCalls,
          leadMessageCount: leadMessages.length,
          issues,
          hangupCause: call.hangup_cause
        });
      }
    }

    // Print summary
    console.log('📈 SUMMARY:\n');
    console.log(`   Total no_response calls analyzed: ${calls.length}`);
    console.log(`   Suspicious calls (potential misclassifications): ${suspiciousCalls.length}`);
    console.log(`   Calls with OpenAI API calls: ${callsWithOpenAICalls.length}`);
    console.log(`   Calls with filtered messages: ${callsWithFilteredMessages.length}`);
    console.log(`   Calls with background noise messages: ${callsWithBackgroundNoise.length}`);
    console.log(`   Calls with duplicate messages: ${callsWithDuplicateMessages.length}`);
    console.log(`   Calls with long duration (>30s): ${callsWithLongDuration.length}\n`);

    // Print detailed findings
    if (callsWithOpenAICalls.length > 0) {
      console.log('⚠️  CALLS WITH OPENAI API CALLS (likely had user responses):');
      console.log('   These calls have OpenAI API calls, suggesting the user DID respond\n');
      callsWithOpenAICalls.slice(0, 10).forEach(call => {
        console.log(`   - ${call.callControlId}: ${call.openaiCalls} API call(s), ${call.duration}s duration, ${call.messageCount} messages`);
      });
      if (callsWithOpenAICalls.length > 10) {
        console.log(`   ... and ${callsWithOpenAICalls.length - 10} more\n`);
      }
      console.log('');
    }

    if (callsWithFilteredMessages.length > 0) {
      console.log('⚠️  CALLS WITH FILTERED MESSAGES (user may have responded but was filtered):');
      console.log('   These calls have messages that were filtered out\n');
      callsWithFilteredMessages.slice(0, 5).forEach(call => {
        console.log(`   - ${call.callControlId}: ${call.filteredCount} filtered, ${call.totalMessages} total messages`);
        call.filteredMessages.slice(0, 2).forEach(msg => {
          console.log(`     "${msg}"`);
        });
      });
      if (callsWithFilteredMessages.length > 5) {
        console.log(`   ... and ${callsWithFilteredMessages.length - 5} more\n`);
      }
      console.log('');
    }

    if (callsWithLongDuration.length > 0) {
      console.log('⚠️  CALLS WITH LONG DURATION (>30s):');
      console.log('   These calls lasted more than 30 seconds - unlikely to be true no_response\n');
      callsWithLongDuration.slice(0, 10).forEach(call => {
        console.log(`   - ${call.callControlId}: ${call.duration}s duration, ${call.messageCount} messages, ${call.openaiCalls} OpenAI calls`);
      });
      if (callsWithLongDuration.length > 10) {
        console.log(`   ... and ${callsWithLongDuration.length - 10} more\n`);
      }
      console.log('');
    }

    // Print top suspicious calls
    if (suspiciousCalls.length > 0) {
      console.log('🔴 TOP SUSPICIOUS CALLS (most likely misclassifications):\n');
      suspiciousCalls
        .sort((a, b) => {
          // Sort by number of issues, then by OpenAI calls, then by duration
          if (b.issues.length !== a.issues.length) {
            return b.issues.length - a.issues.length;
          }
          if (b.openaiCalls !== a.openaiCalls) {
            return b.openaiCalls - a.openaiCalls;
          }
          return b.duration - a.duration;
        })
        .slice(0, 20)
        .forEach((call, index) => {
          console.log(`${index + 1}. ${call.callControlId}`);
          console.log(`   Duration: ${call.duration}s`);
          console.log(`   Messages: ${call.messageCount} (${call.leadMessageCount} Lead)`);
          console.log(`   OpenAI calls: ${call.openaiCalls}`);
          console.log(`   Hangup cause: ${call.hangupCause || 'N/A'}`);
          console.log(`   Issues:`);
          call.issues.forEach(issue => {
            console.log(`     - ${issue}`);
          });
          console.log('');
        });
    }

    // Statistics
    console.log('\n📊 STATISTICS:\n');
    const avgDuration = calls.reduce((sum, c) => sum + (c.duration || 0), 0) / calls.length;
    const avgMessages = calls.reduce((sum, c) => sum + (c.messages?.length || 0), 0) / calls.length;
    const callsWithMessages = calls.filter(c => (c.messages?.length || 0) > 0).length;
    const callsWithCosts = calls.filter(c => {
      const cb = c.cost_breakdown || {};
      return (cb.openai?.apiCalls || 0) > 0 || (cb.telnyx?.ttsCost || 0) > 0 || (cb.elevenlabs?.ttsCost || 0) > 0;
    }).length;

    console.log(`   Average duration: ${avgDuration.toFixed(1)}s`);
    console.log(`   Average messages: ${avgMessages.toFixed(1)}`);
    console.log(`   Calls with messages: ${callsWithMessages} (${((callsWithMessages / calls.length) * 100).toFixed(1)}%)`);
    console.log(`   Calls with costs (TTS/OpenAI): ${callsWithCosts} (${((callsWithCosts / calls.length) * 100).toFixed(1)}%)`);

    // Recommendations
    console.log('\n💡 RECOMMENDATIONS:\n');
    if (callsWithOpenAICalls.length > 0) {
      console.log(`   ⚠️  ${callsWithOpenAICalls.length} calls have OpenAI API calls but are marked as "no_response"`);
      console.log('      → These likely had user responses and should be marked as "completed"\n');
    }
    if (callsWithLongDuration.length > 0) {
      console.log(`   ⚠️  ${callsWithLongDuration.length} calls lasted >30s but are marked as "no_response"`);
      console.log('      → These should be reviewed - unlikely to be true no_response\n');
    }
    if (callsWithFilteredMessages.length > 0) {
      console.log(`   ⚠️  ${callsWithFilteredMessages.length} calls have filtered messages`);
      console.log('      → Review filtering logic - may be incorrectly filtering user responses\n');
    }

  } catch (error) {
    console.error('❌ Error analyzing no_response calls:', error);
    throw error;
  }
}

// Run analysis
if (require.main === module) {
  analyzeNoResponseCalls()
    .then(() => {
      console.log('\n✅ Analysis complete');
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Analysis failed:', error);
      process.exit(1);
    });
}

module.exports = { analyzeNoResponseCalls };

