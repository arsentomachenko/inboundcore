const express = require('express');
const router = express.Router();
const telnyxService = require('../services/telnyxService');
const openaiService = require('../services/openaiService');
const userModel = require('../models/userModel');
const { broadcast } = require('../services/websocketService');
const { agentState, agentConfig, markCallComplete, transferredCalls } = require('./agentRoutes');
const costTracking = require('../services/costTrackingService');
const conversationService = require('../services/conversationService');
const bidirectionalTTS = require('../services/bidirectionalTTSService');  // ✨ NEW: Bidirectional streaming TTS
const { query } = require('../config/database');

// Track calls that are currently speaking or generating response (to ignore transcriptions)
// Value: { startTime, expectedEndTime?, generating? } - generating=true means AI is generating response, false/null means speaking
// expectedEndTime: When speech is expected to finish (used for concurrent call fixes)
const speakingCalls = new Map();

// Track calls that need to hangup after speaking completes
const pendingHangups = new Map();

// Track transfer calls (don't initialize AI conversation for these)
const transferCalls = new Set();

// ⭐ CRITICAL FIX: Export transferCalls to global so mediaStreamingService can check if call is bridged
// This allows media streaming service to stop forwarding audio to ElevenLabs when call is bridged
// (Telnyx handles audio directly between user and agent when bridged)
global.transferCalls = transferCalls;

// Track recent transcriptions to prevent duplicate processing
// Key: `${callControlId}:${transcript}`, Value: timestamp
const recentTranscriptions = new Map();

// Track AMD (Answering Machine Detection) results
// Key: callControlId, Value: { result: 'human'|'machine'|'not_sure', timestamp }
const amdResults = new Map();

// Track silence timeouts for calls
// Key: callControlId, Value: { timer, lastUserSpeech, warningGiven }
const silenceTimeouts = new Map();

// Track no-response timers (hangup after 1 min if 0 responses)
// Key: callControlId, Value: timeout timer
const noResponseTimers = new Map();

// Track no-response timers after AI speech ends
// Key: callControlId, Value: { warningTimer, hangupTimer, warningGiven, startTimerTimeout }
const aiSpeechEndTimers = new Map();

// Track call start times for duration-based voicemail detection
// Key: callControlId, Value: timestamp
const callStartTimes = new Map();

// Set up listener for transcripts from media streaming service (ElevenLabs Scribe STT)
if (global.mediaStreamEvents) {
  console.log('✅ Setting up transcript listener in webhookRoutes...');
  global.mediaStreamEvents.on('transcript', async (transcriptEvent) => {
    // Process transcript as if it came from Telnyx webhook
    console.log(`📥 Transcript event received in webhookRoutes for ${transcriptEvent?.callControlId || transcriptEvent?.payload?.call_control_id}`);
    try {
      await handleTranscription(transcriptEvent);
    } catch (error) {
      console.error('❌ Error processing media stream transcript:', error);
      console.error('   Event:', JSON.stringify(transcriptEvent, null, 2).substring(0, 500));
      console.error('   Stack:', error.stack);
    }
  });
  console.log('✅ Transcript listener set up successfully');
} else {
  console.error('❌ global.mediaStreamEvents is not defined! Cannot set up transcript listener.');
}

// Note: silenceDetectionDisabled is no longer used - silence detection now resets on user response
// Keeping for backward compatibility during cleanup
const silenceDetectionDisabled = new Set();

/**
 * POST /webhooks/telnyx - Handle Telnyx webhooks
 */
router.post('/telnyx', async (req, res) => {
  try {
    const event = req.body.data;
    const eventType = event.event_type;

    console.log(`📨 Telnyx webhook: ${eventType}`);

    // Acknowledge webhook immediately
    res.sendStatus(200);

    // Handle different event types
    switch (eventType) {
      case 'call.initiated':
        await handleCallInitiated(event);
        break;

      case 'call.answered':
        await handleCallAnswered(event);
        break;

      case 'call.machine.detection.ended':
      case 'call.machine.premium.detection.ended':
        await handleMachineDetectionEnded(event);
        break;

      case 'call.hangup':
        await handleCallHangup(event);
        break;

      case 'call.speak.started':
        await handleSpeakStarted(event);
        break;

      case 'call.speak.ended':
        await handleSpeakEnded(event);
        break;

      case 'call.speak.failed':
        await handleSpeakFailed(event);
        break;

      case 'call.transcription':
        await handleTranscription(event);
        break;
      
      case 'call.bridged':
        await handleCallBridged(event);
        break;

      case 'call.streaming.started':
        console.log('✅ Streaming started');
        break;

      case 'call.streaming.stopped':
        console.log('✅ Streaming stopped');
        break;

      case 'streaming.failed':
      case 'call.streaming.failed':
        console.log('⚠️  Streaming failed (this is normal if not using media streaming)');
        break;

      case 'streaming.started':
        console.log(`🎙️  Streaming started for call: ${event?.payload?.call_control_id || 'unknown'}`);
        break;

      case 'streaming.stopped':
        console.log(`🎙️  Streaming stopped for call: ${event?.payload?.call_control_id || 'unknown'}`);
        break;

      default:
        console.log(`⚠️  Unhandled event type: ${eventType}`);
    }
  } catch (error) {
    console.error('Webhook error:', error);
    // Don't send response here - already sent above (line 34)
    // Webhooks are acknowledged immediately for fast response
  }
});

/**
 * Handle call initiated event
 */
async function handleCallInitiated(event) {
  const callControlId = event.payload.call_control_id;
  
  console.log(`📞 Call initiated: ${callControlId}`);

  // 🔍 CRITICAL FIX: Get correct numbers from client_state or telnyx_calls
  // Telnyx webhook payload.from and payload.to are from network perspective (may be reversed)
  let fromNumber = event.payload.from;  // Fallback
  let toNumber = event.payload.to;       // Fallback
  let gotNumbersFromClientState = false;
  
  // Try to get correct numbers from client_state first (fastest)
  if (event.payload.client_state) {
    try {
      const decoded = Buffer.from(event.payload.client_state, 'base64').toString();
      const state = JSON.parse(decoded);
      if (state.fromNumber && state.userInfo && state.userInfo.phone) {
        fromNumber = state.fromNumber;  // DID number (correct)
        toNumber = state.userInfo.phone;  // Client phone (correct)
        gotNumbersFromClientState = true;
        console.log(`   ✅ Using numbers from client_state: ${fromNumber} -> ${toNumber}`);
      }
    } catch (e) {
      console.warn(`   ⚠️  Could not decode client_state: ${e.message}`);
    }
  }
  
  // Fallback: Query telnyx_calls table if client_state didn't work
  if (!gotNumbersFromClientState) {
    try {
      const result = await query(
        `SELECT from_number, to_number FROM telnyx_calls WHERE call_control_id = $1`,
        [callControlId]
      );
      if (result.rows.length > 0 && result.rows[0].from_number && result.rows[0].to_number) {
        fromNumber = result.rows[0].from_number;  // DID number (correct)
        toNumber = result.rows[0].to_number;      // Client phone (correct)
        console.log(`   ✅ Using numbers from telnyx_calls: ${fromNumber} -> ${toNumber}`);
      } else {
        console.warn(`   ⚠️  Using webhook payload numbers (may be incorrect): ${fromNumber} -> ${toNumber}`);
      }
    } catch (error) {
      console.warn(`   ⚠️  Error querying telnyx_calls: ${error.message}, using webhook payload`);
    }
  }

  // Check if this is a transfer call (new call to agent)
  // Method 1: Check client_state (if available)
  let isTransfer = false;
  if (event.payload.client_state) {
    try {
      const decoded = Buffer.from(event.payload.client_state, 'base64').toString();
      const state = JSON.parse(decoded);
      isTransfer = state.isTransfer || false;
    } catch (e) {
      // Ignore decode errors
    }
  }

  // Method 2: Check if destination is the transfer number (more reliable)
  // When we transfer, Telnyx creates a new call TO the agent's number
  const transferNumber = agentConfig.transferNumber || process.env.AGENT_TRANSFER_NUMBER;
  if (!isTransfer && toNumber && transferNumber) {
    // Normalize both numbers for comparison
    const normalizedTo = toNumber.replace(/\s/g, '').replace(/^\+?1?/, '');
    const normalizedTransfer = transferNumber.replace(/\s/g, '').replace(/^\+?1?/, '');
    if (normalizedTo === normalizedTransfer || toNumber === transferNumber) {
      isTransfer = true;
      console.log(`🔗 Transfer call detected by destination number: ${toNumber}`);
    }
  }

  // If this is a transfer call, don't initialize conversation or AI
  if (isTransfer) {
    console.log(`🔗 Transfer call initiated - skipping conversation initialization`);
    transferCalls.add(callControlId);
    // Still track cost for transfer calls
    costTracking.initializeCallCost(callControlId);
    return;
  }

  // 🔍 CRITICAL: Mark webhook as received in telnyx_calls table
  // This confirms Telnyx actually sent the webhook (validates call was created)
  try {
    await userModel.markTelnyxCallWebhookReceived(callControlId);
    console.log(`   ✅ Webhook confirmed in telnyx_calls table`);
  } catch (error) {
    console.error(`   ⚠️  Error marking webhook received (call may not be in telnyx_calls table):`, error.message);
    // Don't fail - this is for tracking only
  }

  // Initialize cost tracking for this call (moved from call.answered)
  costTracking.initializeCallCost(callControlId);
  
  // Initialize conversation tracking for ALL calls (even if AMD hangs up)
  // Now using correct numbers (DID -> Client)
  conversationService.initializeConversation(
    callControlId,
    fromNumber,  // DID number (correct)
    toNumber     // Client phone (correct)
  );
  console.log(`💬 Conversation tracking initialized for ${callControlId}`);

  // Broadcast to frontend
  broadcast({
    type: 'call_event',
    event: 'initiated',
    callControlId,
    timestamp: Date.now()
  });
}

/**
 * Handle machine detection (AMD) ended event
 * NOTE: AMD is now disabled - using custom STT-based voicemail detection instead
 */
async function handleMachineDetectionEnded(event) {
  const callControlId = event.payload.call_control_id;
  console.log(`ℹ️  AMD event received but AMD is disabled - using STT-based detection instead`);
  // No-op: AMD is disabled, using custom keyword detection via STT
}

/**
 * Handle call answered event
 */
async function handleCallAnswered(event) {
  const callControlId = event.payload.call_control_id;
  console.log(`✅ Call answered: ${callControlId}`);

  // Mark call as connected for accurate cost tracking
  // Telnyx only charges for connected time, not ringing time
  costTracking.markCallConnected(callControlId);
  
  try {
    // Check if this call was already bridged (bridged event comes before answered)
    if (transferCalls.has(callControlId)) {
      console.log(`🔗 Call already bridged - skipping AI initialization`);
      // ⭐ FIX: Track start time for transfer calls so we can diagnose premature endings
      const answeredTime = Date.now();
      if (!callStartTimes.has(callControlId)) {
        callStartTimes.set(callControlId, answeredTime);
        console.log(`   ⏱️  Transfer call start time tracked: ${new Date(answeredTime).toISOString()}`);
      }
      return;
    }
    
    // 🔥 CRITICAL: Track call start time from when user ANSWERS (not when call is initiated)
    // Call duration = from "call answered" to "call terminated"
    // Only set if not already set (handleCallAnswered can be called multiple times)
    const answeredTime = Date.now();
    if (!callStartTimes.has(callControlId)) {
      callStartTimes.set(callControlId, answeredTime);
      console.log(`   ⏱️  Call start time tracked for duration-based voicemail detection`);
      
      // 🔥 CRITICAL: Update conversation.startTime to when user ANSWERS (not when call initiated)
      // This ensures conversation.duration is calculated correctly (from answer to hangup)
      const conversation = conversationService.activeConversations?.get?.(callControlId);
      if (conversation) {
        conversation.startTime = answeredTime;
        console.log(`   ✅ Updated conversation.startTime to answered time (duration will be from answer to hangup)`);
      }
    }
    
    // Also check client_state for transfer flag (backup check)
    let isTransfer = false;
    if (event.payload.client_state) {
      try {
        const decoded = Buffer.from(event.payload.client_state, 'base64').toString();
        const state = JSON.parse(decoded);
        isTransfer = state.isTransfer || false;
      } catch (e) {
        console.error('Error decoding client state:', e);
      }
    }

    // Also check if destination is transfer number (more reliable)
    if (!isTransfer) {
      const toNumber = event.payload.to;
      const transferNumber = agentConfig.transferNumber || process.env.AGENT_TRANSFER_NUMBER;
      if (toNumber && transferNumber) {
        const normalizedTo = toNumber.replace(/\s/g, '').replace(/^\+?1?/, '');
        const normalizedTransfer = transferNumber.replace(/\s/g, '').replace(/^\+?1?/, '');
        if (normalizedTo === normalizedTransfer || toNumber === transferNumber) {
          isTransfer = true;
          console.log(`🔗 Transfer call detected by destination number: ${toNumber}`);
        }
      }
    }
    
    // If this is a transfer call, don't initialize AI - just let it bridge
    if (isTransfer) {
      console.log(`🔗 Transfer call answered - bridging to agent (no AI initialization)`);
      transferCalls.add(callControlId);
      return;
    }
    
    // Start audio streaming + ElevenLabs Scribe for STT
    try {
      const { getStreamUrl } = require('../services/mediaStreamingService');
      const scribeService = require('../services/elevenLabsScribeService');
      const streamUrl = getStreamUrl(callControlId);
      
      // STEP 1: Pre-connect to ElevenLabs Scribe FIRST
      console.log(`📝 Pre-connecting to ElevenLabs Scribe before streaming starts...`);
      try {
        await scribeService.connect(callControlId);
        console.log(`✅ ElevenLabs Scribe pre-connected successfully!`);
      } catch (scribeError) {
        console.error(`⚠️  Failed to pre-connect ElevenLabs Scribe:`, scribeError.message);
        // Continue anyway - we'll try again when stream starts
      }
      
      // STEP 2: Now tell Telnyx to start streaming (ElevenLabs Scribe is already ready)
      console.log(`🎙️  Requesting Telnyx to stream audio to: ${streamUrl}`);
      await telnyxService.startStreaming(callControlId, streamUrl);
      console.log(`📝 Audio streaming started: ${callControlId}`);
      
      // Mark transcription as started for accurate cost tracking
      costTracking.markTranscriptionStarted(callControlId);
    } catch (streamingError) {
      console.error(`⚠️  Failed to start audio streaming (call may have ended):`, streamingError.message);
      // Don't throw - the call may have already ended
      // Log and continue without transcription
    }

    // Get user info from client state
    let userInfo = {};
    if (event.payload.client_state) {
      try {
        const decoded = Buffer.from(event.payload.client_state, 'base64').toString();
        const state = JSON.parse(decoded);
        userInfo = state.userInfo || {};
      } catch (e) {
        console.error('Error decoding client state:', e);
      }
    }

    // Initialize conversation if not already done
    if (!openaiService.getConversationState(callControlId)) {
      openaiService.initializeConversation(callControlId, userInfo);
    }
    
    // 🛡️ GUARD: Check if greeting was already sent to prevent duplicate
    const conversationState = openaiService.getConversationState(callControlId);
    if (conversationState && conversationState.greetingSent) {
      console.log('⚠️  Greeting already sent - skipping to prevent duplicate');
      return;
    }
    
    // Speak first greeting immediately when call is answered
    const firstGreeting = openaiService.getGreeting(callControlId);
    console.log(`🎤 Speaking first greeting: "${firstGreeting}"`);
    
    // Brief wait for call to stabilize before speaking
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Speak first greeting using bidirectional streaming
    try {
      conversationService.addMessage(callControlId, 'AI', firstGreeting);
      
      // Mark call as speaking to ignore transcriptions during AI speech
      const greetingStartTime = Date.now();
      
      // Calculate total greeting duration and store expectedEndTime BEFORE speaking
      // This allows transcription handler to check if speech should have ended (even if setTimeout doesn't fire)
      const secondGreeting = openaiService.getGreetingSecondPart(callControlId);
      const firstGreetingDuration = Math.max(3000, (firstGreeting.length * 80));
      const secondGreetingDuration = Math.max(3000, (secondGreeting.length * 80));
      const totalGreetingDuration = firstGreetingDuration + secondGreetingDuration + 3000; // Add buffer
      const expectedEndTime = greetingStartTime + totalGreetingDuration;
      
      // Set speaking state with expected end time (allows time-based check during concurrent calls)
      speakingCalls.set(callControlId, { 
        startTime: greetingStartTime,
        expectedEndTime: expectedEndTime
      });
      console.log(`🗣️  AI started speaking greetings (expected to finish at ${new Date(expectedEndTime).toISOString()})`);
      
      // Silence detection removed
      
      // Speak first part
      await bidirectionalTTS.speak(callControlId, firstGreeting);
      console.log(`✅ First greeting sent`);
      
      // Immediately speak second part
      console.log(`🎤 Speaking second greeting: "${secondGreeting}"`);
      conversationService.addMessage(callControlId, 'AI', secondGreeting);
      await bidirectionalTTS.speak(callControlId, secondGreeting);
      console.log(`✅ Second greeting sent`);
      
      setTimeout(() => {
        if (speakingCalls.has(callControlId)) {
          speakingCalls.delete(callControlId);
          console.log(`   ✅ Cleared speaking state after greetings finished playing (${totalGreetingDuration.toFixed(0)}ms)`);
        }
      }, totalGreetingDuration);
      
      console.log(`✅ Greetings sent successfully via bidirectional streaming!`);
      
      // Calculate estimated audio playback duration for both greetings
      // ⭐ REDUCED: Use faster estimate (35ms per character, was 50ms)
      // Add extra buffer for: network latency, Telnyx buffering, and audio streaming delays
      const totalGreetingText = firstGreeting + ' ' + secondGreeting;
      const estimatedDurationMs = Math.max(1000, (totalGreetingText.length * 35)); // ⭐ REDUCED: 35ms per character (was 50ms), min 1s (was 2s)
      const waitTime = estimatedDurationMs + 1000; // ⭐ REDUCED: 1 second safety buffer (was 2s)
      
      console.log(`   Estimated audio duration: ${estimatedDurationMs.toFixed(0)}ms (${totalGreetingText.length} chars)`);
      
      // Start no-response timer after audio finishes playing
      // Store timeout ID so we can cancel it if call ends early
      // 🔧 FIX: Use waitTime (not estimatedDurationMs) to include safety buffer
      const startTimerTimeout = setTimeout(() => {
        // Check if call is still active before starting timer
        const conversationState = openaiService.getConversationState(callControlId);
        if (!conversationState || transferCalls.has(callControlId) || pendingHangups.has(callControlId)) {
          console.log(`⏸️  Skipping no-response timer start - call ended or has pending action`);
          return;
        }
        console.log(`⏱️  Starting no-response timer now (after ${waitTime.toFixed(0)}ms - greetings finished playing)`);
        startNoResponseTimer(callControlId);
      }, waitTime);
      
      // Store timeout ID in timer data so we can cancel it if needed
      const existingTimerData = aiSpeechEndTimers.get(callControlId);
      if (existingTimerData) {
        existingTimerData.startTimerTimeout = startTimerTimeout;
      } else {
        aiSpeechEndTimers.set(callControlId, { startTimerTimeout });
      }
      
      console.log(`⏱️  Will start no-response timer after ${waitTime.toFixed(0)}ms (greetings playback + buffer)`);
      // Silence detection removed
      
      // Start 1-minute timer to check for user responses
      // If no user responses after 1 minute, hang up the call
      const noResponseTimeout = setTimeout(async () => {
        const currentState = openaiService.getConversationState(callControlId);
        if (!currentState) {
          // Call already ended
          return;
        }
        
        // Check if call was transferred (don't hangup transfer calls)
        if (transferCalls.has(callControlId)) {
          console.log(`⏰ Transfer call - skipping no-response check`);
          noResponseTimers.delete(callControlId);
          return;
        }
        
        // Count user responses
        const userResponseCount = currentState.messages.filter(m => m.role === 'user').length;
        
        if (userResponseCount === 0) {
          console.log(`⏰ No user responses after 1 minute - hanging up call`);
          try {
            await telnyxService.hangupCall(callControlId);
            conversationService.addMessage(
              callControlId, 
              'AI', 
              '[Auto-hangup: No response after 1 minute]'
            );
          } catch (error) {
            console.error('Error hanging up no-response call:', error);
          }
        } else {
          console.log(`✅ User has responded (${userResponseCount} responses) - keeping call active`);
        }
        
        // Clean up timer
        noResponseTimers.delete(callControlId);
      }, 60000); // 30 seconds = 30 seconds
      
      noResponseTimers.set(callControlId, noResponseTimeout);
      console.log(`⏱️  Started 1-minute no-response timer for ${callControlId.slice(0, 20)}...`);
      
      // Broadcast to frontend with both greetings
      broadcast({
        type: 'call_event',
        event: 'answered',
        callControlId,
        aiResponse: firstGreeting + ' ' + secondGreeting,
        stage: 'greeting',
        timestamp: Date.now()
      });
    } catch (speakError) {
      console.error('❌ Failed to speak greeting:');
      console.error('   Error:', JSON.stringify(speakError.raw?.errors || speakError.message, null, 2));
      // Clear speaking status on error
      speakingCalls.delete(callControlId);
      // Don't throw - call can continue with transcription even if speak fails
      // Silence detection removed
      
      // Broadcast to frontend even on error
      broadcast({
        type: 'call_event',
        event: 'answered',
        callControlId,
        stage: 'greeting',
        timestamp: Date.now()
      });
    }
  } catch (error) {
    console.error('Error handling call answered:', error);
  }
}

