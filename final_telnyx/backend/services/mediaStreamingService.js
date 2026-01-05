/**
 * Media Streaming Service
 * Handles audio streaming from Telnyx and forwards to ElevenLabs Scribe STT
 */

const WebSocket = require('ws');
const scribeService = require('./elevenLabsScribeService');
const audioTranscoder = require('./audioTranscoder');

let mediaWss = null;
const activeStreams = new Map(); // callControlId -> { telnyxWs, metadata }
const eventListeners = new Map(); // callControlId -> { transcriptListener, errorListener }

/**
 * Initialize WebSocket server for receiving audio from Telnyx
 */
function initializeMediaStreamServer(server) {
  // Create WebSocket server with noServer for manual upgrade handling
  // Set maxConnections to prevent resource exhaustion (50 concurrent calls + buffer)
  const MAX_CONNECTIONS = parseInt(process.env.MAX_WEBSOCKET_CONNECTIONS) || 100;
  
  mediaWss = new WebSocket.Server({ 
    noServer: true,
    clientTracking: true,
    perMessageDeflate: false, // Disable compression for better performance with audio
    maxPayload: 1024 * 1024 // 1MB max payload (audio chunks are small)
  });

  mediaWss.on('error', (error) => {
    console.error(`❌ Media streaming WebSocket SERVER error:`, error);
    console.error(`   Stack:`, error.stack);
  });

  console.log('✅ Media streaming server initialized on /media-stream');
  console.log(`   Max connections monitoring: ${MAX_CONNECTIONS} (set via MAX_WEBSOCKET_CONNECTIONS env var)`);

  mediaWss.on('connection', (ws, req) => {
    // Monitor connection count
    const connectionCount = mediaWss.clients.size;
    if (connectionCount > MAX_CONNECTIONS * 0.8) {
      console.warn(`⚠️  High WebSocket connection count: ${connectionCount}/${MAX_CONNECTIONS}`);
    }
    
    console.log(`🎙️  Telnyx media stream CONNECTED from ${req.socket.remoteAddress}`);
    console.log(`   Headers:`, JSON.stringify(req.headers, null, 2));
    console.log(`   URL:`, req.url);
    
    // Extract call_control_id from URL query parameters
    const url = new URL(req.url, `http://${req.headers.host}`);
    let callControlId = url.searchParams.get('call_control_id');
    let streamSid = null;
    
    console.log(`   Call Control ID from URL: ${callControlId}`);

    ws.on('message', async (message) => {
      try {
        // Log message type and size (reduce spam - only log every 50th media packet)
        if (!this._mediaPacketCount) this._mediaPacketCount = new Map();
        const count = this._mediaPacketCount.get(callControlId) || 0;
        
        const data = JSON.parse(message.toString());
        
        // if (data.event !== 'media' || count % 50 === 0) {
        //   console.log(`📨 Received message: type=${typeof message}, size=${message.length}`);
        //   console.log(`📨 Parsed event: ${data.event}` + (data.event === 'media' ? ` (packet #${count})` : ''));
        // }
        
        if (data.event === 'media') {
          this._mediaPacketCount.set(callControlId, count + 1);
        }
        
        switch (data.event) {
          case 'connected':
            // Telnyx WebSocket connected - just log it
            console.log(`🎙️  Telnyx WebSocket connected`);
            console.log(`   Call Control ID: ${callControlId}`);
            streamSid = data.stream_id;
            break;
            
          case 'start':
            // Stream actually started - NOW connect to ElevenLabs Scribe
            console.log(`🎙️  Telnyx stream START event received`);
            console.log(`   Call Control ID: ${callControlId}`);
            console.log(`   Stream ID: ${data.stream_id || streamSid}`);
            
            if (callControlId) {
              console.log(`   ✅ Initializing ElevenLabs Scribe for ${callControlId}`);
              activeStreams.set(callControlId, {
                telnyxWs: ws,
                streamSid: data.stream_id || streamSid,
                startTime: Date.now()
              });
              
              // Connect to ElevenLabs Scribe
              console.log(`   📞 Calling handleStreamStart...`);
              await handleStreamStart(ws, callControlId, data.stream_id || streamSid);
              console.log(`   ✅ handleStreamStart completed`);
            } else {
              console.error(`❌ No call_control_id found for stream`);
            }
            break;

          case 'media':
            // Audio chunk received from Telnyx - forward to ElevenLabs Scribe
            if (callControlId && data.media?.payload) {
              // Debug: Log first media event structure
              if (!this._firstMediaLogged) {
                console.log(`🔍 First media event structure:`);
                console.log(`   data.media keys:`, Object.keys(data.media));
                console.log(`   data.media:`, JSON.stringify(data.media, null, 2));
                this._firstMediaLogged = true;
              }
              
              // If ElevenLabs Scribe not yet connected for this call, initialize it now
              // This handles cases where 'start' event is missed or not sent by Telnyx
              if (!activeStreams.has(callControlId)) {
                console.log(`🎙️  First media packet received - initializing ElevenLabs Scribe for ${callControlId}`);
                activeStreams.set(callControlId, {
                  telnyxWs: ws,
                  streamSid: streamSid || 'unknown',
                  startTime: Date.now()
                });
                
                // Connect to ElevenLabs Scribe
                await handleStreamStart(ws, callControlId, streamSid || 'unknown');
              }
              
              await handleMedia(callControlId, data.media.payload);
            } else {
              // Debug: why are we not processing media?
              if (!callControlId) {
                console.warn(`⚠️  Media packet received but callControlId is missing!`);
              }
              if (!data.media?.payload) {
                console.warn(`⚠️  Media packet received but payload is missing!`);
              }
            }
            break;

          case 'stop':
            // Stream ended
            await handleStreamStop(data);
            if (callControlId) {
              activeStreams.delete(callControlId);
            }
            break;

          default:
            console.log(`📝 Unknown media stream event: ${data.event}`);
        }
      } catch (error) {
        console.error(`❌ Error processing media stream message:`, error);
        console.error(`   Error stack:`, error.stack);
        console.error(`   Message type: ${typeof message}`);
        console.error(`   Message preview: ${message.toString().substring(0, 200)}`);
      }
    });

    ws.on('error', (error) => {
      console.error(`❌ Media stream WebSocket client error:`, error);
      console.error(`   Call ID: ${callControlId}`);
    });

    ws.on('close', (code, reason) => {
      console.log(`🎙️  Telnyx media stream disconnected`);
      console.log(`   Code: ${code}, Reason: ${reason.toString()}`);
      if (callControlId) {
        // Clean up event listeners for this call
        if (eventListeners.has(callControlId)) {
          const listeners = eventListeners.get(callControlId);
          scribeService.off('transcript', listeners.transcriptListener);
          scribeService.off('error', listeners.errorListener);
          eventListeners.delete(callControlId);
          console.log(`   🧹 Removed event listeners for ${callControlId}`);
        }
        
        scribeService.disconnect(callControlId);
        activeStreams.delete(callControlId);
      }
    });
  });

  return mediaWss;
}

