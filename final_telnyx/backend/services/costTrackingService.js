/**
 * Cost Tracking Service
 * Calculates and tracks costs for Telnyx and OpenAI services
 * Now uses PostgreSQL for persistent storage
 */

const { query } = require('../config/database');

class CostTrackingService {
  constructor() {
    // Pricing (as of Dec 2024 - verified against official pricing)
    this.pricing = {
      telnyx: {
        outboundCallPerMinute: 0.002,        // $0.002 per minute (Telnyx Voice API)
        streamingPerMinute: 0.0035,          // $0.0035 per minute (Telnyx Bidirectional Streaming)
        transferCost: 0.10                   // $0.10 per invocation (flat fee, not per minute)
        // Note: Using ElevenLabs Scribe v2 for STT and ElevenLabs Turbo v2 for TTS via Telnyx bidirectional streaming
      },
      elevenlabs: {                          // NEW SECTION
        ttsPerSecond: 0.001,                 // $0.001 per second (Turbo v2 Flash) = $0.06 per minute
        sttPerHour: 0.39                     // $0.39 per hour (Scribe v2 Realtime) = $0.0065 per minute
      },
      openai: {
        'gpt-4o-mini': {
          inputPer1M: 0.15,               // $0.15 per 1M input tokens
          outputPer1M: 0.60               // $0.60 per 1M output tokens
        },
        'gpt-4-turbo-preview': {
          inputPer1M: 10.00,              // $10 per 1M input tokens
          outputPer1M: 30.00              // $30 per 1M output tokens
        },
        'gpt-4': {
          inputPer1M: 30.00,
          outputPer1M: 60.00
        }
      }
    };

    // Track costs per call (in-memory cache for active calls)
    this.callCosts = new Map(); // callControlId -> { telnyx, openai, total, breakdown }
    
    // Load existing costs from database on startup
    this.loadCosts();
  }

  /**
   * Load costs from PostgreSQL database
   */
  async loadCosts() {
    try {
      const result = await query(
        `SELECT call_control_id, * FROM costs ORDER BY created_at DESC LIMIT 1000`
      );
      
      // Restore costs from database to in-memory cache
      for (const row of result.rows) {
        const callId = row.call_control_id;
        this.callCosts.set(callId, {
          callControlId: callId,
          initiatedTime: row.initiated_time ? parseInt(row.initiated_time) : null,
          connectedTime: row.connected_time ? parseInt(row.connected_time) : null,
          endTime: row.end_time ? parseInt(row.end_time) : null,
          durationSeconds: row.duration_seconds || 0,
          transcriptionStarted: row.transcription_started || false,
          transcriptionStartTime: row.transcription_start_time ? parseInt(row.transcription_start_time) : null,
          telnyx: {
            callMinutes: parseFloat(row.telnyx_call_minutes) || 0,
            callCost: parseFloat(row.telnyx_call_cost) || 0,
            streamingMinutes: parseFloat(row.telnyx_streaming_minutes) || 0,
            streamingCost: parseFloat(row.telnyx_streaming_cost) || 0,
            transferCost: parseFloat(row.telnyx_transfer_cost) || 0,
            total: parseFloat(row.telnyx_total) || 0
          },
          elevenlabs: {
            ttsSeconds: (parseFloat(row.elevenlabs_tts_minutes) || 0) * 60, // Convert minutes to seconds
            ttsSecondsActual: (parseFloat(row.elevenlabs_tts_minutes) || 0) * 60,
            ttsMinutes: parseFloat(row.elevenlabs_tts_minutes) || 0, // Keep for backward compatibility
            ttsMinutesActual: parseFloat(row.elevenlabs_tts_minutes) || 0,
            ttsCost: parseFloat(row.elevenlabs_tts_cost) || 0,
            sttHours: parseFloat(row.elevenlabs_stt_hours) || 0,
            sttCost: parseFloat(row.elevenlabs_stt_cost) || 0,
            total: parseFloat(row.elevenlabs_total) || 0
          },
          openai: {
            model: row.openai_model || 'gpt-4o-mini',
            inputTokens: row.openai_input_tokens || 0,
            outputTokens: row.openai_output_tokens || 0,
            apiCalls: row.openai_api_calls || 0,
            cost: parseFloat(row.openai_cost) || 0
          },
          totalCost: parseFloat(row.total_cost) || 0,
          breakdown: row.breakdown || []
        });
      }
      
      console.log(`💾 Loaded ${this.callCosts.size} call costs from database`);
    } catch (error) {
      // Table doesn't exist yet (will be created by initializeDatabase)
      if (error.code === '42P01') {
        console.log('💾 Costs table not yet created, will load after database initialization');
      } else {
        console.warn('⚠️  Could not load costs from database:', error.message);
      }
    }
  }