/**
 * Handle call bridged event
 */
async function handleCallBridged(event) {
  const callControlId = event.payload.call_control_id;
  console.log(`🔗 Call bridged: ${callControlId}`);
  console.log(`   Lead and agent are now connected`);
  
  // Mark this call as bridged so we don't start AI conversation if answered event comes later
  transferCalls.add(callControlId);
  console.log(`   Marked call as bridged - AI will not initialize on this call`);
  
  // Silence detection removed
  
  // Track the transferred call details
  const conversationState = openaiService.getConversationState(callControlId);
  if (conversationState && conversationState.userInfo) {
    const userInfo = conversationState.userInfo;
    const transferredCallData = {
      id: callControlId,
      userId: userInfo.id || null,
      phone: userInfo.phone || 'Unknown',
      name: `${userInfo.firstname || ''} ${userInfo.lastname || ''}`.trim() || 'Unknown',
      address: userInfo.address || '',
      timestamp: Date.now(),
      fromNumber: event.payload.from || null,
      toNumber: agentConfig.transferNumber
    };
    
    transferredCalls.push(transferredCallData);
    console.log(`✅ Tracked transferred call: ${userInfo.firstname} ${userInfo.lastname} (${userInfo.phone})`);
    
    // ⚠️ REMOVED: Database tracking of transfer calls
    // Transfer calls are temporary bridge calls between lead and agent
    // The original lead call already tracks transfer status in conversations table
    // No need to create separate database records for bridge calls
    // console.log(`💾 Transferred call saved to database: ${callControlId}`); // REMOVED
  }
  
  // Broadcast to frontend
  broadcast({
    type: 'call_event',
    event: 'bridged',
    callControlId,
    timestamp: Date.now()
  });
}

/**
 * Determine the exact reason why a call was hung up
 */
function determineHangupReason({
  callControlId,
  hangupCause,
  conversation,
  conversationState,
  stage,
  messageCount,
  wasAISpeaking,
  wasProcessingAI,
  timeSinceAISpeechStarted,
  timeSinceLastMessage,
  pendingHangups,
  noResponseTimers,
  amdResults
}) {
  const callDuration = conversation?.startTime 
    ? Math.floor((Date.now() - conversation.startTime) / 1000)
    : null;
  
  // Check for system-initiated hangup
  const hasPendingHangup = pendingHangups.has(callControlId);
  const hasNoResponseTimer = noResponseTimers.has(callControlId);
  
  // Check for auto-hangup messages in conversation
  const messages = conversation?.messages || [];
  const hasAutoHangupMessage = messages.some(m => 
    m.text?.includes('[Auto-hangup') || 
    m.text?.includes('[Voicemail detected]')
  );
  
  // Check for voicemail detection
  const hasVoicemailDetection = amdResults.get(callControlId)?.result === 'machine' ||
    messages.some(m => m.text?.includes('[Voicemail detected]'));
  
  // 1. SYSTEM-INITIATED HANGUP
  if (hasPendingHangup || hasAutoHangupMessage) {
    if (hasVoicemailDetection) {
      return {
        reason: 'system_voicemail_hangup',
        message: '[System: Call ended - Voicemail system detected]',
        details: 'System automatically hung up after detecting voicemail'
      };
    }
    
    if (hasNoResponseTimer) {
      return {
        reason: 'system_no_response_hangup',
        message: '[System: Call ended - No response after 1 minute]',
        details: 'System automatically hung up due to no user response'
      };
    }
    
    return {
      reason: 'system_hangup',
      message: '[System: Call ended by system]',
      details: 'System initiated hangup'
    };
  }
  
  // 2. VOICEMAIL DETECTION
  if (hasVoicemailDetection) {
    return {
      reason: 'voicemail',
      message: '[System: Voicemail system detected]',
      details: 'Call was answered by voicemail system'
    };
  }
  
  // 3. USER HANGUP DURING AI SPEECH/PROCESSING
  if (wasProcessingAI && timeSinceLastMessage && timeSinceLastMessage < 10000) {
    return {
      reason: 'user_hangup_during_ai_processing',
      message: `[User hung up during AI response - call ended ${(timeSinceLastMessage / 1000).toFixed(1)}s after user message]`,
      details: 'User hung up while AI was generating/speaking response'
    };
  }
  
  if (wasAISpeaking && hangupCause === 'normal_clearing') {
    if (messageCount === 0) {
      const speechDuration = timeSinceAISpeechStarted ? (timeSinceAISpeechStarted / 1000).toFixed(1) : 'unknown';
      return {
        reason: 'user_hangup_during_ai_speech',
        message: `[User hung up during AI speech - call ended ${speechDuration}s after AI started speaking]`,
        details: 'User hung up while AI was speaking (no user messages received)'
      };
    } else if (callDuration && callDuration < 10) {
      return {
        reason: 'user_hangup_during_ai_speech',
        message: `[User hung up during AI speech - call ended after ${callDuration}s]`,
        details: 'User hung up while AI was speaking (very short call)'
      };
    }
  }
  
  // 4. USER HANGUP - NORMAL CLEARING
  if (hangupCause === 'normal_clearing') {
    if (messageCount === 0) {
      if (callDuration && callDuration < 5) {
        return {
          reason: 'user_hangup_immediate',
          message: `[User hung up immediately - call ended after ${callDuration}s]`,
          details: 'User hung up very quickly after call was answered (likely not interested or voicemail)'
        };
      } else {
        return {
          reason: 'user_hangup_no_response',
          message: '[User hung up without responding]',
          details: 'User hung up without sending any messages'
        };
      }
    } else if (stage.includes('q1_alzheimers') || stage.includes('q2_hospice') || 
               stage.includes('q3_age') || stage.includes('q4_bank_account')) {
      return {
        reason: 'user_hangup_during_qualification',
        message: '[User hung up during qualification questions]',
        details: 'User hung up while being asked qualification questions'
      };
    } else if (stage === 'disqualified') {
      return {
        reason: 'user_hangup_after_disqualification',
        message: '[User hung up after disqualification]',
        details: 'User hung up after being disqualified'
      };
    } else if (stage === 'completed' || stage === 'transfer_confirmation') {
      return {
        reason: 'user_hangup_after_completion',
        message: '[User hung up after call completion]',
        details: 'User hung up after call was completed or transferred'
      };
    } else {
      return {
        reason: 'user_hangup_during_conversation',
        message: '[User hung up during conversation]',
        details: 'User hung up during active conversation'
      };
    }
  }
  
  // 5. CALL REJECTED
  if (hangupCause === 'call_rejected') {
    return {
      reason: 'call_rejected',
      message: '[Call rejected by user]',
      details: 'User rejected the call before answering'
    };
  }
  
  // 6. USER BUSY
  if (hangupCause === 'user_busy') {
    return {
      reason: 'user_busy',
      message: '[User busy]',
      details: 'User was busy and could not answer'
    };
  }
  
  // 7. NO ANSWER
  if (hangupCause === 'no_answer') {
    return {
      reason: 'no_answer',
      message: '[No answer]',
      details: 'Call was not answered'
    };
  }
  
  // 8. NETWORK/CARRIER ISSUES
  if (hangupCause === 'not_found' || hangupCause === 'unallocated_number') {
    return {
      reason: 'invalid_number',
      message: `[Invalid number - ${hangupCause}]`,
      details: 'Number not found or unallocated'
    };
  }
  
  // 9. UNKNOWN/OTHER
  return {
    reason: 'unknown',
    message: `[Call ended - ${hangupCause || 'unknown reason'}]`,
    details: `Hangup cause: ${hangupCause || 'unknown'}`
  };
}

/**
 * Determine the exact reason why a call was hung up
 */
function determineHangupReason({
  callControlId,
  hangupCause,
  conversation,
  conversationState,
  stage,
  messageCount,
  wasAISpeaking,
  wasProcessingAI,
  timeSinceAISpeechStarted,
  timeSinceLastMessage,
  pendingHangups,
  noResponseTimers,
  amdResults
}) {
  const callDuration = conversation?.startTime 
    ? Math.floor((Date.now() - conversation.startTime) / 1000)
    : null;
  
  // Check for system-initiated hangup
  const hasPendingHangup = pendingHangups.has(callControlId);
  const hasNoResponseTimer = noResponseTimers.has(callControlId);
  
  // Check for auto-hangup messages in conversation
  const messages = conversation?.messages || [];
  const hasAutoHangupMessage = messages.some(m => 
    m.text?.includes('[Auto-hangup') || 
    m.text?.includes('[Voicemail detected]')
  );
  
  // Check for voicemail detection
  const hasVoicemailDetection = amdResults.get(callControlId)?.result === 'machine' ||
    messages.some(m => m.text?.includes('[Voicemail detected]'));
  
  // 1. SYSTEM-INITIATED HANGUP
  if (hasPendingHangup || hasAutoHangupMessage) {
    if (hasVoicemailDetection) {
      return {
        reason: 'system_voicemail_hangup',
        message: '[System: Call ended - Voicemail system detected]',
        details: 'System automatically hung up after detecting voicemail'
      };
    }
    
    if (hasNoResponseTimer) {
      return {
        reason: 'system_no_response_hangup',
        message: '[System: Call ended - No response after 1 minute]',
        details: 'System automatically hung up due to no user response'
      };
    }
    
    return {
      reason: 'system_hangup',
      message: '[System: Call ended by system]',
      details: 'System initiated hangup'
    };
  }
  
  // 2. VOICEMAIL DETECTION
  if (hasVoicemailDetection) {
    return {
      reason: 'voicemail',
      message: '[System: Voicemail system detected]',
      details: 'Call was answered by voicemail system'
    };
  }
  
  // 3. USER HANGUP DURING AI SPEECH/PROCESSING
  if (wasProcessingAI && timeSinceLastMessage && timeSinceLastMessage < 10000) {
    return {
      reason: 'user_hangup_during_ai_processing',
      message: `[User hung up during AI response - call ended ${(timeSinceLastMessage / 1000).toFixed(1)}s after user message]`,
      details: 'User hung up while AI was generating/speaking response'
    };
  }
  
  if (wasAISpeaking && hangupCause === 'normal_clearing') {
    if (messageCount === 0) {
      const speechDuration = timeSinceAISpeechStarted ? (timeSinceAISpeechStarted / 1000).toFixed(1) : 'unknown';
      return {
        reason: 'user_hangup_during_ai_speech',
        message: `[User hung up during AI speech - call ended ${speechDuration}s after AI started speaking]`,
        details: 'User hung up while AI was speaking (no user messages received)'
      };
    } else if (callDuration && callDuration < 10) {
      return {
        reason: 'user_hangup_during_ai_speech',
        message: `[User hung up during AI speech - call ended after ${callDuration}s]`,
        details: 'User hung up while AI was speaking (very short call)'
      };
    }
  }
  
  // 4. USER HANGUP - NORMAL CLEARING
  if (hangupCause === 'normal_clearing') {
    if (messageCount === 0) {
      if (callDuration && callDuration < 5) {
        return {
          reason: 'user_hangup_immediate',
          message: `[User hung up immediately - call ended after ${callDuration}s]`,
          details: 'User hung up very quickly after call was answered (likely not interested or voicemail)'
        };
      } else {
        return {
          reason: 'user_hangup_no_response',
          message: '[User hung up without responding]',
          details: 'User hung up without sending any messages'
        };
      }
    } else if (stage.includes('q1_alzheimers') || stage.includes('q2_hospice') || 
               stage.includes('q3_age') || stage.includes('q4_bank_account')) {
      return {
        reason: 'user_hangup_during_qualification',
        message: '[User hung up during qualification questions]',
        details: 'User hung up while being asked qualification questions'
      };
    } else if (stage === 'disqualified') {
      return {
        reason: 'user_hangup_after_disqualification',
        message: '[User hung up after disqualification]',
        details: 'User hung up after being disqualified'
      };
    } else if (stage === 'completed' || stage === 'transfer_confirmation') {
      return {
        reason: 'user_hangup_after_completion',
        message: '[User hung up after call completion]',
        details: 'User hung up after call was completed or transferred'
      };
    } else {
      return {
        reason: 'user_hangup_during_conversation',
        message: '[User hung up during conversation]',
        details: 'User hung up during active conversation'
      };
    }
  }
  
  // 5. CALL REJECTED
  if (hangupCause === 'call_rejected') {
    return {
      reason: 'call_rejected',
      message: '[Call rejected by user]',
      details: 'User rejected the call before answering'
    };
  }
  
  // 6. USER BUSY
  if (hangupCause === 'user_busy') {
    return {
      reason: 'user_busy',
      message: '[User busy]',
      details: 'User was busy and could not answer'
    };
  }
  
  // 7. NO ANSWER
  if (hangupCause === 'no_answer') {
    return {
      reason: 'no_answer',
      message: '[No answer]',
      details: 'Call was not answered'
    };
  }
  
  // 8. NETWORK/CARRIER ISSUES
  if (hangupCause === 'not_found' || hangupCause === 'unallocated_number') {
    return {
      reason: 'invalid_number',
      message: `[Invalid number - ${hangupCause}]`,
      details: 'Number not found or unallocated'
    };
  }
  
  // 9. UNKNOWN/OTHER
  return {
    reason: 'unknown',
    message: `[Call ended - ${hangupCause || 'unknown reason'}]`,
    details: `Hangup cause: ${hangupCause || 'unknown'}`
  };
}

/**
 * Handle call hangup event
 */