/**
 * Handle stream start event - connect to ElevenLabs Scribe
 */
async function handleStreamStart(ws, callControlId, streamSid) {
  // CRITICAL: This should ALWAYS log if function is called
  console.error(`🚨🚨🚨 handleStreamStart CALLED with callControlId=${callControlId} 🚨🚨🚨`);
  console.log(`🎙️  Media stream started:`);
  console.log(`   Call Control ID: ${callControlId}`);
  console.log(`   Stream SID: ${streamSid}`);
  console.log(`   Media format: MULAW @ 8000Hz`);
  console.log(`   scribeService type: ${typeof scribeService}`);
  console.log(`   scribeService.activeConnections: ${scribeService.activeConnections ? 'EXISTS' : 'NULL'}`);

  // Connect to ElevenLabs Scribe for this call (if not already connected)
  try {
    // Check if already connected from pre-connection
    if (scribeService.activeConnections && scribeService.activeConnections.has(callControlId)) {
      console.log(`✅ ElevenLabs Scribe already connected from pre-connection - skipping duplicate connection`);
      const existing = scribeService.activeConnections.get(callControlId);
      console.log(`   Existing connection isReady: ${existing?.isReady || 'N/A'}`);
      // DON'T RETURN - we still need to set up event listeners below!
    } else {
      console.log(`📞 Attempting to connect ElevenLabs Scribe for call ${callControlId}...`);
      console.log(`   ELEVENLABS_API_KEY is ${process.env.ELEVENLABS_API_KEY ? 'SET (' + process.env.ELEVENLABS_API_KEY.substring(0, 10) + '...)' : 'NOT SET'}`);
      
      // Check if scribeService.connect is a function
      if (typeof scribeService.connect !== 'function') {
        throw new Error(`scribeService.connect is not a function! Type: ${typeof scribeService.connect}`);
      }
      
      console.log(`   Calling scribeService.connect()...`);
      await scribeService.connect(callControlId);
      console.log(`✅ ElevenLabs Scribe connection initiated for call ${callControlId}`);
    }

    // Set up transcription event handlers
    // ✨ FIXED: Store listener references per call to prevent leaks
    console.log(`🔧 Setting up event listeners for ${callControlId}...`);
    
    // Remove any existing listeners for this call (cleanup from previous connection)
    if (eventListeners.has(callControlId)) {
      const oldListeners = eventListeners.get(callControlId);
      scribeService.off('transcript', oldListeners.transcriptListener);
      scribeService.off('error', oldListeners.errorListener);
      console.log(`   🧹 Removed old listeners for ${callControlId}`);
    }
    
    // Create new listeners for this call
    const transcriptListener = (cid, transcript) => {
      if (cid === callControlId) {
        console.log(`📨 Received transcript event from ElevenLabs Scribe for ${cid}: "${transcript.text}" (isFinal: ${transcript.isFinal})`);
        // Emit transcript event that webhook routes can handle
        const transcriptEvent = {
          type: 'transcript',
          callControlId: cid,
          payload: {
            call_control_id: cid,
            transcription_data: {
              transcript: transcript.text,
              is_final: transcript.isFinal,
              confidence: transcript.confidence || 0.9
            }
          }
        };
        
        // Notify webhook routes via event emitter
        if (global.mediaStreamEvents) {
          global.mediaStreamEvents.emit('transcript', transcriptEvent);
          console.log(`✅ Transcript event emitted successfully`);
        } else {
          console.error(`❌ global.mediaStreamEvents is not defined!`);
        }
      }
    };

    const errorListener = (cid, error) => {
      if (cid === callControlId) {
        console.error(`❌ ElevenLabs Scribe error for ${cid}:`, error);
      }
    };
    
    // Add listeners
    scribeService.on('transcript', transcriptListener);
    scribeService.on('error', errorListener);
    
    // Store listener references for cleanup
    eventListeners.set(callControlId, {
      transcriptListener,
      errorListener
    });
    
    console.log(`✅ Event listeners set up for ${callControlId} (stored for cleanup)`);

  } catch (error) {
    console.error(`❌ CRITICAL: Failed to connect to ElevenLabs Scribe for ${callControlId}:`);
    console.error(`   Error type: ${error.constructor.name}`);
    console.error(`   Error message: ${error.message}`);
    console.error(`   Error stack:`, error.stack);
    console.error(`   Full error object:`, JSON.stringify(error, Object.getOwnPropertyNames(error)));
    
    // Check if it's a module not found error
    if (error.code === 'MODULE_NOT_FOUND') {
      console.error(`   ⚠️  MODULE NOT FOUND - Run 'npm install' in the backend directory!`);
    }
  }
}

