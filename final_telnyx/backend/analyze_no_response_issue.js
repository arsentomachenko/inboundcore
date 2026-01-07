/**
 * Analyze "no_response" calls to identify potential misclassifications
 * 769 out of 1951 calls (39%) being marked as "no_response" seems too high
 * This script will identify calls that might be incorrectly marked
 */

// Load environment variables
try {
  require('dotenv').config();
} catch (e) {
  // dotenv not available
}

const { query } = require('./config/database');

async function analyzeNoResponseCalls() {
  try {
    console.log('🔍 Analyzing "no_response" calls for potential misclassifications...\n');

    // Get total counts
    const totalResult = await query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'no_response') as no_response_count
      FROM conversations
    `);
    
    const total = parseInt(totalResult.rows[0].total);
    const noResponseCount = parseInt(totalResult.rows[0].no_response_count);
    const percentage = ((noResponseCount / total) * 100).toFixed(1);
    
    console.log(`📊 OVERVIEW:`);
    console.log(`   Total calls: ${total}`);
    console.log(`   No response calls: ${noResponseCount} (${percentage}%)`);
    console.log(`   ⚠️  ${percentage}% is very high - investigating...\n`);

    // Get all no_response calls with detailed info
    const noResponseCalls = await query(`
      SELECT 
        call_control_id,
        duration,
        status,
        hangup_cause,
        messages,
        cost_breakdown,
        start_time,
        end_time
      FROM conversations
      WHERE status = 'no_response'
      ORDER BY duration DESC
    `);

    console.log(`📋 Analyzing ${noResponseCalls.rows.length} "no_response" calls...\n`);

    // Analysis categories
    const issues = {
      hasLeadMessages: [],           // Has Lead messages but marked no_response
      hasOpenAICalls: [],            // Has OpenAI API calls (user likely responded)
      longDuration: [],              // Duration > 30s (unlikely to be true no_response)
      hasTTSButNoMessages: [],       // Has TTS cost but no messages (race condition?)
      hasMultipleAIMessages: [],    // Has multiple AI messages (conversation happened)
      shortDurationNoTTS: [],       // Short duration, no TTS (might be no_answer instead)
      potentialVoicemail: [],        // Quick hangup, might be voicemail
      suspicious: []                  // Other suspicious patterns
    };

    // Analyze each call
    for (const call of noResponseCalls.rows) {
      const messages = call.messages || [];
      const costBreakdown = call.cost_breakdown || {};
      const duration = call.duration || 0;
      
      // Count message types
      const leadMessages = messages.filter(m => m.speaker === 'Lead');
      const aiMessages = messages.filter(m => m.speaker === 'AI');
      const systemMessages = messages.filter(m => m.speaker === 'System');
      
      // Check cost breakdown
      const hasTTSCost = (costBreakdown.details?.telnyx?.ttsCost > 0) || 
                        (costBreakdown.details?.elevenlabs?.ttsCost > 0);
      const hasOpenAICalls = costBreakdown.details?.openai?.apiCalls > 0;
      const openAICalls = costBreakdown.details?.openai?.apiCalls || 0;
      
      // Check for real user messages (not filtered/background noise)
      const realLeadMessages = leadMessages.filter(m => 
        !m.text.includes('[Voicemail detected]') && 
        !m.text.includes('[Background noise]') && 
        !m.text.includes('[Filtered:')
      );

      const analysis = {
        callControlId: call.call_control_id,
        duration,
        hangupCause: call.hangup_cause,
        totalMessages: messages.length,
        leadMessages: leadMessages.length,
        realLeadMessages: realLeadMessages.length,
        aiMessages: aiMessages.length,
        hasTTSCost,
        hasOpenAICalls,
        openAICalls,
        issues: []
      };

      // Issue 1: Has Lead messages but marked as no_response
      if (realLeadMessages.length > 0) {
        analysis.issues.push(`Has ${realLeadMessages.length} real Lead message(s) - should NOT be no_response`);
        issues.hasLeadMessages.push(analysis);
      }

      // Issue 2: Has OpenAI API calls (user likely responded)
      if (hasOpenAICalls && openAICalls > 0) {
        analysis.issues.push(`Has ${openAICalls} OpenAI API call(s) - user likely responded`);
        issues.hasOpenAICalls.push(analysis);
      }

      // Issue 3: Long duration (unlikely to be true no_response)
      if (duration > 30) {
        analysis.issues.push(`Long duration (${duration}s) - unlikely to be true no_response`);
        issues.longDuration.push(analysis);
      }

      // Issue 4: Has TTS cost but no messages (race condition?)
      if (hasTTSCost && messages.length === 0) {
        analysis.issues.push(`Has TTS cost but no messages - possible race condition`);
        issues.hasTTSButNoMessages.push(analysis);
      }

      // Issue 5: Has multiple AI messages (conversation happened)
      if (aiMessages.length > 1 && !hasOpenAICalls) {
        analysis.issues.push(`Has ${aiMessages.length} AI messages but no OpenAI calls - suspicious`);
        issues.hasMultipleAIMessages.push(analysis);
      }

      // Issue 6: Short duration, no TTS (might be no_answer instead)
      if (duration < 10 && !hasTTSCost) {
        analysis.issues.push(`Short duration (${duration}s), no TTS - might be no_answer instead`);
        issues.shortDurationNoTTS.push(analysis);
      }

      // Issue 7: Quick hangup, might be voicemail
      if (duration > 0 && duration < 30 && hasTTSCost && leadMessages.length === 0 && 
          (call.hangup_cause === 'normal_clearing' || !call.hangup_cause)) {
        analysis.issues.push(`Quick hangup (${duration}s) with TTS but no Lead messages - might be voicemail`);
        issues.potentialVoicemail.push(analysis);
      }

      // Collect suspicious patterns
      if (analysis.issues.length > 0) {
        issues.suspicious.push(analysis);
      }
    }

    // Generate report
    console.log('='.repeat(100));
    console.log('📊 NO_RESPONSE ANALYSIS REPORT');
    console.log('='.repeat(100));

    console.log(`\n⚠️  POTENTIAL MISCLASSIFICATIONS:`);
    console.log(`   Total suspicious calls: ${issues.suspicious.length} out of ${noResponseCalls.rows.length}`);
    console.log(`   Percentage that might be misclassified: ${((issues.suspicious.length / noResponseCalls.rows.length) * 100).toFixed(1)}%\n`);

    // Detailed breakdown
    console.log(`\n📋 ISSUE BREAKDOWN:`);
    console.log(`   1. Has Lead messages: ${issues.hasLeadMessages.length}`);
    console.log(`      → These should likely be "completed" status`);
    console.log(`   2. Has OpenAI API calls: ${issues.hasOpenAICalls.length}`);
    console.log(`      → User likely responded, should be "completed"`);
    console.log(`   3. Long duration (>30s): ${issues.longDuration.length}`);
    console.log(`      → Unlikely to be true no_response`);
    console.log(`   4. Has TTS but no messages: ${issues.hasTTSButNoMessages.length}`);
    console.log(`      → Possible race condition in message saving`);
    console.log(`   5. Multiple AI messages, no OpenAI calls: ${issues.hasMultipleAIMessages.length}`);
    console.log(`      → Suspicious pattern`);
    console.log(`   6. Short duration, no TTS: ${issues.shortDurationNoTTS.length}`);
    console.log(`      → Might be "no_answer" instead`);
    console.log(`   7. Quick hangup, might be voicemail: ${issues.potentialVoicemail.length}`);
    console.log(`      → Should be "voicemail" status`);

    // Show examples
    if (issues.hasLeadMessages.length > 0) {
      console.log(`\n❌ EXAMPLE: Calls with Lead messages marked as no_response (first 5):`);
      issues.hasLeadMessages.slice(0, 5).forEach(call => {
        console.log(`\n   📞 ${call.callControlId}`);
        console.log(`      Duration: ${call.duration}s`);
        console.log(`      Lead messages: ${call.realLeadMessages} (total: ${call.leadMessages})`);
        console.log(`      AI messages: ${call.aiMessages}`);
        console.log(`      OpenAI calls: ${call.openAICalls}`);
        console.log(`      Issues: ${call.issues.join(', ')}`);
      });
    }

    if (issues.hasOpenAICalls.length > 0) {
      console.log(`\n❌ EXAMPLE: Calls with OpenAI API calls marked as no_response (first 5):`);
      issues.hasOpenAICalls.slice(0, 5).forEach(call => {
        console.log(`\n   📞 ${call.callControlId}`);
        console.log(`      Duration: ${call.duration}s`);
        console.log(`      OpenAI API calls: ${call.openAICalls}`);
        console.log(`      Lead messages: ${call.realLeadMessages}`);
        console.log(`      Issues: ${call.issues.join(', ')}`);
      });
    }

    if (issues.longDuration.length > 0) {
      console.log(`\n❌ EXAMPLE: Long duration calls marked as no_response (first 5):`);
      issues.longDuration.slice(0, 5).forEach(call => {
        console.log(`\n   📞 ${call.callControlId}`);
        console.log(`      Duration: ${call.duration}s`);
        console.log(`      Messages: ${call.totalMessages}`);
        console.log(`      Lead messages: ${call.realLeadMessages}`);
        console.log(`      OpenAI calls: ${call.openAICalls}`);
        console.log(`      Issues: ${call.issues.join(', ')}`);
      });
    }

    // Summary and recommendations
    console.log(`\n\n💡 RECOMMENDATIONS:`);
    console.log(`   1. Review calls with Lead messages (${issues.hasLeadMessages.length} calls)`);
    console.log(`      → These should be reclassified as "completed"`);
    console.log(`   2. Review calls with OpenAI API calls (${issues.hasOpenAICalls.length} calls)`);
    console.log(`      → These indicate user responded, should be "completed"`);
    console.log(`   3. Review long duration calls (${issues.longDuration.length} calls)`);
    console.log(`      → These are unlikely to be true no_response`);
    console.log(`   4. Check for race conditions in message saving`);
    console.log(`      → ${issues.hasTTSButNoMessages.length} calls have TTS but no messages`);
    console.log(`   5. Review quick hangups (${issues.potentialVoicemail.length} calls)`);
    console.log(`      → These might be voicemail instead of no_response`);

    const totalMisclassified = new Set([
      ...issues.hasLeadMessages.map(c => c.callControlId),
      ...issues.hasOpenAICalls.map(c => c.callControlId),
      ...issues.longDuration.map(c => c.callControlId),
      ...issues.potentialVoicemail.map(c => c.callControlId)
    ]).size;

    console.log(`\n📊 ESTIMATED MISCLASSIFICATION:`);
    console.log(`   Potentially misclassified: ${totalMisclassified} calls`);
    console.log(`   Out of ${noResponseCount} no_response calls`);
    console.log(`   Estimated error rate: ${((totalMisclassified / noResponseCount) * 100).toFixed(1)}%`);

    console.log('\n' + '='.repeat(100));
    console.log('✅ Analysis complete');
    console.log('='.repeat(100));

  } catch (error) {
    console.error('❌ Error analyzing no_response calls:', error);
    throw error;
  }
}

// Run analysis
analyzeNoResponseCalls()
  .then(() => {
    console.log('\n✅ No response analysis completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ No response analysis failed:', error);
    process.exit(1);
  });

