/**
 * ElevenLabs Text-to-Speech Service (Direct API)
 * 
 * This service calls ElevenLabs TTS API directly to get audio streams
 * for use with Telnyx bidirectional streaming.
 * 
 * Uses streaming API for lowest latency (audio chunks arrive as they're generated)
 */

const axios = require('axios');
const { Readable } = require('stream');

class ElevenLabsTTSService {
  constructor() {
    this.apiKey = process.env.ELEVENLABS_API_KEY;
    
    // Normalize voice ID (remove Telnyx format prefix if present)
    let voiceId = process.env.ELEVENLABS_VOICE || 'pNInz6obpgDQGcFmaJgB'; // Adam voice
    this.voiceId = this.normalizeVoiceId(voiceId);
    
    this.baseUrl = 'https://api.elevenlabs.io/v1';
    
    // Track active TTS requests
    this.activeRequests = new Map();
    
    console.log('✅ ElevenLabs TTS Service initialized');
    console.log(`   Voice ID: ${this.voiceId}`);
    console.log(`   API Key: ${this.apiKey ? this.apiKey.substring(0, 10) + '...' : 'NOT SET'}`);
  }

  /**
   * Normalize voice ID to ElevenLabs API format
   * Removes "ElevenLabs.Default." or "ElevenLabs." prefix (Telnyx format)
   * 
   * @param {string} voiceId - Voice ID in any format
   * @returns {string} - Voice ID in ElevenLabs API format
   */
  normalizeVoiceId(voiceId) {
    if (!voiceId) return 'pNInz6obpgDQGcFmaJgB'; // Default Adam voice
    
    // Remove Telnyx format prefixes
    if (voiceId.startsWith('ElevenLabs.Default.')) {
      return voiceId.replace('ElevenLabs.Default.', '');
    } else if (voiceId.startsWith('ElevenLabs.')) {
      return voiceId.replace('ElevenLabs.', '');
    }
    
    return voiceId;
  }

  /**
   * Convert text to speech using ElevenLabs streaming API
   * Returns a stream of audio chunks as they're generated (lowest latency)
   * 
   * @param {string} text - Text to convert to speech
   * @param {object} options - TTS options
   * @param {string} options.voiceId - Override default voice ID
   * @param {string} options.model - Model to use (default: eleven_turbo_v2 for lowest latency)
   * @param {number} options.stability - Voice stability (0-1, default: 0.5)
   * @param {number} options.similarity_boost - Voice similarity boost (0-1, default: 0.75)
   * @param {boolean} options.optimize_streaming_latency - Optimize for streaming latency (0-4, default: 4)
   * @returns {Promise<Stream>} - Readable stream of audio data (MP3 format)
   */
  async textToSpeechStream(text, options = {}) {
    // Normalize voice ID (remove Telnyx format prefix if present)
    const voiceId = this.normalizeVoiceId(options.voiceId || this.voiceId);
    const model = options.model || 'eleven_turbo_v2';  // Fastest model for low latency
    
    console.log(`🎙️  ElevenLabs TTS: Converting text to speech (streaming)`);
    console.log(`   Text length: ${text.length} characters`);
    console.log(`   Voice ID: ${voiceId}`);
    console.log(`   Model: ${model} (low latency)`);
    console.log(`   First 100 chars: "${text.substring(0, 100)}..."`);
    
    try {
      const response = await axios.post(
        `${this.baseUrl}/text-to-speech/${voiceId}/stream`,
        {
          text: text,
          model_id: model,
          voice_settings: {
            stability: options.stability !== undefined ? options.stability : 0.65,  // Better stability
            similarity_boost: options.similarity_boost !== undefined ? options.similarity_boost : 0.8,  // Better clarity
            style: options.style || 0,
            use_speaker_boost: options.use_speaker_boost !== undefined ? options.use_speaker_boost : true
          },
          // Optimize for balanced quality/latency
          optimize_streaming_latency: options.optimize_streaming_latency !== undefined 
            ? options.optimize_streaming_latency 
            : 3  // Balanced (3 = better quality than 4, still fast)
        },
        {
          headers: {
            'Accept': 'audio/mpeg',  // MP3 format (will need conversion to PCMU)
            'xi-api-key': this.apiKey,
            'Content-Type': 'application/json'
          },
          responseType: 'stream'  // Get streaming response for lowest latency
        }
      );
      
      console.log(`✅ ElevenLabs TTS stream started (receiving audio chunks...)`);
      
      // Track stream size for logging
      let totalBytes = 0;
      response.data.on('data', (chunk) => {
        totalBytes += chunk.length;
      });
      
      response.data.on('end', () => {
        console.log(`✅ ElevenLabs TTS stream completed: ${totalBytes} bytes received`);
      });
      
      response.data.on('error', (error) => {
        console.error(`❌ ElevenLabs TTS stream error:`, error);
      });
      
      return response.data;  // Returns a readable stream
      
    } catch (error) {
      console.error('❌ Error calling ElevenLabs TTS API:');
      console.error('   Status:', error.response?.status);
      console.error('   Message:', error.response?.data || error.message);
      
      if (error.response?.status === 401) {
        console.error('   🔑 Check your ELEVENLABS_API_KEY in .env file');
      }
      
      throw error;
    }
  }

  /**
   * Convert text to speech and get complete audio buffer
   * (Non-streaming version, waits for complete audio before returning)
   * 
   * @param {string} text - Text to convert to speech
   * @param {object} options - TTS options (same as textToSpeechStream)
   * @returns {Promise<Buffer>} - Complete audio buffer in MP3 format
   */
  async textToSpeech(text, options = {}) {
    const stream = await this.textToSpeechStream(text, options);
    
    return new Promise((resolve, reject) => {
      const chunks = [];
      
      stream.on('data', (chunk) => {
        chunks.push(chunk);
      });
      
      stream.on('end', () => {
        const buffer = Buffer.concat(chunks);
        console.log(`✅ ElevenLabs TTS complete: ${buffer.length} bytes`);
        resolve(buffer);
      });
      
      stream.on('error', reject);
    });
  }

  /**
   * Get list of available voices from ElevenLabs
   * Useful for testing different voices
   * 
   * @returns {Promise<Array>} - Array of voice objects
   */
  async getVoices() {
    try {
      const response = await axios.get(
        `${this.baseUrl}/voices`,
        {
          headers: {
            'xi-api-key': this.apiKey
          }
        }
      );
      
      return response.data.voices;
    } catch (error) {
      console.error('❌ Error fetching ElevenLabs voices:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get voice details by ID
   * 
   * @param {string} voiceId - Voice ID to look up
   * @returns {Promise<Object>} - Voice details
   */
  async getVoice(voiceId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/voices/${voiceId}`,
        {
          headers: {
            'xi-api-key': this.apiKey
          }
        }
      );
      
      return response.data;
    } catch (error) {
      console.error(`❌ Error fetching voice ${voiceId}:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Cancel active TTS request
   * 
   * @param {string} requestId - Request ID to cancel
   */
  cancelRequest(requestId) {
    const request = this.activeRequests.get(requestId);
    if (request) {
      request.abort();
      this.activeRequests.delete(requestId);
      console.log(`🛑 Cancelled ElevenLabs TTS request: ${requestId}`);
    }
  }
}

module.exports = new ElevenLabsTTSService();