/**
 * Handle media (audio) chunk - forward to ElevenLabs Scribe
 */
async function handleMedia(callControlId, base64Payload) {
  try {
    // ⭐ CRITICAL FIX: Skip forwarding media to ElevenLabs if call is bridged to agent
    // When a call is bridged, Telnyx handles audio directly between user and agent
    // We should not process it through ElevenLabs anymore - let Telnyx handle the audio flow
    // Check if this call is bridged by accessing transferCalls from webhookRoutes
    // We use a global reference to avoid circular dependencies
    if (global.transferCalls && global.transferCalls.has(callControlId)) {
      // Call is bridged - don't forward media to ElevenLabs
      // Telnyx handles audio flow directly between user and agent
      // Only log occasionally to avoid spam
      if (!this._bridgedMediaSkipped) this._bridgedMediaSkipped = new Set();
      if (!this._bridgedMediaSkipped.has(callControlId)) {
        console.log(`🔗 Call ${callControlId} is bridged - skipping media forwarding to ElevenLabs (Telnyx handles audio directly)`);
        this._bridgedMediaSkipped.add(callControlId);
      }
      return;
    }
    
    // Debug: Log first payload
    if (!this._firstPayloadLogged) {
      console.log(`🔍 First Telnyx payload received:`);
      console.log(`   Base64 length: ${base64Payload ? base64Payload.length : 'null'}`);
      this._firstPayloadLogged = true;
    }
    
    // Convert base64 audio to Buffer (µ-law @ 8kHz from Telnyx)
    const ulawBuffer = Buffer.from(base64Payload, 'base64');
    
    // Skip tiny packets (< 80 bytes = < 10ms of audio at 8kHz)
    // Telnyx sometimes sends keepalive/initialization packets
    if (ulawBuffer.length < 80) {
      if (!this._skippedTinyPackets) this._skippedTinyPackets = 0;
      this._skippedTinyPackets++;
      if (this._skippedTinyPackets <= 5) {
        console.log(`⏭️  Skipping tiny packet #${this._skippedTinyPackets} (${ulawBuffer.length} bytes - too small)`);
      }
      return;
    }
    
    // Send µ-law DIRECTLY to ElevenLabs Scribe (NO transcoding!)
    // ElevenLabs Scribe supports ulaw_8000 format natively
    if (!this._firstTranscodeLogged) {
      console.log(`🧪 Sending µ-law DIRECTLY to ElevenLabs Scribe (no transcoding):`);
      console.log(`   Input: ${ulawBuffer.length} bytes µ-law @ 8kHz`);
      console.log(`   Sending AS-IS to ElevenLabs Scribe with ulaw_8000 format`);
      this._firstTranscodeLogged = true;
    }
    
    // 🔍 CRITICAL FIX FOR CONCURRENT CALLS: Check if Scribe is connected before forwarding audio
    // This prevents "No Scribe connection" errors after queue_overflow disconnects
    if (!scribeService.activeConnections || !scribeService.activeConnections.has(callControlId)) {
      // Scribe not connected (likely disconnected due to queue_overflow or other error)
      // Silently skip - connection will be re-established on next stream start if needed
      return;
    }
    
    // Forward RAW µ-law @ 8kHz to ElevenLabs Scribe
    scribeService.sendAudio(callControlId, ulawBuffer);
  } catch (error) {
    console.error(`❌ Error processing media chunk:`, error);
  }
}

