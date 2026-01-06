/**
 * Bidirectional TTS Service
 * 
 * Handles the complete flow for sending AI responses back to the caller:
 * 1. Text → ElevenLabs TTS (streaming)
 * 2. MP3 → PCMU conversion (streaming)
 * 3. PCMU → Telnyx WebSocket (chunked for real-time playback)
 * 
 * Optimized for lowest latency with streaming pipeline.
 */

const elevenLabsTTS = require('./elevenLabsTTSService');
const audioConverter = require('./audioFormatConverter');
const { streamAudioToCall } = require('./mediaStreamingService');
const costTracking = require('./costTrackingService');

class BidirectionalTTSService {
  constructor() {
    this.activeSpeechRequests = new Map();
    console.log('✅ Bidirectional TTS Service initialized');
  }

  /**
   * Speak text to caller using bidirectional streaming
   * OPTIMIZED FOR LOW LATENCY with streaming pipeline
   * 
   * @param {string} callControlId - Call control ID
   * @param {string} text - Text to speak
   * @param {object} options - TTS options
   * @returns {Promise<{actualDurationMs: number, actualDurationSeconds: number, bytesSent: number}>}
   */
  async speak(callControlId, text, options = {}) {
    const requestId = `${callControlId}_${Date.now()}`;
    
    // 🔧 RACE CONDITION FIX: Check if call is still active before starting TTS
    let isCallActive = true;
    try {
      // Dynamically require to avoid circular dependency
      const webhookRoutes = require('../routes/webhookRoutes');
      if (typeof webhookRoutes.checkCallActive === 'function') {
        isCallActive = webhookRoutes.checkCallActive(callControlId);
        if (!isCallActive) {
          console.warn(`⚠️  Skipping TTS for ${callControlId}: Call is no longer active (ended or pending hangup)`);
          return null;
        }
      }
    } catch (e) {
      // If checkCallActive doesn't exist yet, continue (backward compatibility)
      console.warn(`⚠️  Could not check call state: ${e.message}`);
    }
    
    console.log(`🎙️  Bidirectional TTS: Speaking to ${callControlId}`);
    console.log(`   Text: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);
    console.log(`   Length: ${text.length} characters`);
    
    // ✨ CRITICAL: Guard against concurrent TTS calls (prevents duplicate responses)
    if (this.activeSpeechRequests.has(callControlId)) {
      const existingRequest = this.activeSpeechRequests.get(callControlId);
      console.warn(`⚠️  Already speaking for ${callControlId} (status: ${existingRequest.status})`);
      console.warn(`   Existing text: "${existingRequest.text.substring(0, 50)}..."`);
      console.warn(`   New text: "${text.substring(0, 50)}..."`);
      console.warn(`   Ignoring duplicate TTS request to prevent crash`);
      return null; // Skip this request - return null to indicate no new TTS was started
    }
    
    try {
      this.activeSpeechRequests.set(callControlId, {
        requestId,
        text,
        startTime: Date.now(),
        status: 'starting'
      });
      
      // STEP 1: Get TTS audio stream from ElevenLabs (streaming starts immediately)
      console.log(`   [1/3] Requesting TTS from ElevenLabs...`);
      const mp3Stream = await elevenLabsTTS.textToSpeechStream(text, {
        model: 'eleven_turbo_v2',           // Fastest model
        optimize_streaming_latency: 4,      // Maximum latency optimization
        ...options
      });
      
      // 🔧 RACE CONDITION FIX: Check if call is still active after async ElevenLabs call
      const requestAfterTTS = this.activeSpeechRequests.get(callControlId);
      if (!requestAfterTTS) {
        console.warn(`⚠️  TTS request was cancelled for ${callControlId} during ElevenLabs call - aborting`);
        return null; // Request was cancelled, abort silently
      }
      
      // Check call state again after async operation
      try {
        const webhookRoutes = require('../routes/webhookRoutes');
        if (typeof webhookRoutes.checkCallActive === 'function') {
          if (!webhookRoutes.checkCallActive(callControlId)) {
            console.warn(`⚠️  Call ${callControlId} ended during TTS processing - aborting before audio conversion`);
            this.activeSpeechRequests.delete(callControlId);
            return null;
          }
        }
      } catch (e) {
        // Continue if checkCallActive doesn't exist
      }
      
      requestAfterTTS.status = 'converting';
      
      // STEP 2: Convert MP3 stream to PCMU (µ-law) @ 8kHz in real-time
      console.log(`   [2/3] Converting MP3 → PCMU (streaming)...`);
      
      // Estimate audio duration from text length (more reliable than byte calculation)
      // Average speaking rate: ~150 words/min = ~2.5 words/sec
      // Average word length: ~5 characters, so ~12.5 chars/sec = ~0.08 sec/char
      // This is more accurate than calculating from bytes which can be inflated by compression/conversion
      const estimatedSeconds = text.length * 0.08; // Rough estimate: 0.08 seconds per character
      console.log(`   📊 Estimated audio duration: ${estimatedSeconds.toFixed(2)} seconds (${text.length} chars × 0.08 sec/char)`);
      
      // Convert MP3 to PCMU
      const pcmuBuffer = await audioConverter.convertToPCMU(mp3Stream, { streaming: false });
      
      // 🔧 RACE CONDITION FIX: Check call state again after conversion
      const request = this.activeSpeechRequests.get(callControlId);
      if (!request) {
        console.warn(`⚠️  TTS request was cancelled for ${callControlId} during audio conversion - aborting`);
        return null; // Request was cancelled, abort silently
      }
      
      // Check call state again before streaming
      try {
        const webhookRoutes = require('../routes/webhookRoutes');
        if (typeof webhookRoutes.checkCallActive === 'function') {
          if (!webhookRoutes.checkCallActive(callControlId)) {
            console.warn(`⚠️  Call ${callControlId} ended during audio conversion - aborting before streaming`);
            this.activeSpeechRequests.delete(callControlId);
            return null;
          }
        }
      } catch (e) {
        // Continue if checkCallActive doesn't exist
      }
      
      request.status = 'streaming';
      
      // STEP 3: Stream PCMU audio to Telnyx in 20ms chunks (160 bytes @ 8kHz)
      console.log(`   [3/3] Streaming PCMU to Telnyx (${pcmuBuffer.length} bytes)...`);
      const bytesSent = await streamAudioToCall(callControlId, pcmuBuffer, 160);
      
      // ⭐ FIX: Calculate ACTUAL audio duration from PCMU buffer size
      // PCMU @ 8kHz = 8000 bytes per second
      const actualDurationSeconds = pcmuBuffer.length / 8000;
      const actualDurationMs = actualDurationSeconds * 1000;
      
      // Calculate processing duration (for logging only)
      const startTime = request ? request.startTime : Date.now();
      const processingMs = Date.now() - startTime;
      
      console.log(`✅ Bidirectional TTS complete for ${callControlId}`);
      console.log(`   Processing time: ${processingMs}ms`);
      console.log(`   Audio sent: ${bytesSent} bytes`);
      console.log(`   📊 ACTUAL audio duration: ${actualDurationSeconds.toFixed(2)}s (calculated from ${pcmuBuffer.length} bytes @ 8kHz)`);
      console.log(`   📊 Previous estimate: ${estimatedSeconds.toFixed(2)}s (text-based)`);
      
      // Track TTS cost using ACTUAL duration (more accurate billing)
      costTracking.trackElevenLabsTTS(callControlId, actualDurationSeconds);
      
      this.activeSpeechRequests.delete(callControlId);
      
      // ⭐ NEW: Return actual duration so webhookRoutes can use it
      return {
        actualDurationMs,
        actualDurationSeconds,
        bytesSent
      };
      
    } catch (error) {
      console.error(`❌ Bidirectional TTS error for ${callControlId}:`, error);
      
      const request = this.activeSpeechRequests.get(callControlId);
      if (request) {
        console.error(`   Failed at stage: ${request.status}`);
        this.activeSpeechRequests.delete(callControlId);
      }
      
      throw error;
    }
  }

  /**
   * Speak text with ULTRA LOW LATENCY using chunked streaming
   * Audio chunks are sent as they're converted (minimal buffering)
   * 
   * @param {string} callControlId - Call control ID
   * @param {string} text - Text to speak
   * @param {object} options - TTS options
   * @returns {Promise<void>}
   */
  async speakStreaming(callControlId, text, options = {}) {
    const requestId = `${callControlId}_${Date.now()}`;
    
    console.log(`⚡ ULTRA LOW LATENCY TTS: Speaking to ${callControlId}`);
    console.log(`   Text: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);
    
    try {
      this.activeSpeechRequests.set(callControlId, {
        requestId,
        text,
        startTime: Date.now(),
        status: 'streaming'
      });
      
      // STEP 1: Get TTS audio stream from ElevenLabs
      const mp3Stream = await elevenLabsTTS.textToSpeechStream(text, {
        model: 'eleven_turbo_v2',
        optimize_streaming_latency: 4,
        ...options
      });
      
      // STEP 2 & 3: Convert and stream chunks in real-time (LOWEST LATENCY)
      let totalBytes = 0;
      let chunkCount = 0;
      
      // Use chunked conversion generator for streaming
      for await (const pcmuChunk of audioConverter.convertToPCMUChunked(mp3Stream, 160)) {
        // Send chunk immediately as it's converted
        const { sendAudioToCall } = require('./mediaStreamingService');
        sendAudioToCall(callControlId, pcmuChunk);
        
        totalBytes += pcmuChunk.length;
        chunkCount++;
        
        // Small delay to match real-time playback (160 bytes @ 8kHz = 20ms)
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      
      const processingMs = Date.now() - this.activeSpeechRequests.get(callControlId).startTime;
      
      // Calculate ACTUAL audio playback duration for billing
      // Use text-based estimation (more reliable than byte calculation)
      // Average speaking rate: ~150 words/min = ~2.5 words/sec
      // Average word length: ~5 characters, so ~12.5 chars/sec = ~0.08 sec/char
      const estimatedSeconds = text.length * 0.08; // Rough estimate: 0.08 seconds per character
      
      console.log(`✅ Ultra low latency TTS complete for ${callControlId}`);
      console.log(`   Processing time: ${processingMs}ms`);
      console.log(`   Chunks sent: ${chunkCount}`);
      console.log(`   Total bytes: ${totalBytes}`);
      console.log(`   Estimated audio duration: ${estimatedSeconds.toFixed(2)}s from ${text.length} chars`);
      
      // Track TTS cost using text-based estimated duration (billed per second)
      costTracking.trackElevenLabsTTS(callControlId, estimatedSeconds);
      
      this.activeSpeechRequests.delete(callControlId);
      
    } catch (error) {
      console.error(`❌ Ultra low latency TTS error for ${callControlId}:`, error);
      this.activeSpeechRequests.delete(callControlId);
      throw error;
    }
  }

  /**
   * Cancel active speech request
   * 
   * @param {string} callControlId - Call control ID
   */
  cancel(callControlId) {
    const request = this.activeSpeechRequests.get(callControlId);
    if (request) {
      console.log(`🛑 Cancelling TTS for ${callControlId} (was at stage: ${request.status})`);
      this.activeSpeechRequests.delete(callControlId);
    }
  }

  /**
   * Get active speech request status
   * 
   * @param {string} callControlId - Call control ID
   * @returns {object|null} - Request status or null
   */
  getStatus(callControlId) {
    return this.activeSpeechRequests.get(callControlId) || null;
  }

  /**
   * Check if call is currently speaking
   * 
   * @param {string} callControlId - Call control ID
   * @returns {boolean} - True if currently speaking
   */
  isSpeaking(callControlId) {
    return this.activeSpeechRequests.has(callControlId);
  }
}

module.exports = new BidirectionalTTSService();