  /**
   * Save costs to PostgreSQL database
   */
  async saveCosts() {
    // This method is kept for backward compatibility but now saves individual calls
    // Individual calls are saved in finalizeCallCost
    console.log(`💾 Cost tracking now uses PostgreSQL (${this.callCosts.size} calls in cache)`);
  }

  /**
   * Initialize cost tracking for a call
   */
  initializeCallCost(callControlId) {
    this.callCosts.set(callControlId, {
      callControlId,
      initiatedTime: Date.now(),  // When call was initiated (dialing started)
      connectedTime: null,         // When call was actually answered/connected
      endTime: null,
      durationSeconds: 0,
      transcriptionStarted: false,  // Track if transcription was actually started
      transcriptionStartTime: null,
      telnyx: {
        callMinutes: 0,
        callCost: 0,
        streamingMinutes: 0,        // NEW
        streamingCost: 0,            // NEW
        transferCost: 0,
        total: 0
      },
      elevenlabs: {                  // NEW SECTION
        ttsSeconds: 0,
        ttsSecondsActual: 0,          // Track actual seconds before rounding
        ttsMinutes: 0,                // Keep for backward compatibility
        ttsMinutesActual: 0,          // Keep for backward compatibility
        ttsCost: 0,
        sttHours: 0,
        sttCost: 0,
        total: 0
      },
      openai: {
        model: 'gpt-4o-mini',
        inputTokens: 0,
        outputTokens: 0,
        apiCalls: 0,
        cost: 0
      },
      totalCost: 0,
      breakdown: []
    });
  }

  /**
   * Track OpenAI API usage
   */
  trackOpenAIUsage(callControlId, model, inputTokens, outputTokens, operation = 'unknown') {
    const callCost = this.callCosts.get(callControlId);
    if (!callCost) {
      console.warn(`⚠️  No cost tracking initialized for call: ${callControlId}`);
      return;
    }

    // Get pricing for model
    const modelPricing = this.pricing.openai[model] || this.pricing.openai['gpt-4o-mini'];
    
    // Calculate cost
    const inputCost = (inputTokens / 1000000) * modelPricing.inputPer1M;
    const outputCost = (outputTokens / 1000000) * modelPricing.outputPer1M;
    const totalCost = inputCost + outputCost;

    // Update tracking
    callCost.openai.model = model;
    callCost.openai.inputTokens += inputTokens;
    callCost.openai.outputTokens += outputTokens;
    callCost.openai.apiCalls += 1;
    callCost.openai.cost += totalCost;

    // Add to breakdown
    callCost.breakdown.push({
      service: 'OpenAI',
      operation,
      model,
      inputTokens,
      outputTokens,
      cost: totalCost,
      timestamp: Date.now()
    });

    console.log(`💰 OpenAI cost: $${totalCost.toFixed(6)} (${inputTokens} in + ${outputTokens} out tokens) [${operation}]`);
  }

  /**
   * Mark that call has been connected (answered)
   * This is when Telnyx starts charging for call time
   */
  markCallConnected(callControlId) {
    const callCost = this.callCosts.get(callControlId);
    if (callCost) {
      callCost.connectedTime = Date.now();
      console.log(`📞 Call connected - starting billable time tracking`);
    }
  }

  /**
   * Mark that transcription has started for this call
   */
  markTranscriptionStarted(callControlId) {
    const callCost = this.callCosts.get(callControlId);
    if (callCost) {
      callCost.transcriptionStarted = true;
      callCost.transcriptionStartTime = Date.now();
    }
  }