/**
 * Handle stream stop event
 */
async function handleStreamStop(data) {
  const callControlId = data.stop?.callControlId || data.stop?.call_control_id;
  
  console.log(`🎙️  Media stream stopped for call: ${callControlId}`);
  
  if (callControlId) {
    // Calculate STT duration and track cost
    const stream = activeStreams.get(callControlId);
    if (stream && stream.startTime) {
      const durationMs = Date.now() - stream.startTime;
      const durationMinutes = Math.ceil(durationMs / 60000); // Round up to nearest minute
      
      // Track ElevenLabs STT cost
      const costTracking = require('./costTrackingService');
      costTracking.trackElevenLabsSTT(callControlId, durationMinutes);
    }
    
    // Clean up event listeners for this call
    if (eventListeners.has(callControlId)) {
      const listeners = eventListeners.get(callControlId);
      scribeService.off('transcript', listeners.transcriptListener);
      scribeService.off('error', listeners.errorListener);
      eventListeners.delete(callControlId);
      console.log(`   🧹 Removed event listeners for ${callControlId}`);
    }
    
    // Commit any pending transcript to ElevenLabs Scribe
    scribeService.commit(callControlId);
    
    // Disconnect from ElevenLabs Scribe
    setTimeout(() => {
      scribeService.disconnect(callControlId);
    }, 1000); // Give time for final transcript
  }
}

