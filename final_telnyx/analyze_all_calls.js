/**
 * Comprehensive analysis of all calls in database
 * Checks conversation history, workflow, and transfer status
 */

// Load environment variables if .env exists
try {
  require('dotenv').config();
} catch (e) {
  // dotenv not available, environment variables should be set externally
}

const { query } = require('./backend/config/database');

async function analyzeAllCalls() {
  try {
    console.log('🔍 Starting comprehensive call analysis...\n');

    // Get all calls from database
    console.log('📊 Fetching all calls from database...');
    const allCalls = await query(`
      SELECT 
        c.id,
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
        c.created_at,
        co.telnyx_transfer_cost,
        co.duration_seconds as cost_duration_seconds,
        co.telnyx_call_minutes,
        co.telnyx_call_cost
      FROM conversations c
      LEFT JOIN costs co ON c.call_control_id = co.call_control_id
      ORDER BY c.duration DESC, c.start_time DESC
    `);

    console.log(`✅ Found ${allCalls.rows.length} total calls\n`);

    if (allCalls.rows.length === 0) {
      console.log('No calls found in database.');
      return;
    }

    // Analysis categories
    const issues = {
      longCallsNoTransfer: [],      // Calls > 1600s without transfer
      shouldHaveTransferred: [],    // Calls that should have transferred based on workflow
      transferMismatch: [],         // Transfer status mismatch
      incompleteConversations: [],  // Conversations that seem incomplete
      anomalies: []                  // Other anomalies
    };

    // Analyze each call
    for (const call of allCalls.rows) {
      const analysis = analyzeCall(call);
      
      // Categorize issues
      if (analysis.issues.length > 0) {
        if (analysis.isLongCallNoTransfer) {
          issues.longCallsNoTransfer.push(analysis);
        }
        if (analysis.shouldHaveTransferred) {
          issues.shouldHaveTransferred.push(analysis);
        }
        if (analysis.transferMismatch) {
          issues.transferMismatch.push(analysis);
        }
        if (analysis.incomplete) {
          issues.incompleteConversations.push(analysis);
        }
        if (analysis.anomalies.length > 0) {
          issues.anomalies.push(analysis);
        }
      }
    }

    // Generate report
    console.log('\n' + '='.repeat(100));
    console.log('📊 COMPREHENSIVE CALL ANALYSIS REPORT');
    console.log('='.repeat(100));
    
    console.log(`\n📈 SUMMARY:`);
    console.log(`   Total calls analyzed: ${allCalls.rows.length}`);
    console.log(`   Calls with issues: ${issues.longCallsNoTransfer.length + issues.shouldHaveTransferred.length + issues.transferMismatch.length + issues.incompleteConversations.length + issues.anomalies.length}`);
    
    // Long calls without transfer
    if (issues.longCallsNoTransfer.length > 0) {
      console.log(`\n⚠️  LONG CALLS WITHOUT TRANSFER (${issues.longCallsNoTransfer.length}):`);
      issues.longCallsNoTransfer.forEach(analysis => {
        console.log(`\n   📞 Call: ${analysis.callControlId}`);
        console.log(`      Duration: ${analysis.duration}s (${(analysis.duration / 60).toFixed(2)} minutes)`);
        console.log(`      Status: ${analysis.status}`);
        console.log(`      Transfer Cost: $${analysis.transferCost || 0}`);
        console.log(`      Issues: ${analysis.issues.join(', ')}`);
        if (analysis.transferIndicators.length > 0) {
          console.log(`      Transfer Indicators Found: ${analysis.transferIndicators.join(', ')}`);
        }
      });
    }

    // Should have transferred
    if (issues.shouldHaveTransferred.length > 0) {
      console.log(`\n⚠️  CALLS THAT SHOULD HAVE TRANSFERRED (${issues.shouldHaveTransferred.length}):`);
      issues.shouldHaveTransferred.forEach(analysis => {
        console.log(`\n   📞 Call: ${analysis.callControlId}`);
        console.log(`      Duration: ${analysis.duration}s`);
        console.log(`      Status: ${analysis.status}`);
        console.log(`      Stage: ${analysis.stage || 'unknown'}`);
        console.log(`      User Messages: ${analysis.userMessageCount}`);
        console.log(`      Transfer Indicators: ${analysis.transferIndicators.join(', ') || 'None'}`);
        console.log(`      Issues: ${analysis.issues.join(', ')}`);
      });
    }

    // Transfer mismatch
    if (issues.transferMismatch.length > 0) {
      console.log(`\n⚠️  TRANSFER STATUS MISMATCH (${issues.transferMismatch.length}):`);
      issues.transferMismatch.forEach(analysis => {
        console.log(`\n   📞 Call: ${analysis.callControlId}`);
        console.log(`      Status: ${analysis.status}`);
        console.log(`      Transfer Cost: $${analysis.transferCost || 0}`);
        console.log(`      Issues: ${analysis.issues.join(', ')}`);
      });
    }

    // Incomplete conversations
    if (issues.incompleteConversations.length > 0) {
      console.log(`\n⚠️  INCOMPLETE CONVERSATIONS (${issues.incompleteConversations.length}):`);
      issues.incompleteConversations.forEach(analysis => {
        console.log(`\n   📞 Call: ${analysis.callControlId}`);
        console.log(`      Duration: ${analysis.duration}s`);
        console.log(`      Status: ${analysis.status}`);
        console.log(`      Messages: ${analysis.totalMessages}`);
        console.log(`      Issues: ${analysis.issues.join(', ')}`);
      });
    }

    // Anomalies
    if (issues.anomalies.length > 0) {
      console.log(`\n⚠️  OTHER ANOMALIES (${issues.anomalies.length}):`);
      issues.anomalies.forEach(analysis => {
        console.log(`\n   📞 Call: ${analysis.callControlId}`);
        analysis.anomalies.forEach(anomaly => {
          console.log(`      - ${anomaly}`);
        });
      });
    }

    // Detailed analysis for top 10 longest calls
    console.log(`\n\n📋 DETAILED ANALYSIS - TOP 10 LONGEST CALLS:`);
    const topLongest = allCalls.rows
      .filter(c => c.duration > 0)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 10);
    
    topLongest.forEach((call, index) => {
      const analysis = analyzeCall(call);
      console.log(`\n${index + 1}. Call: ${call.call_control_id}`);
      console.log(`   Duration: ${call.duration}s (${(call.duration / 60).toFixed(2)} minutes)`);
      console.log(`   Status: ${call.status}`);
      console.log(`   Transfer Cost: $${call.telnyx_transfer_cost || 0}`);
      console.log(`   Hangup Cause: ${call.hangup_cause || 'N/A'}`);
      console.log(`   Messages: ${analysis.totalMessages} (AI: ${analysis.aiMessageCount}, Lead: ${analysis.userMessageCount}, System: ${analysis.systemMessageCount})`);
      console.log(`   Stage: ${analysis.stage || 'unknown'}`);
      console.log(`   Transfer Indicators: ${analysis.transferIndicators.length > 0 ? analysis.transferIndicators.join(', ') : 'None'}`);
      console.log(`   Transfer Triggered: ${analysis.transferTriggered ? 'Yes' : 'No'}`);
      console.log(`   User Agreed: ${analysis.userAgreedToTransfer ? 'Yes' : 'No'}`);
      if (analysis.issues.length > 0) {
        console.log(`   ⚠️  Issues: ${analysis.issues.join(', ')}`);
      }
      
      // Show last 3 messages
      if (analysis.messages && analysis.messages.length > 0) {
        console.log(`   Last 3 messages:`);
        analysis.messages.slice(-3).forEach((msg, idx) => {
          const preview = msg.text.length > 80 ? msg.text.substring(0, 80) + '...' : msg.text;
          console.log(`      ${idx + 1}. [${msg.speaker}] ${preview}`);
        });
      }
    });

    console.log('\n' + '='.repeat(100));
    console.log('✅ Analysis complete');
    console.log('='.repeat(100));

  } catch (error) {
    console.error('❌ Error analyzing calls:', error);
    throw error;
  }
}

