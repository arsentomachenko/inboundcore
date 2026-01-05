/**
 * Deepgram STT Service
 * Handles real-time speech-to-text using Deepgram Live API with Telnyx streaming
 */

console.error(`🚨🚨🚨 DEEPGRAM MODULE LOADING... 🚨🚨��`);

const { createClient } = require("@deepgram/sdk");
const EventEmitter = require('events');

// Test import on startup
try {
  console.log(`🔍 Testing Deepgram SDK import...`);
  const testDeepgram = createClient(process.env.DEEPGRAM_API_KEY || 'test');
  console.log(`✅ Deepgram SDK imported and initialized successfully`);
} catch (error) {
  console.error(`❌ CRITICAL: Failed to import/initialize Deepgram SDK:`, error);
  console.error(`   Error message: ${error.message}`);
  console.error(`   Error stack: ${error.stack}`);
}

class DeepgramScribeService extends EventEmitter {
  constructor() {
    super();
    this.activeConnections = new Map(); // callControlId -> { deepgramLive, buffer }
    this.apiKey = process.env.DEEPGRAM_API_KEY;
    
    if (!this.apiKey) {
      console.warn('⚠️  DEEPGRAM_API_KEY not configured! STT will not work.');
    }
  }

  /**
   * Connect to Deepgram for a specific call
   */
  async connect(callControlId) {
    console.log(`🔍 Deepgram connect() called for ${callControlId}`);
    console.log(`   Active connections: ${this.activeConnections.size}`);
    console.log(`   Already has connection: ${this.activeConnections.has(callControlId)}`);
    
    if (this.activeConnections.has(callControlId)) {
      const existing = this.activeConnections.get(callControlId);
      console.log(`⚠️  Deepgram already connected for ${callControlId}`);
      console.log(`   Existing connection state: ${existing.deepgramLive ? 'EXISTS' : 'NO CONNECTION'}`);
      return;
    }

    if (!this.apiKey) {
      console.error(`❌ DEEPGRAM_API_KEY not configured! Cannot connect to Deepgram.`);
      throw new Error('DEEPGRAM_API_KEY environment variable is required');
    }

    console.log(`🔗 Connecting to Deepgram for ${callControlId}...`);
    console.log(`   API Key: ${this.apiKey ? this.apiKey.substring(0, 10) + '...' : 'NOT SET'}`);

    return new Promise((resolve, reject) => {
      try {
        const deepgram = createClient(this.apiKey);
        
        // Create Deepgram live transcription connection
        const deepgramLive = deepgram.listen.live({
          punctuate: true,
          interim_results: true,
          encoding: "mulaw",
          sample_rate: 8000,
          model: "general-polaris",
          channels: 1
        });

        const connection = {
          deepgramLive,
          isReady: false,
          resolveConnection: null,
          audioBuffer: Buffer.alloc(0),
          connectedAt: Date.now()
        };

        this.activeConnections.set(callControlId, connection);

        // Timeout for connection
        const connectionTimeout = setTimeout(() => {
          if (!connection.isReady) {
            console.error(`❌ Deepgram connection timeout for ${callControlId}`);
            deepgramLive.finish();
            this.activeConnections.delete(callControlId);
            reject(new Error('Connection timeout after 10 seconds'));
          }
        }, 10000);

        // Store resolve callback to call after connection is ready
        connection.resolveConnection = resolve;

        // Deepgram connection opened
        deepgramLive.addListener('open', () => {
          clearTimeout(connectionTimeout);
          console.log(`📝 Deepgram connection OPEN for call: ${callControlId}`);
          console.log(`   WebSocket readyState: ${deepgramLive.getReadyState()}`);
          
          connection.isReady = true;
          connection.connectedAt = Date.now();
          
          // Resolve connection promise
          if (connection.resolveConnection) {
            connection.resolveConnection();
            connection.resolveConnection = null;
            console.log(`   ✅ Connection promise resolved - ready to start streaming!`);
          }
          
          this.emit('connected', callControlId);
        });

        // Listen for transcription from Deepgram
        // In v3, the event name is "Results" (from LiveTranscriptionEvents.Transcript = "Results")
        deepgramLive.on("Results", (data) => {
          try {
            // In v3, data is already a parsed JSON object, not a string
            // Log first few messages for debugging
            if (!this._deepgramMessagesLogged) this._deepgramMessagesLogged = new Map();
            const count = this._deepgramMessagesLogged.get(callControlId) || 0;
            if (count < 5) {
              console.log(`🔍 Deepgram Results message #${count + 1} for ${callControlId}:`, JSON.stringify(data, null, 2).substring(0, 500));
              this._deepgramMessagesLogged.set(callControlId, count + 1);
            }
            
            this.handleDeepgramMessage(callControlId, data);
          } catch (error) {
            console.error(`❌ Error processing Deepgram Results:`, error);
            console.error(`   Data:`, JSON.stringify(data, null, 2).substring(0, 200));
          }
        });

        // Also listen for Metadata and other events for debugging
        deepgramLive.on("Metadata", (data) => {
          console.log(`📊 Deepgram Metadata for ${callControlId}:`, JSON.stringify(data, null, 2).substring(0, 200));
        });

        deepgramLive.on("UtteranceEnd", (data) => {
          console.log(`�� Deepgram UtteranceEnd for ${callControlId}:`, JSON.stringify(data, null, 2).substring(0, 200));
        });

        // Deepgram connection closed
        deepgramLive.addListener('close', () => {
          clearTimeout(connectionTimeout);
          console.log(`📝 Deepgram connection closed for call: ${callControlId}`);
          
          if (this.activeConnections.has(callControlId)) {
            this.activeConnections.delete(callControlId);
          }
          
          this.emit('disconnected', callControlId);
          
          // If close happens before open, reject the promise
          if (!connection.isReady) {
            reject(new Error(`Deepgram connection closed before opening`));
          }
        });

        // Deepgram error
        deepgramLive.addListener('error', (error) => {
          clearTimeout(connectionTimeout);
          console.error(`❌ Deepgram error for ${callControlId}:`);
          console.error(`   Error:`, error);
          this.emit('error', callControlId, error);
          this.activeConnections.delete(callControlId);
          reject(error);
        });

      } catch (error) {
        console.error(`❌ Error creating Deepgram connection:`, error);
        this.activeConnections.delete(callControlId);
        reject(error);
      }
    });
  }