/**
 * Get WebSocket URL for Telnyx streaming
 */
function getStreamUrl(callControlId) {
  const baseUrl = process.env.WEBHOOK_BASE_URL || 'http://localhost:3000';
  // Convert http:// to ws:// or https:// to wss://
  const wsUrl = baseUrl.replace(/^http/, 'ws');
  // Include call_control_id as a query parameter so we can identify the stream
  return `${wsUrl}/media-stream?call_control_id=${encodeURIComponent(callControlId)}`;
}

/**
 * Send audio back to Telnyx (for bidirectional streaming)
 * Audio must be in PCMU (µ-law) format @ 8kHz
 * 
 * @param {string} callControlId - Call control ID
 * @param {Buffer} audioBuffer - Audio data in PCMU (µ-law) format @ 8kHz
 * @returns {boolean} - True if sent successfully, false otherwise
 */
function sendAudioToCall(callControlId, audioBuffer) {
  const stream = activeStreams.get(callControlId);
  
  if (!stream) {
    console.warn(`⚠️  Cannot send audio: No active stream for ${callControlId}`);
    return false;
  }
  
  if (!stream.telnyxWs || stream.telnyxWs.readyState !== WebSocket.OPEN) {
    console.warn(`⚠️  Cannot send audio: WebSocket not open for ${callControlId} (state: ${stream.telnyxWs?.readyState})`);
    return false;
  }
  
  try {
    // Convert audio buffer to base64
    const base64Audio = audioBuffer.toString('base64');
    
    // Send audio packet back to Telnyx using the media event format
    // This is the SAME format Telnyx uses to send us audio, just in reverse
    const mediaMessage = {
      event: 'media',
      stream_id: stream.streamSid,
      media: {
        payload: base64Audio
      }
    };
    
    stream.telnyxWs.send(JSON.stringify(mediaMessage));
    
    // Log only every 100th packet to reduce spam
    if (!this._sentPacketCount) this._sentPacketCount = new Map();
    const count = (this._sentPacketCount.get(callControlId) || 0) + 1;
    this._sentPacketCount.set(callControlId, count);
    
    // if (count % 100 === 1) {
    //   console.log(`🔊 Sent audio packet #${count} to ${callControlId} (${audioBuffer.length} bytes → ${base64Audio.length} base64 chars)`);
    // }
    
    return true;
  } catch (error) {
    console.error(`❌ Error sending audio to call ${callControlId}:`, error);
    return false;
  }
}

/**
 * Send audio stream to call in chunks (for TTS streaming with low latency)
 * Automatically chunks large audio buffers into 20ms packets for real-time playback
 * 
 * @param {string} callControlId - Call control ID
 * @param {Buffer} audioBuffer - Complete audio buffer in PCMU format
 * @param {number} chunkSize - Size of each chunk in bytes (default: 160 bytes = 20ms @ 8kHz)
 */