async function handleCallHangup(event) {
  const callControlId = event.payload.call_control_id;
  const hangupCause = event.payload.hangup_cause;
  
  // 🔧 FIX: Check if this is a transfer call BEFORE attempting recovery
  // Transfer calls should never be saved to conversation history
  const transferNumber = agentConfig.transferNumber || process.env.AGENT_TRANSFER_NUMBER;
  let isTransferCall = transferCalls.has(callControlId);
  
  // Also check by destination number if not already marked
  if (!isTransferCall && transferNumber) {
    const toNumber = event.payload.to;
    if (toNumber) {
      const normalizedTo = toNumber.replace(/\s/g, '').replace(/^\+?1?/, '');
      const normalizedTransfer = transferNumber.replace(/\s/g, '').replace(/^\+?1?/, '');
      if (normalizedTo === normalizedTransfer || toNumber === transferNumber) {
        isTransferCall = true;
        transferCalls.add(callControlId);
        console.log(`🔗 Transfer call detected by destination number in hangup: ${toNumber}`);
      }
    }
  }
  
  // ⚠️ FIX: Ensure conversation was initialized even if call never answered
  // This can happen if the call.initiated webhook never arrived or was delayed
  // BUT skip for transfer calls - they should never be in conversation history
  let conversation = conversationService.activeConversations?.get?.(callControlId);
  if (!conversation && !isTransferCall) {
    // Try to get numbers from telnyx_calls or client_state to initialize
    console.log(`⚠️  Call hangup received but no conversation found for ${callControlId} - attempting to recover`);
    try {
      let fromNumber = event.payload.from;
      let toNumber = event.payload.to;
      
      // Try to get from telnyx_calls table
      const result = await query(
        `SELECT from_number, to_number FROM telnyx_calls WHERE call_control_id = $1`,
        [callControlId]
      );
      if (result.rows.length > 0) {
        fromNumber = result.rows[0].from_number;
        toNumber = result.rows[0].to_number;
      }
      
      // Initialize conversation retroactively so we can save it
      conversationService.initializeConversation(callControlId, fromNumber, toNumber);
      // Reassign conversation variable after recovery
      conversation = conversationService.activeConversations?.get?.(callControlId);
      console.log(`   ✅ Conversation initialized retroactively for hangup event`);
    } catch (error) {
      console.error(`   ⚠️  Could not recover conversation: ${error.message}`);
    }
  } else if (isTransferCall) {
    console.log(`🔗 Transfer call detected - skipping conversation recovery`);
  }
  
  // Skip processing for transfer calls (they're just bridge calls, no conversation)
  // Use isTransferCall from above check OR check transferCalls map
  if (isTransferCall || transferCalls.has(callControlId)) {
    console.log(`📵 Transfer call ended: ${callControlId} (${hangupCause}) - skipping conversation processing`);
    
    // ⭐ FIX: Log transfer call duration to diagnose premature endings
    const transferCallStartTime = callStartTimes.get(callControlId);
    if (transferCallStartTime) {
      const transferCallDuration = (Date.now() - transferCallStartTime) / 1000;
      console.log(`   Transfer call duration: ${transferCallDuration.toFixed(1)}s`);
      
      // Warn if transfer call ended very quickly (less than 5 seconds)
      if (transferCallDuration < 5 && hangupCause === 'normal_clearing') {
        console.warn(`   ⚠️  WARNING: Transfer call ended very quickly (${transferCallDuration.toFixed(1)}s) - may indicate agent didn't answer or call failed`);
        console.warn(`   ⚠️  This could be due to:`);
        console.warn(`      - Agent not answering the call`);
        console.warn(`      - Transfer timeout too short`);
        console.warn(`      - Network/connection issue`);
      }
    } else {
      console.log(`   ⚠️  Transfer call start time not found - cannot calculate duration`);
    }
    
    stopSilenceDetection(callControlId);
    // 🔧 FIX: Only finalize cost tracking for transfer calls - DO NOT save to conversation history
    // Transfer calls are temporary bridge calls - only the lead outbound call should be in conversation history
    try {
      const finalCost = await costTracking.finalizeCallCost(callControlId, false);
      console.log(`💰 Final call cost: $${finalCost.total.toFixed(4)}`);
      console.log(`   Telnyx: $${finalCost.telnyx.toFixed(4)} (${finalCost.telnyxMinutes} min)`);
      console.log(`   ElevenLabs: $${finalCost.elevenLabs.toFixed(4)}`);
      console.log(`   OpenAI: $${finalCost.openai.toFixed(4)} (${finalCost.openaiCalls} calls)`);
      await costTracking.saveCallCost(callControlId, finalCost);
      console.log(`💾 Saved cost to database: ${callControlId}`);
      // ⚠️ REMOVED: conversationService.finalizeConversation() - transfer calls should NOT be in conversation history
      console.log(`ℹ️  Transfer call - NOT saving to conversation history (only lead calls are saved)`);
    } catch (error) {
      console.error('Error finalizing transfer call cost:', error);
    }
    return;
  }
  
  // Silence detection removed
  
  // Clean up no-response timer if call ends
  const noResponseTimer = noResponseTimers.get(callControlId);
  if (noResponseTimer) {
    clearTimeout(noResponseTimer);
    noResponseTimers.delete(callControlId);
  }
  
  // Clean up AI speech end timer if call ends
  clearNoResponseTimer(callControlId);
  
  
  // Get conversation state before cleanup for context
  const conversationState = openaiService.getConversationState(callControlId);
  const stage = conversationState?.stage || 'unknown';
  const messageCount = conversationState?.messages?.filter(m => m.role === 'user').length || 0;
  
  // 🔍 Check if AI was speaking when call ended
  const wasAISpeaking = speakingCalls.has(callControlId);
  const speakingInfo = speakingCalls.get(callControlId);
  const aiSpeechStartTime = speakingInfo?.startTime || null;
  const timeSinceAISpeechStarted = aiSpeechStartTime ? Date.now() - aiSpeechStartTime : null;
  
  // 🔍 Check if user hung up during AI processing (after sending a message)
  const wasProcessingAI = conversation?.pendingAIResponse || false;
  const lastUserMessageTime = conversation?.lastUserMessageTime || null;
  const timeSinceLastMessage = lastUserMessageTime ? Date.now() - lastUserMessageTime : null;
  
  // Detect user hangup during AI speech/processing
  let userHangupDetected = false;
  let userHangupMessage = null;
  
  if (wasProcessingAI && lastUserMessageTime && timeSinceLastMessage < 10000) {
    // User hung up within 10 seconds of sending a message (likely during AI processing)
    userHangupDetected = true;
    userHangupMessage = `[User hung up during AI response - call ended ${(timeSinceLastMessage / 1000).toFixed(1)}s after user message]`;
    console.log(`⚠️  USER HUNG UP DURING AI PROCESSING!`);
    console.log(`   Last user message was ${(timeSinceLastMessage / 1000).toFixed(1)}s ago`);
    console.log(`   AI was generating/speaking response when user hung up`);
  } else if (wasAISpeaking && messageCount === 0 && hangupCause === 'normal_clearing') {
    // User hung up during AI speech before sending any message
    userHangupDetected = true;
    const speechDuration = timeSinceAISpeechStarted ? (timeSinceAISpeechStarted / 1000).toFixed(1) : 'unknown';
    userHangupMessage = `[User hung up during AI speech - call ended ${speechDuration}s after AI started speaking]`;
    console.log(`⚠️  USER HUNG UP DURING AI SPEECH!`);
    console.log(`   AI was speaking when user hung up`);
    console.log(`   No user messages received`);
    console.log(`   AI had been speaking for ${speechDuration}s`);
  } else if (wasAISpeaking && hangupCause === 'normal_clearing') {
    // AI was speaking and call ended with normal_clearing = user likely hung up
    // Calculate call duration from start_time if available
    const callDuration = conversation?.startTime 
      ? Math.floor((Date.now() - conversation.startTime) / 1000)
      : null;
    
    // Only detect as user hangup if call is very short (< 10s) or no user messages
    if ((callDuration && callDuration < 10) || messageCount === 0) {
      userHangupDetected = true;
      const speechDuration = timeSinceAISpeechStarted ? (timeSinceAISpeechStarted / 1000).toFixed(1) : 'unknown';
      const durationText = callDuration ? `${callDuration}s` : 'unknown duration';
      userHangupMessage = `[User hung up during AI speech - call ended after ${durationText}]`;
      console.log(`⚠️  USER HUNG UP DURING AI SPEECH!`);
      console.log(`   AI was speaking when user hung up`);
      if (callDuration) {
        console.log(`   Call duration: ${callDuration}s`);
      }
      console.log(`   AI had been speaking for ${speechDuration}s`);
    }
  }
  
  if (userHangupDetected && userHangupMessage) {
    // Add system message to conversation
    conversationService.addMessage(
      callControlId,
      'System',
      userHangupMessage
    );
    
    // Broadcast to frontend
    broadcast({
      type: 'call_event',
      event: 'user_hangup_during_ai_response',
      callControlId,
      hangupCause,
      timeSinceLastMessage: timeSinceLastMessage,
      timeSinceAISpeechStarted: timeSinceAISpeechStarted,
      timestamp: Date.now()
    });
    
    // Mark conversation with user hangup flag
    if (conversation) {
      conversation.userHangupDuringProcessing = true;
      conversation.userHangupTime = Date.now();
    }
  }
  
  // 🔍 DETERMINE EXACT HANGUP REASON
  const hangupReason = determineHangupReason({
    callControlId,
    hangupCause,
    conversation,
    conversationState,
    stage,
    messageCount,
    wasAISpeaking,
    wasProcessingAI,
    timeSinceAISpeechStarted,
    timeSinceLastMessage,
    pendingHangups,
    noResponseTimers,
    amdResults
  });
  
  // Add system message with exact hangup reason (if not already added by user hangup detection)
  if (hangupReason.message && !userHangupDetected) {
    conversationService.addMessage(
      callControlId,
      'System',
      hangupReason.message
    );
  }
  
  console.log(`📵 Call ended: ${callControlId} (${hangupCause})`);
  console.log(`   📊 Call Context:`);
  console.log(`      - Stage: ${stage}`);
  console.log(`      - User responses: ${messageCount}`);
  console.log(`      - Hangup Reason: ${hangupReason.reason}`);
  if (hangupReason.details) {
    console.log(`      - Details: ${hangupReason.details}`);
  }
  if (wasProcessingAI) {
    console.log(`      - ⚠️  User hung up while AI was processing/speaking`);
  }
  
  // Extract user info from client_state to update answer type
  let userInfo = null;
  if (event.payload.client_state) {
    try {
      const decoded = Buffer.from(event.payload.client_state, 'base64').toString();
      const state = JSON.parse(decoded);
      userInfo = state.userInfo;
    } catch (e) {
      console.error('Error decoding client state in hangup:', e);
    }
  }
  
  // Determine answer type if user hasn't been marked as answered yet
  if (userInfo && userInfo.phone) {
    const user = await userModel.getUserById(userInfo.id);
    
    // Only update if user hasn't been marked as "answered" by a real person
    if (!user?.answered) {
      let answerType = null;
      const stage = conversationState?.stage || 'greeting';
      
      // Calculate call duration for better detection
      const callDuration = conversationState?.startTime 
        ? (Date.now() - conversationState.startTime) / 1000  // in seconds
        : 0;
      
      // Determine answer type based on hangup cause, conversation stage, and duration
      // 🔍 CRITICAL FIX: Check for user responses FIRST before marking as no_answer
      // Even if hangup cause is call_rejected or user_busy, if user responded, mark as answered
      // Check both conversationState (OpenAI messages with role='user') and conversationService (with speaker='Lead')
      // Reuse conversation variable from line 601 (already declared in function scope)
      const hasUserMessagesInOpenAI = messageCount > 0 || conversationState?.messages?.some(m => m.role === 'user');
      const hasUserMessagesInConversation = conversation?.messages?.some(m => m.speaker === 'Lead');
      const hasUserMessages = hasUserMessagesInOpenAI || hasUserMessagesInConversation;
      
      if (hangupCause === 'not_found' || hangupCause === 'unallocated_number') {
        answerType = 'not_found';
      } else if (hangupCause === 'call_rejected' || hangupCause === 'user_busy') {
        // ⚠️ FIX: Only mark as no_answer if user didn't actually respond
        // If user responded (has messages), mark as answered instead
        if (hasUserMessages) {
          answerType = 'answered';
          console.log(`   ✅ User responded despite ${hangupCause} - marking as answered`);
          console.log(`   📊 Checked: OpenAI messages=${hasUserMessagesInOpenAI}, Conversation messages=${hasUserMessagesInConversation}`);
        } else {
          answerType = 'no_answer';
        }
      } else if (messageCount === 0 && callDuration > 0 && callDuration < 30) {
        // Hung up quickly (< 30s) with no user responses - almost certainly voicemail
        // This catches cases where user/voicemail hangs up before silence timer triggers
        answerType = 'voicemail';
        console.log(`   📊 Quick hangup detected: ${callDuration.toFixed(1)}s with 0 responses → voicemail`);
      } else if (stage === 'greeting' || stage === 'verify_info' || stage === 'unknown') {
        // Call was answered but never got past greeting - likely voicemail
        answerType = 'voicemail';
      } else if (stage === 'await_verification' && hangupCause === 'normal_clearing') {
        // Got to verification stage but hung up - likely voicemail
        answerType = 'voicemail';
      } else if (stage === 'reason_not_forward' || conversationState?.messages?.some(m => m.role === 'user')) {
        // If we got past verification or have user messages, they answered
        // This shouldn't happen as they would have been marked in transcription handler
        answerType = 'answered';
      } else {
        answerType = 'no_answer';
      }
      
      if (answerType) {
        await userModel.markUserAnswered(userInfo.phone, answerType, stage);
      }
    }
  }
  
  // Update statistics
  if (conversationState) {
    if (conversationState.stage === 'completed') {
      agentState.qualifiedLeads++;
    } else if (conversationState.stage === 'disqualified') {
      agentState.disqualifiedLeads++;
    }
  }

  // 🔍 CRITICAL FIX: Check if conversation was already finalized (e.g., by voicemail detection)
  // This prevents duplicate finalization during concurrent calls
  // Reuse conversation variable from line 601 (already declared in function scope)
  if (!conversation) {
    console.log(`⚠️  Call hangup received but conversation already finalized for ${callControlId} - skipping finalization`);
    // Still clean up other resources
    openaiService.endConversation(callControlId);
    speakingCalls.delete(callControlId);
    transferCalls.delete(callControlId);
    amdResults.delete(callControlId);
    return;
  }
  
  // Finalize cost tracking
  // Check if call was transferred by checking transferredCalls array
  const wasTransferred = transferredCalls.some(call => call.id === callControlId) ||
                         transferCalls.has(callControlId) || 
                         stage === 'completed' || 
                         stage === 'transfer_confirmation';
  const finalCost = await costTracking.finalizeCallCost(callControlId, wasTransferred);
  
  // Finalize conversation tracking with full cost breakdown and hangup cause
  // ⚠️ If voicemail was detected, use 'voicemail' as hangupCause instead of Telnyx's hangup cause
  const effectiveHangupCause = amdResults.get(callControlId)?.result === 'machine' ? 'voicemail' : hangupCause;
  await conversationService.finalizeConversation(
    callControlId,
    finalCost,  // Pass entire cost object for detailed breakdown
    wasTransferred,
    effectiveHangupCause  // Use voicemail if detected, otherwise use Telnyx hangup cause
  );
  
  // Clean up
  openaiService.endConversation(callControlId);
  speakingCalls.delete(callControlId); // Clean up speaking state
  transferCalls.delete(callControlId); // Clean up transfer tracking
  amdResults.delete(callControlId); // Clean up AMD results
  callStartTimes.delete(callControlId); // Clean up call start time tracking
  
  // ✨ CRITICAL: Close all websockets (STT and TTS) when call hangs up
  try {
    const { closeAllWebsocketsForCall } = require('../services/mediaStreamingService');
    closeAllWebsocketsForCall(callControlId);
    console.log(`   ✅ All websockets closed for ${callControlId}`);
  } catch (error) {
    console.error(`   ❌ Error closing websockets:`, error);
  }
  
  // Cancel any active TTS requests
  try {
    bidirectionalTTS.cancel(callControlId);
    console.log(`   ✅ Cancelled any active TTS requests for ${callControlId}`);
  } catch (error) {
    console.error(`   ❌ Error cancelling TTS requests:`, error);
  }
  
  // ⚠️ CRITICAL: Clear any pending transfers/hangups since call has ended
  // This prevents attempting to transfer a call that has already hung up
  const pendingAction = pendingHangups.get(callControlId);
  if (pendingAction) {
    console.log(`🧹 Clearing pending ${pendingAction.type} for ended call: ${callControlId}`);
    pendingHangups.delete(callControlId);
  }
  
  // Cancel any pending transfer timeouts to prevent attempting transfer after call ends
  if (global.pendingTransferTimeouts) {
    const timeoutId = global.pendingTransferTimeouts.get(callControlId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      global.pendingTransferTimeouts.delete(callControlId);
      console.log(`🧹 Cancelled pending transfer timeout for ended call: ${callControlId}`);
    }
  }
  
  // Clean up pending transfers map
  if (global.pendingTransfers) {
    if (global.pendingTransfers.has(callControlId)) {
      global.pendingTransfers.delete(callControlId);
      console.log(`🧹 Cleared pending transfer details for ended call: ${callControlId}`);
    }
  }

  // ✅ Notify agent queue that this call is complete
  markCallComplete(callControlId, {
    status: conversationState?.stage || 'completed',
    hangupCause,
    conversationState
  });

  // Broadcast to frontend
  broadcast({
    type: 'call_event',
    event: 'hangup',
    callControlId,
    hangupCause,
    conversationState,
    timestamp: Date.now()
  });
}

/**
 * Handle speak ended event
 */
/**
 * Handle speak started event
 */
async function handleSpeakStarted(event) {
  const callControlId = event.payload.call_control_id;
  console.log(`🗣️  Speak started: ${callControlId}`);
  
  // Mark this call as currently speaking
  speakingCalls.set(callControlId, { startTime: Date.now() });

  // Silence detection removed

  // Broadcast to frontend
  broadcast({
    type: 'call_event',
    event: 'speak_started',
    callControlId,
    timestamp: Date.now()
  });
}

async function handleSpeakEnded(event) {
  const callControlId = event.payload.call_control_id;
  console.log(`🗣️  Speak ended: ${callControlId}`);
  console.log(`   ⚠️  NOTE: Bidirectional TTS typically doesn't trigger this event, but checking anyway...`);
  
  // Mark this call as no longer speaking
  speakingCalls.delete(callControlId);

  // Silence detection removed

  // Check if there's a pending hangup for this call
  const pendingAction = pendingHangups.get(callControlId);
  if (pendingAction) {
    // ⚠️ CRITICAL: Check if call is still active before executing pending action
    // (This handler is for Telnyx speak.ended events, but bidirectional TTS doesn't trigger this)
    const conversationState = openaiService.getConversationState(callControlId);
    if (!conversationState) {
      console.log(`⚠️  Call ${callControlId} has already ended - skipping pending ${pendingAction.type}`);
      pendingHangups.delete(callControlId);
      // Also clear from pendingTransfers if it exists
      if (global.pendingTransfers) {
        global.pendingTransfers.delete(callControlId);
      }
      return;
    }
    
    // Cancel the timeout since we're executing now (avoid double execution)
    if (global.pendingTransferTimeouts) {
      const timeoutId = global.pendingTransferTimeouts.get(callControlId);
      if (timeoutId) {
        clearTimeout(timeoutId);
        global.pendingTransferTimeouts.delete(callControlId);
        console.log(`   🧹 Cancelled transfer timeout (executing immediately via speak.ended)`);
      }
    }
    
    pendingHangups.delete(callControlId);
    // Also clear from pendingTransfers
    if (global.pendingTransfers) {
      global.pendingTransfers.delete(callControlId);
    }
    
    console.log(`📵 Executing pending ${pendingAction.type} after speech completed (via speak.ended event)`);
    
    try {
      if (pendingAction.type === 'hangup') {
        await telnyxService.hangupCall(callControlId);
      } else if (pendingAction.type === 'transfer') {
        console.log(`📲 Transferring call to: ${pendingAction.transferNumber}`);
        console.log(`   Using caller ID: ${pendingAction.fromNumber || 'auto'}`);
        
        const result = await telnyxService.transferCall(
          callControlId, 
          pendingAction.transferNumber, 
          pendingAction.fromNumber
        );
        
        if (!result) {
          console.warn('⚠️  Transfer failed (call may have ended) - attempting hangup as fallback');
          try {
            await telnyxService.hangupCall(callControlId);
          } catch (hangupError) {
            // Call already ended - this is expected
            console.log('   Call already ended (expected if user hung up)');
          }
        } else {
          console.log(`✅ Transfer executed successfully via speak.ended event`);
        }
      }
    } catch (error) {
      // Check if error is because call already ended (expected scenario)
      if (error.response?.data?.errors?.[0]?.code === '90018' || 
          error.message?.includes('already ended') ||
          error.message?.includes('90018')) {
        console.log(`ℹ️  ${pendingAction.type} skipped - call ${callControlId} already ended`);
      } else {
        console.error(`❌ Error executing pending ${pendingAction.type}:`, error.message);
        // Try to hang up as a fallback
        if (pendingAction.type === 'transfer') {
          console.log('   Attempting hangup as fallback after failed transfer...');
          try {
            await telnyxService.hangupCall(callControlId);
          } catch (hangupError) {
            // Call already ended - this is expected
            console.log('   Call already ended (expected if user hung up)');
          }
        }
      }
    }
  } else {
    console.log(`   ℹ️  No pending action found for ${callControlId} (this is normal for bidirectional TTS)`);
  }

  // Broadcast to frontend
  broadcast({
    type: 'call_event',
    event: 'speak_ended',
    callControlId,
    timestamp: Date.now()
  });
}

