/**
 * Conversation Tracking Service
 * Saves full call conversations (AI Agent + Lead dialogue) to PostgreSQL
 */

const { query } = require('../config/database');
const openaiService = require('./openaiService');

class ConversationService {
  constructor() {
    this.activeConversations = new Map(); // callControlId -> conversation object
    this.finalizedCalls = new Set(); // Track finalized calls to prevent duplicate finalization
  }

  /**
   * Initialize conversation for a new call
   */
  initializeConversation(callControlId, fromNumber, toNumber) {
    // ⚠️ FIX: Prevent duplicate initialization - check if conversation already exists
    if (this.activeConversations.has(callControlId)) {
      console.log(`⚠️  Conversation already initialized for ${callControlId} - skipping duplicate initialization`);
      return;
    }
    
    this.activeConversations.set(callControlId, {
      callControlId,
      fromNumber,
      toNumber,
      startTime: Date.now(),
      endTime: null,
      duration: 0,
      cost: 0,
      model: 'gpt-4o-mini',
      messages: [],  // Array of {speaker: 'AI'|'Lead', text: '', timestamp: }
      status: 'active'
    });
    console.log(`💬 Conversation initialized: ${callControlId}`);
  }

  /**
   * Add message to active conversation
   */
  addMessage(callControlId, speaker, text) {
    const conversation = this.activeConversations.get(callControlId);
    if (!conversation) {
      console.warn(`⚠️  No active conversation for: ${callControlId}`);
      return;
    }

    conversation.messages.push({
      speaker, // 'AI' or 'Lead'
      text,
      timestamp: Date.now()
    });

    const preview = text.length > 50 ? text.substring(0, 50) + '...' : text;
    console.log(`💬 Message added [${speaker}]: "${preview}"`);
  }