  /**
   * Track AMD (Answering Machine Detection) usage
   * NOTE: AMD is now DISABLED - using custom STT-based voicemail detection instead
   * This function is kept for backwards compatibility but should not be called
   */
  trackAMD(callControlId, amdType = 'premium') {
    console.log(`ℹ️  AMD tracking called but AMD is disabled - using STT-based detection instead`);
    // No-op: AMD is disabled, no cost to track
  }

  /**
   * Track TTS usage (DEPRECATED - use trackElevenLabsTTS instead)
   * @param {string} callControlId - Call control ID
   * @param {number} duration - Duration in seconds (or minutes if old code, will be converted)
   */
  trackTTS(callControlId, duration) {
    // If duration seems like it's in minutes (very small number < 1), convert to seconds
    // Otherwise assume it's already in seconds
    // Note: This is a heuristic - ideally all callers should be updated
    const durationSeconds = duration < 1 ? duration * 60 : duration;
    // Redirect to new method for backward compatibility
    this.trackElevenLabsTTS(callControlId, durationSeconds);
  }

  /**
   * Track ElevenLabs TTS usage (duration-based, per second)
   * @param {string} callControlId - Call control ID
   * @param {number} durationSeconds - Duration in seconds (billed per second)
   */
  trackElevenLabsTTS(callControlId, durationSeconds) {
    const callCost = this.callCosts.get(callControlId);
    if (!callCost) return;

    // Initialize elevenlabs object if it doesn't exist
    if (!callCost.elevenlabs) {
      callCost.elevenlabs = {
        ttsSeconds: 0,        // Actual seconds (for tracking)
        ttsSecondsActual: 0,  // Track actual seconds before rounding
        ttsMinutes: 0,        // Keep for backward compatibility (converted from seconds)
        ttsMinutesActual: 0,  // Keep for backward compatibility
        ttsCost: 0,
        sttHours: 0,
        sttCost: 0,
        total: 0
      };
    }
    
    // Accumulate actual seconds (billed per second, no rounding needed)
    callCost.elevenlabs.ttsSecondsActual += durationSeconds;
    callCost.elevenlabs.ttsMinutesActual += durationSeconds / 60; // For backward compatibility
    
    // Calculate cost per second (no rounding - billed exactly per second)
    const cost = durationSeconds * this.pricing.elevenlabs.ttsPerSecond;
    
    // Track individual call for breakdown
    callCost.elevenlabs.ttsSeconds += durationSeconds;
    callCost.elevenlabs.ttsMinutes += durationSeconds / 60; // For backward compatibility
    callCost.elevenlabs.ttsCost += cost;

    callCost.breakdown.push({
      service: 'ElevenLabs TTS',
      operation: 'text-to-speech',
      seconds: durationSeconds,
      minutes: durationSeconds / 60,
      cost,
      timestamp: Date.now()
    });

    console.log(`💰 ElevenLabs TTS cost: $${cost.toFixed(6)} (${durationSeconds.toFixed(2)}s @ $${this.pricing.elevenlabs.ttsPerSecond}/sec)`);
  }

  /**
   * Track ElevenLabs STT usage (hour-based)
   * @param {string} callControlId - Call control ID
   * @param {number} durationMinutes - Duration in minutes (will be converted to hours)
   */
  trackElevenLabsSTT(callControlId, durationMinutes) {
    const callCost = this.callCosts.get(callControlId);
    if (!callCost) return;

    // Convert minutes to hours and round up for billing
    const durationHours = durationMinutes / 60;
    const billableHours = Math.ceil(durationHours * 100) / 100; // Round up to nearest 0.01 hour (36 seconds)
    const cost = billableHours * this.pricing.elevenlabs.sttPerHour;
    
    // Initialize elevenlabs object if it doesn't exist
    if (!callCost.elevenlabs) {
      callCost.elevenlabs = {
        ttsMinutes: 0,
        ttsCost: 0,
        sttHours: 0,
        sttCost: 0,
        total: 0
      };
    }
    
    callCost.elevenlabs.sttHours += billableHours;
    callCost.elevenlabs.sttCost += cost;

    callCost.breakdown.push({
      service: 'ElevenLabs STT',
      operation: 'speech-to-text',
      hours: billableHours,
      minutes: durationMinutes,
      cost,
      timestamp: Date.now()
    });

    console.log(`💰 ElevenLabs STT cost: $${cost.toFixed(6)} (${billableHours.toFixed(2)} hours @ $${this.pricing.elevenlabs.sttPerHour}/hour)`);
  }