/**
 * Handle speak.failed event - TTS failed to play
 */
async function handleSpeakFailed(event) {
  const callControlId = event.payload.call_control_id;
  console.error(`❌ SPEAK FAILED on call: ${callControlId}`);
  console.error(`   Error details:`, JSON.stringify(event.payload, null, 2));
  
  // Mark this call as no longer speaking
  speakingCalls.delete(callControlId);
  
  // If there's a pending action, we should still try to execute it
  const pendingAction = pendingHangups.get(callControlId);
  if (pendingAction) {
    // ⚠️ CRITICAL: Check if call is still active before executing pending action
    const conversationState = openaiService.getConversationState(callControlId);
    if (!conversationState) {
      console.log(`⚠️  Call ${callControlId} has already ended - skipping pending ${pendingAction.type} after speak failed`);
      pendingHangups.delete(callControlId);
      // Also clear from pendingTransfers
      if (global.pendingTransfers) {
        global.pendingTransfers.delete(callControlId);
      }
      return;
    }
    
    // Cancel the timeout since we're executing now (avoid double execution)
    if (global.pendingTransferTimeouts) {
      const timeoutId = global.pendingTransferTimeouts.get(callControlId);
      if (timeoutId) {
        clearTimeout(timeoutId);
        global.pendingTransferTimeouts.delete(callControlId);
        console.log(`   🧹 Cancelled transfer timeout (executing immediately via speak.failed)`);
      }
    }
    
    pendingHangups.delete(callControlId);
    // Also clear from pendingTransfers
    if (global.pendingTransfers) {
      global.pendingTransfers.delete(callControlId);
    }
    
    console.log(`📵 Executing pending ${pendingAction.type} after speak failed`);
    
    try {
      if (pendingAction.type === 'hangup') {
        await telnyxService.hangupCall(callControlId);
      } else if (pendingAction.type === 'transfer') {
        console.log(`📲 Transferring call to: ${pendingAction.transferNumber}`);
        console.log(`   Using caller ID: ${pendingAction.fromNumber || 'auto'}`);
        
        const result = await telnyxService.transferCall(
          callControlId, 
          pendingAction.transferNumber, 
          pendingAction.fromNumber
        );
        
        if (!result) {
          console.warn('⚠️  Transfer failed after speak failed - attempting hangup');
          try {
            await telnyxService.hangupCall(callControlId);
          } catch (hangupError) {
            // Call already ended - this is expected
            console.log('   Call already ended (expected if user hung up)');
          }
        } else {
          console.log(`✅ Transfer executed successfully via speak.failed event`);
        }
      }
    } catch (error) {
      // Check if error is because call already ended (expected scenario)
      if (error.response?.data?.errors?.[0]?.code === '90018' || 
          error.message?.includes('already ended') ||
          error.message?.includes('90018')) {
        console.log(`ℹ️  ${pendingAction.type} skipped - call ${callControlId} already ended`);
      } else {
        console.error(`❌ Error executing pending action after speak failed:`, error.message);
      }
    }
  }

  // Broadcast to frontend
  broadcast({
    type: 'call_event',
    event: 'speak_failed',
    callControlId,
    error: event.payload,
    timestamp: Date.now()
  });
}

/**
 * Handle transcription event
 */