  /**
   * Finalize conversation when call ends - saves to PostgreSQL
   */
  async finalizeConversation(callControlId, costData = null, transferred = false, hangupCause = null) {
    // 🔍 CRITICAL FIX: Prevent duplicate finalization during concurrent calls
    if (this.finalizedCalls.has(callControlId)) {
      console.log(`⚠️  Conversation already finalized for ${callControlId} - skipping duplicate finalization`);
      return null;
    }
    
    const conversation = this.activeConversations.get(callControlId);
    if (!conversation) {
      console.warn(`⚠️  No conversation to finalize for: ${callControlId}`);
      return null;
    }
    
    // 🔧 RACE CONDITION FIX: Wait for active TTS operations to complete
    // This prevents finalizing conversation while TTS is still trying to add messages
    try {
      const bidirectionalTTS = require('./bidirectionalTTSService');
      if (bidirectionalTTS.isSpeaking && bidirectionalTTS.isSpeaking(callControlId)) {
        console.log(`⏳ Waiting for active TTS to complete for ${callControlId} before finalizing...`);
        // Wait up to 5 seconds for TTS to complete
        const maxWait = 5000;
        const startWait = Date.now();
        while (bidirectionalTTS.isSpeaking(callControlId) && (Date.now() - startWait) < maxWait) {
          await new Promise(resolve => setTimeout(resolve, 100)); // Check every 100ms
        }
        if (bidirectionalTTS.isSpeaking(callControlId)) {
          console.warn(`⚠️  TTS still active after ${maxWait}ms wait - proceeding with finalization anyway`);
        } else {
          console.log(`✅ TTS completed, proceeding with finalization`);
        }
      }
    } catch (e) {
      // If bidirectionalTTS doesn't exist or error, continue anyway
      console.warn(`⚠️  Could not check TTS status: ${e.message}`);
    }
    
    // Mark as finalized immediately to prevent race conditions
    this.finalizedCalls.add(callControlId);

    conversation.endTime = Date.now();
    conversation.duration = Math.ceil((conversation.endTime - conversation.startTime) / 1000);
    
    // 🔍 CRITICAL FIX FOR CONCURRENT CALLS: If messages are empty but TTS costs exist,
    // try to recover messages from OpenAI state BEFORE determining status
    // This handles race conditions where finalizeConversation runs before addMessage completes
    if (conversation.messages.length === 0) {
      const hasTTSCost = costData?.telnyx?.ttsCost > 0 || costData?.elevenlabs?.ttsCost > 0;
      if (hasTTSCost) {
        const conversationState = openaiService.getConversationState(callControlId);
        if (conversationState?.messages) {
          // Recover AI assistant messages from OpenAI state
          let recoveredCount = 0;
          conversationState.messages.forEach((msg, index) => {
            if (msg.role === 'assistant' && msg.content && typeof msg.content === 'string') {
              conversation.messages.push({
                speaker: 'AI',
                text: msg.content,
                timestamp: conversation.startTime + (index * 1000) // Approximate timestamp
              });
              recoveredCount++;
            }
          });
          if (recoveredCount > 0) {
            console.log(`   ✅ Recovered ${recoveredCount} AI message(s) from OpenAI state for concurrent call`);
          } else {
            // Recovery attempted but no messages found - add placeholder to show call was answered
            conversation.messages.push({
              speaker: 'AI',
              text: '[AI agent spoke but messages were not captured - Call was answered but no user response]',
              timestamp: conversation.startTime
            });
            console.log(`   ⚠️  TTS cost indicates AI spoke but no messages in OpenAI state - added placeholder`);
          }
        } else {
          // No OpenAI state available - add placeholder to show call was answered
          conversation.messages.push({
            speaker: 'AI',
            text: '[AI agent spoke but messages were not captured - Call was answered but no user response]',
            timestamp: conversation.startTime
          });
          console.log(`   ⚠️  TTS cost indicates AI spoke but no OpenAI state available - added placeholder`);
        }
      }
    }
    
    // Store detailed cost breakdown
    if (costData && typeof costData === 'object') {
      conversation.cost = costData.totalCost || 0;
      conversation.costBreakdown = {
        total: costData.totalCost || 0,
        telnyx: costData.telnyx?.total || 0,
        elevenlabs: costData.elevenlabs?.total || 0,
        openai: costData.openai?.cost || 0,
        details: {
          telnyx: {
            callCost: costData.telnyx?.callCost || 0,
            transcriptionCost: costData.telnyx?.transcriptionCost || 0,
            ttsCost: costData.telnyx?.ttsCost || 0,
            transferCost: costData.telnyx?.transferCost || 0,
            amdCost: costData.telnyx?.amdCost || 0,
          },
          elevenlabs: {
            ttsCost: costData.elevenlabs?.ttsCost || 0,
            sttCost: costData.elevenlabs?.sttCost || 0,
            ttsMinutes: costData.elevenlabs?.ttsMinutes || 0,
            sttHours: costData.elevenlabs?.sttHours || 0,
            total: costData.elevenlabs?.total || 0,
          },
          openai: {
            inputTokens: costData.openai?.inputTokens || 0,
            outputTokens: costData.openai?.outputTokens || 0,
            apiCalls: costData.openai?.apiCalls || 0,
          }
        }
      };
    } else {
      // Fallback for simple cost value
      conversation.cost = costData || 0;
      conversation.costBreakdown = {
        total: costData || 0,
        telnyx: 0,
        elevenlabs: 0,
        openai: 0,
      };
    }
    
    // Determine status based on conversation state
    if (transferred) {
      conversation.status = 'transferred';
    } else if (conversation.messages.length === 0) {
      // No messages - check if call was actually answered by looking at TTS costs
      // If TTS cost exists, call WAS answered (AI spoke), so it's not "no_answer"
      const hasTTSCost = costData?.telnyx?.ttsCost > 0 || costData?.elevenlabs?.ttsCost > 0;
      
      if (hasTTSCost) {
        // Call WAS answered (TTS was used = AI spoke), but no messages recorded
        // This means it's NOT "no_answer" - should be "no_response" or "voicemail"
        // Check hangup cause to distinguish
        if (hangupCause === 'voicemail') {
          conversation.status = 'voicemail';
          console.log(`   ✅ TTS cost detected but no messages - marking as voicemail (call was answered)`);
        } else if (hangupCause === 'normal_clearing' && conversation.duration > 0 && conversation.duration < 30) {
          // Quick hangup with TTS - likely voicemail
          conversation.status = 'voicemail';
          console.log(`   ✅ TTS cost detected, quick hangup (${conversation.duration}s) - marking as voicemail`);
        } else {
          // TTS cost exists = call was answered, but no user response
          conversation.status = 'no_response';
          console.log(`   ✅ TTS cost detected but no messages - marking as no_response (call was answered but no user response)`);
        }
      } else {
        // No messages AND no TTS cost - call was never answered
        if (hangupCause === 'no_answer' || hangupCause === 'not_found' || hangupCause === 'unallocated_number') {
          conversation.status = 'no_answer';
        } else if (hangupCause === 'call_rejected' || hangupCause === 'user_busy') {
          conversation.status = 'no_answer';
        } else {
          // Call was initiated but never answered (webhook may have been delayed)
          conversation.status = 'no_answer';
        }
      }
    } else if (conversation.messages.length > 0 && conversation.messages[0].text.includes('[AMD Detection:')) {
      // AMD detected voicemail/fax
      conversation.status = 'voicemail';
    } else if (hangupCause === 'voicemail') {
      // 🔍 CRITICAL FIX: If hangupCause is explicitly 'voicemail', mark as voicemail
      // This handles cases where voicemail was detected via transcription keywords
      conversation.status = 'voicemail';
      console.log(`   ✅ Voicemail detected - marking as voicemail (hangupCause: voicemail)`);
    } else {
      // 🔍 CRITICAL FIX: Check for voicemail messages FIRST before checking for user messages
      // This ensures voicemail conversations are marked correctly even if other conditions might suggest completion
      const hasVoicemailMessages = conversation.messages.some(m => 
        m.text.includes('[Voicemail detected]')
      );
      const conversationState = openaiService.getConversationState(callControlId);
      const hasVoicemailInOpenAI = conversationState?.messages?.some(m => 
        m.content?.includes('[Voicemail detected]')
      ) || false;
      
      // If voicemail messages exist, mark as voicemail regardless of other conditions
      if (hasVoicemailMessages || hasVoicemailInOpenAI) {
        conversation.status = 'voicemail';
        console.log(`   ✅ Voicemail messages detected - marking as voicemail`);
      } else {
        // 🔍 CRITICAL FIX: Check BOTH conversation service messages AND OpenAI conversation state
        // to determine if user actually responded. This prevents incorrectly marking as "no_response"
        // when user messages exist in OpenAI state but haven't been added to conversation service yet
        // ⚠️ IMPORTANT: Filter out voicemail-detected messages (they have "[Voicemail detected]" prefix)
        const hasRealUserMessagesInConversation = conversation.messages.some(m => 
          m.speaker === 'Lead' && !m.text.includes('[Voicemail detected]') && !m.text.includes('[Background noise]') && !m.text.includes('[Filtered:')
        );
        // Also filter voicemail messages from OpenAI state
        const hasRealUserMessagesInOpenAI = conversationState?.messages?.some(m => 
          m.role === 'user' && !m.content?.includes('[Voicemail detected]')
        ) || false;
        
        // Check if all Lead messages are voicemail/background noise (no real user response)
        const allLeadMessagesAreVoicemail = conversation.messages
          .filter(m => m.speaker === 'Lead')
          .every(m => m.text.includes('[Voicemail detected]') || m.text.includes('[Background noise]') || m.text.includes('[Filtered:'));
        
        // 🔍 CRITICAL FIX: Check if user attempted to respond (even if during AI speech)
        // This handles cases where user tried to respond but transcription was ignored due to overlapping speech
        // Only consider this if there are no voicemail indicators
        const userAttemptedResponse = conversation.userAttemptedResponse || false;
        const hasUserMessages = hasRealUserMessagesInConversation || hasRealUserMessagesInOpenAI;
        
        // 🔍 CRITICAL FIX: Check OpenAI API calls FIRST - this is the strongest indicator that user responded
        // OpenAI API calls mean user definitely responded, regardless of message tracking
        const hasOpenAICalls = costData?.openai?.apiCalls > 0;
        const openAICallCount = costData?.openai?.apiCalls || 0;
        
        if (hasOpenAICalls && openAICallCount > 0) {
          // OpenAI was called = user definitely responded
          conversation.status = 'completed';
          console.log(`   ✅ OpenAI API calls detected (${openAICallCount}) - marking as completed (user responded)`);
        } else if (hasUserMessages && !allLeadMessagesAreVoicemail) {
          // Had real user responses - completed conversation
          conversation.status = 'completed';
          if (hasRealUserMessagesInOpenAI && !hasRealUserMessagesInConversation) {
            console.log(`   ⚠️  User messages found in OpenAI state but not in conversation service - marking as completed`);
          }
        } else if (userAttemptedResponse && !allLeadMessagesAreVoicemail) {
          // User attempted to respond but message wasn't captured (likely filtered during AI speech)
          if (conversation.duration > 30) {
            // Long call with user attempt - likely a real response that was missed
            conversation.status = 'completed';
            console.log(`   ⚠️  User attempted to respond (userAttemptedResponse flag) in long call (${conversation.duration}s) - marking as completed`);
          } else {
            // Short call with user attempt but no confirmation - likely just background noise or false positive
            conversation.status = 'no_response';
          }
        } else {
          // AI spoke but no real user response - likely voicemail or hangup
          // ⚠️ FIX: Check if there are ANY Lead messages first - if there are Lead messages
          // (even if filtered), and we have multiple messages, it's likely NOT voicemail
          const hasAnyLeadMessages = conversation.messages.some(m => m.speaker === 'Lead');
          
          // ⚠️ CRITICAL FIX: Don't mark as voicemail if there are Lead messages and message count > 1
          // This prevents incorrectly marking real calls as voicemail just because they're short
          if (hasAnyLeadMessages && conversation.messages.length > 1) {
            // Has Lead messages and multiple messages - likely a real call, not voicemail
            // Check if all Lead messages are voicemail/system messages
            if (allLeadMessagesAreVoicemail) {
              // All Lead messages are voicemail/system messages - mark as voicemail
              conversation.status = 'voicemail';
              console.log(`   ✅ All Lead messages are voicemail/system - marking as voicemail`);
            } else {
              // Has real Lead messages - mark as completed (user responded)
              conversation.status = 'completed';
              console.log(`   ✅ Lead messages found with ${conversation.messages.length} total messages - marking as completed`);
            }
          } else if (hangupCause === 'normal_clearing' && conversation.duration > 0 && conversation.duration < 30) {
            // Quick hangup (< 30s) with AI messages but no Lead messages - likely voicemail
            conversation.status = 'voicemail';
            console.log(`   ✅ Quick hangup (${conversation.duration}s) with no Lead messages - marking as voicemail`);
          } else if (allLeadMessagesAreVoicemail && conversation.messages.some(m => m.speaker === 'Lead')) {
            // All Lead messages are voicemail/system messages - mark as voicemail
            conversation.status = 'voicemail';
            console.log(`   ✅ All Lead messages are voicemail/system - marking as voicemail`);
          } else {
            // 🔍 CRITICAL FIX: Before marking as no_response, check for additional indicators
            // Check if call had significant duration and TTS (might be race condition)
            const hasTTSCost = costData?.telnyx?.ttsCost > 0 || costData?.elevenlabs?.ttsCost > 0;
            const hasSignificantDuration = conversation.duration > 15;
            
            if (hasSignificantDuration && hasTTSCost) {
              // Long call with TTS but no messages - might be race condition
              // Check OpenAI state more carefully for user messages
              const conversationState = openaiService.getConversationState(callControlId);
              const hasUserInOpenAI = conversationState?.messages?.some(m => 
                m.role === 'user' && !m.content?.includes('[Voicemail detected]')
              ) || false;
              
              if (hasUserInOpenAI) {
                conversation.status = 'completed';
                console.log(`   ⚠️  Long call (${conversation.duration}s) with TTS and user messages in OpenAI state - marking as completed`);
              } else {
                // Long call but no user messages found - likely true no_response
                conversation.status = 'no_response';
                console.log(`   ✅ Long call (${conversation.duration}s) but no user messages - marking as no_response`);
              }
            } else {
              // Short call or no TTS - likely true no_response
              conversation.status = 'no_response';
            }
          }
        }
      }
    }
    
    // Store hangup cause if provided
    if (hangupCause) {
      conversation.hangupCause = hangupCause;
    }

    // 🔍 CRITICAL FIX: Validate that to_number is a user phone, not a DID number
    // This ensures conversations can be properly matched to leads
    if (conversation.toNumber) {
      try {
        const normalizedTo = conversation.toNumber.replace(/[^0-9]/g, '');
        const userCheck = await query(
          `SELECT id FROM users WHERE REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = $1 LIMIT 1`,
          [normalizedTo]
        );
        
        if (userCheck.rows.length === 0) {
          // to_number doesn't exist in users table - might be a DID number (incorrect)
          // Try to find the correct lead phone from telnyx_calls table
          console.warn(`   ⚠️  WARNING: to_number (${conversation.toNumber}) not found in users table - may be a DID number`);
          console.warn(`   🔍 Attempting to find correct lead phone from telnyx_calls table...`);
          
          try {
            const telnyxCallResult = await query(
              `SELECT from_number, to_number FROM telnyx_calls WHERE call_control_id = $1`,
              [callControlId]
            );
            
            if (telnyxCallResult.rows.length > 0 && telnyxCallResult.rows[0].to_number) {
              const correctToNumber = telnyxCallResult.rows[0].to_number;
              const normalizedCorrectTo = correctToNumber.replace(/[^0-9]/g, '');
              const correctUserCheck = await query(
                `SELECT id FROM users WHERE REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = $1 LIMIT 1`,
                [normalizedCorrectTo]
              );
              
              if (correctUserCheck.rows.length > 0) {
                console.warn(`   ✅ Found correct to_number from telnyx_calls: ${correctToNumber} (was: ${conversation.toNumber})`);
                conversation.toNumber = correctToNumber;
                // Also update from_number if needed
                if (telnyxCallResult.rows[0].from_number) {
                  conversation.fromNumber = telnyxCallResult.rows[0].from_number;
                }
              } else {
                console.error(`   ❌ ERROR: Corrected to_number (${correctToNumber}) also not found in users table`);
              }
            }
          } catch (error) {
            console.error(`   ⚠️  Error checking telnyx_calls for correction: ${error.message}`);
          }
        } else {
          console.log(`   ✅ Validated: to_number (${conversation.toNumber}) exists in users table`);
        }
      } catch (error) {
        console.error(`   ⚠️  Error validating to_number: ${error.message}`);
      }
    }

    // Save to PostgreSQL database
    try {
      await query(
        `INSERT INTO conversations (
          call_control_id, from_number, to_number, start_time, end_time,
          duration, cost, model, messages, status, cost_breakdown, hangup_cause,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
        ON CONFLICT (call_control_id) 
        DO UPDATE SET
          end_time = $5,
          duration = $6,
          cost = $7,
          messages = $9,
          status = $10,
          cost_breakdown = $11,
          hangup_cause = $12,
          updated_at = NOW()`,
        [
          conversation.callControlId,
          conversation.fromNumber,
          conversation.toNumber,
          conversation.startTime,
          conversation.endTime,
          conversation.duration,
          conversation.cost,
          conversation.model,
          JSON.stringify(conversation.messages),
          conversation.status,
          JSON.stringify(conversation.costBreakdown),
          conversation.hangupCause || null
        ]
      );

      console.log(`💾 Conversation saved to database: ${callControlId} (${conversation.messages.length} messages, status: ${conversation.status}, $${conversation.cost.toFixed(4)})`);
      
      // Remove from active conversations after successful save
      this.activeConversations.delete(callControlId);
      console.log(`   ✅ Conversation removed from active conversations`);
    } catch (error) {
      console.error(`❌ Error saving conversation to database:`, error.message);
      // Still remove from active conversations even on error to prevent memory leaks
      this.activeConversations.delete(callControlId);
    }
    
    // Clean up finalizedCalls set after 5 minutes to prevent memory leaks
    setTimeout(() => {
      this.finalizedCalls.delete(callControlId);
    }, 5 * 60 * 1000);

    console.log(`💬 Conversation finalized: ${callControlId}`);
    return conversation;
  }

