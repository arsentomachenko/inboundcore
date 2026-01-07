/**
 * ElevenLabs Scribe Service
 * Handles real-time speech-to-text using ElevenLabs Scribe v2 Realtime API
 */

const WebSocket = require('ws');
const EventEmitter = require('events');

class ElevenLabsScribeService extends EventEmitter {
  constructor() {
    super();
    this.activeConnections = new Map(); // callControlId -> { ws, buffer }
    this.apiKey = process.env.ELEVENLABS_API_KEY;
  }

  /**
   * Generate a single-use token for Scribe v2 Realtime
   */
  async generateScribeToken() {
    const https = require('https');
    
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: '/v1/single-use-token/realtime_scribe',
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed.token);
            } catch (error) {
              reject(new Error(`Failed to parse token response: ${error.message}`));
            }
          } else {
            reject(new Error(`Token generation failed: ${res.statusCode} - ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Connect to ElevenLabs Scribe for a specific call
   */
  async connect(callControlId) {
    console.log(`🔍 connect() called for ${callControlId}`);
    console.log(`   Active connections: ${this.activeConnections.size}`);
    console.log(`   Already has connection: ${this.activeConnections.has(callControlId)}`);
    
    if (this.activeConnections.has(callControlId)) {
      const existing = this.activeConnections.get(callControlId);
      console.log(`⚠️  ElevenLabs Scribe already connected for ${callControlId}`);
      console.log(`   Existing connection state: ${existing.ws ? existing.ws.readyState : 'NO WS'}`);
      console.log(`   Is ready: ${existing.isReady}`);
      return;
    }

    if (!this.apiKey) {
      console.error(`❌ ELEVENLABS_API_KEY not configured! Cannot connect to Scribe.`);
      throw new Error('ELEVENLABS_API_KEY environment variable is required');
    }

    console.log(`🔗 Connecting to ElevenLabs Scribe for ${callControlId}...`);
    console.log(`   API Key: ${this.apiKey ? this.apiKey.substring(0, 10) + '...' : 'NOT SET'}`);

    // Generate single-use token for Scribe
    console.log(`🎫 Generating Scribe token...`);
    const token = await this.generateScribeToken();
    console.log(`✅ Token generated: ${token.substring(0, 15)}...`);

    return new Promise((resolve, reject) => {
      try {
        // ElevenLabs Scribe WebSocket URL with token authentication and VAD settings
        // audio_format=ulaw_8000 → µ-law audio (8-bit @ 8kHz) matching Telnyx
        // language_code=en → Improve accuracy by specifying English
        // commit_strategy=vad → Enable Voice Activity Detection for auto-commits
        // vad_silence_threshold_secs=0.3 → 300ms silence before committing (faster response, more sensitive)
        // vad_threshold=0.3 → More sensitive to catch all speech (0.1=very sensitive, 0.9=less sensitive)
        // min_speech_duration_ms=100 → Require at least 100ms of speech (very low to catch all speech)
        // min_silence_duration_ms=150 → Require 150ms silence to separate speech segments (reduced for faster detection)
        const wsUrl = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?` +
          `model_id=scribe_v2_realtime` +
          `&audio_format=ulaw_8000` +
          `&language_code=en` +
          `&commit_strategy=vad` +
          `&vad_silence_threshold_secs=0.3` +  // Reduced to 300ms for faster commits and better detection
          `&vad_threshold=0.3` +  // More sensitive (lower = more sensitive, catches quieter speech)
          `&min_speech_duration_ms=100` +  // Very low threshold to catch all speech including short words
          `&min_silence_duration_ms=150` +  // Reduced silence requirement for faster detection
          `&token=${token}`;
        
        console.log(`🔌 Connecting to Scribe WebSocket with token...`);
        const ws = new WebSocket(wsUrl);

        const connection = {
          ws,
          isReady: false,
          resolveConnection: null,  // Store resolve callback to call after session_started
          audioBuffer: [],  // Buffer to accumulate audio chunks
          audioBufferSize: 0,  // Track total bytes buffered
          initialBufferSent: false,  // Track if we've sent the required 2-second initial buffer
          latestPartialTranscript: null,  // Store latest partial transcript
          lastPartialTime: null,  // Timestamp of last partial transcript
          silenceCheckInterval: null,  // Interval timer for checking silence
          lastAudioTime: Date.now(),  // Timestamp of last audio received
          lastAutoCommittedText: null,  // Track last auto-committed text to prevent duplicates
          lastAutoCommitTime: null,  // Track when we last auto-committed to throttle duplicates
          lastSendTime: 0  // Track last audio send time for throttling
        };

        this.activeConnections.set(callControlId, connection);

        // Timeout for connection
        const connectionTimeout = setTimeout(() => {
          if (!connection.isReady) {
            console.error(`❌ Scribe connection timeout for ${callControlId}`);
            ws.close();
            this.activeConnections.delete(callControlId);
            reject(new Error('Connection timeout after 10 seconds'));
          }
        }, 10000);

        // Store resolve callback to call after session_started
        connection.resolveConnection = resolve;

        // WebSocket event handlers
        ws.on('open', () => {
          clearTimeout(connectionTimeout);
          console.log(`📝 ElevenLabs Scribe WebSocket OPEN event fired for call: ${callControlId}`);
          console.log(`   WebSocket readyState: ${ws.readyState}`);
          console.log(`   ⚠️  NOT marking as ready yet - waiting for session_started message!`);
          // DON'T set isReady = true here! Wait for session_started message
          // DON'T call resolve() here! Wait for session_started message
          connection.connectedAt = Date.now();
          this.emit('connected', callControlId);
        });

        ws.on('message', (data) => {
          try {
            const dataStr = data.toString();
            
            // Log ALL messages from Scribe for debugging (per-connection counter)
            if (!connection.messagesLogged) connection.messagesLogged = 0;
            connection.messagesLogged++;
            // Log ALL messages (no limit) to catch errors
            console.log(`🔍 Scribe message #${connection.messagesLogged} for ${callControlId}:`, dataStr.substring(0, 1000));
            
            const message = JSON.parse(dataStr);
            this.handleScribeMessage(callControlId, message);
          } catch (error) {
            console.error(`❌ Error parsing Scribe message:`, error);
            console.error(`   Raw data:`, data.toString());
          }
        });

        ws.on('error', (error) => {
          clearTimeout(connectionTimeout);
          console.error(`❌ ElevenLabs Scribe WebSocket error for ${callControlId}:`);
          console.error(`   Error message: ${error.message}`);
          console.error(`   Error code: ${error.code}`);
          console.error(`   Full error:`, error);
          this.emit('error', callControlId, error);
          this.activeConnections.delete(callControlId);
          reject(error);
        });

        ws.on('close', (code, reason) => {
          clearTimeout(connectionTimeout);
          const reasonStr = reason ? reason.toString() : 'No reason provided';
          console.log(`📝 ElevenLabs Scribe disconnected for call: ${callControlId}`);
          console.log(`   Close code: ${code} (${this.getCloseCodeDescription(code)})`);
          console.log(`   Close reason: ${reasonStr}`);
          
          // Warn if connection closed immediately (likely auth/quota issue)
          if (connection.isReady) {
            const connectionDuration = Date.now() - (connection.connectedAt || 0);
            if (connectionDuration < 2000) {
              console.error(`❌ ElevenLabs Scribe closed immediately after connecting (${connectionDuration}ms)`);
              console.error(`   This usually indicates:`);
              console.error(`   - Invalid or expired API key`);
              console.error(`   - Quota exceeded`);
              console.error(`   - Authentication/permission issue`);
              console.error(`   Please check your ElevenLabs account and API key`);
            }
          }
          
          // Only delete if connection existed
          if (this.activeConnections.has(callControlId)) {
            this.activeConnections.delete(callControlId);
          }
          
          this.emit('disconnected', callControlId);
          
          // If close happens before open, reject the promise
          if (!connection.isReady) {
            reject(new Error(`WebSocket closed before opening: ${code} - ${reasonStr}`));
          }
        });

      } catch (error) {
        console.error(`❌ Error creating ElevenLabs Scribe connection:`, error);
        this.activeConnections.delete(callControlId);
        reject(error);
      }
    });
  }

  /**
   * Handle messages from ElevenLabs Scribe
   */
  handleScribeMessage(callControlId, message) {
    // ElevenLabs sends 'message_type' not 'type'
    const type = message.message_type || message.type;

    switch (type) {
      case 'session_started':
        console.log(`✅ Scribe session started for ${callControlId}`);
        console.log(`   Config:`, JSON.stringify(message.config, null, 2));
        
        // Wait 100ms before marking as ready to give Scribe time to fully initialize
        const conn = this.activeConnections.get(callControlId);
        if (conn) {
          console.log(`   ⏳ Waiting 100ms before marking Scribe as ready...`);
          setTimeout(() => {
            conn.isReady = true;
            console.log(`   ✅ Scribe is NOW READY to receive audio! (after delay)`);
            
            // Resolve the connection promise NOW (not in the 'open' handler)
            if (conn.resolveConnection) {
              conn.resolveConnection();
              conn.resolveConnection = null;  // Clean up
              console.log(`   ✅ Connection promise resolved - ready to start streaming!`);
            }
            
            // Start silence detection for auto-commit (check every 200ms)
            conn.silenceCheckInterval = setInterval(() => {
              this.checkForAutoCommit(callControlId);
            }, 200);
          }, 100);
        }
        break;

      case 'partial_transcript':
        // Interim transcription results (not final)
        const partialText = message.text || message.transcript;
        if (partialText && partialText.trim()) {
          // Accept all transcripts including single words (yes/no are valid!)
          const words = partialText.trim().split(/\s+/);
          const MIN_WORDS = 1; // Accept single words like "yes", "no", "okay"
          
          if (words.length >= MIN_WORDS) {
            const connection = this.activeConnections.get(callControlId);
            
            // Clear lastAutoCommittedText after 3 seconds (reduced from 5s for faster response)
            if (connection && connection.lastAutoCommitTime) {
              const timeSinceLastCommit = Date.now() - connection.lastAutoCommitTime;
              if (timeSinceLastCommit > 3000) {
                connection.lastAutoCommittedText = null; // Clear after 3s
              }
            }
            
            // IGNORE if this is the same text we just auto-committed (within 3s, reduced from 5s)
            if (connection && connection.lastAutoCommittedText === partialText) {
              // Reduce log spam - only log occasionally
              if (!connection._duplicateIgnoreCount) connection._duplicateIgnoreCount = 0;
              connection._duplicateIgnoreCount++;
              if (connection._duplicateIgnoreCount % 10 === 1) {
                console.log(`🔇 Ignoring duplicate partial (already auto-committed) - count: ${connection._duplicateIgnoreCount}`);
              }
              return; // Skip - we already committed this exact text
            } else {
              // Reset duplicate counter when new text arrives
              if (connection) connection._duplicateIgnoreCount = 0;
            }
            
            // IGNORE partials for 1 second after auto-committing (reduced cooldown from 2s)
            if (connection && connection.lastAutoCommitTime) {
              const timeSinceLastCommit = Date.now() - connection.lastAutoCommitTime;
              if (timeSinceLastCommit < 1000) {
                // Only log first few to avoid spam
                if (!connection._cooldownLogCount) connection._cooldownLogCount = 0;
                connection._cooldownLogCount++;
                if (connection._cooldownLogCount <= 3) {
                  console.log(`🔇 Ignoring partial during cooldown (${timeSinceLastCommit}ms since commit)`);
                }
                return; // Skip this partial entirely
              }
            }
            
            console.log(`📝 Scribe [PARTIAL]: "${partialText}"`);
            
            // ⭐ CRITICAL FIX: Check for voicemail keywords in partial transcripts
            // If detected, immediately commit as final to trigger voicemail hangup
            const transcriptLower = partialText.toLowerCase();
            const voicemailKeywords = [
              'voicemail', 'voice mail', 'mailbox', 'mailbox is full', 'mailbox full',
              'leave a message', 'leave me a message', 'please leave your message',
              'after the beep', 'at the tone', 'after the tone',
              'record your message', 'not available', 'please leave',
              'can i take a message', 'take a message',
              'you\'ve reached', 'you have reached',
              'forwarded to an automated voice messaging system', 'automated voice messaging system',
              'voice messaging system', 'voice message system'
            ];
            
            const matchedKeywords = voicemailKeywords.filter(keyword => transcriptLower.includes(keyword));
            
            if (matchedKeywords.length >= 1) {
              console.log(`🤖 Voicemail detected in PARTIAL transcript!`);
              console.log(`   Matched ${matchedKeywords.length} keyword(s): ${matchedKeywords.join(', ')}`);
              console.log(`   Immediately committing as final to trigger voicemail hangup`);
              
              // Immediately emit as final transcript to trigger voicemail detection
              this.emit('transcript', callControlId, {
                text: partialText,
                isFinal: true,
                confidence: 0.9, // High confidence for voicemail detection
                autoCommitted: true,
                voicemailDetected: true
              });
              
              // Tell ElevenLabs to commit and clear its buffer
              this.sendCommitToElevenLabs(callControlId);
              
              // Clear partial buffer
              if (connection) {
                connection.lastAutoCommittedText = partialText;
                connection.lastAutoCommitTime = Date.now();
                connection.latestPartialTranscript = null;
                connection.lastPartialTime = null;
              }
              
              // Don't emit as partial - we've already emitted as final
              return;
            }
            
            // Store latest partial transcript for this call
            if (connection) {
              connection.latestPartialTranscript = partialText;
              connection.lastPartialTime = Date.now();
            }
            
            this.emit('partial', callControlId, {
              text: partialText,
              isFinal: false
            });
          } else {
            console.log(`⏭️  Skipping short partial: "${partialText}" (${words.length} word${words.length === 1 ? '' : 's'})`);
          }
        }
        break;

      case 'committed_transcript':
        // Final transcription results from ElevenLabs
        const committedText = message.text || message.transcript;
        if (committedText && committedText.trim()) {
          console.log(`📝 Scribe [FINAL]: "${committedText}" (confidence: ${message.confidence?.toFixed(4) || 'N/A'})`);
          
          // Clear auto-commit tracker when ElevenLabs sends final
          const connection = this.activeConnections.get(callControlId);
          if (connection) {
            connection.lastAutoCommittedText = null;
            connection.lastAutoCommitTime = null;
            connection.latestPartialTranscript = null;
            connection.lastPartialTime = null;
            console.log(`✅ Cleared all buffers (ElevenLabs sent final transcript)`);
          }
          
          this.emit('transcript', callControlId, {
            text: committedText,
            isFinal: true,
            confidence: message.confidence || 1.0
          });
        }
        break;

      case 'committed_transcript_with_timestamps':
        // Final transcription with word-level timestamps
        const timestampedText = message.text || message.transcript;
        if (timestampedText && timestampedText.trim()) {
          console.log(`📝 Scribe [FINAL+TIMESTAMPS]: "${timestampedText}"`);
          this.emit('transcript', callControlId, {
            text: timestampedText,
            isFinal: true,
            confidence: message.confidence || 1.0,
            words: message.words
          });
        }
        break;

      case 'auth_error':
        console.error(`❌ Scribe auth error for ${callControlId}: ${message.message}`);
        this.emit('error', callControlId, new Error('Authentication failed'));
        break;

      case 'quota_exceeded':
        console.error(`❌ Scribe quota exceeded for ${callControlId}`);
        this.emit('error', callControlId, new Error('Quota exceeded'));
        // Disconnect on quota exceeded to prevent further audio sending
        this.disconnect(callControlId);
        break;

      case 'queue_overflow':
        console.error(`❌ Scribe queue overflow for ${callControlId}: ${message.error || 'Audio data being sent too frequently'}`);
        console.error(`   Session terminated by ElevenLabs - stopping audio forwarding`);
        this.emit('error', callControlId, new Error(message.error || 'Queue overflow'));
        // 🔍 CRITICAL: Disconnect immediately on queue_overflow to prevent further audio sending
        // This prevents "No Scribe connection" errors when audio continues to arrive
        this.disconnect(callControlId);
        break;

      case 'transcriber_error':
      case 'input_error':
      case 'error':
        console.error(`❌ Scribe error for ${callControlId}:`);
        console.error(`   Error type: ${type}`);
        console.error(`   Full message:`, JSON.stringify(message, null, 2));
        this.emit('error', callControlId, new Error(message.message || message.error || 'Transcription error'));
        break;

      default:
        console.log(`📝 Scribe message (${type}):`, JSON.stringify(message, null, 2));
    }
  }

  /**
   * Send audio chunk to ElevenLabs Scribe
   * CRITICAL: Scribe requires 2 seconds of audio before processing starts!
   * Buffer initial audio, then send in proper JSON format
   */
  sendAudio(callControlId, audioData) {
    const connection = this.activeConnections.get(callControlId);
    
    if (!connection) {
      // Only log warning occasionally to avoid spam
      if (!this._noConnectionWarnings) this._noConnectionWarnings = new Map();
      const count = this._noConnectionWarnings.get(callControlId) || 0;
      if (count % 50 === 0) {
        console.warn(`⚠️  No Scribe connection for ${callControlId} (${count} packets dropped)`);
      }
      this._noConnectionWarnings.set(callControlId, count + 1);
      return;
    }
    
    // Clear warning counter once connected
    if (this._noConnectionWarnings) {
      this._noConnectionWarnings.delete(callControlId);
    }

    // Only send if connection is ready and open
    if (!connection.isReady) {
      // Track dropped packets before ready
      if (!this._notReadyDropped) this._notReadyDropped = new Map();
      const dropped = this._notReadyDropped.get(callControlId) || 0;
      if (dropped < 5) {
        console.warn(`⚠️  Scribe not ready for ${callControlId} - dropping audio packet (${dropped + 1} dropped)`);
      }
      this._notReadyDropped.set(callControlId, dropped + 1);
      return; // Drop packets until ready
    }
    
    if (connection.ws.readyState !== WebSocket.OPEN) {
      // Track dropped packets when WebSocket not open
      if (!this._wsClosedDropped) this._wsClosedDropped = new Map();
      const dropped = this._wsClosedDropped.get(callControlId) || 0;
      if (dropped < 5) {
        console.warn(`⚠️  Scribe WebSocket not open for ${callControlId} (state: ${connection.ws.readyState}) - dropping audio packet`);
      }
      this._wsClosedDropped.set(callControlId, dropped + 1);
      return; // Drop packets if WebSocket closed
    }
    
    // Clear dropped packet counters once connection is good
    if (this._notReadyDropped) {
      this._notReadyDropped.delete(callControlId);
    }
    if (this._wsClosedDropped) {
      this._wsClosedDropped.delete(callControlId);
    }

    // Update last audio received time (for silence detection)
    connection.lastAudioTime = Date.now();
    
    // Buffer audio chunks
    connection.audioBuffer.push(audioData);
    connection.audioBufferSize += audioData.length;
    
    // ⚡ OPTIMIZED TO PREVENT QUEUE OVERFLOW: Larger chunks = fewer sends = no queue overflow
    // For µ-law @ 8kHz: 160 bytes = 20ms, 400 bytes = 50ms, 800 bytes = 100ms, 1600 bytes = 200ms
    // Using 100ms chunks (800 bytes) balances latency and prevents queue overflow
    // This is better than rate limiting - we batch more efficiently without artificial delays
    const INITIAL_BUFFER_SIZE = 800; // 100ms initial buffer (good balance)
    const CHUNK_SIZE = 800; // 100ms chunks (reduces send frequency by 2x vs 50ms, prevents overflow)
    const MAX_BUFFER_SIZE = 8000; // 1 second max buffer (safety limit - prevents memory issues)
    
    // Safety check: if buffer grows too large, force send to prevent memory issues
    if (connection.audioBufferSize > MAX_BUFFER_SIZE) {
      console.warn(`⚠️  Audio buffer exceeded ${MAX_BUFFER_SIZE} bytes - forcing send to prevent memory issues`);
      const combinedBuffer = Buffer.concat(connection.audioBuffer);
      const chunk = combinedBuffer.slice(0, CHUNK_SIZE);
      
      this.sendAudioChunk(connection.ws, chunk);
      connection.lastSendTime = Date.now();
      connection._throttleWarned = false; // Reset throttle warning
      
      // Keep remainder
      const remainder = combinedBuffer.slice(CHUNK_SIZE);
      connection.audioBuffer = remainder.length > 0 ? [remainder] : [];
      connection.audioBufferSize = remainder.length;
      return;
    }
    
    // Send initial 100ms buffer
    if (!connection.initialBufferSent && connection.audioBufferSize >= INITIAL_BUFFER_SIZE) {
      const combinedBuffer = Buffer.concat(connection.audioBuffer);
      const initialChunk = combinedBuffer.slice(0, INITIAL_BUFFER_SIZE);
      
      console.log(`🎯 Sending INITIAL 100ms audio buffer (${initialChunk.length} bytes) - optimized to prevent queue overflow`);
      this.sendAudioChunk(connection.ws, initialChunk);
      connection.lastSendTime = Date.now();
      
      // Keep remainder
      const remainder = combinedBuffer.slice(INITIAL_BUFFER_SIZE);
      connection.audioBuffer = remainder.length > 0 ? [remainder] : [];
      connection.audioBufferSize = remainder.length;
      connection.initialBufferSent = true;
    }
    // After initial buffer, send in 100ms chunks with intelligent throttling
    else if (connection.initialBufferSent && connection.audioBufferSize >= CHUNK_SIZE) {
      const now = Date.now();
      const timeSinceLastSend = now - connection.lastSendTime;
      
      // ⚡ SMART THROTTLING: Only throttle if sending too fast (prevents overflow)
      // Minimum 80ms between sends (allows up to 12.5 sends/sec, well below queue limit)
      // This prevents queue overflow while maintaining low latency
      const MIN_SEND_INTERVAL_MS = 80; // 80ms = max 12.5 sends/sec (safe for ElevenLabs)
      
      if (timeSinceLastSend >= MIN_SEND_INTERVAL_MS) {
        // Safe to send - enough time has passed
        const combinedBuffer = Buffer.concat(connection.audioBuffer);
        const chunk = combinedBuffer.slice(0, CHUNK_SIZE);
        
        this.sendAudioChunk(connection.ws, chunk);
        connection.lastSendTime = now;
        connection._throttleWarned = false; // Reset throttle warning on successful send
        
        // Keep remainder
        const remainder = combinedBuffer.slice(CHUNK_SIZE);
        connection.audioBuffer = remainder.length > 0 ? [remainder] : [];
        connection.audioBufferSize = remainder.length;
      } else {
        // Throttling: buffer is growing, but we need to wait a bit
        // This is rare - only happens if audio arrives in bursts
        // Buffer will continue accumulating, we'll send when safe
        if (!connection._throttleWarned) {
          console.log(`⏸️  Throttling send (${timeSinceLastSend}ms since last, need ${MIN_SEND_INTERVAL_MS}ms) - buffer: ${connection.audioBufferSize} bytes`);
          connection._throttleWarned = true;
        }
      }
    }
  }

  /**
   * Check if we should auto-commit based on silence detection
   * This handles the case where ElevenLabs VAD doesn't commit
   */
  checkForAutoCommit(callControlId) {
    const connection = this.activeConnections.get(callControlId);
    
    if (!connection || !connection.latestPartialTranscript) {
      return;
    }
    
    const SILENCE_THRESHOLD_MS = 500; // Auto-commit after 500ms of silence (increased slightly to avoid premature commits)
    const MIN_TIME_BETWEEN_COMMITS_MS = 1500; // Don't auto-commit within 1.5 seconds of last commit (reduced for faster response)
    const timeSinceLastPartial = Date.now() - (connection.lastPartialTime || 0);
    const timeSinceLastCommit = Date.now() - (connection.lastAutoCommitTime || 0);
    
    // If we have a partial transcript and it's been silent for threshold time, emit as final
    if (timeSinceLastPartial > SILENCE_THRESHOLD_MS) {
      const transcript = connection.latestPartialTranscript;
      
      // Check if we already auto-committed this exact transcript
      if (connection.lastAutoCommittedText === transcript) {
        return; // Skip - already committed this text
      }
      
      // Throttle: Don't auto-commit if we just committed something recently
      // (ElevenLabs sends slightly different versions of same speech - "wait" vs "write")
      if (connection.lastAutoCommitTime && timeSinceLastCommit < MIN_TIME_BETWEEN_COMMITS_MS) {
        console.log(`⏸️  Throttling auto-commit: only ${timeSinceLastCommit}ms since last commit (need ${MIN_TIME_BETWEEN_COMMITS_MS}ms)`);
        return;
      }
      
      // Additional validation: require minimum length to reduce hallucinations
      const words = transcript.trim().split(/\s+/);
      const MIN_WORDS_FOR_COMMIT = 1; // Require at least 2 words for auto-commit (or important single words)
      
      if (words.length >= MIN_WORDS_FOR_COMMIT) {
        console.log(`🔁 Auto-committing partial transcript after ${timeSinceLastPartial}ms silence: "${transcript}"`);
        
        // Emit as final transcript
        this.emit('transcript', callControlId, {
          text: transcript,
          isFinal: true,
          confidence: 0.8, // Lower confidence for auto-committed partials
          autoCommitted: true
        });
        
        // Tell ElevenLabs to commit and clear its buffer
        this.sendCommitToElevenLabs(callControlId);
        
        // Track what we auto-committed to prevent duplicates
        connection.lastAutoCommittedText = transcript;
        connection.lastAutoCommitTime = Date.now();
        
        // IMMEDIATELY clear everything to prevent re-commits
        connection.latestPartialTranscript = null;
        connection.lastPartialTime = null;
        
        console.log(`✅ Cleared partial buffer - entering 2s cooldown`);
      } else {
        console.log(`⏭️  Skipping auto-commit of short transcript: "${transcript}" (${words.length} words, need ${MIN_WORDS_FOR_COMMIT})`);
        // Clear anyway to prevent stale data
        connection.latestPartialTranscript = null;
        connection.lastPartialTime = null;
      }
    }
  }

  /**
   * Send audio chunk to WebSocket as JSON with base64-encoded audio
   * Per ElevenLabs Scribe v2 documentation
   */
  sendAudioChunk(ws, audioData) {
    try {
      // Convert to base64
      const audioBase64 = audioData.toString('base64');
      
      // Log first audio chunk for debugging
      if (!this._firstChunkLogged) {
        console.log(`📨 Sending first audio chunk to Scribe (JSON with base64):`);
        console.log(`   Size: ${audioData.length} bytes µ-law @ 8kHz`);
        console.log(`   Duration: ${(audioData.length / 8000).toFixed(1)} seconds`);
        console.log(`   WebSocket readyState: ${ws.readyState} (1=OPEN)`);
        console.log(`   Format: JSON with base64-encoded audio (per ElevenLabs docs)`);
        
        this._firstChunkLogged = true;
      }
      
      // Log every audio send for first 10 chunks
      if (!this._audioChunksSent) this._audioChunksSent = 0;
      this._audioChunksSent++;
      // if (this._audioChunksSent <= 10) {
      //   console.log(`📤 Sending audio chunk #${this._audioChunksSent} (${audioData.length} bytes = ${(audioData.length / 8000).toFixed(1)}s)`);
      // }
      
      // Send as proper protocol message with message_type (required for raw WebSocket)
      // Per ElevenLabs documentation: https://elevenlabs.io/docs/api-reference/websockets
      ws.send(JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: audioBase64,
        commit: false,
        sample_rate: 8000
      }));
    } catch (error) {
      console.error(`❌ Error sending audio to Scribe:`, error);
    }
  }

  /**
   * Send commit signal to ElevenLabs (clears its buffer and starts fresh)
   */
  sendCommitToElevenLabs(callControlId) {
    const connection = this.activeConnections.get(callControlId);
    
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // Send commit message to tell ElevenLabs to finalize and clear its buffer
    console.log(`📤 Sending commit signal to ElevenLabs (clear buffer for next speech)`);
    try {
      connection.ws.send(JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: "",
        commit: true,
        sample_rate: 8000
      }));
    } catch (error) {
      console.error(`❌ Error sending commit to ElevenLabs:`, error);
    }
  }

  /**
   * Manually commit the current transcript segment
   * Sends a commit message to finalize the current segment
   */
  commit(callControlId) {
    const connection = this.activeConnections.get(callControlId);
    
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // Send commit message with proper message_type (required for raw WebSocket)
    console.log(`ℹ️  Committing final audio to ElevenLabs Scribe for ${callControlId}`);
    connection.ws.send(JSON.stringify({
      message_type: "input_audio_chunk",
      audio_base_64: "",
      commit: true,
      sample_rate: 8000
    }));
  }

  /**
   * Disconnect from ElevenLabs Scribe
   */
  disconnect(callControlId) {
    const connection = this.activeConnections.get(callControlId);
    
    if (!connection) {
      return;
    }

    try {
      // Clear silence check interval
      if (connection.silenceCheckInterval) {
        clearInterval(connection.silenceCheckInterval);
        connection.silenceCheckInterval = null;
      }
      
      if (connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.close();
      }
      this.activeConnections.delete(callControlId);
      console.log(`📝 Disconnected Scribe for ${callControlId}`);
    } catch (error) {
      console.error(`❌ Error disconnecting Scribe:`, error);
    }
  }

  /**
   * Disconnect all connections (cleanup on server shutdown)
   */
  disconnectAll() {
    for (const [callControlId] of this.activeConnections) {
      this.disconnect(callControlId);
    }
  }

  /**
   * Get human-readable description of WebSocket close code
   */
  getCloseCodeDescription(code) {
    const codes = {
      1000: 'Normal closure',
      1001: 'Going away',
      1002: 'Protocol error',
      1003: 'Unsupported data',
      1004: 'Reserved',
      1005: 'No status received',
      1006: 'Abnormal closure',
      1007: 'Invalid frame payload data',
      1008: 'Policy violation',
      1009: 'Message too big',
      1010: 'Mandatory extension',
      1011: 'Internal server error',
      1012: 'Service restart',
      1013: 'Try again later',
      1014: 'Bad gateway',
      1015: 'TLS handshake'
    };
    return codes[code] || 'Unknown';
  }
}

// Export singleton instance
module.exports = new ElevenLabsScribeService();