async function handleTranscription(event) {
  const callControlId = event.payload.call_control_id;
  
  // Extract transcript from the correct location in the payload
  const transcriptionData = event.payload.transcription_data;
  const transcript = transcriptionData?.transcript || event.payload.transcription_text || event.payload.transcript;
  const isFinal = transcriptionData?.is_final ?? event.payload.is_final;
  // Default to 0.9 if confidence not provided (ElevenLabs Scribe often doesn't return confidence)
  const confidence = transcriptionData?.confidence ?? 0.9;

  // Silently skip empty/interim transcriptions (don't log - too noisy)
  if (!isFinal || !transcript || transcript.trim().length === 0) {
    return;
  }

  console.log(`📝 Transcription [FINAL]: "${transcript}" (confidence: ${confidence.toFixed(4)})`);

  // ✨ Whitelist of common short response words that should always be accepted
  // These are legitimate user responses that are often short
  const commonShortWords = ['yes', 'yep', 'yeah', 'yup', 'no', 'nope', 'nah', 'not', 'ok', 'okay', 'sure', 'uh', 'uh-huh', 'mm-hmm', 'hmm', 'ah', 'oh', 'hi', 'hey', 'bye'];
  const transcriptLower = transcript.toLowerCase().trim();
  const isCommonShortWord = commonShortWords.includes(transcriptLower);

  // Filter out very short transcriptions (often noise)
  // BUT: Always accept common short words (even 2-character words like "no")
  if (transcript.length < 3 && !isCommonShortWord) {
    console.log(`⚠️  Too short (${transcript.length} chars) - likely noise - SKIPPING`);
    
    // Clear silence timer - any audio means not silent
    // Silence detection removed
    
    return;
  }
  
  // Log when we accept a common short word (for debugging)
  if (isCommonShortWord) {
    console.log(`✅ Accepted common short word: "${transcript}" (confidence: ${confidence.toFixed(4)})`);
  }

  // Filter out nonsensical patterns that indicate background TV/noise
  const nonsensicalPatterns = [
    /\d{4}[-–]\d{2,4}/,  // Years like "2018-19" or "2018-2019"
    /season|stadium|game|score|points/i,  // Sports commentary
    /channel|program|show|episode/i,  // TV program references
    /breaking news|weather|forecast/i,  // News/weather broadcasts
  ];
  
  if (nonsensicalPatterns.some(pattern => pattern.test(transcript))) {
    console.log(`⚠️  Background TV/noise detected - SKIPPING: "${transcript.substring(0, 50)}..."`);
    conversationService.addMessage(callControlId, 'Lead', `[Background noise] ${transcript}`);
    
    // Clear silence timer - TV noise means audio is present
    // Silence detection removed
    
    return;
  }

  // Ignore transcriptions for bridged/transferred calls
  if (transferCalls.has(callControlId)) {
    console.log(`🔗 Ignoring transcription - call is bridged to agent`);
    return;
  }

  // ⭐ FIX: Only ignore transcriptions when HANGUP is pending, not when TRANSFER is pending
  // When transfer is pending, user might be confirming the transfer (e.g., "yes, that sounds good")
  const pendingAction = pendingHangups.get(callControlId);
  if (pendingAction && pendingAction.type === 'hangup') {
    console.log(`🔇 User spoke after call end - logging but not processing`);
    // Log to conversation history
    conversationService.addMessage(
      callControlId, 
      'Lead', 
      `[After call end] ${transcript}`
    );
    return;
  }
  
  // ⭐ FIX: Allow user responses when transfer is pending (they're confirming the transfer)
  if (pendingAction && pendingAction.type === 'transfer') {
    console.log(`✅ User responding during transfer confirmation - processing response`);
    // Continue processing - don't return here
  }

  // Check for duplicate transcriptions (prevent processing same transcript twice)
  // 🔍 CRITICAL FIX: Check duplicates BEFORE voicemail detection to prevent duplicate voicemail processing
  const transcriptKey = `${callControlId}:${transcript}`;
  const now = Date.now();
  const lastProcessed = recentTranscriptions.get(transcriptKey);
  
  if (lastProcessed && (now - lastProcessed) < 5000) {  // Increased from 3s to 5s
    console.log(`🔄 Duplicate transcription detected (processed ${((now - lastProcessed) / 1000).toFixed(1)}s ago) - SKIPPING`);
    // Log as duplicate but don't process
    conversationService.addMessage(
      callControlId, 
      'Lead', 
      `[Duplicate] ${transcript}`
    );
    return;  // ✅ Stop here - don't process voicemail detection, OpenAI, or speak
  }
  
  // ⭐ CRITICAL: Mark this transcription as "seen" IMMEDIATELY to prevent race conditions
  // This includes transcriptions that will be ignored (during AI speech) - we mark them
  // so they won't be processed later if they arrive again after AI finishes speaking
  // Mark BEFORE voicemail detection to prevent duplicate voicemail processing
  recentTranscriptions.set(transcriptKey, now);
  
  // Clean up old transcriptions (older than 10 seconds)
  for (const [key, timestamp] of recentTranscriptions.entries()) {
    if (now - timestamp > 10000) {
      recentTranscriptions.delete(key);
    }
  }

  // Log ALL transcriptions to conversation history, even during AI speech/generation
  // But only PROCESS them when AI is not speaking or generating
  // 🔍 CRITICAL FIX FOR CONCURRENT CALLS: Check if speech has actually ended (time-based check)
  // During concurrent calls, setTimeout might not fire in time, so we check expectedEndTime
  let isSpeaking = false;
  let speakingState = null;
  
  if (speakingCalls.has(callControlId)) {
    speakingState = speakingCalls.get(callControlId);
    const isGenerating = speakingState && speakingState.generating;
    
    // ⭐ CRITICAL FIX: Check if actual audio duration has passed (ignoring buffer)
    // This allows responses immediately after audio finishes playing, not after buffer expires
    if (speakingState.actualDurationMs && speakingState.audioSentTime && !isGenerating) {
      const timeSinceAudioSent = Date.now() - speakingState.audioSentTime;
      if (timeSinceAudioSent >= speakingState.actualDurationMs) {
        // Actual audio duration has passed - audio should have finished playing
        console.log(`   ⏰ Actual audio duration passed (${(timeSinceAudioSent/1000).toFixed(2)}s since sent, ${(speakingState.actualDurationMs/1000).toFixed(2)}s duration) - allowing response`);
        speakingCalls.delete(callControlId);
        isSpeaking = false; // Allow transcription to be processed
      } else {
        // ⭐ AGGRESSIVE: Allow responses when we're past 60% of audio duration (audio is mostly done)
        // This prevents false overlapping detection when user responds near the end of AI speech
        // 🔧 FIX: Reduced threshold from 70% to 60% to allow responses sooner
        const audioProgress = timeSinceAudioSent / speakingState.actualDurationMs;
        const timeUntilAudioEnds = speakingState.actualDurationMs - timeSinceAudioSent;
        
        if (audioProgress >= 0.6 || timeUntilAudioEnds <= 1500) {
          // Past 60% of audio OR within 1.5 seconds of ending - allow response
          console.log(`   ⏰ Audio ${(audioProgress * 100).toFixed(0)}% complete (${timeUntilAudioEnds.toFixed(0)}ms remaining) - allowing response early`);
          isSpeaking = false; // Allow transcription to be processed
        } else {
          isSpeaking = true;
        }
      }
    } else if (speakingState.expectedEndTime && Date.now() >= speakingState.expectedEndTime) {
      // Speech should have ended but speakingCalls wasn't cleared (setTimeout didn't fire in time)
      const timeSinceExpectedEnd = Date.now() - speakingState.expectedEndTime;
      console.log(`   ⏰ Speech expected end time passed (${timeSinceExpectedEnd}ms ago) - clearing speaking state (concurrent call fix)`);
      speakingCalls.delete(callControlId);
      isSpeaking = false; // Allow transcription to be processed
    } else if (speakingState.expectedEndTime && !isGenerating) {
      // ⭐ FIX: Increase threshold significantly to allow responses much sooner
      // This handles cases where audio finished playing but setTimeout hasn't fired yet
      // Since we use actual duration from PCMU buffer, we can be more aggressive
      const timeUntilExpectedEnd = speakingState.expectedEndTime - Date.now();
      if (timeUntilExpectedEnd <= 4000) { // ⭐ INCREASED to 4000ms (4 seconds before expected end) - very aggressive
        console.log(`   ⏰ Close to expected end time (${timeUntilExpectedEnd}ms remaining) - allowing response to prevent false overlapping detection`);
        isSpeaking = false; // Allow transcription to be processed
      } else {
        isSpeaking = true;
      }
    } else {
      isSpeaking = true;
    }
  }
  
  if (isSpeaking) {
    const isGenerating = speakingState && speakingState.generating;
    
    // 🔧 FIX: Allow short affirmative responses during AI speech if AI just asked for transfer confirmation
    // This fixes the issue where user says "yes" to transfer but it gets ignored as overlapping speech
    const conversationState = openaiService.getConversationState(callControlId);
    if (conversationState && !isGenerating) {
      // Check if last AI message was asking for transfer confirmation
      const lastAIMessage = [...conversationState.messages].reverse().find(m => m.role === 'assistant');
      const lastAIText = (lastAIMessage?.content || '').toLowerCase();
      
      // Check if AI was asking for transfer confirmation
      const isTransferQuestion = lastAIText.includes('sound good') || 
                                 lastAIText.includes('get you connected') ||
                                 lastAIText.includes('transfer') ||
                                 lastAIText.includes('connect you') ||
                                 lastAIText.includes('licensed agent');
      
      // Check if user response is a short affirmative
      const transcriptLower = transcript.toLowerCase().trim();
      const shortAffirmatives = ['yes', 'yeah', 'yep', 'yup', 'yess', 'yea', 'okay', 'ok', 'sure', 'sounds good', 'sounds great'];
      const isShortAffirmative = shortAffirmatives.some(aff => transcriptLower === aff || transcriptLower.startsWith(aff + ' ') || transcriptLower.startsWith(aff + '.'));
      
      if (isTransferQuestion && isShortAffirmative) {
        console.log(`✅ Allowing transfer confirmation during AI speech: "${transcript}"`);
        console.log(`   Last AI message was asking for transfer confirmation`);
        // Clear speaking state so we can process this response
        speakingCalls.delete(callControlId);
        // Note: bidirectionalTTS might still be speaking, but we allow this special case
        // Continue processing below (don't return here)
      } else {
        if (isGenerating) {
          console.log(`⏸️  User spoke while AI is generating response - logging but ignoring`);
        } else {
          console.log(`⏸️  User spoke during AI speech - logging but ignoring`);
        }
        
        // ✨ IMPORTANT: Clear no-response timer if user responds during AI speech (including warning)
        // This handles the case where user responds during the warning message
        clearNoResponseTimer(callControlId);
        
        // ⭐ CRITICAL FIX: Track that user attempted to respond (even if overlapping)
        // This prevents no-response timer from hanging up when user tried to respond during AI speech
        const conversation = conversationService.activeConversations?.get?.(callControlId);
        if (conversation) {
          conversation.lastUserAttemptTime = Date.now(); // Track user attempt
          conversation.userAttemptedResponse = true; // Mark that user tried to respond
          console.log(`✅ User attempted to respond during AI speech - tracking attempt to prevent false hangup`);
        }
        
        // Silence detection removed
        
        // ⚠️ CRITICAL: Check for voicemail/IVR keywords even during AI speech
        // This is our fallback when AMD returns "not_sure"
        const voicemailKeywords = [
          // Core voicemail phrases
          'voicemail', 'voice mail', 'mailbox', 'mailbox is full', 'mailbox full',
          'box is full', 'box full', 'voicemail box is full', 'voicemail box full',
          'not enough space', 'not enough space to leave', 'not enough space to leave a message',
          'cannot leave a message', 'unable to leave a message', 'cannot accept messages',
          'mailbox capacity reached', 'mailbox storage full', 'storage full',
          'leave a message', 'leaving a message', 'leave me a message', 'please leave your message', 'please leave your message for',
          'after the beep', 'at the tone', 'after the tone',
          'record your message', 'record your message after the tone', 'record your message after the beep',
          'record your name', 'when you have finished recording',
          'you may hang up', 'not available', 'please leave a message',
          'cannot be reached', 'this person cannot be reached', 'person cannot be reached',
          'cannot be reached at the moment', 'this person cannot be reached at the moment',
          'person cannot be reached at the moment', 'is not available at the moment',
          'not accepting your call', 'not accepting calls', 'is not accepting your call',
          'number is not accepting', 'not accepting', 'the number you are calling is not accepting',
          'can i take a message', 'can take a message', 'take a message', 'i can take a message',
          'reason for calling', 'name and reason for calling', 'record your name and reason for calling',
          'see if this person is available', 'see if person is available', 'i\'ll see if this person is available',
          'i\'ll see if person is available',
          'forwarded to an automated voice messaging system', 'automated voice messaging system',
          'forwarded to an automatic voice message system', 'automatic voice message system',
          'have been forwarded to an automatic voice message system', 'have been forwarded to an automatic voice messaging system',
          'voice messaging system', 'voice message system', 'voice messaging', 'voice message',
          'forwarded to automated', 'forwarded to automatic',
          'you\'ve reached', 'you have reached', 'reaching',
          'return your call', 'return your follow-up',
          'i will return your call', 'i will return your follow-up', 'as soon as possible',
          'no answer', 'if you get a no answer', 'if you\'d get a no answer',
          'call my home number', 'call my', 'home number', 'call my number',
          
          // Personal voicemail greetings
          'not at the phone', "i'm not at the phone", "i am not at the phone",
          "can't come to the phone", "cannot come to the phone", "i can't come to the phone",
          "can't get to the phone", "cannot get to the phone", "i can't get to the phone", "can't get to the phone right now",
          "can't answer", "cannot answer", "i can't answer", "can't answer it now",
          "can't take your call", "cannot take your call", "i can't take your call", "can't take your call now",
          "unable to answer", "unable to answer the phone", "i'm unable to answer", "i'm unable to answer the phone",
          "couldn't answer", "could not answer", "i couldn't answer", "sorry i couldn't answer",
          "sorry i couldn't answer your call", "i couldn't answer your call", "couldn't answer your call",
          "sorry, i couldn't answer your call", "sorry couldn't answer your call",
          "do not answer", "don't answer", "i do not answer", "i don't answer",
          "please text me", "text me", "please text",
          "ringer is turned off", "ringer turned off", "my ringer is off", "ringer is off",
          "i'll get back to you", "get back to you", "get back with you", "will get back",
          "i'll call you back", "call you back", "call you right back", "i'll call you right back",
          "return your call", "return your follow-up", "i will return your call", "i will return your follow-up",
          "leave your name", "brief message", "leave a brief message",
          "i will get back", "get back to you shortly", "get back with you shortly",
          "as soon as i can", "as soon as possible", "i'll get back", "get back to you as soon",
          "unable to hang", "can't hang", "cannot hang", "i'm unable to hang", "i can't hang",
          "give me a call", "give me a call when", "call when you can", "when you can",
          "call me when you can", "call me back when you can", "give me a call back",
          "leave your message and phone number", "leave your message and phone", "message and phone number",
          "phone number for", "leave a message and phone number", "leave a message and phone",
          "leave your phone number", "leave your phone number and", "leave your number",
          "leave your message", "leave a message", "leave me a message", "leave message",
          "leave message and", "leave message and phone", "leave message and number",
          "i will call you", "i'll call you", "will call you",
          
          // Setup/configuration messages
          'not been set up', 'has not been set up', 'hasn\'t been set up',
          'has a voicemail', 'reached a voicemail', 'reached the voicemail',
          
          // Retry messages
          'try your call again', 'try again later', 'please try again',
          'call again later', 'try back later',
          
          // Call completion errors
          'cannot be completed', 'cannot complete your call', 'could not be completed',
          'unable to complete', 'cannot complete the call',
          'cannot be dialed', 'number you requested cannot be dialed', 'number cannot be dialed',
          'sorry, the number you requested cannot be dialed', 'the number you requested cannot be dialed',
          'number you requested', 'cannot be dialed', 'requested cannot be dialed',
          
          // Person/number references
          'person you are calling', 'person you have reached', 'person you\'re calling',
          'person you dialed', 'person you have dialed', 'the person you dialed',
          'person you\'re trying to reach', 'person you are trying to reach', 'trying to reach',
          'number you have reached', 'number you have dialed', 'number you dialed',
          'subscriber', 'customer you are calling', 'party you have reached',
          'will be connected', 'will be connected to', 'connected to the person',
          
          // Recording/answering service messages
          'recording this call', 'recording the call', 'recording for the person',
          
          // IVR menu options
          'to re-record', 'press 1', 'press 2', 'press 3', 'press 4', 'press 5', 'press 6', 'press 7',
          'press pound', 'press star', 'delivery options', 'to continue', 'to delete', 'for more options',
          'to send an sms', 'sms notification', 'send an sms',
          
          // Spanish voicemail phrases
          'buzón de voz', 'buzón de voz la persona', 'envió al buzón', 'enviado al buzón',
          'buzón de mensajes', 'correo de voz', 'mensaje de voz', 'deje un mensaje',
          'deje su mensaje', 'deje su nombre', 'deje su número', 'deje su teléfono',
          'después del tono', 'después de la señal', 'al oír la señal',
          'grabar su mensaje', 'grabe su mensaje', 'grabe su nombre',
          'no disponible', 'no está disponible', 'no puedo contestar',
          'no puedo atender', 'no puedo atender su llamada', 'no puedo contestar su llamada',
          'le devolveré la llamada', 'te devolveré la llamada', 'volveré a llamar',
          'llamada no contestada', 'no contesta', 'no contesta el teléfono',
          'ha llegado a', 'ha marcado', 'la persona que marcó',
          'persona que está llamando', 'persona que ha marcado', 'persona que marcó',
          'presione 1', 'presione 2', 'presione 3', 'presione 4', 'presione 5',
          'oprima 1', 'oprima 2', 'oprima 3', 'oprima 4', 'oprima 5',
          'mensaje completo', 'buzón lleno', 'buzón de mensajes lleno',
          'no se puede completar', 'no se pudo completar', 'llamada no completada',
          
          // Portuguese voicemail phrases
          'caixa postal', 'caixa de mensagens', 'correio de voz', 'mensagem de voz',
          'deixe uma mensagem', 'deixe seu recado', 'deixe seu nome', 'deixe seu número',
          'deixe seu telefone', 'após o sinal', 'após o toque', 'ao ouvir o sinal',
          'grave sua mensagem', 'gravar mensagem', 'grave seu nome',
          'não disponível', 'não estou disponível', 'não posso atender',
          'não posso atender sua ligação', 'não posso atender o telefone',
          'vou retornar sua ligação', 'vou te retornar', 'vou ligar de volta',
          'ligação não atendida', 'não atende', 'não atende o telefone',
          'você ligou para', 'você discou', 'a pessoa que discou',
          'pessoa que está ligando', 'pessoa que ligou', 'pessoa que discou',
          'pressione 1', 'pressione 2', 'pressione 3', 'pressione 4', 'pressione 5',
          'aperte 1', 'aperte 2', 'aperte 3', 'aperte 4', 'aperte 5',
          'caixa cheia', 'caixa postal cheia', 'mensagem completa',
          'não pode ser completada', 'não foi possível completar', 'ligação não completada',
          
          // French voicemail phrases
          'boîte vocale', 'messagerie vocale', 'répondeur', 'répondeur automatique',
          'laissez un message', 'laissez votre message', 'laissez votre nom', 'laissez votre numéro',
          'laissez votre téléphone', 'après le signal', 'après le bip', 'au signal sonore',
          'enregistrez votre message', 'enregistrer un message', 'enregistrez votre nom',
          'non disponible', 'je ne suis pas disponible', 'je ne peux pas répondre',
          'je ne peux pas répondre à votre appel', 'je ne peux pas décrocher',
          'je vous rappellerai', 'je vais vous rappeler', 'je vais rappeler',
          'appel non répondu', 'ne répond pas', 'ne répond pas au téléphone',
          'vous avez appelé', 'vous avez composé', 'la personne que vous avez appelée',
          'personne que vous appelez', 'personne qui a appelé', 'personne qui a composé',
          'appuyez sur 1', 'appuyez sur 2', 'appuyez sur 3', 'appuyez sur 4', 'appuyez sur 5',
          'tapez 1', 'tapez 2', 'tapez 3', 'tapez 4', 'tapez 5',
          'boîte pleine', 'messagerie pleine', 'message complet',
          'ne peut pas être complété', 'n\'a pas pu être complété', 'appel non complété',
          
          // German voicemail phrases
          'mailbox', 'ansagebox', 'sprachbox', 'sprachnachricht',
          'hinterlassen sie eine nachricht', 'hinterlassen sie ihre nachricht', 'hinterlassen sie ihren namen',
          'hinterlassen sie ihre nummer', 'hinterlassen sie ihre telefonnummer',
          'nach dem ton', 'nach dem signal', 'beim ertönen des signals',
          'sprechen sie ihre nachricht', 'sprechen sie nach dem ton', 'sprechen sie ihren namen',
          'nicht verfügbar', 'nicht erreichbar', 'ich bin nicht verfügbar', 'ich kann nicht rangehen',
          'ich kann nicht ans telefon gehen', 'ich kann nicht abheben',
          'ich rufe zurück', 'ich werde zurückrufen', 'ich werde sie zurückrufen',
          'anruf nicht beantwortet', 'geht nicht ran', 'geht nicht ans telefon',
          'sie haben angerufen', 'sie haben gewählt', 'die person die angerufen hat',
          'person die anruft', 'person die angerufen hat', 'person die gewählt hat',
          'drücken sie 1', 'drücken sie 2', 'drücken sie 3', 'drücken sie 4', 'drücken sie 5',
          'taste 1', 'taste 2', 'taste 3', 'taste 4', 'taste 5',
          'mailbox voll', 'ansagebox voll', 'nachricht voll',
          'kann nicht abgeschlossen werden', 'konnte nicht abgeschlossen werden', 'anruf nicht abgeschlossen'
        ];
    
    const transcriptLower = transcript.toLowerCase();
    const matchedKeywords = voicemailKeywords.filter(keyword => transcriptLower.includes(keyword));
    
    // Require at least 1 voicemail keyword (changed from 2 to match normal processing)
    if (matchedKeywords.length >= 1) {
      console.log(`🤖 Voicemail detected during AI speech!`);
      console.log(`   Matched ${matchedKeywords.length} keywords: ${matchedKeywords.join(', ')}`);
      console.log(`   Hanging up immediately to save costs`);
      
      // Silence detection removed
      
      conversationService.addMessage(
        callControlId, 
        'Lead', 
        `[Voicemail detected] ${transcript}`
      );
      
      try {
        await telnyxService.hangupCall(callControlId);
        conversationService.addMessage(
          callControlId, 
          'AI', 
          '[Auto-hangup: Voicemail system detected during AI speech]'
        );
        
        // Broadcast voicemail detection to frontend
        broadcast({
          type: 'call_event',
          event: 'voicemail_detected_fallback',
          callControlId,
          keywords: matchedKeywords,
          timestamp: Date.now()
        });
      } catch (error) {
        console.error('Error hanging up voicemail call:', error);
      }
      
      return;
    }
    
        // ⭐ FIX: Just log and ignore - don't process overlapping speech
        // Note: Overlapping speech can be legitimate (user speaking during AI speech) - don't auto-hangup
        // ⚠️ REMOVED: Incorrect voicemail detection based on overlapping message count
        // Overlapping speech is NOT a reliable indicator of voicemail - users may speak during AI speech
        // Voicemail should only be detected via:
        // 1. Explicit voicemail keywords in transcriptions
        // 2. AMD (Answering Machine Detection) results
        // 3. NOT based on overlapping message patterns
        conversationService.addMessage(
          callControlId, 
          'Lead', 
          `[Overlapping speech - ignored] ${transcript}`
        );
        
        // ⭐ CRITICAL FIX: Track that user attempted to respond (even if overlapping)
        // This prevents no-response timer from hanging up when user tried to respond during AI speech
        const conversationForTracking = conversationService.activeConversations?.get?.(callControlId);
        if (conversationForTracking) {
          conversationForTracking.lastUserAttemptTime = Date.now(); // Track user attempt
          conversationForTracking.userAttemptedResponse = true; // Mark that user tried to respond
          console.log(`✅ User attempted to respond during AI speech - tracking attempt to prevent false hangup`);
        }
        
        return; // Ignore this transcription completely
      }
    } else {
      // No conversation state or AI is generating - always ignore
      if (isGenerating) {
        console.log(`⏸️  User spoke while AI is generating response - logging but ignoring`);
      } else {
        console.log(`⏸️  User spoke during AI speech - logging but ignoring`);
      }
      
      clearNoResponseTimer(callControlId);
      
      // ⚠️ CRITICAL: Check for voicemail/IVR keywords even during AI speech
      // This is our fallback when AMD returns "not_sure"
      const transcriptLower = transcript.toLowerCase();
      const voicemailKeywords = [
        // Core voicemail phrases
        'voicemail', 'voice mail', 'mailbox', 'mailbox is full', 'mailbox full',
        'leave a message', 'leave me a message', 'please leave your message', 'please leave your message for',
        'after the beep', 'at the tone', 'after the tone',
        'record your message', 'record your message after the tone', 'record your message after the beep',
        'record your name', 'when you have finished recording',
        'you may hang up', 'not available', 'please leave a message',
        'can i take a message', 'can take a message', 'take a message', 'i can take a message',
        'reason for calling', 'name and reason for calling', 'record your name and reason for calling',
        'see if this person is available', 'see if person is available', 'i\'ll see if this person is available',
        'i\'ll see if person is available',
        'forwarded to an automated voice messaging system', 'automated voice messaging system',
        'forwarded to an automatic voice message system', 'automatic voice message system',
        'have been forwarded to an automatic voice message system', 'have been forwarded to an automatic voice messaging system',
        'voice messaging system', 'voice message system', 'voice messaging', 'voice message',
        'forwarded to automated', 'forwarded to automatic',
        'you\'ve reached', 'you have reached', 'reaching',
        'return your call', 'return your follow-up',
        'i will return your call', 'i will return your follow-up', 'as soon as possible',
        'no answer', 'if you get a no answer', 'if you\'d get a no answer',
        'call my home number', 'call my', 'home number', 'call my number',
        // Personal voicemail greetings
        'not at the phone', "i'm not at the phone", "i am not at the phone",
        "can't come to the phone", "cannot come to the phone", "i can't come to the phone",
        "can't get to the phone", "cannot get to the phone", "i can't get to the phone", "can't get to the phone right now",
        "can't answer", "cannot answer", "i can't answer", "can't answer it now",
        "can't take your call", "cannot take your call", "i can't take your call", "can't take your call now",
        "unable to answer", "unable to answer the phone", "i'm unable to answer", "i'm unable to answer the phone",
        "do not answer", "don't answer", "i do not answer", "i don't answer",
        "please text me", "text me", "please text",
        "ringer is turned off", "ringer turned off", "my ringer is off", "ringer is off",
        "i'll get back to you", "get back to you", "get back with you", "will get back",
        "i'll call you back", "call you back", "call you right back", "i'll call you right back",
        "return your call", "return your follow-up", "i will return your call", "i will return your follow-up",
        "leave your name", "brief message", "leave a brief message",
        "i will get back", "get back to you shortly", "get back with you shortly",
        "as soon as i can", "as soon as possible", "i'll get back", "get back to you as soon",
        "unable to hang", "can't hang", "cannot hang", "i'm unable to hang", "i can't hang",
        "give me a call", "give me a call when", "call when you can", "when you can",
        "call me when you can", "call me back when you can", "give me a call back",
        "leave your message and phone number", "leave your message and phone", "message and phone number",
        "phone number for", "leave a message and phone number", "leave a message and phone",
        "leave your message", "leave a message", "leave me a message", "leave message",
        "leave message and", "leave message and phone", "leave message and number",
        // Setup/configuration messages
        'not been set up', 'has not been set up', 'hasn\'t been set up',
        'has a voicemail', 'reached a voicemail', 'reached the voicemail',
        // Retry messages
        'try your call again', 'try again later', 'please try again',
        'call again later', 'try back later',
        // Call completion errors
        'cannot be completed', 'cannot complete your call', 'could not be completed',
        'unable to complete', 'cannot complete the call',
        // Person/number references
        'person you are calling', 'person you have reached', 'person you\'re calling',
        'person you dialed', 'person you have dialed', 'the person you dialed',
        'person you\'re trying to reach', 'person you are trying to reach', 'trying to reach',
        'number you have reached', 'number you have dialed', 'number you dialed',
        'subscriber', 'customer you are calling', 'party you have reached',
        'will be connected', 'will be connected to', 'connected to the person',
        // Recording/answering service messages
        'recording this call', 'recording the call', 'recording for the person',
        // IVR menu options
        'to re-record', 'press 1', 'press 2', 'press 3', 'press 4', 'press 5', 'press 6', 'press 7',
        'press pound', 'press star', 'delivery options', 'to continue', 'to delete', 'for more options',
        'to send an sms', 'sms notification', 'send an sms'
      ];
      
      const matchedKeywords = voicemailKeywords.filter(keyword => transcriptLower.includes(keyword));
      
      if (matchedKeywords.length >= 1) {
        console.log(`🤖 Voicemail detected during AI speech!`);
        console.log(`   Matched ${matchedKeywords.length} keywords: ${matchedKeywords.join(', ')}`);
        console.log(`   Hanging up immediately to save costs`);
        
        conversationService.addMessage(
          callControlId, 
          'Lead', 
          `[Voicemail detected] ${transcript}`
        );
        
        try {
          await telnyxService.hangupCall(callControlId);
          conversationService.addMessage(
            callControlId, 
            'AI', 
            '[Auto-hangup: Voicemail system detected during AI speech]'
          );
          
          broadcast({
            type: 'call_event',
            event: 'voicemail_detected_fallback',
            callControlId,
            keywords: matchedKeywords,
            timestamp: Date.now()
          });
        } catch (error) {
          console.error('Error hanging up voicemail call:', error);
        }
        
        return;
      }
      
      // Just log and ignore - don't process overlapping speech
      // Note: Overlapping speech can be legitimate (user speaking during AI speech) - don't auto-hangup
      conversationService.addMessage(
        callControlId, 
        'Lead', 
        `[Overlapping speech - ignored] ${transcript}`
      );
      
      // ⭐ CRITICAL FIX: Track that user attempted to respond (even if overlapping)
      // This prevents no-response timer from hanging up when user tried to respond during AI speech
      const conversationForTracking2 = conversationService.activeConversations?.get?.(callControlId);
      if (conversationForTracking2) {
        conversationForTracking2.lastUserAttemptTime = Date.now(); // Track user attempt
        conversationForTracking2.userAttemptedResponse = true; // Mark that user tried to respond
        console.log(`✅ User attempted to respond during AI speech - tracking attempt to prevent false hangup`);
      }
      
      // 🔥 NEW: Check for voicemail immediately after user answers (pattern-based, not time-based)
      // If we see multiple overlapping messages with no real user responses, likely voicemail
      const conversation = conversationService.activeConversations?.get?.(callControlId);
      if (conversation) {
        const callStartTime = callStartTimes.get(callControlId);
        if (callStartTime) {
          // Only check after user has answered (callStartTime is set)
          const messages = conversation.messages || [];
          
          // ⚠️ REMOVED: Incorrect voicemail detection based on overlapping message count
          // This logic was incorrectly marking legitimate calls as voicemail
          // Overlapping speech is NOT a reliable indicator of voicemail
          // Voicemail detection should only happen via explicit keywords or AMD results
        }
      }
      
      return; // Ignore this transcription completely
    }
  }

  // Check if this is an active conversation (has conversation state)
  const conversationState = openaiService.getConversationState(callControlId);
  
  // ALWAYS check for voicemail keywords on every transcription (STT-based detection)
  // Use existing transcriptLower defined at the top of the function
  const voicemailKeywords = [
    'voicemail', 'voice mail', 'mailbox', 'mailbox is full', 'mailbox full',
    'leave a message', 'leave me a message', 'please leave your message', 'please leave your message for',
    'after the beep', 'at the tone', 'after the tone',
    'record your message', 'record your message after the tone', 'record your message after the beep',
    'record your name', 'not available', 'please leave',
    'can i take a message', 'can take a message', 'take a message', 'i can take a message',
    'reason for calling', 'name and reason for calling', 'record your name and reason for calling',
    'see if this person is available', 'see if person is available', 'i\'ll see if this person is available',
    'i\'ll see if person is available',
    'forwarded to an automated voice messaging system', 'automated voice messaging system',
    'forwarded to an automatic voice message system', 'automatic voice message system',
    'have been forwarded to an automatic voice message system', 'have been forwarded to an automatic voice messaging system',
    'voice messaging system', 'voice message system', 'voice messaging', 'voice message',
    'forwarded to automated', 'forwarded to automatic', 'message', 'messaging',
    'you\'ve reached', 'you have reached', 'reaching',
    'return your call', 'return your follow-up',
    'i will return your call', 'i will return your follow-up', 'as soon as possible',
    'no answer', 'if you get a no answer', 'if you\'d get a no answer',
    'call my home number', 'call my', 'home number', 'call my number',
    'press 1', 'press 2', 'press 3', 'press 4', 'press 5', 'press 6', 'press 7',
    'press pound', 'press star', 'to send an sms', 'sms notification', 'send an sms',
    'has not been set up', 'try your call again', 'cannot be completed',
    'person you are calling', 'person you dialed', 'person you have dialed', 'the person you dialed',
    'person you\'re trying to reach', 'person you are trying to reach', 'trying to reach',
    'number you have reached', 'subscriber',
    'will be connected', 'will be connected to', 'connected to the person',
    'recording this call', 'recording the call', 'recording for the person',
    // Personal voicemail greetings
    'not at the phone', "i'm not at the phone", "i am not at the phone",
    "can't come to the phone", "cannot come to the phone", "i can't come to the phone",
    "can't get to the phone", "cannot get to the phone", "i can't get to the phone", "can't get to the phone right now",
    "can't answer", "cannot answer", "i can't answer", "can't answer it now",
    "can't take your call", "cannot take your call", "i can't take your call", "can't take your call now",
    "unable to answer", "unable to answer the phone", "i'm unable to answer", "i'm unable to answer the phone",
    "do not answer", "don't answer", "i do not answer", "i don't answer",
    "please text me", "text me", "please text",
    "ringer is turned off", "ringer turned off", "my ringer is off", "ringer is off",
    "i'll get back to you", "get back to you", "get back with you", "will get back",
    "i'll call you back", "call you back", "call you right back", "i'll call you right back",
    "return your call", "return your follow-up", "i will return your call", "i will return your follow-up",
    "leave your name", "brief message", "leave a brief message",
    "i will get back", "get back to you shortly", "get back with you shortly",
    "as soon as i can", "as soon as possible", "i'll get back", "get back to you as soon",
    "unable to hang", "can't hang", "cannot hang", "i'm unable to hang", "i can't hang",
    "give me a call", "give me a call when", "call when you can", "when you can",
    "call me when you can", "call me back when you can", "give me a call back",
    "leave your message and phone number", "leave your message and phone", "message and phone number",
    "phone number for", "leave a message and phone number", "leave a message and phone",
    "leave your message", "leave a message", "leave me a message", "leave message",
    "leave message and", "leave message and phone", "leave message and number"
  ];
  
  const matchedKeywords = voicemailKeywords.filter(kw => transcriptLower.includes(kw));
  
  if (matchedKeywords.length >= 1) {
    // 🔍 CRITICAL FIX: Check if call is already finalized to prevent duplicate processing during concurrent calls
    const conversation = conversationService.activeConversations?.get?.(callControlId);
    if (!conversation) {
      console.log(`⚠️  Voicemail detected but conversation already finalized for ${callControlId} - skipping`);
      return;
    }
    
    // VOICEMAIL DETECTED! Hang up immediately
    console.log(`🤖 Voicemail detected from transcription`);
    console.log(`   Matched ${matchedKeywords.length} keyword(s): ${matchedKeywords.join(', ')}`);
    console.log(`   💰 Hanging up to save costs`);
    
    conversationService.addMessage(
      callControlId, 
      'Lead', 
      `[Voicemail detected] ${transcript}`
    );
    
    try {
      stopSilenceDetection(callControlId);
      await telnyxService.hangupCall(callControlId);
      conversationService.addMessage(
        callControlId, 
        'AI', 
        '[Auto-hangup: Voicemail system detected]'
      );
      
      // Mark as voicemail for tracking
      amdResults.set(callControlId, { result: 'machine', timestamp: Date.now() });
      
      // Calculate cost and finalize
      await new Promise(resolve => setTimeout(resolve, 100));
      const finalCost = await costTracking.finalizeCallCost(callControlId, false);
      await conversationService.finalizeConversation(callControlId, finalCost, false, 'voicemail');
      
      // Broadcast voicemail detection to frontend
      broadcast({
        type: 'call_event',
        event: 'voicemail_detected',
        callControlId,
        keywords: matchedKeywords,
        timestamp: Date.now()
      });
      
      return; // Stop processing
    } catch (error) {
      console.error('Error hanging up voicemail call:', error);
    }
  }
  
  // Clear silence timer - user spoke!
  // Don't restart timer yet - it will start AFTER AI finishes speaking
  clearSilenceTimer(callControlId);
  
  // Clear no-response timer - user responded!
  clearNoResponseTimer(callControlId);

  // Filter out background noise and nonsensical transcriptions
  const noisePatterns = [
    /^\([^)]*\)$/,  // Anything in parentheses like "(engine revving)", "(music)", "(background noise)"
    /^[\W_]+$/,     // Only special characters or underscores
    /^[^a-z0-9]{1,3}$/i,  // Very short non-alphanumeric transcripts
  ];
  
  const noiseKeywords = [
    'engine revving',
    'background noise',
    'music playing',
    'static',
    'humming',
    'buzzing',
    'clicking',
    'beeping',
    'ringing',
    'door opening',
    'door closing',
    'car horn',
    'traffic',
    'wind blowing'
  ];
  
  // Check if transcript matches noise patterns
  if (noisePatterns.some(pattern => pattern.test(transcript))) {
    console.log(`🔇 Ignoring noise transcription: "${transcript}"`);
    conversationService.addMessage(
      callControlId, 
      'Lead', 
      `[Filtered: Background noise] ${transcript}`
    );
    return;
  }
  
  // Check if transcript contains noise keywords
  if (noiseKeywords.some(keyword => transcriptLower.includes(keyword))) {
    console.log(`🔇 Ignoring noise transcription: "${transcript}"`);
    conversationService.addMessage(
      callControlId, 
      'Lead', 
      `[Filtered: Background noise] ${transcript}`
    );
    return;
  }
  
  // Filter out very short transcriptions (likely noise or artifacts)
  // BUT: Always accept common short words (even 2-character words like "no")
  // Use existing isCommonShortWord variable defined at the top of the function
  if (transcript.trim().length < 3 && !isCommonShortWord) {
    console.log(`🔇 Ignoring very short transcription: "${transcript}"`);
    return;
  }

  // Filter out IVR/voicemail system prompts
  const ivrKeywords = ['press 1', 'press 2', 'press 3', 'press pound', 'press star', 
                       'to continue', 'to delete', 'delivery options', 'send a fax',
                       're-record', 'leave a message', 'after the beep', 'mailbox'];
  // transcriptLower already declared above for voicemail detection
  
  // If transcript contains multiple IVR keywords, it's likely an automated system
  const ivrMatches = ivrKeywords.filter(keyword => transcriptLower.includes(keyword)).length;
  if (ivrMatches >= 2) {
    console.log(`🤖 Ignoring IVR/voicemail system prompt (${ivrMatches} keywords detected)`);
    return;
  }

  // Filter out very long transcripts (likely IVR menus - real user responses are typically short)
  if (transcript.length > 200) {
    console.log(`📏 Ignoring very long transcript (${transcript.length} chars - likely IVR menu)`);
    return;
  }

  // CRITICAL: Check for explicit hangup/removal requests FIRST (before AI analysis)
  // This ensures 100% consistent detection regardless of AI interpretation
  const hangupKeywords = [
    'hang up',
    'hangup',
    'please hang up',
    'end the call',
    'end call',
    'stop calling',
    'remove me',
    'take me off',
    'unsubscribe',
    'do not call'
  ];
  
  const hasHangupRequest = hangupKeywords.some(keyword => transcriptLower.includes(keyword));
  
  if (hasHangupRequest) {
    console.log(`🛑 Explicit hangup keyword detected in: "${transcript}"`);
    
    try {
      await telnyxService.speak(
        callControlId,
        "I understand. You have a great day, and feel free to reach back out if you change your mind. Take care!"
      );
      
      // Schedule hangup after speech
      pendingHangups.set(callControlId, { type: 'hangup' });
      console.log(`📋 Hangup scheduled after goodbye message`);
      
      return;
    } catch (error) {
      console.error('Error handling hangup request:', error);
      // Try to hang up anyway
      try {
        await telnyxService.hangupCall(callControlId);
      } catch (hangupError) {
        console.error('Failed to hang up:', hangupError);
      }
      return;
    }
  }

  try {
    // Extract fromNumber and userInfo from client_state
    let fromNumber = null;
    let userInfo = null;
    if (event.payload.client_state) {
      try {
        const decoded = Buffer.from(event.payload.client_state, 'base64').toString();
        const state = JSON.parse(decoded);
        fromNumber = state.fromNumber;
        userInfo = state.userInfo;
      } catch (e) {
        console.error('Error decoding client state for transfer:', e);
      }
    }
    
    // ⭐ CRITICAL FIX: Fallback to get fromNumber from conversation service if not in client_state
    if (!fromNumber) {
      const conversation = conversationService.activeConversations?.get?.(callControlId);
      if (conversation && conversation.fromNumber) {
        fromNumber = conversation.fromNumber;
        console.log(`   ✅ Retrieved fromNumber from conversation service: ${fromNumber}`);
      } else {
        // Last resort: Try to get from telnyx_calls table
        try {
          const result = await query(
            `SELECT from_number FROM telnyx_calls WHERE call_control_id = $1`,
            [callControlId]
          );
          if (result.rows.length > 0 && result.rows[0].from_number) {
            fromNumber = result.rows[0].from_number;
            console.log(`   ✅ Retrieved fromNumber from telnyx_calls table: ${fromNumber}`);
          }
        } catch (e) {
          console.error('Error getting fromNumber from telnyx_calls:', e);
        }
      }
    }
    
    if (!fromNumber) {
      console.warn(`   ⚠️  Could not determine fromNumber for transfer - will use fallback in telnyxService`);
    } else {
      console.log(`   ✅ Using fromNumber for transfer: ${fromNumber}`);
    }
    
    // Log user's message to conversation
    conversationService.addMessage(callControlId, 'Lead', transcript);
    
    // ⭐ Clear user attempt flag since we're now processing a valid (non-overlapping) response
    const conversationForValidResponse = conversationService.activeConversations?.get?.(callControlId);
    if (conversationForValidResponse) {
      conversationForValidResponse.userAttemptedResponse = false; // Clear flag - user successfully responded
    }
    
    // Clear no-response timer since user has responded
    const noResponseTimer = noResponseTimers.get(callControlId);
    if (noResponseTimer) {
      clearTimeout(noResponseTimer);
      noResponseTimers.delete(callControlId);
      console.log(`✅ User responded - cleared 1-minute no-response timer`);
    }
    
    // Silence detection removed
    
    // ⭐ CRITICAL FIX: Mark as generating BEFORE calling getNextResponse
    // This blocks transcriptions that come in while AI is generating the response
    speakingCalls.set(callControlId, { startTime: Date.now(), generating: true });
    console.log(`🤖 AI generating response - blocking transcriptions`);
    
    // Track that we're processing this user message
    const processingStartTime = Date.now();
    const conversation = conversationService.activeConversations?.get?.(callControlId);
    if (conversation) {
      conversation.lastUserMessageTime = processingStartTime;
      conversation.pendingAIResponse = true;
    }
    
    let aiResponse;
    try {
      // Get AI response (pass confidence for better handling)
      aiResponse = await openaiService.getNextResponse(callControlId, transcript, confidence);
      console.log(`🤖 AI Response: ${aiResponse.response}`);
      
      // Check if call ended during processing
      const conversationState = openaiService.getConversationState(callControlId);
      if (!conversationState) {
        console.log(`⚠️  Call ended while AI was generating response for: "${transcript}"`);
        // Log that user hung up during AI processing
        conversationService.addMessage(
          callControlId, 
          'System', 
          `[User hung up during AI response generation]`
        );
        
        // Broadcast to frontend
        broadcast({
          type: 'call_event',
          event: 'user_hangup_during_processing',
          callControlId,
          userMessage: transcript,
          timestamp: Date.now()
        });
        
        // Clear generating state
        speakingCalls.delete(callControlId);
        if (conversation) {
          conversation.pendingAIResponse = false;
        }
        return; // Exit early - call has ended
      }
      
      // Log AI's response to conversation
      conversationService.addMessage(callControlId, 'AI', aiResponse.response);
      
      // Clear pending flag
      if (conversation) {
        conversation.pendingAIResponse = false;
      }
    } catch (error) {
      console.error(`❌ Error getting AI response for transcript: "${transcript}"`);
      console.error(`   Error:`, error.message);
      console.error(`   Stack:`, error.stack);
      
      // Check if call ended during error
      const conversationState = openaiService.getConversationState(callControlId);
      if (!conversationState) {
        console.log(`⚠️  Call ended during error handling for: "${transcript}"`);
        conversationService.addMessage(
          callControlId, 
          'System', 
          `[User hung up during AI response generation - error occurred]`
        );
        
        broadcast({
          type: 'call_event',
          event: 'user_hangup_during_processing',
          callControlId,
          userMessage: transcript,
          error: error.message,
          timestamp: Date.now()
        });
      } else {
        // Call is still active but error occurred - log error message
        conversationService.addMessage(
          callControlId, 
          'System', 
          `[Error generating AI response: ${error.message}]`
        );
        
        // Try to continue with a fallback response
        console.log(`⚠️  Attempting to continue call despite error`);
        try {
          // Use a simple fallback response
          const fallbackResponse = "I apologize, I'm having trouble processing that. Could you repeat that?";
          conversationService.addMessage(callControlId, 'AI', fallbackResponse);
          
          // Try to speak the fallback
          const responseStartTime = Date.now();
          const estimatedDurationMs = Math.max(1000, (fallbackResponse.length * 35)); // ⭐ REDUCED: 35ms per character (was 50ms), min 1s (was 2s)
          const waitTime = estimatedDurationMs + 1000; // ⭐ REDUCED: 1 second safety buffer (was 2s)
          const expectedEndTime = responseStartTime + waitTime;
          
          speakingCalls.set(callControlId, { 
            startTime: responseStartTime,
            expectedEndTime: expectedEndTime
          });
          
          await bidirectionalTTS.speak(callControlId, fallbackResponse);
          
          setTimeout(() => {
            if (speakingCalls.has(callControlId)) {
              speakingCalls.delete(callControlId);
            }
          }, waitTime);
          
          // Start no-response timer
          setTimeout(() => {
            const conversationState = openaiService.getConversationState(callControlId);
            if (conversationState && !transferCalls.has(callControlId) && !pendingHangups.has(callControlId)) {
              startNoResponseTimer(callControlId);
            }
          }, waitTime);
        } catch (fallbackError) {
          console.error(`❌ Fallback response also failed:`, fallbackError.message);
        }
      }
      
      // Clear generating state
      speakingCalls.delete(callControlId);
      if (conversation) {
        conversation.pendingAIResponse = false;
      }
      return; // Exit - can't continue without AI response
    }
    
    // Mark user as answered by real person (first time they provide meaningful response)
    if (userInfo && userInfo.phone) {
      await userModel.markUserAnswered(
        userInfo.phone, 
        'answered', 
        aiResponse.stage
      );
    }

    // Speak response using bidirectional streaming
    // ✨ NEW: Use bidirectional TTS for low latency
    
    // Update speaking state (now actually speaking, not generating)
    // 🔍 CRITICAL FIX FOR CONCURRENT CALLS: Store expectedEndTime for time-based checking
    const responseStartTime = Date.now();
    const estimatedDurationMs = Math.max(1000, (aiResponse.response.length * 35)); // ⭐ REDUCED: 35ms per character (was 50ms), min 1s (was 2s)
    const waitTime = estimatedDurationMs + 1000; // ⭐ REDUCED: 1 second safety buffer (was 2s)
    const expectedEndTime = responseStartTime + waitTime;
    
    speakingCalls.set(callControlId, { 
      startTime: responseStartTime,
      expectedEndTime: expectedEndTime
    });
    console.log(`🗣️  AI started speaking (bidirectional TTS, expected to finish at ${new Date(expectedEndTime).toISOString()})`);
    
    // Silence detection removed
    
    try {
      const ttsResult = await bidirectionalTTS.speak(callControlId, aiResponse.response);
      
      // Handle case where TTS was skipped (duplicate request or cancelled)
      if (!ttsResult) {
        console.log(`⚠️  TTS was skipped (duplicate or cancelled) - using fallback duration estimate`);
      }
      
      // ⭐ FIX: Use ACTUAL duration from TTS service instead of text-based estimate
      const actualDurationMs = ttsResult?.actualDurationMs || Math.max(1000, (aiResponse.response.length * 30)); // ⭐ REDUCED: Fallback 30ms/char (was 45ms), min 1s (was 2s)
      const reducedBuffer = 0; // ⭐ REMOVED buffer entirely - actual duration is very accurate, no buffer needed
      const actualWaitTime = actualDurationMs + reducedBuffer;
      const actualExpectedEndTime = Date.now() + actualWaitTime;
      
      console.log(`✅ AI finished sending audio (bidirectional TTS)`);
      console.log(`   📊 ACTUAL audio duration: ${(actualDurationMs/1000).toFixed(2)}s (from PCMU buffer)`);
      console.log(`   ⏱️  Wait time: ${actualWaitTime.toFixed(0)}ms (${(actualDurationMs/1000).toFixed(2)}s audio + ${reducedBuffer}ms buffer)`);
      
      // Update the speaking state with accurate expectedEndTime and actual duration
      if (speakingCalls.has(callControlId)) {
        const currentState = speakingCalls.get(callControlId);
        const audioSentTime = Date.now();
        speakingCalls.set(callControlId, {
          ...currentState,
          expectedEndTime: actualExpectedEndTime,
          actualDurationMs: actualDurationMs, // Store actual duration for early response detection
          audioSentTime: audioSentTime // Store when audio was sent
        });
        console.log(`   ⏰ Updated expected end time: ${new Date(actualExpectedEndTime).toISOString()} (based on ACTUAL audio duration)`);
      }
      
      console.log(`   ⏱️  Will clear speaking state after ${actualWaitTime.toFixed(0)}ms (actual audio playback + reduced buffer)`);
      
      // 🔍 CRITICAL FIX: Clear speakingCalls after audio finishes playing
      // bidirectionalTTS.speak() returns when audio is SENT, not when it finishes PLAYING
      // During concurrent calls, this causes user responses to be blocked even after AI finishes speaking
      setTimeout(() => {
        if (speakingCalls.has(callControlId)) {
          speakingCalls.delete(callControlId);
          console.log(`   ✅ Cleared speaking state after audio playback (${actualWaitTime.toFixed(0)}ms)`);
        }
      }, actualWaitTime);
      
      // Silence detection removed
      
      // Schedule actions to execute after audio finishes playing
      if (aiResponse.shouldTransfer) {
        const transferNumber = agentConfig.transferNumber || process.env.AGENT_TRANSFER_NUMBER;
        if (transferNumber) {
          // ⭐ CRITICAL FIX: Use the SAME DID number that was used to call the user originally
          // This number is already active in the call, so it should work for transfers
          // First try fromNumber from client_state, then fallback to conversation service
          let transferFromNumber = fromNumber; // Use the original DID number from the call
          
          // Fallback: Get fromNumber from conversation service if not available
          if (!transferFromNumber || transferFromNumber === 'auto' || transferFromNumber === null) {
            const conversation = conversationService.activeConversations?.get?.(callControlId);
            if (conversation && conversation.fromNumber) {
              transferFromNumber = conversation.fromNumber;
              console.log(`   ✅ Retrieved fromNumber from conversation service: ${transferFromNumber}`);
            }
          }
          
          // Last resort: Try to get from telnyx_calls table
          if (!transferFromNumber || transferFromNumber === 'auto' || transferFromNumber === null) {
            try {
              const result = await query(
                `SELECT from_number FROM telnyx_calls WHERE call_control_id = $1`,
                [callControlId]
              );
              if (result.rows.length > 0 && result.rows[0].from_number) {
                transferFromNumber = result.rows[0].from_number;
                console.log(`   ✅ Retrieved fromNumber from telnyx_calls table: ${transferFromNumber}`);
              }
            } catch (e) {
              console.error('Error getting fromNumber from telnyx_calls:', e);
            }
          }
          
          // 🔧 FIX: Use actualWaitTime (actual audio duration) instead of waitTime (estimated)
          // This ensures transfer happens AFTER AI finishes speaking, not during
          const transferWaitTime = actualWaitTime; // Use actual audio duration, not estimated
          console.log(`📋 Scheduling transfer after ${transferWaitTime.toFixed(0)}ms (actual audio duration)`);
          console.log(`   Transfer number: ${transferNumber}`);
          console.log(`   From number (original DID): ${transferFromNumber || 'auto (will use original caller ID)'}`);
          console.log(`   Call Control ID: ${callControlId}`);
          if (transferFromNumber && transferFromNumber !== 'auto' && transferFromNumber !== null) {
            console.log(`   ✅ Using same DID number that called the user: ${transferFromNumber} - should work for transfer`);
          } else {
            console.warn(`   ⚠️  WARNING: No fromNumber available - transfer may fail with "Unverified origination number" error`);
          }
          
          // Store transfer details in pendingHangups (for handleSpeakEnded fallback)
          pendingHangups.set(callControlId, {
            type: 'transfer',
            transferNumber,
            fromNumber: transferFromNumber, // Use original DID number
            scheduledAt: Date.now()
          });
          
          // 🔧 FIX: Also store transfer details separately to ensure timeout executes
          // even if handleSpeakEnded clears pendingHangups first
          if (!global.pendingTransfers) {
            global.pendingTransfers = new Map();
          }
          global.pendingTransfers.set(callControlId, {
            transferNumber,
            fromNumber: transferFromNumber, // Use original DID number
            scheduledAt: Date.now()
          });
          
          const transferTimeoutId = setTimeout(async () => {
            console.log(`⏰ Transfer timeout fired for ${callControlId} after ${transferWaitTime.toFixed(0)}ms`);
            
            // Check both maps to see if transfer should execute
            const pendingAction = pendingHangups.get(callControlId);
            const storedTransfer = global.pendingTransfers?.get(callControlId);
            
            // Determine if transfer should proceed
            let shouldExecute = false;
            let transferDetails = null;
            
            if (pendingAction && pendingAction.type === 'transfer') {
              shouldExecute = true;
              transferDetails = {
                transferNumber: pendingAction.transferNumber,
                fromNumber: pendingAction.fromNumber
              };
              console.log(`   ✅ Found transfer in pendingHangups`);
            } else if (storedTransfer) {
              shouldExecute = true;
              transferDetails = storedTransfer;
              console.log(`   ✅ Found transfer in pendingTransfers (pendingHangups was cleared)`);
            } else {
              console.log(`   ⚠️  Transfer details not found - may have been cancelled`);
            }
            
            if (shouldExecute && transferDetails) {
              // ⚠️ CRITICAL: Check if call is still active before attempting transfer
              const conversationState = openaiService.getConversationState(callControlId);
              if (!conversationState) {
                console.log(`⚠️  Call ${callControlId} has already ended - skipping transfer`);
                pendingHangups.delete(callControlId);
                if (global.pendingTransfers) {
                  global.pendingTransfers.delete(callControlId);
                }
                return;
              }
              
              // Clear both maps before executing
              pendingHangups.delete(callControlId);
              if (global.pendingTransfers) {
                global.pendingTransfers.delete(callControlId);
              }
              
              console.log(`📲 EXECUTING TRANSFER NOW:`);
              console.log(`   Call Control ID: ${callControlId}`);
              console.log(`   Transfer to: ${transferDetails.transferNumber}`);
              console.log(`   Using caller ID: ${transferDetails.fromNumber || 'auto'}`);
              
              try {
                const result = await telnyxService.transferCall(
                  callControlId, 
                  transferDetails.transferNumber, 
                  transferDetails.fromNumber
                );
                
                if (result) {
                  console.log(`✅ Transfer initiated successfully!`);
                } else {
                  console.warn('⚠️  Transfer returned null (call may have ended) - attempting hangup as fallback');
                  try {
                    await telnyxService.hangupCall(callControlId);
                  } catch (hangupError) {
                    // Call already ended - this is expected
                    console.log('   Call already ended (expected if user hung up)');
                  }
                }
              } catch (error) {
                // Check if error is because call already ended (expected scenario)
                if (error.response?.data?.errors?.[0]?.code === '90018' || 
                    error.message?.includes('already ended') ||
                    error.message?.includes('90018')) {
                  console.log(`ℹ️  Transfer skipped - call ${callControlId} already ended (user may have hung up)`);
                } else {
                  console.error(`❌ Error transferring call:`, error.message);
                  console.error(`   Full error:`, error);
                  console.log('   Attempting hangup as fallback after failed transfer...');
                  try {
                    await telnyxService.hangupCall(callControlId);
                  } catch (hangupError) {
                    // Call already ended - this is expected
                    console.log('   Call already ended (expected if user hung up)');
                  }
                }
              }
            } else {
              // Transfer was cancelled or call ended
              console.log(`ℹ️  Transfer cancelled for ${callControlId} - pending action was cleared or call ended`);
            }
          }, transferWaitTime);
          
          // Store timeout ID so we can cancel it if call ends early
          if (!global.pendingTransferTimeouts) {
            global.pendingTransferTimeouts = new Map();
          }
          global.pendingTransferTimeouts.set(callControlId, transferTimeoutId);
          console.log(`   ✅ Transfer timeout scheduled (ID: ${transferTimeoutId})`);
        } else {
          console.warn('⚠️  Transfer requested but transfer number not configured - hanging up instead');
          try {
            await telnyxService.hangupCall(callControlId);
          } catch (error) {
            console.error(`❌ Error hanging up call:`, error.message);
          }
        }
      } else if (aiResponse.shouldHangup) {
        console.log(`📋 Scheduling hangup after ${waitTime.toFixed(0)}ms`);
        
        pendingHangups.set(callControlId, { type: 'hangup' });
        
        setTimeout(async () => {
          const pendingAction = pendingHangups.get(callControlId);
          if (pendingAction && pendingAction.type === 'hangup') {
            // Check if call is still active before attempting hangup
            const conversationState = openaiService.getConversationState(callControlId);
            if (!conversationState) {
              console.log(`⚠️  Call ${callControlId} has already ended - skipping scheduled hangup`);
              pendingHangups.delete(callControlId);
              return;
            }
            
            pendingHangups.delete(callControlId);
            console.log(`📵 Executing hangup after AI finished speaking`);
            try {
              await telnyxService.hangupCall(callControlId);
            } catch (error) {
              // Check if error is because call already ended (expected scenario)
              if (error.response?.data?.errors?.[0]?.code === '90018' || 
                  error.message?.includes('already ended') ||
                  error.message?.includes('90018')) {
                console.log(`ℹ️  Hangup skipped - call ${callControlId} already ended`);
              } else {
                console.error(`❌ Error hanging up call:`, error.message);
              }
            }
          } else {
            // Pending action was cleared (likely call ended)
            console.log(`ℹ️  Hangup cancelled for ${callControlId} - pending action was cleared`);
          }
        }, waitTime);
      } else {
      // Start no-response timer after AI speech ends (if not transferring/hanging up)
      // Wait for audio to finish playing before starting the timer
      // Store timeout ID so we can cancel it if call ends early
      // 🔧 FIX: Use waitTime (not estimatedDurationMs) to include safety buffer
      const startTimerTimeout = setTimeout(() => {
        // Check if call is still active before starting timer
        const conversationState = openaiService.getConversationState(callControlId);
        if (!conversationState || transferCalls.has(callControlId) || pendingHangups.has(callControlId)) {
          console.log(`⏸️  Skipping no-response timer start - call ended or has pending action`);
          return;
        }
        console.log(`⏱️  Starting no-response timer now (after ${waitTime.toFixed(0)}ms - audio finished playing)`);
        startNoResponseTimer(callControlId);
      }, waitTime);
      
      // Store timeout ID in timer data so we can cancel it if needed
      const existingTimerData = aiSpeechEndTimers.get(callControlId);
      if (existingTimerData) {
        existingTimerData.startTimerTimeout = startTimerTimeout;
      } else {
        aiSpeechEndTimers.set(callControlId, { startTimerTimeout });
      }
      
      console.log(`⏱️  Will start no-response timer after ${waitTime.toFixed(0)}ms (audio playback + buffer)`);
      }
    } finally {
      // ⚠️ FIX: DO NOT delete speakingCalls here - it's already scheduled to be deleted
      // in the setTimeout on line 1970 after audio finishes playing
      // Deleting it here would clear it too early (when audio is sent, not when it finishes playing)
      // speakingCalls.delete(callControlId); // REMOVED - handled by setTimeout
    }

    // Broadcast to frontend
    broadcast({
      type: 'call_event',
      event: 'transcription',
      callControlId,
      transcript,
      aiResponse: aiResponse.response,
      stage: aiResponse.stage,
      timestamp: Date.now()
    });
  } catch (error) {
    // Handle "Conversation not initialized" gracefully - this happens when server restarts during a call
    if (error.message === 'Conversation not initialized') {
      console.log(`⚠️  Orphaned call detected (${callControlId.slice(0, 20)}...) - conversation was lost due to server restart`);
      console.log(`   Hanging up orphaned call...`);
      try {
        await telnyxService.hangupCall(callControlId);
      } catch (hangupError) {
        // Ignore hangup errors for orphaned calls
      }
    } else {
      console.error('Error processing transcription:', error.message);
    }
  }
}