  /**
   * Mark call as ended and calculate final costs
   */
  async finalizeCallCost(callControlId, transferred = false) {
    const callCost = this.callCosts.get(callControlId);
    if (!callCost) return null;

    // Calculate call duration - ONLY from when call was actually connected
    callCost.endTime = Date.now();
    
    if (callCost.connectedTime) {
      // Call was answered - calculate billable time from connection
      callCost.durationSeconds = Math.ceil((callCost.endTime - callCost.connectedTime) / 1000);
    } else {
      // Call was never answered (no answer, busy, rejected, invalid number)
      // Telnyx doesn't charge for ringing time
      callCost.durationSeconds = 0;
    }
    
    // Telnyx bills per minute, rounded UP (30s = 1 min, 90s = 2 min, etc.)
    const billableMinutes = callCost.durationSeconds > 0 ? Math.ceil(callCost.durationSeconds / 60) : 0;

    // Calculate Telnyx call costs (will be $0 if call was never connected)
    callCost.telnyx.callMinutes = billableMinutes;
    callCost.telnyx.callCost = billableMinutes * this.pricing.telnyx.outboundCallPerMinute;
    
    // Telnyx streaming cost (for bidirectional audio)
    callCost.telnyx.streamingMinutes = billableMinutes;
    callCost.telnyx.streamingCost = billableMinutes * this.pricing.telnyx.streamingPerMinute;
    
    // Transfer cost (Telnyx charges $0.10 flat fee per transfer invocation)
    if (transferred) {
      callCost.telnyx.transferCost = this.pricing.telnyx.transferCost;  // Flat $0.10 fee
    }

    // Calculate Telnyx total (call + streaming + transfer)
    callCost.telnyx.total = 
      callCost.telnyx.callCost + 
      callCost.telnyx.streamingCost +
      callCost.telnyx.transferCost;

    // Calculate ElevenLabs total (STT + TTS)
    if (callCost.elevenlabs) {
      // Recalculate TTS cost based on total actual seconds (billed per second, no rounding)
      // This ensures accurate billing when multiple TTS calls are made
      if (callCost.elevenlabs.ttsSecondsActual > 0) {
        const correctTtsCost = callCost.elevenlabs.ttsSecondsActual * this.pricing.elevenlabs.ttsPerSecond;
        
        // Only adjust if there's a significant difference (to avoid rounding errors)
        if (Math.abs(callCost.elevenlabs.ttsCost - correctTtsCost) > 0.0001) {
          console.log(`💰 Adjusting TTS cost: ${callCost.elevenlabs.ttsCost.toFixed(6)} → ${correctTtsCost.toFixed(6)}`);
          console.log(`   Actual TTS duration: ${callCost.elevenlabs.ttsSecondsActual.toFixed(2)}s (${(callCost.elevenlabs.ttsSecondsActual / 60).toFixed(3)} min)`);
          callCost.elevenlabs.ttsCost = correctTtsCost;
          callCost.elevenlabs.ttsSeconds = callCost.elevenlabs.ttsSecondsActual;
          callCost.elevenlabs.ttsMinutes = callCost.elevenlabs.ttsSecondsActual / 60; // For backward compatibility
        }
      }
      
      callCost.elevenlabs.total = callCost.elevenlabs.sttCost + callCost.elevenlabs.ttsCost;
    }

    // Calculate overall total
    callCost.totalCost = callCost.telnyx.total + (callCost.elevenlabs?.total || 0) + callCost.openai.cost;

    console.log(`💰 Final call cost: $${callCost.totalCost.toFixed(4)}`);
    console.log(`   Telnyx: $${callCost.telnyx.total.toFixed(4)} (${billableMinutes} min)`);
    console.log(`   ElevenLabs: $${(callCost.elevenlabs?.total || 0).toFixed(4)}`);
    console.log(`   OpenAI: $${callCost.openai.cost.toFixed(4)} (${callCost.openai.apiCalls} calls)`);

    // Save to PostgreSQL database
    try {
      await query(
        `INSERT INTO costs (
          call_control_id, initiated_time, connected_time, end_time,
          duration_seconds, transcription_started, transcription_start_time,
          telnyx_call_minutes, telnyx_call_cost, telnyx_streaming_minutes,
          telnyx_streaming_cost, telnyx_transfer_cost, telnyx_total,
          elevenlabs_tts_minutes, elevenlabs_tts_cost, elevenlabs_stt_hours,
          elevenlabs_stt_cost, elevenlabs_total,
          openai_model, openai_input_tokens, openai_output_tokens,
          openai_api_calls, openai_cost, total_cost, breakdown,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, NOW(), NOW())
        ON CONFLICT (call_control_id) 
        DO UPDATE SET
          connected_time = $3,
          end_time = $4,
          duration_seconds = $5,
          transcription_started = $6,
          transcription_start_time = $7,
          telnyx_call_minutes = $8,
          telnyx_call_cost = $9,
          telnyx_streaming_minutes = $10,
          telnyx_streaming_cost = $11,
          telnyx_transfer_cost = $12,
          telnyx_total = $13,
          elevenlabs_tts_minutes = $14,
          elevenlabs_tts_cost = $15,
          elevenlabs_stt_hours = $16,
          elevenlabs_stt_cost = $17,
          elevenlabs_total = $18,
          openai_model = $19,
          openai_input_tokens = $20,
          openai_output_tokens = $21,
          openai_api_calls = $22,
          openai_cost = $23,
          total_cost = $24,
          breakdown = $25,
          updated_at = NOW()`,
        [
          callControlId,
          callCost.initiatedTime,
          callCost.connectedTime,
          callCost.endTime,
          callCost.durationSeconds,
          callCost.transcriptionStarted,
          callCost.transcriptionStartTime,
          callCost.telnyx.callMinutes,
          callCost.telnyx.callCost,
          callCost.telnyx.streamingMinutes,
          callCost.telnyx.streamingCost,
          callCost.telnyx.transferCost,
          callCost.telnyx.total,
          callCost.elevenlabs?.ttsMinutes || 0,
          callCost.elevenlabs?.ttsCost || 0,
          callCost.elevenlabs?.sttHours || 0,
          callCost.elevenlabs?.sttCost || 0,
          callCost.elevenlabs?.total || 0,
          callCost.openai.model,
          callCost.openai.inputTokens,
          callCost.openai.outputTokens,
          callCost.openai.apiCalls,
          callCost.openai.cost,
          callCost.totalCost,
          JSON.stringify(callCost.breakdown || [])
        ]
      );
      console.log(`💾 Saved cost to database: ${callControlId}`);
    } catch (error) {
      console.error('❌ Error saving cost to database:', error.message);
    }

    return callCost;
  }