function analyzeCall(call) {
  const messages = call.messages || [];
  const analysis = {
    callControlId: call.call_control_id,
    duration: call.duration || 0,
    status: call.status,
    transferCost: call.telnyx_transfer_cost || 0,
    hangupCause: call.hangup_cause,
    messages: messages,
    totalMessages: messages.length,
    aiMessageCount: messages.filter(m => m.speaker === 'AI').length,
    userMessageCount: messages.filter(m => m.speaker === 'Lead').length,
    systemMessageCount: messages.filter(m => m.speaker === 'System').length,
    issues: [],
    transferIndicators: [],
    shouldHaveTransferred: false,
    isLongCallNoTransfer: false,
    transferMismatch: false,
    incomplete: false,
    anomalies: [],
    stage: null,
    qualifications: {
      verified_info: null,
      no_alzheimers: null,
      no_hospice: null,
      age_qualified: null,
      has_bank_account: null
    },
    transferTriggered: false,
    userAgreedToTransfer: false
  };

  // Extract stage from messages or cost breakdown
  const costBreakdown = call.cost_breakdown || {};
  if (costBreakdown.details) {
    // Try to extract stage from OpenAI state if available
  }

  // Analyze messages for workflow indicators
  let transferMentioned = false;
  let setCallOutcomeCalled = false;
  let transferToAgentCalled = false;
  
  messages.forEach(msg => {
    if (msg.text) {
      const text = msg.text.toLowerCase();
      
      // Check for transfer keywords
      const transferKeywords = ['transfer', 'bridged', 'connecting', 'agent', 'connect you', 'put you through'];
      transferKeywords.forEach(keyword => {
        if (text.includes(keyword) && !analysis.transferIndicators.includes(keyword)) {
          analysis.transferIndicators.push(keyword);
          transferMentioned = true;
        }
      });
      
      // Check for set_call_outcome mentions
      if (text.includes('set_call_outcome') || text.includes('transfer_to_agent')) {
        setCallOutcomeCalled = true;
        transferToAgentCalled = true;
        analysis.transferTriggered = true;
      }
      
      // Check for user agreement to transfer
      if (transferMentioned && (text.includes('yes') || text.includes('sure') || text.includes('okay') || text.includes('ok'))) {
        analysis.userAgreedToTransfer = true;
      }
      
      // Check for qualification updates (extract from message context)
      if (text.includes('update_qualification') || text.includes('verified_info')) {
        // Try to extract qualification status from context
        if (text.includes('verified_info') && (text.includes('true') || text.includes('yes'))) {
          analysis.qualifications.verified_info = true;
        }
      }
    }
  });
  
  // Check cost breakdown for transfer indicators
  if (costBreakdown.details && costBreakdown.details.telnyx) {
    if (costBreakdown.details.telnyx.transferCost > 0) {
      analysis.transferIndicators.push('transferCostInBreakdown');
      analysis.transferTriggered = true;
    }
  }

  // Check cost breakdown for transfer indicators
  if (costBreakdown.details && costBreakdown.details.telnyx) {
    if (costBreakdown.details.telnyx.transferCost > 0) {
      analysis.transferIndicators.push('transferCostInBreakdown');
    }
  }

  // Issue 1: Long call without transfer
  if (analysis.duration > 1600 && analysis.transferCost === 0 && analysis.status !== 'transferred') {
    analysis.isLongCallNoTransfer = true;
    analysis.issues.push(`Call duration ${analysis.duration}s > 1600s but no transfer detected`);
    
    // Check if there are transfer indicators but no actual transfer
    if (analysis.transferIndicators.length > 0) {
      analysis.issues.push(`Transfer was mentioned/attempted but not completed`);
    }
  }

  // Issue 2: Transfer status mismatch
  const hasTransferCost = analysis.transferCost > 0;
  const isTransferredStatus = analysis.status === 'transferred';
  if (hasTransferCost !== isTransferredStatus) {
    analysis.transferMismatch = true;
    if (hasTransferCost && !isTransferredStatus) {
      analysis.issues.push(`Transfer cost exists ($${analysis.transferCost}) but status is not 'transferred'`);
    } else if (!hasTransferCost && isTransferredStatus) {
      analysis.issues.push(`Status is 'transferred' but no transfer cost recorded`);
    }
  }

  // Issue 3: Should have transferred based on workflow
  // A call should transfer if:
  // - Transfer was triggered (set_call_outcome with transfer_to_agent)
  // - User agreed to transfer
  // - Call duration is long (suggests conversation happened)
  // - No actual transfer occurred
  if (analysis.transferTriggered && analysis.transferCost === 0 && analysis.status !== 'transferred') {
    analysis.shouldHaveTransferred = true;
    analysis.issues.push(`Transfer was triggered (set_call_outcome called) but transfer did not complete`);
  }
  
  // Also check for long calls with user engagement that should have transferred
  const hasUserMessages = analysis.userMessageCount > 0;
  const hasReasonableDuration = analysis.duration > 60 && analysis.duration < 1800; // 1min to 30min
  const isNotVoicemail = analysis.status !== 'voicemail' && !analysis.hangupCause?.includes('voicemail');
  const isNotNoAnswer = analysis.status !== 'no_answer';
  const hasMultipleUserMessages = analysis.userMessageCount >= 3; // User engaged significantly
  
  if (hasUserMessages && hasMultipleUserMessages && hasReasonableDuration && isNotVoicemail && isNotNoAnswer && 
      analysis.transferCost === 0 && analysis.status !== 'transferred' && !analysis.transferTriggered) {
    // Long conversation with user engagement but no transfer triggered
    if (analysis.duration > 300) { // 5+ minutes
      analysis.shouldHaveTransferred = true;
      analysis.issues.push(`Long conversation (${analysis.duration}s, ${analysis.userMessageCount} user messages) but transfer was never triggered`);
    }
  }

  // Issue 4: Incomplete conversations
  if (analysis.duration > 60 && analysis.userMessageCount === 0 && analysis.status !== 'voicemail' && analysis.status !== 'no_answer') {
    analysis.incomplete = true;
    analysis.issues.push(`Long call (${analysis.duration}s) with no user messages`);
  }

  // Issue 5: Anomalies
  if (analysis.duration > 1800) { // 30+ minutes
    analysis.anomalies.push(`Extremely long call: ${analysis.duration}s (${(analysis.duration / 60).toFixed(2)} minutes)`);
  }
  
  if (analysis.duration > 0 && analysis.totalMessages === 0) {
    analysis.anomalies.push(`Call has duration (${analysis.duration}s) but no messages recorded`);
  }

  if (analysis.status === 'completed' && analysis.transferCost === 0 && analysis.duration > 300) {
    analysis.anomalies.push(`Call marked as 'completed' but no transfer (${analysis.duration}s duration)`);
  }

  return analysis;
}

// Run analysis
analyzeAllCalls()
  .then(() => {
    console.log('\n✅ Analysis script completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Analysis script failed:', error);
    process.exit(1);
  });