/**
 * Start silence detection after AI speech ends
 * ⚠️ DISABLED - Silence detection turned off
 */
function startSilenceDetection(callControlId) {
  // Silence detection disabled - no automatic hangups
  console.log(`⏸️  Silence detection DISABLED for ${callControlId.slice(0, 20)}...`);
  return;
  
  /* DISABLED CODE:
  const INITIAL_SILENCE_TIMEOUT = 10000;  // 10 seconds
  const SECOND_SILENCE_TIMEOUT = 5000;     // 5 seconds
  const WARNING_MESSAGE = "I can't hear clearly, so please try again.";
  
  // Clear any existing timeout for this call
  stopSilenceDetection(callControlId);
  
  // ✨ CRITICAL FIX: Create silenceData object FIRST (before setTimeout)
  // This prevents race condition where clearSilenceTimer is called before silenceData exists
  silenceTimeouts.set(callControlId, {
    timer: null,  // Will be set immediately after setTimeout
    lastUserSpeech: Date.now(),
    warningGiven: false,
    waitingForWarningToEnd: false,
    userResponded: false,  // Track if user responded during timer
    userRespondedDuringWarning: false,  // Track if user responded during warning playback
    secondTimeout: SECOND_SILENCE_TIMEOUT,
    warningMessage: WARNING_MESSAGE
  });
  
  // Start the 10-second timer
  const timeout = setTimeout(async () => {
    const silenceData = silenceTimeouts.get(callControlId);
    if (!silenceData) {
      // Timer was cleared (user responded or call ended)
      return;
    }
    
    // Check if user responded during the 10-second wait
    if (silenceData.userResponded) {
      console.log(`✅ User responded during 10-second timer - cancelling warning`);
      // Don't restart timer here - resetSilenceDetection will be called when transcription is processed
      return;
    }
    
    console.log(`⏰ 10 seconds of silence detected - playing warning message`);
    silenceData.warningGiven = true;
    silenceData.waitingForWarningToEnd = true;
    silenceData.userRespondedDuringWarning = false;
    
    // Stop silence detection while playing warning
    clearTimeout(silenceData.timer);
    silenceData.timer = null;
    
    try {
      // Mark call as speaking to ignore transcriptions during warning
      speakingCalls.set(callControlId, { startTime: Date.now() });
      
      // Log warning message to conversation history so it's visible
      conversationService.addMessage(callControlId, 'AI', WARNING_MESSAGE);
      
      // Play warning message using bidirectional TTS
      await bidirectionalTTS.speak(callControlId, WARNING_MESSAGE);
      console.log(`✅ Warning message sent: "${WARNING_MESSAGE}"`);
      
      // Calculate estimated audio playback duration for warning
      // Average speech rate: ~150 words/min = 2.5 words/sec
      // Average word length: ~5 characters, so ~12.5 chars/sec = ~80ms per character
      const estimatedWarningDurationMs = Math.max(1000, (WARNING_MESSAGE.length * 80));
      const warningWaitTime = estimatedWarningDurationMs + 500; // Add 500ms safety buffer
      
      console.log(`   Estimated warning audio duration: ${estimatedWarningDurationMs.toFixed(0)}ms (${WARNING_MESSAGE.length} chars)`);
      console.log(`   Will wait ${warningWaitTime.toFixed(0)}ms before starting 5-second timer`);
      
      // Wait for warning audio to finish playing before starting 5-second timer
      setTimeout(() => {
        // Check if user responded during warning playback
        const currentSilenceData = silenceTimeouts.get(callControlId);
        if (!currentSilenceData) {
          // Timer was cleared (user responded or call ended)
          speakingCalls.delete(callControlId);
          return;
        }
        
        if (currentSilenceData.userRespondedDuringWarning) {
          // User responded during warning - reset timer
          console.log(`✅ User responded during warning - resetting silence timer`);
          currentSilenceData.userRespondedDuringWarning = false;
          currentSilenceData.waitingForWarningToEnd = false;
          speakingCalls.delete(callControlId);
          // Restart the 10-second timer
          resetSilenceDetection(callControlId);
          return;
        }
        
        // Warning finished playing - start the 5-second timer
        currentSilenceData.waitingForWarningToEnd = false;
        console.log(`⏱️  Starting second silence timer (${SECOND_SILENCE_TIMEOUT/1000}s) after warning audio finished`);
        
        const secondTimeout = setTimeout(async () => {
          // Check again if user responded during the 5-second wait
          const finalSilenceData = silenceTimeouts.get(callControlId);
          if (!finalSilenceData) {
            return; // Timer was cleared
          }
          
          if (finalSilenceData.userResponded) {
            console.log(`✅ User responded during 5-second timer - cancelling hangup`);
            finalSilenceData.userResponded = false;
            return;
          }
          
          console.log(`⏰ User still silent after warning - hanging up`);
          try {
            await telnyxService.hangupCall(callControlId);
            conversationService.addMessage(
              callControlId, 
              'AI', 
              '[Auto-hangup: No response after silence warning]'
            );
          } catch (error) {
            console.error('Error hanging up silent call:', error);
          }
          stopSilenceDetection(callControlId);
        }, SECOND_SILENCE_TIMEOUT);
        
        currentSilenceData.timer = secondTimeout;
        speakingCalls.delete(callControlId);
      }, warningWaitTime);
    } catch (error) {
      console.error(`❌ Error playing warning message:`, error);
      // If warning fails, start the 5-second timer immediately (no audio to wait for)
      const currentSilenceData = silenceTimeouts.get(callControlId);
      if (currentSilenceData) {
        currentSilenceData.waitingForWarningToEnd = false;
        speakingCalls.delete(callControlId);
        
        console.log(`⏱️  Starting second silence timer (${SECOND_SILENCE_TIMEOUT/1000}s) after warning failed`);
        
        const secondTimeout = setTimeout(async () => {
          const finalSilenceData = silenceTimeouts.get(callControlId);
          if (!finalSilenceData || finalSilenceData.userResponded) {
            if (finalSilenceData) finalSilenceData.userResponded = false;
            return;
          }
          
          console.log(`⏰ User still silent after warning - hanging up`);
          try {
            await telnyxService.hangupCall(callControlId);
            conversationService.addMessage(
              callControlId, 
              'AI', 
              '[Auto-hangup: No response after silence warning]'
            );
          } catch (error) {
            console.error('Error hanging up silent call:', error);
          }
          stopSilenceDetection(callControlId);
        }, SECOND_SILENCE_TIMEOUT);
        
        currentSilenceData.timer = secondTimeout;
      }
    }
  }, INITIAL_SILENCE_TIMEOUT);
  
  // Store the timeout ID
  const silenceData = silenceTimeouts.get(callControlId);
  if (silenceData) {
    silenceData.timer = timeout;
  }
  
  console.log(`⏱️  Started silence detection timer (${INITIAL_SILENCE_TIMEOUT/1000}s) for ${callControlId.slice(0, 20)}...`);
  */
}