  /**
   * Get cost for specific call
   */
  getCallCost(callControlId) {
    return this.callCosts.get(callControlId);
  }

  /**
   * Get all call costs (from database)
   */
  async getAllCosts() {
    try {
      const result = await query(
        `SELECT call_control_id, * FROM costs ORDER BY created_at DESC`
      );
      
      return result.rows.map(row => ({
        callControlId: row.call_control_id,
        initiatedTime: row.initiated_time ? parseInt(row.initiated_time) : null,
        connectedTime: row.connected_time ? parseInt(row.connected_time) : null,
        endTime: row.end_time ? parseInt(row.end_time) : null,
        durationSeconds: row.duration_seconds || 0,
        transcriptionStarted: row.transcription_started || false,
        transcriptionStartTime: row.transcription_start_time ? parseInt(row.transcription_start_time) : null,
        telnyx: {
          callMinutes: parseFloat(row.telnyx_call_minutes) || 0,
          callCost: parseFloat(row.telnyx_call_cost) || 0,
          streamingMinutes: parseFloat(row.telnyx_streaming_minutes) || 0,
          streamingCost: parseFloat(row.telnyx_streaming_cost) || 0,
          transferCost: parseFloat(row.telnyx_transfer_cost) || 0,
          total: parseFloat(row.telnyx_total) || 0
        },
        elevenlabs: {
          ttsSeconds: (parseFloat(row.elevenlabs_tts_minutes) || 0) * 60, // Convert minutes to seconds
          ttsMinutes: parseFloat(row.elevenlabs_tts_minutes) || 0, // Keep for backward compatibility
          ttsCost: parseFloat(row.elevenlabs_tts_cost) || 0,
          sttHours: parseFloat(row.elevenlabs_stt_hours) || 0,
          sttCost: parseFloat(row.elevenlabs_stt_cost) || 0,
          total: parseFloat(row.elevenlabs_total) || 0
        },
        openai: {
          model: row.openai_model || 'gpt-4o-mini',
          inputTokens: row.openai_input_tokens || 0,
          outputTokens: row.openai_output_tokens || 0,
          apiCalls: row.openai_api_calls || 0,
          cost: parseFloat(row.openai_cost) || 0
        },
        totalCost: parseFloat(row.total_cost) || 0,
        breakdown: row.breakdown || []
      }));
    } catch (error) {
      console.error('❌ Error fetching costs from database:', error.message);
      return Array.from(this.callCosts.values()); // Fallback to cache
    }
  }