  /**
   * Get all conversations with pagination and filtering
   * @param {number} page - Page number (1-indexed)
   * @param {number} limit - Items per page
   * @param {string} filter - Filter mode: 'all', 'with_responses', 'completed'
   * @param {string} durationFilter - Duration filter: '0-15', '16-30', '31-60', '60+' (only applies when filter='completed')
   */
  async getAllConversations(page = 1, limit = 20, filter = 'all', durationFilter = null) {
    try {
      let whereClause = '';
      const conditions = [];
      
      // Build conditions for WHERE clause
      const countConditions = [];
      
      // Apply filter
      if (filter === 'with_responses') {
        // Only conversations where user responded (has Lead messages)
        const condition = "messages::text LIKE '%\"speaker\":\"Lead\"%'";
        conditions.push("c.messages::text LIKE '%\"speaker\":\"Lead\"%'");
        countConditions.push(condition);
      } else if (filter === 'completed') {
        // Only completed status
        conditions.push("c.status = 'completed'");
        countConditions.push("status = 'completed'");
        
        // Apply duration filter if provided (only for completed calls)
        // Ranges: 0-15s, 16-30s, 30-60s, 60s+
        if (durationFilter) {
          let durationCondition;
          if (durationFilter === '0-15') {
            durationCondition = "duration >= 0 AND duration <= 15";
            conditions.push("c.duration >= 0 AND c.duration <= 15");
          } else if (durationFilter === '16-30') {
            durationCondition = "duration >= 16 AND duration <= 30";
            conditions.push("c.duration >= 16 AND c.duration <= 30");
          } else if (durationFilter === '30-60') {
            // Note: 30 is included in both 16-30 and 30-60 ranges per user spec
            durationCondition = "duration >= 30 AND duration <= 60";
            conditions.push("c.duration >= 30 AND c.duration <= 60");
          } else if (durationFilter === '60+') {
            durationCondition = "duration > 60";
            conditions.push("c.duration > 60");
          }
          countConditions.push(durationCondition);
        }
      }
      // 'all' mode shows everything - no WHERE clause
      
      if (conditions.length > 0) {
        whereClause = `WHERE ${conditions.join(' AND ')}`;
      }
      
      // Build count WHERE clause (for conversations table only, no join needed)
      let countWhereClause = '';
      if (countConditions.length > 0) {
        countWhereClause = `WHERE ${countConditions.join(' AND ')}`;
      }
      
      // Get total count (use conversations table only for count)
      const countResult = await query(
        `SELECT COUNT(*) as count FROM conversations ${countWhereClause}`
      );
      const totalCount = parseInt(countResult.rows[0].count);
      
      // Get paginated conversations with recording info
      const offset = (page - 1) * limit;
      const result = await query(
        `SELECT 
          c.id, c.call_control_id as "callControlId", c.from_number as "fromNumber", 
          c.to_number as "toNumber", c.start_time as "startTime", c.end_time as "endTime",
          c.duration, c.cost, c.model, c.messages, c.status, c.cost_breakdown as "costBreakdown",
          c.hangup_cause as "hangupCause", c.created_at as "createdAt"
        FROM conversations c
        ${whereClause}
        ORDER BY c.start_time DESC
        LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      
      // Parse JSON fields and convert BIGINT timestamps to numbers
      const conversations = result.rows.map(row => {
        const conversation = {
          ...row,
          startTime: row.startTime ? parseInt(row.startTime, 10) : null,
          endTime: row.endTime ? parseInt(row.endTime, 10) : null,
          messages: row.messages || [],
          costBreakdown: row.costBreakdown || {}
        };
        
        return conversation;
      });

      return {
        conversations,
        totalCount,
        currentPage: page,
        totalPages: Math.ceil(totalCount / limit),
        limit,
        filter,
        durationFilter
      };
    } catch (error) {
      console.error('❌ Error fetching conversations from database:', error.message);
      return {
        conversations: [],
        totalCount: 0,
        currentPage: page,
        totalPages: 0,
        limit,
        filter,
        durationFilter
      };
    }
  }

  /**
   * Get single conversation by ID
   */
  async getConversation(callControlId) {
    try {
      const result = await query(
        `SELECT 
          id, call_control_id as "callControlId", from_number as "fromNumber", 
          to_number as "toNumber", start_time as "startTime", end_time as "endTime",
          duration, cost, model, messages, status, cost_breakdown as "costBreakdown",
          hangup_cause as "hangupCause", created_at as "createdAt"
        FROM conversations 
        WHERE call_control_id = $1`,
        [callControlId]
      );
      
      if (result.rows.length === 0) {
        return null;
      }
      
      const row = result.rows[0];
      return {
        ...row,
        startTime: row.startTime ? parseInt(row.startTime, 10) : null,
        endTime: row.endTime ? parseInt(row.endTime, 10) : null,
        messages: row.messages || [],
        costBreakdown: row.costBreakdown || {}
      };
    } catch (error) {
      console.error('❌ Error fetching conversation from database:', error.message);
      return null;
    }
  }

  /**
   * Clear all conversations (for testing)
   */
  async clearAllConversations() {
    try {
      await query('DELETE FROM conversations');
      console.log(`🗑️  All conversations cleared from database`);
    } catch (error) {
      console.error('❌ Error clearing conversations:', error.message);
    }
  }
}

// Export singleton instance
module.exports = new ConversationService();