  /**
   * Handle messages from Deepgram
   */
  handleDeepgramMessage(callControlId, data) {
    // Deepgram response structure can vary:
    // - Metadata: { type: "Metadata", ... }
    // - Results: { type: "Results", channel: { alternatives: [{ transcript: "...", words: [...] }] }, is_final: true/false }
    // - Error: { type: "Error", ... }
    
    // Skip metadata and error messages
    if (data.type === 'Metadata' || data.type === 'Error') {
      return;
    }
    
    // Handle Results messages
    if (data.type === 'Results' || data.channel) {
      if (!data.channel || !data.channel.alternatives || data.channel.alternatives.length === 0) {
        return;
      }

      const transcript = data.channel.alternatives[0].transcript;
      // is_final can be at the top level or in the channel
      const isFinal = data.is_final !== undefined ? data.is_final : (data.channel.is_final || false);
      
      if (!transcript || transcript.trim().length === 0) {
        return;
      }

      if (isFinal) {
        // Final transcription
        console.log(`📝 Deepgram [FINAL]: "${transcript}"`);
        this.emit('transcript', callControlId, {
          text: transcript,
          isFinal: true,
          confidence: 0.9 // Deepgram doesn't always provide confidence, default to 0.9
        });
      } else {
        // Interim/partial transcription
        console.log(`📝 Deepgram [PARTIAL]: "${transcript}"`);
        this.emit('partial', callControlId, {
          text: transcript,
          isFinal: false
        });
      }
    }
  }

  /**
   * Send audio chunk to Deepgram
   * Based on reference code: buffer 10 chunks of 160 bytes (1600 bytes total) before sending
   */
  sendAudio(callControlId, audioData) {
    const connection = this.activeConnections.get(callControlId);
    
    if (!connection) {
      // Only log warning occasionally to avoid spam
      if (!this._noConnectionWarnings) this._noConnectionWarnings = new Map();
      const count = this._noConnectionWarnings.get(callControlId) || 0;
      if (count % 50 === 0) {
        console.warn(`⚠️  No Deepgram connection for ${callControlId} (${count} packets dropped)`);
      }
      this._noConnectionWarnings.set(callControlId, count + 1);
      return;
    }
    
    // Clear warning counter once connected
    if (this._noConnectionWarnings) {
      this._noConnectionWarnings.delete(callControlId);
    }

    // Only send if connection is ready
    if (!connection.isReady) {
      return; // Drop early packets silently
    }

    // Check if Deepgram WebSocket is ready
    const readyState = connection.deepgramLive.getReadyState();
    if (readyState !== 1) { // 1 = OPEN
      return; // Not ready yet
    }

    // Buffer audio chunks (from reference code: send 10 chunks of 160 bytes = 1600 bytes)
    connection.audioBuffer = Buffer.concat([connection.audioBuffer, audioData]);
    
    // Send when buffer reaches 1600 bytes (10 chunks of 160 bytes)
    if (Buffer.byteLength(connection.audioBuffer) >= 1600) {
      const chunk = connection.audioBuffer.slice(0, 1600);
      const remainder = connection.audioBuffer.slice(1600);
      
      // Log first few sends for debugging
      if (!this._audioChunksSent) this._audioChunksSent = new Map();
      const sentCount = this._audioChunksSent.get(callControlId) || 0;
      if (sentCount < 5) {
        console.log(`📤 Sending audio chunk #${sentCount + 1} to Deepgram (${chunk.length} bytes)`);
        this._audioChunksSent.set(callControlId, sentCount + 1);
      }
      
      try {
        connection.deepgramLive.send(chunk);
      } catch (error) {
        console.error(`❌ Error sending audio to Deepgram:`, error);
      }
      
      // Keep remainder in buffer
      connection.audioBuffer = remainder;
    }
  }

  /**
   * Manually commit the current transcript segment (not needed for Deepgram, but kept for compatibility)
   */
  commit(callControlId) {
    // Deepgram handles commits automatically, but we can keep this for compatibility
    console.log(`ℹ️  Commit called for ${callControlId} (Deepgram handles this automatically)`);
  }

  /**
   * Disconnect from Deepgram
   */
  disconnect(callControlId) {
    const connection = this.activeConnections.get(callControlId);
    
    if (!connection) {
      return;
    }

    try {
      if (connection.deepgramLive) {
        connection.deepgramLive.finish();
      }
      this.activeConnections.delete(callControlId);
      console.log(`📝 Disconnected Deepgram for ${callControlId}`);
    } catch (error) {
      console.error(`❌ Error disconnecting Deepgram:`, error);
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
}

// Export singleton instance
module.exports = new DeepgramScribeService();