  /**
   * Get total costs across all calls
   */
  async getTotalCosts() {
    const allCosts = await this.getAllCosts();
    
    // Filter out failed/incomplete calls (calls with no AI interaction)
    // A successful call should have OpenAI API calls (meaning actual conversation happened)
    const successfulCalls = allCosts.filter(call => {
      return call.openai?.apiCalls > 0;
    });
    
    const total = {
      totalCalls: allCosts.length,
      successfulCalls: successfulCalls.length,
      totalCost: 0,
      telnyxTotal: 0,
      elevenlabsTotal: 0,      // NEW
      openaiTotal: 0,
      avgCostPerCall: 0,
      avgCostPerMinute: 0,
      breakdown: {
        callCost: 0,
        streamingCost: 0,       // NEW
        transferCost: 0,
        elevenlabsTTS: 0,       // NEW
        elevenlabsSTT: 0,       // NEW
        openaiCost: 0
      }
    };

    // Sum costs from ALL calls (including failed ones for accurate total tracking)
    for (const callCost of allCosts) {
      total.totalCost += callCost.totalCost || 0;
      total.telnyxTotal += callCost.telnyx?.total || 0;
      total.elevenlabsTotal += callCost.elevenlabs?.total || 0;
      total.openaiTotal += callCost.openai?.cost || 0;
      
      total.breakdown.callCost += callCost.telnyx?.callCost || 0;
      total.breakdown.streamingCost += callCost.telnyx?.streamingCost || 0;
      total.breakdown.transferCost += callCost.telnyx?.transferCost || 0;
      total.breakdown.elevenlabsTTS += callCost.elevenlabs?.ttsCost || 0;
      total.breakdown.elevenlabsSTT += callCost.elevenlabs?.sttCost || 0;
      total.breakdown.openaiCost += callCost.openai?.cost || 0;
    }

    // Calculate average based on successful calls only
    // Sum only the costs and durations from successful calls for a more accurate average
    let successfulCallsCost = 0;
    let successfulCallsMinutes = 0;
    for (const callCost of successfulCalls) {
      successfulCallsCost += callCost.totalCost || 0;
      successfulCallsMinutes += (callCost.durationSeconds || 0) / 60;
    }
    
    if (successfulCalls.length > 0) {
      total.avgCostPerCall = successfulCallsCost / successfulCalls.length;
      // Calculate cost per minute (total cost / total minutes)
      if (successfulCallsMinutes > 0) {
        total.avgCostPerMinute = successfulCallsCost / successfulCallsMinutes;
      }
    }

    return total;
  }

  /**
   * Clear cost tracking for a call
   */
  clearCallCost(callControlId) {
    this.callCosts.delete(callControlId);
  }

  /**
   * Clear all cost tracking
   */
  async clearAllCosts() {
    try {
      await query('DELETE FROM costs');
      this.callCosts.clear();
      console.log('🗑️  All costs cleared from database');
    } catch (error) {
      console.error('❌ Error clearing costs:', error.message);
    }
  }
}

// Export singleton instance
module.exports = new CostTrackingService();