/**
 * Reset silence timer when user speaks
 * ⚠️ DISABLED - Silence detection turned off
 */
function resetSilenceDetection(callControlId) {
  // Silence detection disabled
  return;
  
  /* DISABLED CODE:
  const silenceData = silenceTimeouts.get(callControlId);
  if (!silenceData) {
    // No active silence detection - start it
    startSilenceDetection(callControlId);
    return;
  }
  
  // Mark that user responded
  silenceData.userResponded = true;
  silenceData.userRespondedDuringWarning = false;
  
  // Clear existing timer
  if (silenceData.timer) {
    clearTimeout(silenceData.timer);
    silenceData.timer = null;
  }
  
  // Reset state
  silenceData.warningGiven = false;
  silenceData.waitingForWarningToEnd = false;
  silenceData.lastUserSpeech = Date.now();
  silenceData.userResponded = false;  // Reset for new timer
  
  // Restart the 10-second timer
  const INITIAL_SILENCE_TIMEOUT = 10000;  // 10 seconds
  const timeout = setTimeout(async () => {
    const currentSilenceData = silenceTimeouts.get(callControlId);
    if (!currentSilenceData) {
      return;
    }
    
    if (currentSilenceData.userResponded) {
      console.log(`✅ User responded during 10-second timer - cancelling warning`);
      currentSilenceData.userResponded = false;
      return;
    }
    
    console.log(`⏰ 10 seconds of silence detected - playing warning message`);
    currentSilenceData.warningGiven = true;
    currentSilenceData.waitingForWarningToEnd = true;
    currentSilenceData.userRespondedDuringWarning = false;
    
    clearTimeout(currentSilenceData.timer);
    currentSilenceData.timer = null;
    
    try {
      const warningMessage = currentSilenceData.warningMessage || "I can't hear clearly, so please try again.";
      speakingCalls.set(callControlId, { startTime: Date.now() });
      await bidirectionalTTS.speak(callControlId, warningMessage);
      console.log(`✅ Warning message sent`);
      
      // Calculate estimated audio playback duration for warning
      const estimatedWarningDurationMs = Math.max(1000, (warningMessage.length * 80));
      const warningWaitTime = estimatedWarningDurationMs + 500; // Add 500ms safety buffer
      
      console.log(`   Estimated warning audio duration: ${estimatedWarningDurationMs.toFixed(0)}ms (${warningMessage.length} chars)`);
      console.log(`   Will wait ${warningWaitTime.toFixed(0)}ms before starting 5-second timer`);
      
      // Wait for warning audio to finish playing before starting 5-second timer
      setTimeout(() => {
        // Check if user responded during warning playback
        const updatedSilenceData = silenceTimeouts.get(callControlId);
        if (!updatedSilenceData) {
          speakingCalls.delete(callControlId);
          return;
        }
        
        if (updatedSilenceData.userRespondedDuringWarning) {
          console.log(`✅ User responded during warning - resetting silence timer`);
          updatedSilenceData.userRespondedDuringWarning = false;
          updatedSilenceData.waitingForWarningToEnd = false;
          speakingCalls.delete(callControlId);
          // Restart the 10-second timer
          resetSilenceDetection(callControlId);
          return;
        }
        
        // Warning finished playing - start the 5-second timer
        updatedSilenceData.waitingForWarningToEnd = false;
        console.log(`⏱️  Starting second silence timer (${updatedSilenceData.secondTimeout/1000}s) after warning audio finished`);
        
        const secondTimeout = setTimeout(async () => {
          const finalSilenceData = silenceTimeouts.get(callControlId);
          if (!finalSilenceData || finalSilenceData.userResponded) {
            if (finalSilenceData) finalSilenceData.userResponded = false;
            return;
          }
          
          console.log(`⏰ User still silent after warning - hanging up`);
          try {
            await telnyxService.hangupCall(callControlId);
            conversationService.addMessage(
              callControlId, 
              'AI', 
              '[Auto-hangup: No response after silence warning]'
            );
          } catch (error) {
            console.error('Error hanging up silent call:', error);
          }
          stopSilenceDetection(callControlId);
        }, updatedSilenceData.secondTimeout);
        
        updatedSilenceData.timer = secondTimeout;
        speakingCalls.delete(callControlId);
      }, warningWaitTime);
    } catch (error) {
      console.error(`❌ Error playing warning message:`, error);
      // If warning fails, start the 5-second timer immediately (no audio to wait for)
      const errorSilenceData = silenceTimeouts.get(callControlId);
      if (errorSilenceData) {
        errorSilenceData.waitingForWarningToEnd = false;
        speakingCalls.delete(callControlId);
        
        console.log(`⏱️  Starting second silence timer (${errorSilenceData.secondTimeout/1000}s) after warning failed`);
        
        const secondTimeout = setTimeout(async () => {
          const finalSilenceData = silenceTimeouts.get(callControlId);
          if (!finalSilenceData || finalSilenceData.userResponded) {
            if (finalSilenceData) finalSilenceData.userResponded = false;
            return;
          }
          
          console.log(`⏰ User still silent after warning - hanging up`);
          try {
            await telnyxService.hangupCall(callControlId);
            conversationService.addMessage(
              callControlId, 
              'AI', 
              '[Auto-hangup: No response after silence warning]'
            );
          } catch (error) {
            console.error('Error hanging up silent call:', error);
          }
          stopSilenceDetection(callControlId);
        }, errorSilenceData.secondTimeout);
        
        errorSilenceData.timer = secondTimeout;
      }
    } finally {
      speakingCalls.delete(callControlId);
    }
  }, INITIAL_SILENCE_TIMEOUT);
  
  silenceData.timer = timeout;
  console.log(`🔄 Reset silence detection timer (${INITIAL_SILENCE_TIMEOUT/1000}s) for ${callControlId.slice(0, 20)}...`);
  */
}

