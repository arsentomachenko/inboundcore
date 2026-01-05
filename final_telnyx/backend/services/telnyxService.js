const telnyx = require('telnyx')(process.env.TELNYX_API_KEY);
const axios = require('axios');
const costTracking = require('./costTrackingService');

class TelnyxService {
  constructor() {
    this.activeStreams = new Map();
    this.elevenLabsSecretRegistered = false;
    this.cachedPurchasedNumbers = null; // Cache purchased numbers
    this.cachedPurchasedNumbersTime = null; // Cache timestamp
    this.CACHE_DURATION = 5 * 60 * 1000; // Cache for 5 minutes
  }

  /**
   * Register ElevenLabs API key with Telnyx as integration secret
   * This only needs to be done once
   */
  async registerElevenLabsSecret() {
    if (this.elevenLabsSecretRegistered) {
      return; // Already registered in this session
    }

    try {
      const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
      if (!elevenLabsKey) {
        console.warn('⚠️  ELEVENLABS_API_KEY not found in environment');
        return;
      }

      console.log('🔐 Registering ElevenLabs API key with Telnyx...');
      console.log(`   API Key: ${elevenLabsKey.substring(0, 10)}...${elevenLabsKey.substring(elevenLabsKey.length - 4)}`);
      
      // First, try to get existing secrets to check if it's already there
      try {
        const listResponse = await axios.get(
          'https://api.telnyx.com/v2/integration_secrets',
          {
            headers: {
              'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
            }
          }
        );
        
        const existingSecret = listResponse.data.data?.find(
          secret => secret.identifier === 'elevenlabs' || secret.identifier === 'elevenlabs_api_key'
        );
        
        if (existingSecret) {
          console.log(`✅ ElevenLabs integration secret already exists with identifier: ${existingSecret.identifier}`);
          
          // Note: Cannot update existing secrets via API, need to delete and recreate
          // For now, we'll just use the existing secret
          console.log('ℹ️  Using existing ElevenLabs integration secret');
          
          this.elevenLabsSecretRegistered = true;
          return existingSecret;
        }
      } catch (listError) {
        console.log('   Could not check existing secrets, will try to create new one...');
      }
      
      // Try with 'elevenlabs' identifier first (most common format)
      try {
        const response = await axios.post(
          'https://api.telnyx.com/v2/integration_secrets',
          {
            identifier: 'elevenlabs_api_key',
            value: elevenLabsKey
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
            }
          }
        );

        this.elevenLabsSecretRegistered = true;
        console.log('✅ ElevenLabs API key registered with Telnyx (identifier: elevenlabs)');
        return response.data;
      } catch (createError) {
        // If 'elevenlabs' fails, try 'elevenlabs_api_key'
        if (createError.response?.status === 422 && !createError.response?.data?.errors?.some(e => e.code === 'identifier_taken')) {
          console.log('   Trying alternative identifier: elevenlabs_api_key...');
          const response = await axios.post(
            'https://api.telnyx.com/v2/integration_secrets',
            {
              identifier: 'elevenlabs_api_key',
              value: elevenLabsKey
            },
            {
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
              }
            }
          );

          this.elevenLabsSecretRegistered = true;
          console.log('✅ ElevenLabs API key registered with Telnyx (identifier: elevenlabs_api_key)');
          return response.data;
        } else {
          throw createError;
        }
      }
    } catch (error) {
      // If secret already exists, that's fine
      if (error.response?.status === 422 || error.response?.data?.errors?.[0]?.code === 'identifier_taken') {
        console.log('✅ ElevenLabs API key already registered with Telnyx');
        this.elevenLabsSecretRegistered = true;
      } else if (error.response?.status === 401 || error.response?.status === 403) {
        // Account blocked or authentication failed - log but don't crash
        console.error('❌ Error registering ElevenLabs secret:');
        console.error('   Status:', error.response?.status);
        console.error('   Response:', JSON.stringify(error.response?.data || error.message, null, 2));
        console.warn('⚠️  Telnyx account authentication failed. Server will continue but ElevenLabs integration may not work.');
        // Don't throw - allow server to continue running
      } else {
        console.error('❌ Error registering ElevenLabs secret:');
        console.error('   Status:', error.response?.status);
        console.error('   Response:', JSON.stringify(error.response?.data || error.message, null, 2));
        console.warn('⚠️  Failed to register ElevenLabs secret. Server will continue but ElevenLabs integration may not work.');
        // Don't throw - allow server to continue running
      }
    }
  }

  /**
   * Initiate an outbound call
   */
  /**
   * Normalize phone number to E.164 format
   */
  normalizePhoneNumber(phoneNumber) {
    if (!phoneNumber) return null;
    
    // Remove all non-digit characters except +
    let cleaned = phoneNumber.toString().replace(/[^\d+]/g, '');
    
    // If it doesn't start with +, add it
    if (!cleaned.startsWith('+')) {
      // Assume US/Canada numbers (country code 1) if 10 or 11 digits
      if (cleaned.length === 10) {
        cleaned = '+1' + cleaned;
      } else if (cleaned.length === 11 && cleaned.startsWith('1')) {
        cleaned = '+' + cleaned;
      } else {
        cleaned = '+' + cleaned;
      }
    }
    
    return cleaned;
  }

  async initiateCall(toNumber, fromNumber, userInfo) {
    try {
      // Normalize phone numbers to E.164 format
      const normalizedTo = this.normalizePhoneNumber(toNumber);
      const normalizedFrom = this.normalizePhoneNumber(fromNumber);
      
      console.log(`📞 Initiating call: ${normalizedFrom} -> ${normalizedTo}`);
      if (toNumber !== normalizedTo) {
        console.log(`   ✅ Normalized 'to': ${toNumber} → ${normalizedTo}`);
      }
      console.log(`   Connection ID: ${process.env.TELNYX_CONNECTION_ID}`);
      
      const response = await telnyx.calls.create({
        connection_id: process.env.TELNYX_CONNECTION_ID,
        to: normalizedTo,
        from: normalizedFrom,
        webhook_url: `${process.env.WEBHOOK_BASE_URL}/webhooks/telnyx`,
        webhook_url_method: 'POST',
        
        // Note: AMD removed - using custom STT-based voicemail detection
        // This saves $0.0065 per call and provides faster, more accurate detection
        
        client_state: Buffer.from(JSON.stringify({
          userInfo,
          fromNumber: normalizedFrom,  // Store normalized DID used for this call
          timestamp: Date.now()
        })).toString('base64')
      });

      // The Telnyx SDK returns data in response.data
      const callData = response.data || response;
      console.log(`✅ Call initiated: ${callData.call_control_id}`);
      
      // Return the call data directly for easier access
      return callData;
    } catch (error) {
      console.error('❌ Error initiating call:', error.message || error);
      console.error('   Status Code:', error.statusCode);
      console.error('   Request ID:', error.requestId);
      
      // Extract the actual error details from the errors array
      if (error.raw && error.raw.errors && error.raw.errors.length > 0) {
        console.error('   📋 Error Details:', JSON.stringify(error.raw.errors, null, 2));
      }
      
      throw error;
    }
  }

  /**
   * Answer an incoming call
   */
  async answerCall(callControlId) {
    try {
      const result = await telnyx.calls.answer({
        call_control_id: callControlId
      });
      console.log(`✅ Call answered: ${callControlId}`);
      return result;
    } catch (error) {
      console.error('❌ Error answering call:', error.raw?.errors || error.message);
      throw error;
    }
  }

  /**
   * Start streaming audio (WebSocket for low latency)
   */
  async startStreaming(callControlId, streamUrl) {
    try {
      const result = await telnyx.calls.stream({
        call_control_id: callControlId,
        stream_url: streamUrl || `wss://${process.env.WEBHOOK_BASE_URL.replace('https://', '')}/media`,
        stream_track: 'both_tracks',
        enable_dialogflow: false
      });
      
      console.log(`🔊 Streaming started: ${callControlId}`);
      return result;
    } catch (error) {
      console.error('Error starting stream:', error);
      throw error;
    }
  }

  /**
   * Stop streaming
   */
  async stopStreaming(callControlId) {
    try {
      const result = await telnyx.calls.stopStream({
        call_control_id: callControlId
      });
      
      console.log(`🛑 Streaming stopped: ${callControlId}`);
      return result;
    } catch (error) {
      console.error('Error stopping stream:', error);
      throw error;
    }
  }

  /**
   * Start Speech-to-Text
   */
  async startTranscription(callControlId) {
    try {
      // Use the REST API directly for transcription
      const axios = require('axios');
      const result = await axios.post(
        `https://api.telnyx.com/v2/calls/${callControlId}/actions/transcription_start`,
        {
          language: 'en',
          transcription_engine: 'deepgram',  // Deepgram STT engine
          transcription_engine_config: {
            model: 'nova-2'  // Deepgram Nova 2 model for low-latency, real-time transcription
          },
          transcription_track: 'inbound'  // Capture caller's audio only (singular, not plural)
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log(`📝 Transcription started successfully`);
      console.log(`   Call Control ID: ${callControlId}`);
      console.log(`   Engine: Deepgram Nova 2 (low-latency, real-time transcription)`);
      console.log(`   Track: inbound`);
      console.log(`   Response:`, JSON.stringify(result.data, null, 2));
      return result.data;
    } catch (error) {
      console.error('❌ Error starting transcription:');
      if (error.response?.data?.errors) {
        console.error('   Errors:', JSON.stringify(error.response.data.errors, null, 2));
      } else {
        console.error('   ', error.response?.data || error.message);
      }
      throw error;
    }
  }

  /**
   * Start BIDIRECTIONAL audio streaming (for use with external STT/TTS like ElevenLabs)
   * Enables both receiving audio from caller AND sending audio back through WebSocket
   */
  async startStreaming(callControlId, websocketUrl) {
    try {
      const axios = require('axios');
      const result = await axios.post(
        `https://api.telnyx.com/v2/calls/${callControlId}/actions/streaming_start`,
        {
          stream_url: websocketUrl,
          stream_track: 'inbound_track',  // Stream caller's audio to us
          enable_dialogflow: false,
          
          // ✨ BIDIRECTIONAL STREAMING - Send audio back to caller
          stream_bidirectional_mode: 'rtp',  // RTP for lowest latency (vs mp3)
          stream_bidirectional_codec: 'PCMU',  // µ-law @ 8kHz (matches inbound format)
          stream_bidirectional_target_legs: 'self',  // Send audio back to the caller
          stream_bidirectional_sampling_rate: 8000  // 8kHz standard phone quality
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log(`🎙️  BIDIRECTIONAL audio streaming started successfully`);
      console.log(`   Call Control ID: ${callControlId}`);
      console.log(`   Stream URL: ${websocketUrl}`);
      console.log(`   Inbound Track: caller audio → us`);
      console.log(`   Bidirectional: us → caller via RTP`);
      console.log(`   Codec: PCMU (µ-law) @ 8kHz`);
      console.log(`   Response:`, JSON.stringify(result.data, null, 2));
      return result.data;
    } catch (error) {
      console.error('❌ Error starting bidirectional audio streaming:');
      if (error.response?.data?.errors) {
        console.error('   Errors:', JSON.stringify(error.response.data.errors, null, 2));
      } else {
        console.error('   ', error.response?.data || error.message);
      }
      throw error;
    }
  }

  /**
   * Stop audio streaming
   */
  async stopStreaming(callControlId) {
    try {
      const axios = require('axios');
      const result = await axios.post(
        `https://api.telnyx.com/v2/calls/${callControlId}/actions/streaming_stop`,
        {},
        {
          headers: {
            'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log(`🎙️  Audio streaming stopped: ${callControlId}`);
      return result.data;
    } catch (error) {
      console.error('❌ Error stopping streaming:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Stop Speech-to-Text
   */
  async stopTranscription(callControlId) {
    try {
      const axios = require('axios');
      const result = await axios.post(
        `https://api.telnyx.com/v2/calls/${callControlId}/actions/transcription_stop`,
        {},
        {
          headers: {
            'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log(`🛑 Transcription stopped: ${callControlId}`);
      return result.data;
    } catch (error) {
      console.error('Error stopping transcription:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Speak text using ElevenLabs TTS via Telnyx
   * Format: ElevenLabs.<voice-id>
   * Voice IDs can be found in your ElevenLabs dashboard
   * Popular voices:
   *   - ElevenLabs.pNInz6obpgDQGcFmaJgB (Adam - male, American)
   *   - ElevenLabs.21m00Tcm4TlvDq8ikWAM (Rachel - female, American)
   *   - ElevenLabs.AZnzlk1XvdvUeBnXmlld (Domi - female, American)
   */
  async speak(callControlId, text, voice = null) {
    try {
      // Ensure ElevenLabs API key is registered with Telnyx
      await this.registerElevenLabsSecret();
      
      // Get voice from environment or use default
      // Note: Voice format should be ElevenLabs.<voice-id> or ElevenLabs.Default.<voice-id>
      // The voice ID should match a voice in your ElevenLabs account
      const defaultVoice = process.env.ELEVENLABS_VOICE || 'ElevenLabs.pNInz6obpgDQGcFmaJgB';
      const selectedVoice = voice || defaultVoice;
      
      console.log(`🎙️  Attempting to speak on call: ${callControlId}`);
      console.log(`   Voice: ${selectedVoice}`);
      console.log(`   Text length: ${text.length} characters`);
      console.log(`   First 100 chars: "${text.substring(0, 100)}..."`);
      
      // Use direct REST API to send ElevenLabs TTS command via Telnyx
      const result = await axios.post(
        `https://api.telnyx.com/v2/calls/${callControlId}/actions/speak`,
        {
          payload: text,
          voice: selectedVoice,
          voice_settings: {
            api_key_ref: 'elevenlabs_api_key'
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log(`✅ ElevenLabs TTS command sent successfully`);
      
      // Track TTS cost
      costTracking.trackTTS(callControlId, text.length);
      
      return result.data;
      
    } catch (error) {
      console.error('❌ Error speaking with ElevenLabs:', error.response?.data || error.message);
      console.error('   Call Control ID:', callControlId);
      if (error.response?.data?.errors) {
        console.error('   Errors:', JSON.stringify(error.response.data.errors, null, 2));
      }
      throw error;
    }
  }

  /**
   * Transfer call to another number
   */
  async transferCall(callControlId, toNumber, fromNumber = null) {
    try {
      console.log(`📲 Attempting to transfer call:`);
      console.log(`   Call Control ID: ${callControlId}`);
      console.log(`   From: ${fromNumber || 'auto'}`);
      console.log(`   To: ${toNumber}`);
      
      const payload = { to: toNumber };
      
      // ⭐ CRITICAL FIX: Use the original DID number that called the user
      // Priority: 1) fromNumber (original DID), 2) VERIFIED_TRANSFER_NUMBER env, 3) First purchased number, 4) Don't set 'from'
      if (fromNumber && fromNumber !== 'auto' && fromNumber !== null) {
        // Use the original DID number that was used to call the user
        // This number is already active in the call, so it should work for transfers
        payload.from = fromNumber;
        console.log(`   📞 Using original DID number from call: ${fromNumber}`);
        console.log(`   ✅ This is the same number that called the user - should work for transfer`);
      } else {
        // Fallback: Try to get a verified number
        const transferFromNumber = await this.getTransferNumber();
        if (transferFromNumber) {
          payload.from = transferFromNumber;
          console.log(`   📞 Using fallback number for transfer: ${transferFromNumber}`);
          if (process.env.VERIFIED_TRANSFER_NUMBER) {
            console.log(`   ✅ Using VERIFIED_TRANSFER_NUMBER from environment`);
          } else {
            console.log(`   ✅ Using first purchased number from Telnyx account`);
          }
        } else {
          // Don't set 'from' - let Telnyx handle it
          console.log(`   📞 NOT setting 'from' field - Telnyx will determine caller ID automatically`);
          console.log(`   ⚠️  If you get "Unverified origination number" error, the original DID may need verification`);
        }
      }
      
      // ⭐ FIX: Set timeout for transfer call (how long to wait for agent to answer)
      // Default is 30 seconds, but we'll use 60 seconds to give agent more time
      // Minimum is 5 seconds, maximum is 600 seconds (10 minutes)
      payload.timeout_secs = 60;
      console.log(`   ⏱️  Transfer timeout: 60 seconds (agent has 60s to answer)`);
      
      // Mark this as a transfer call so we don't initialize AI conversation with agent
      const clientState = Buffer.from(JSON.stringify({ isTransfer: true })).toString('base64');
      payload.client_state = clientState;
      
      console.log(`   Payload:`, JSON.stringify(payload, null, 2));
      
      // Use direct REST API instead of SDK (like speak and transcription)
      const result = await axios.post(
        `https://api.telnyx.com/v2/calls/${callControlId}/actions/transfer`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log(`✅ Call transferred successfully: ${callControlId} -> ${toNumber}`);
      return result.data;
    } catch (error) {
      console.error('❌ ============= TRANSFER ERROR DETAILS =============');
      console.error('   Call Control ID:', callControlId);
      console.error('   To Number:', toNumber);
      console.error('   From Number:', fromNumber || 'auto');
      console.error('   HTTP Status:', error.response?.status);
      console.error('   Status Text:', error.response?.statusText);
      
      if (error.response?.data?.errors) {
        console.error('   🔴 Telnyx Error Details:');
        error.response.data.errors.forEach((err, index) => {
          console.error(`      Error ${index + 1}:`);
          console.error(`         Code: ${err.code || 'N/A'}`);
          console.error(`         Title: ${err.title || 'N/A'}`);
          console.error(`         Detail: ${err.detail || 'N/A'}`);
          console.error(`         Source: ${JSON.stringify(err.source) || 'N/A'}`);
        });
      } else {
        console.error('   Error message:', error.message);
      }
      console.error('================================================');
      
      // Check if it's a call state error (call already ended/transferred)
      const isCallStateError = error.response?.status === 403 || 
                               error.response?.status === 404 ||
                               error.response?.data?.errors?.some(e => 
                                 e.code === 'call_already_bridged' || 
                                 e.code === 'call_not_found' ||
                                 e.title?.includes('call') ||
                                 e.detail?.includes('call')
                               );
      
      // ⭐ FIX: Also check for unverified number error (code 10010)
      const isUnverifiedNumberError = error.response?.data?.errors?.some(e => 
        e.code === '10010' || 
        e.detail?.includes('Unverified origination number') ||
        e.detail?.includes('unverified')
      );
      
      if (isUnverifiedNumberError) {
        console.error('❌ Transfer failed: Unverified origination number');
        console.error('   💡 The number being used as caller ID is not verified for outbound calls in Telnyx');
        console.error('   💡 Solutions:');
        console.error('      1. Verify your DID numbers in Telnyx Portal:');
        console.error('         - Go to https://portal.telnyx.com/#/app/numbers');
        console.error('         - Select your numbers and verify them for outbound calls');
        console.error('      2. Set VERIFIED_TRANSFER_NUMBER env variable to a verified number');
        console.error('      3. Use a number that is already verified for outbound calls');
        console.error('   📞 Note: Purchased numbers may still need verification for outbound/transfer calls');
        // Don't throw - return null so caller can handle gracefully
        return null;
      }
      
      if (isCallStateError) {
        console.warn('⚠️  Call may have already ended or been transferred - this is not critical');
        // Don't throw for call state errors - call might have ended naturally
        return null;
      }
      
      throw error;
    }
  }


  /**
   * Hangup call
   */
  async hangupCall(callControlId) {
    try {
      console.log(`📵 Attempting to hang up call: ${callControlId}`);
      
      // Use direct REST API instead of SDK
      const result = await axios.post(
        `https://api.telnyx.com/v2/calls/${callControlId}/actions/hangup`,
        {},
        {
          headers: {
            'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log(`✅ Call ended successfully: ${callControlId}`);
      return result.data;
    } catch (error) {
      console.error('❌ Error hanging up call:', error.response?.data || error.message);
      console.error('   Call Control ID:', callControlId);
      if (error.response?.data?.errors) {
        console.error('   Errors:', JSON.stringify(error.response.data.errors, null, 2));
      }
      // Don't throw - call might already be hung up
      console.warn('⚠️  Continuing despite hangup error (call may already be ended)');
    }
  }

  /**
   * Get available phone numbers
   */
  async getAvailableNumbers(areaCode = null) {
    try {
      const params = {
        filter: {
          limit: 50,
          features: ['voice', 'sms']
        }
      };

      if (areaCode) {
        params.filter.national_destination_code = areaCode;
      }

      const numbers = await telnyx.availablePhoneNumbers.list(params);
      return numbers.data;
    } catch (error) {
      console.error('Error fetching available numbers:', error);
      throw error;
    }
  }

  /**
   * Get purchased phone numbers (with caching)
   */
  async getPurchasedNumbers(useCache = true) {
    // Return cached data if still valid
    if (useCache && this.cachedPurchasedNumbers && this.cachedPurchasedNumbersTime) {
      const cacheAge = Date.now() - this.cachedPurchasedNumbersTime;
      if (cacheAge < this.CACHE_DURATION) {
        return this.cachedPurchasedNumbers;
      }
    }

    try {
      // Use direct REST API for better error handling
      const result = await axios.get(
        'https://api.telnyx.com/v2/phone_numbers',
        {
          headers: {
            'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
            'Content-Type': 'application/json'
          },
          params: {
            'page[size]': 250
          }
        }
      );
      
      // Cache the results
      this.cachedPurchasedNumbers = result.data.data;
      this.cachedPurchasedNumbersTime = Date.now();
      
      return result.data.data;
    } catch (error) {
      console.error('❌ Error fetching purchased numbers:');
      console.error('   Status:', error.response?.status);
      console.error('   Message:', error.response?.data?.errors?.[0]?.detail || error.message);
      
      // Return cached data if available, even if stale
      if (this.cachedPurchasedNumbers) {
        console.warn('⚠️  Using cached phone number list...');
        return this.cachedPurchasedNumbers;
      }
      
      // Return empty array instead of throwing - this is not critical
      console.warn('⚠️  Continuing without phone number list...');
      return [];
    }
  }

  /**
   * Get a purchased number to use for transfers
   * Returns the first available purchased number, or null if none available
   */
  async getTransferNumber() {
    // First check env variable
    const verifiedTransferNumber = process.env.VERIFIED_TRANSFER_NUMBER;
    if (verifiedTransferNumber) {
      return verifiedTransferNumber;
    }

    // Otherwise, get first purchased number
    try {
      const numbers = await this.getPurchasedNumbers();
      if (numbers && numbers.length > 0) {
        const firstNumber = numbers[0].phone_number;
        console.log(`   📞 Using first purchased number for transfer: ${firstNumber}`);
        return firstNumber;
      }
    } catch (error) {
      console.error('   ⚠️  Error getting purchased numbers for transfer:', error.message);
    }

    return null;
  }

  /**
   * Purchase a phone number
   */
  async purchaseNumber(phoneNumber) {
    try {
      const result = await telnyx.phoneNumbers.create({
        phone_number: phoneNumber,
        connection_id: process.env.TELNYX_CONNECTION_ID
      });
      
      console.log(`✅ Number purchased: ${phoneNumber}`);
      return result;
    } catch (error) {
      console.error('Error purchasing number:', error);
      throw error;
    }
  }
}

module.exports = new TelnyxService();