async function streamAudioToCall(callControlId, audioBuffer, chunkSize = 160) {
  console.log(`🎙️  Streaming ${audioBuffer.length} bytes of audio to ${callControlId} in ${chunkSize}-byte chunks`);
  
  let sentBytes = 0;
  const totalChunks = Math.ceil(audioBuffer.length / chunkSize);
  
  for (let i = 0; i < audioBuffer.length; i += chunkSize) {
    const chunk = audioBuffer.slice(i, Math.min(i + chunkSize, audioBuffer.length));
    
    const sent = sendAudioToCall(callControlId, chunk);
    if (!sent) {
      console.warn(`⚠️  Failed to send chunk ${Math.floor(i / chunkSize) + 1}/${totalChunks}, stopping stream`);
      break;
    }
    
    sentBytes += chunk.length;
    
    // Send packets as fast as possible - let Telnyx handle buffering
    // No artificial delay - maximum throughput for lowest latency
    // Only add tiny delay every 10 chunks to prevent WebSocket buffer overflow
    if ((Math.floor(i / chunkSize) % 10) === 0 && i > 0) {
      await new Promise(resolve => setImmediate(resolve));  // Yield to event loop
    }
  }
  
  console.log(`✅ Finished streaming ${sentBytes}/${audioBuffer.length} bytes (${totalChunks} chunks) to ${callControlId}`);
  return sentBytes;
}

/**
 * Close all websockets for a specific call (STT and TTS)
 * Called when call hangs up to ensure all connections are properly closed
 * 
 * @param {string} callControlId - Call control ID
 */
function closeAllWebsocketsForCall(callControlId) {
  if (!callControlId) {
    console.warn(`⚠️  closeAllWebsocketsForCall called without callControlId`);
    return;
  }
  
  console.log(`🔌 Closing all websockets for call: ${callControlId}`);
  
  // 1. Clean up event listeners for this call
  if (eventListeners.has(callControlId)) {
    const listeners = eventListeners.get(callControlId);
    scribeService.off('transcript', listeners.transcriptListener);
    scribeService.off('error', listeners.errorListener);
    eventListeners.delete(callControlId);
    console.log(`   🧹 Removed event listeners for ${callControlId}`);
  }
  
  // 2. Close ElevenLabs Scribe websocket (STT)
  try {
    if (scribeService && typeof scribeService.disconnect === 'function') {
      scribeService.disconnect(callControlId);
      console.log(`   ✅ ElevenLabs Scribe websocket closed`);
    } else {
      console.log(`   ℹ️  ElevenLabs Scribe service not available`);
    }
  } catch (error) {
    console.error(`   ❌ Error closing ElevenLabs Scribe websocket:`, error.message);
  }
  
  // 3. Close Telnyx media streaming websocket (STT)
  const stream = activeStreams.get(callControlId);
  if (stream && stream.telnyxWs) {
    try {
      const readyState = stream.telnyxWs.readyState;
      // WebSocket states: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
      if (readyState === WebSocket.OPEN || readyState === WebSocket.CONNECTING) {
        stream.telnyxWs.close();
        console.log(`   ✅ Telnyx media streaming websocket closed (was ${readyState === WebSocket.OPEN ? 'OPEN' : 'CONNECTING'})`);
      } else {
        console.log(`   ℹ️  Telnyx media streaming websocket already closed (state: ${readyState})`);
      }
    } catch (error) {
      console.error(`   ❌ Error closing Telnyx media streaming websocket:`, error.message);
    }
  } else {
    console.log(`   ℹ️  No active Telnyx media stream found for ${callControlId}`);
  }
  
  // 4. Remove from active streams
  if (activeStreams.has(callControlId)) {
    activeStreams.delete(callControlId);
    console.log(`   ✅ Removed from active streams`);
  }
  
  console.log(`✅ All websockets closed for call: ${callControlId}`);
}

/**
 * Cleanup on server shutdown
 */
function cleanup() {
  if (mediaWss) {
    mediaWss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.close();
      }
    });
    mediaWss.close();
  }
  scribeService.disconnectAll();
}

module.exports = {
  initializeMediaStreamServer,
  getStreamUrl,
  cleanup,
  activeStreams,
  sendAudioToCall,       // ✨ NEW: Send single audio packet
  streamAudioToCall,     // ✨ NEW: Stream complete audio buffer in chunks
  closeAllWebsocketsForCall  // ✨ NEW: Close all websockets for a call
};