/**
 * Clear silence timer when user speaks (without restarting)
 * ⚠️ DISABLED - Silence detection turned off
 */
function clearSilenceTimer(callControlId) {
  // Silence detection disabled
  return;
}

/**
 * Stop silence detection (call ended)
 * ⚠️ DISABLED - Silence detection turned off
 */
function stopSilenceDetection(callControlId) {
  // Silence detection disabled - just cleanup
  const silenceData = silenceTimeouts.get(callControlId);
  if (silenceData) {
    clearTimeout(silenceData.timer);
    silenceTimeouts.delete(callControlId);
  }
  silenceDetectionDisabled.delete(callControlId);
}

/**
 * Start no-response timer after AI speech ends
 * - After 10 seconds: show warning message
 * - After 5 more seconds (15 total): end call
 */
function startNoResponseTimer(callControlId) {
  const INITIAL_TIMEOUT = 10000;  // 10 seconds
  const SECOND_TIMEOUT = 5000;     // 5 seconds
  const WARNING_MESSAGE = "I can't hear you clearly. Please try again.";
  
  console.log(`🔔 startNoResponseTimer called for ${callControlId.slice(0, 20)}...`);
  
  // Clear any existing timer for this call
  clearNoResponseTimer(callControlId);
  
  // ✨ IMPORTANT: Clear the old 1-minute timer when new timer system starts
  // This prevents the old timer from interfering with the new 10s + 5s system
  const oldNoResponseTimer = noResponseTimers.get(callControlId);
  if (oldNoResponseTimer) {
    clearTimeout(oldNoResponseTimer);
    noResponseTimers.delete(callControlId);
    console.log(`🧹 Cleared old 1-minute timer - using new 10s+5s system instead`);
  }
  
  // Skip if call is being transferred or hung up
  if (pendingHangups.has(callControlId)) {
    console.log(`⏸️  Skipping no-response timer - call has pending action`);
    return;
  }
  
  // Skip if call is already ended
  const conversationState = openaiService.getConversationState(callControlId);
  if (!conversationState) {
    console.log(`⏸️  Skipping no-response timer - call already ended`);
    return;
  }
  
  // Skip if call is bridged/transferred
  if (transferCalls.has(callControlId)) {
    console.log(`⏸️  Skipping no-response timer - call is bridged`);
    return;
  }
  
  console.log(`⏱️  Starting no-response timer (10s) for ${callControlId.slice(0, 20)}...`);
  
  // Create timer data structure
  const timerData = {
    warningTimer: null,
    hangupTimer: null,
    warningGiven: false,
    startTime: Date.now()
  };
  
  aiSpeechEndTimers.set(callControlId, timerData);
  
  // Start the 10-second timer
  timerData.warningTimer = setTimeout(async () => {
    const currentTimerData = aiSpeechEndTimers.get(callControlId);
    if (!currentTimerData) {
      // Timer was cleared (user responded or call ended)
      return;
    }
    
    // Check if call is still active
    const currentState = openaiService.getConversationState(callControlId);
    if (!currentState || transferCalls.has(callControlId) || pendingHangups.has(callControlId)) {
      console.log(`⏸️  No-response timer cancelled - call ended or has pending action`);
      clearNoResponseTimer(callControlId);
      return;
    }
    
    console.log(`⏰ 10 seconds of no response after AI speech - showing warning`);
    currentTimerData.warningGiven = true;
    
    // ✨ IMPORTANT: Clear the old 1-minute timer when warning is shown
    // This prevents it from hanging up the call before the 5-second timer completes
    const oldNoResponseTimer = noResponseTimers.get(callControlId);
    if (oldNoResponseTimer) {
      clearTimeout(oldNoResponseTimer);
      noResponseTimers.delete(callControlId);
      console.log(`🧹 Cleared old 1-minute timer before showing warning`);
    }
    
    try {
      // Mark call as speaking to ignore transcriptions during warning
      speakingCalls.set(callControlId, { startTime: Date.now() });
      
      // Log warning message to conversation history so it's visible
      conversationService.addMessage(callControlId, 'AI', WARNING_MESSAGE);
      
      // Play warning message using bidirectional TTS
      await bidirectionalTTS.speak(callControlId, WARNING_MESSAGE);
      console.log(`✅ Warning message sent: "${WARNING_MESSAGE}"`);
      
      // Calculate estimated audio playback duration for warning
      // bidirectionalTTS.speak() returns when audio is sent, not when it finishes playing
      // So we need to wait for the estimated playback duration
      const estimatedWarningDurationMs = Math.max(1000, (WARNING_MESSAGE.length * 80));
      const warningWaitTime = estimatedWarningDurationMs + 500; // Add 500ms safety buffer
      
      console.log(`   Estimated warning audio duration: ${estimatedWarningDurationMs.toFixed(0)}ms`);
      console.log(`   Will wait ${warningWaitTime.toFixed(0)}ms before starting 5-second timer`);
      
      // Wait for warning audio to finish playing before starting 5-second timer
      // bidirectionalTTS.speak() returns when audio is sent, so we wait for estimated playback duration
      setTimeout(() => {
        console.log(`⏱️  Warning audio playback should be finished now, checking if 5s timer should start...`);
        
        // Clear speaking status after warning finishes
        speakingCalls.delete(callControlId);
        
        const updatedTimerData = aiSpeechEndTimers.get(callControlId);
        if (!updatedTimerData) {
          // Timer was cleared (user responded or call ended)
          console.log(`⏸️  5-second timer not started - timer was cleared (user may have responded)`);
          return;
        }
        
        // Check if call is still active
        const checkState = openaiService.getConversationState(callControlId);
        if (!checkState) {
          console.log(`⏸️  5-second timer not started - call already ended`);
          clearNoResponseTimer(callControlId);
          return;
        }
        
        if (transferCalls.has(callControlId)) {
          console.log(`⏸️  5-second timer not started - call is bridged/transferred`);
          clearNoResponseTimer(callControlId);
          return;
        }
        
        if (pendingHangups.has(callControlId)) {
          console.log(`⏸️  5-second timer not started - call has pending action`);
          clearNoResponseTimer(callControlId);
          return;
        }
        
        // Warning finished playing - start the 5-second timer
        console.log(`⏱️  ✅ Starting second no-response timer (5s) after warning finished playing`);
        
        updatedTimerData.hangupTimer = setTimeout(async () => {
          console.log(`⏰ 5-second timer expired - checking if call should be ended...`);
          
          const finalTimerData = aiSpeechEndTimers.get(callControlId);
          if (!finalTimerData) {
            // Timer was cleared (user responded or call ended)
            console.log(`⏸️  Hangup cancelled - timer was cleared (user may have responded)`);
            return;
          }
          
          // Check if call is still active
          const finalState = openaiService.getConversationState(callControlId);
          if (!finalState || transferCalls.has(callControlId) || pendingHangups.has(callControlId)) {
            console.log(`⏸️  Hangup cancelled - call ended or has pending action`);
            clearNoResponseTimer(callControlId);
            return;
          }
          
          // ⭐ CRITICAL FIX: Check if user attempted to respond (even if it was overlapping speech)
          // This prevents hanging up when user tried to respond during AI speech but it was ignored
          const conversation = conversationService.activeConversations?.get?.(callControlId);
          if (conversation && conversation.userAttemptedResponse) {
            const timeSinceAttempt = Date.now() - (conversation.lastUserAttemptTime || 0);
            // If user attempted to respond within last 30 seconds, don't hang up - restart timer instead
            if (timeSinceAttempt < 30000) {
              console.log(`✅ User attempted to respond ${(timeSinceAttempt/1000).toFixed(1)}s ago (overlapping speech) - not hanging up, restarting timer`);
              // Reset the flag and extend the timer
              conversation.userAttemptedResponse = false;
              clearNoResponseTimer(callControlId);
              startNoResponseTimer(callControlId); // Restart timer to give user another chance
              return;
            } else {
              // User attempt was too long ago, clear the flag
              conversation.userAttemptedResponse = false;
            }
          }
          
          console.log(`⏰ No response after warning - ending call`);
          try {
            await telnyxService.hangupCall(callControlId);
            conversationService.addMessage(
              callControlId, 
              'AI', 
              '[Auto-hangup: No response after warning]'
            );
            
            // Broadcast to frontend
            broadcast({
              type: 'call_event',
              event: 'auto_hangup',
              callControlId,
              reason: 'no_response_after_warning',
              timestamp: Date.now()
            });
          } catch (error) {
            console.error('Error hanging up call after no response:', error);
          }
          
          clearNoResponseTimer(callControlId);
        }, SECOND_TIMEOUT);
      }, warningWaitTime);
    } catch (error) {
      console.error(`❌ Error playing warning message:`, error);
      // If warning fails, start the 5-second timer immediately
      const errorTimerData = aiSpeechEndTimers.get(callControlId);
      if (errorTimerData) {
        console.log(`⏱️  Warning failed, starting 5-second timer immediately`);
        errorTimerData.hangupTimer = setTimeout(async () => {
          const errorFinalTimerData = aiSpeechEndTimers.get(callControlId);
          if (!errorFinalTimerData) {
            return;
          }
          
          const errorFinalState = openaiService.getConversationState(callControlId);
          if (!errorFinalState || transferCalls.has(callControlId) || pendingHangups.has(callControlId)) {
            clearNoResponseTimer(callControlId);
            return;
          }
          
          // ⭐ CRITICAL FIX: Check if user attempted to respond (even if it was overlapping speech)
          // This prevents hanging up when user tried to respond during AI speech but it was ignored
          const errorConversation = conversationService.activeConversations?.get?.(callControlId);
          if (errorConversation && errorConversation.userAttemptedResponse) {
            const timeSinceAttempt = Date.now() - (errorConversation.lastUserAttemptTime || 0);
            // If user attempted to respond within last 30 seconds, don't hang up - restart timer instead
            if (timeSinceAttempt < 30000) {
              console.log(`✅ User attempted to respond ${(timeSinceAttempt/1000).toFixed(1)}s ago (overlapping speech) - not hanging up, restarting timer`);
              // Reset the flag and extend the timer
              errorConversation.userAttemptedResponse = false;
              clearNoResponseTimer(callControlId);
              startNoResponseTimer(callControlId); // Restart timer to give user another chance
              return;
            } else {
              // User attempt was too long ago, clear the flag
              errorConversation.userAttemptedResponse = false;
            }
          }
          
          console.log(`⏰ No response after warning - ending call`);
          try {
            await telnyxService.hangupCall(callControlId);
            conversationService.addMessage(
              callControlId, 
              'AI', 
              '[Auto-hangup: No response after warning]'
            );
            
            broadcast({
              type: 'call_event',
              event: 'auto_hangup',
              callControlId,
              reason: 'no_response_after_warning',
              timestamp: Date.now()
            });
          } catch (hangupError) {
            console.error('Error hanging up call after no response:', hangupError);
          }
          
          clearNoResponseTimer(callControlId);
        }, SECOND_TIMEOUT);
      }
      speakingCalls.delete(callControlId);
    }
  }, INITIAL_TIMEOUT);
}

/**
 * Clear no-response timer when user responds
 */
function clearNoResponseTimer(callControlId) {
  // Clear the 10-second + 5-second timer system (aiSpeechEndTimers)
  const timerData = aiSpeechEndTimers.get(callControlId);
  if (timerData) {
    if (timerData.startTimerTimeout) {
      clearTimeout(timerData.startTimerTimeout);
    }
    if (timerData.warningTimer) {
      clearTimeout(timerData.warningTimer);
    }
    if (timerData.hangupTimer) {
      clearTimeout(timerData.hangupTimer);
    }
    aiSpeechEndTimers.delete(callControlId);
    console.log(`✅ Cleared 10s+5s no-response timer for ${callControlId.slice(0, 20)}...`);
  }
  
  // ✨ CRITICAL FIX: Also clear the 60-second timer (noResponseTimers)
  // This ensures that when user responds (even during AI speech or if filtered),
  // the 60-second timer is also cleared, preventing false "no_response" detection
  const noResponseTimer = noResponseTimers.get(callControlId);
  if (noResponseTimer) {
    clearTimeout(noResponseTimer);
    noResponseTimers.delete(callControlId);
    console.log(`✅ Cleared 60-second no-response timer for ${callControlId.slice(0, 20)}...`);
  }
}

/**
 * GET /webhooks/health - Health check for webhooks
 */

router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Webhook endpoint is healthy',
    timestamp: Date.now()
  });
});

module.exports = router;

