const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const telnyxService = require('../services/telnyxService');
const openaiService = require('../services/openaiService');
const userModel = require('../models/userModel');
const { didRotation, extractAreaCode, getStateFromAreaCode } = require('./didRoutes');
const costTracking = require('../services/costTrackingService');
const { query } = require('../config/database');

// Configuration file paths (agent-config.json still uses file storage for simplicity)
const CONFIG_FILE = path.join(__dirname, '../data/agent-config.json');

// Agent state management
let agentState = {
  status: 'stopped', // stopped, running, paused
  totalCalls: 0,
  successfulCalls: 0,
  failedCalls: 0,
  qualifiedLeads: 0,
  disqualifiedLeads: 0,
  currentBatch: [],
  activeCalls: 0, // Track number of currently active calls
  startTime: null,
  pauseTime: null
};

// Agent configuration (loaded from file or defaults)
let agentConfig = {
  transferNumber: process.env.AGENT_TRANSFER_NUMBER || '+18434028556',
  maxConcurrentCalls: 50 // Default: 1 call at a time (sequential), changed via UI
};

let callQueue = [];
let isProcessingQueue = false;

// Track transferred calls with details (now in PostgreSQL, kept for backward compatibility)
let transferredCalls = []; // Array of { id, phone, name, address, timestamp, fromNumber, toNumber }

// Track active calls and their completion status
const activeCallsCompletion = new Map(); // callControlId -> { resolve, reject, timeout }

// ⚠️ FIX: Track phone numbers that are currently being called to prevent duplicates
const activePhoneNumbers = new Map(); // phoneNumber -> callControlId

/**
 * Load agent configuration from JSON file
 */
async function loadAgentConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf8');
    const savedConfig = JSON.parse(data);
    // Update existing object instead of reassigning to preserve references
    Object.assign(agentConfig, savedConfig);
    console.log('📋 Agent config loaded from file:', agentConfig);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('📋 No saved config found, using defaults');
      // Create default config file
      await saveAgentConfig();
    } else {
      console.error('❌ Error loading agent config:', error);
    }
  }
}

/**
 * Save agent configuration to JSON file
 */
async function saveAgentConfig() {
  try {
    // Ensure data directory exists
    const dataDir = path.dirname(CONFIG_FILE);
    try {
      await fs.access(dataDir);
    } catch {
      await fs.mkdir(dataDir, { recursive: true });
    }
    
    await fs.writeFile(CONFIG_FILE, JSON.stringify(agentConfig, null, 2), 'utf8');
    console.log('💾 Agent config saved to file:', CONFIG_FILE);
    return true;
  } catch (error) {
    console.error('❌ Error saving agent config:', error);
    return false;
  }
}

/**
 * Load transferred calls from PostgreSQL database
 */
async function loadTransferredCalls() {
  try {
    const result = await query(
      `SELECT * FROM transferred_calls ORDER BY transferred_at DESC LIMIT 1000`
    );
    
    transferredCalls.length = 0; // Clear array
    for (const row of result.rows) {
      transferredCalls.push({
        id: row.call_control_id,
        userId: row.user_id,
        phone: row.phone,
        name: row.name,
        address: row.address,
        timestamp: row.transferred_at ? new Date(row.transferred_at).getTime() : Date.now(),
        fromNumber: row.from_number,
        toNumber: row.to_number
      });
    }
    console.log(`📋 Transferred calls loaded from database: ${transferredCalls.length} calls`);
  } catch (error) {
    // Table doesn't exist yet (will be created by initializeDatabase)
    if (error.code === '42P01') {
      console.log('📋 Transferred calls table not yet created, will load after database initialization');
    } else {
      console.error('❌ Error loading transferred calls from database:', error.message);
    }
  }
}

/**
 * Save transferred call to PostgreSQL database
 */
async function saveTransferredCall(callData) {
  try {
    await query(
      `INSERT INTO transferred_calls (
        call_control_id, user_id, phone, name, address, from_number, to_number, transferred_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (call_control_id) DO NOTHING`,
      [
        callData.id || callData.callControlId,
        callData.userId || null,
        callData.phone,
        callData.name,
        callData.address || null,
        callData.fromNumber,
        callData.toNumber
      ]
    );
    console.log(`💾 Transferred call saved to database: ${callData.id || callData.callControlId}`);
    return true;
  } catch (error) {
    console.error('❌ Error saving transferred call to database:', error.message);
    return false;
  }
}

// Load config and transferred calls on startup
loadAgentConfig();
loadTransferredCalls();

/**
 * Wait for a call to complete (with timeout)
 */
function waitForCallCompletion(callControlId, timeoutMs = 300000) { // 5 minute timeout
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      activeCallsCompletion.delete(callControlId);
      console.log(`⏰ Call ${callControlId} timed out after ${timeoutMs}ms`);
      resolve({ status: 'timeout', callControlId });
    }, timeoutMs);

    activeCallsCompletion.set(callControlId, {
      resolve: (result) => {
        clearTimeout(timeout);
        activeCallsCompletion.delete(callControlId);
        resolve(result);
      },
      reject: (error) => {
        clearTimeout(timeout);
        activeCallsCompletion.delete(callControlId);
        reject(error);
      },
      timeout
    });

    console.log(`⏳ Waiting for call ${callControlId} to complete...`);
  });
}

/**
 * Mark a call as complete (called from webhook handler)
 */
function markCallComplete(callControlId, result) {
  console.log(`📞 markCallComplete called for: ${callControlId}`);
  console.log(`   Active calls waiting: ${activeCallsCompletion.size}`);
  
  const callCompletion = activeCallsCompletion.get(callControlId);
  if (callCompletion) {
    console.log(`✅ Call ${callControlId} marked as complete:`, result.status);
    callCompletion.resolve(result);
  } else {
    console.log(`⚠️  Call ${callControlId} not found in activeCallsCompletion Map`);
    console.log(`   This may happen if server restarted during call`);
  }
}

/**
 * GET /api/agent/status - Get agent status
 */
router.get('/status', (req, res) => {
  res.json({
    success: true,
    data: {
      ...agentState,
      queueLength: callQueue.length,
      transferNumber: agentConfig.transferNumber
    }
  });
});

/**
 * GET /api/agent/config - Get agent configuration
 */
router.get('/config', (req, res) => {
  res.json({
    success: true,
    data: agentConfig
  });
});

/**
 * GET /api/agent/transferred-calls - Get list of transferred calls
 */
router.get('/transferred-calls', (req, res) => {
  res.json({
    success: true,
    data: transferredCalls
  });
});

/**
 * DELETE /api/agent/transferred-calls - Clear transferred calls list
 */
router.delete('/transferred-calls', async (req, res) => {
  try {
    await query('DELETE FROM transferred_calls');
    transferredCalls.length = 0; // Clear the array
    console.log('🗑️  Cleared transferred calls list from database');
    res.json({
      success: true,
      message: 'Transferred calls list cleared'
    });
  } catch (error) {
    console.error('❌ Error clearing transferred calls:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error clearing transferred calls'
    });
  }
});

/**
 * PUT /api/agent/config - Update agent configuration
 */
router.put('/config', async (req, res) => {
  console.log('📞 Updating agent config:', req.body);
  const { transferNumber, maxConcurrentCalls } = req.body;
  
  let updated = false;
  
  if (transferNumber !== undefined) {
    // Validate phone number format (basic validation)
    const cleanNumber = transferNumber.replace(/[\s()-]/g, '');
    console.log('   Clean number:', cleanNumber);
    
    if (!/^\+?[1-9]\d{1,14}$/.test(cleanNumber)) {
      console.log('   ❌ Invalid format');
      return res.status(400).json({
        success: false,
        error: 'Invalid phone number format. Use E.164 format (e.g., +18434028556)'
      });
    }
    
    agentConfig.transferNumber = transferNumber;
    console.log('   ✅ Transfer number updated to:', agentConfig.transferNumber);
    updated = true;
  }
  
  if (maxConcurrentCalls !== undefined) {
    const concurrent = parseInt(maxConcurrentCalls);
    if (isNaN(concurrent) || concurrent < 1 || concurrent > 50) {
      return res.status(400).json({
        success: false,
        error: 'Invalid concurrent calls value. Must be between 1 and 50'
      });
    }
    
    agentConfig.maxConcurrentCalls = concurrent;
    console.log('   ✅ Max concurrent calls updated to:', agentConfig.maxConcurrentCalls);
    updated = true;
  }
  
  if (updated) {
    // Save to file for persistence
    const saved = await saveAgentConfig();
    if (!saved) {
      console.log('   ⚠️  Config updated in memory but failed to save to file');
    }
  }
  
  res.json({
    success: true,
    data: agentConfig
  });
});

/**
 * POST /api/agent/start - Start AI agent calling
 */
router.post('/start', async (req, res) => {
  try {
    if (agentState.status === 'running') {
      return res.status(400).json({
        success: false,
        error: 'Agent is already running'
      });
    }

    const { userIds, delayBetweenCalls = 5000 } = req.body;

    // Get users to call
    let usersToCall;
    if (userIds && Array.isArray(userIds)) {
      usersToCall = await Promise.all(
        userIds.map(id => userModel.getUserById(id))
      );
      usersToCall = usersToCall.filter(Boolean);
    } else {
      usersToCall = await userModel.getPendingUsers();
    }

    if (usersToCall.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No users available to call'
      });
    }

    // Initialize agent state
    agentState = {
      status: 'running',
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      qualifiedLeads: 0,
      disqualifiedLeads: 0,
      currentBatch: usersToCall.map(u => u.id),
      activeCalls: 0, // ✅ FIX: Initialize active calls counter
      startTime: Date.now(),
      pauseTime: null,
      delayBetweenCalls
    };

    // Add to call queue
    callQueue = usersToCall.map(user => ({
      user,
      attempts: 0,
      status: 'pending'
    }));

    // Start processing queue
    processCallQueue();

    res.json({
      success: true,
      message: `Agent started with ${usersToCall.length} users in queue`,
      data: agentState
    });
  } catch (error) {
    console.error('Error starting agent:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/agent/stop - Stop AI agent
 */
router.post('/stop', (req, res) => {
  try {
    if (agentState.status === 'stopped') {
      return res.status(400).json({
        success: false,
        error: 'Agent is already stopped'
      });
    }

    console.log(`🛑 STOPPING AGENT (User requested)`);
    console.log(`   Queue size: ${callQueue.length}`);
    console.log(`   Active calls: ${agentState.activeCalls}`);
    
    agentState.status = 'stopped';
    callQueue = [];
    isProcessingQueue = false;

    res.json({
      success: true,
      message: 'Agent stopped successfully',
      data: agentState
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/agent/pause - Pause AI agent
 */
router.post('/pause', (req, res) => {
  try {
    if (agentState.status !== 'running') {
      return res.status(400).json({
        success: false,
        error: 'Agent is not running'
      });
    }

    agentState.status = 'paused';
    agentState.pauseTime = Date.now();

    res.json({
      success: true,
      message: 'Agent paused successfully',
      data: agentState
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/agent/resume - Resume AI agent
 */
router.post('/resume', (req, res) => {
  try {
    if (agentState.status !== 'paused') {
      return res.status(400).json({
        success: false,
        error: 'Agent is not paused'
      });
    }

    agentState.status = 'running';
    agentState.pauseTime = null;

    // Resume processing queue
    if (!isProcessingQueue && callQueue.length > 0) {
      processCallQueue();
    }

    res.json({
      success: true,
      message: 'Agent resumed successfully',
      data: agentState
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/agent/stats - Get agent statistics
 */
router.get('/stats', async (req, res) => {
  try {
    // Get cost data (now async)
    const totalCosts = await costTracking.getTotalCosts();
    
    // 🔍 CRITICAL: Get actual Telnyx call statistics (source of truth)
    // This counts only calls that were actually made through Telnyx API
    const telnyxCallStats = await userModel.getTelnyxCallStats();
    
    const stats = {
      ...agentState,
      queueLength: callQueue.length,
      successRate: agentState.totalCalls > 0 
        ? (agentState.successfulCalls / agentState.totalCalls * 100).toFixed(2) + '%'
        : '0%',
      qualificationRate: agentState.totalCalls > 0
        ? (agentState.qualifiedLeads / agentState.totalCalls * 100).toFixed(2) + '%'
        : '0%',
      runningTime: agentState.startTime 
        ? Date.now() - agentState.startTime
        : 0,
      // Add Telnyx call statistics (actual calls made through Telnyx API)
      telnyxCalls: {
        total: parseInt(telnyxCallStats.total_calls) || 0,
        webhookConfirmed: parseInt(telnyxCallStats.webhook_confirmed) || 0,
        initiated: parseInt(telnyxCallStats.initiated) || 0,
        last24h: parseInt(telnyxCallStats.calls_last_24h) || 0,
        last7d: parseInt(telnyxCallStats.calls_last_7d) || 0
      },
      // Add cost tracking
      costs: {
        totalCost: totalCosts.totalCost,
        telnyxCost: totalCosts.telnyxTotal,
        elevenlabsTotal: totalCosts.elevenlabsTotal,
        openaiCost: totalCosts.openaiTotal,
        avgCostPerCall: totalCosts.avgCostPerCall,
        avgCostPerMinute: totalCosts.avgCostPerMinute,
        breakdown: totalCosts.breakdown
      }
    };

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/agent/audit - Audit call count discrepancy
 */
router.get('/audit', async (req, res) => {
  try {
    // Get Telnyx call stats (actual calls)
    const telnyxCallStats = await userModel.getTelnyxCallStats();
    
    // Get user stats (database status)
    const userStats = await userModel.getUserStats();
    
    // Get users marked as 'called' but with no Telnyx call
    const orphanedUsers = await userModel.auditCalledUsersWithoutTelnyxCall();
    
    const audit = {
      telnyxCalls: {
        total: parseInt(telnyxCallStats.total_calls) || 0,
        webhookConfirmed: parseInt(telnyxCallStats.webhook_confirmed) || 0
      },
      databaseStatus: {
        totalUsers: userStats.total || 0,
        called: userStats.called || 0,
        pending: userStats.pending || 0
      },
      discrepancy: {
        difference: (userStats.called || 0) - (parseInt(telnyxCallStats.total_calls) || 0),
        percentage: userStats.called > 0 
          ? (((userStats.called - (parseInt(telnyxCallStats.total_calls) || 0)) / userStats.called) * 100).toFixed(2) + '%'
          : '0%'
      },
      orphanedUsers: {
        count: orphanedUsers.length,
        sample: orphanedUsers.slice(0, 10) // Show first 10 as sample
      }
    };

    res.json({
      success: true,
      data: audit
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Process a single call (async task)
 */
async function processSingleCall(callItem) {
  // Note: activeCalls is incremented in processCallQueue BEFORE calling this function
  // to reserve the slot and prevent race conditions
  let callInitiated = false; // Track if call was successfully initiated
  try {
    // Get phone number with smart DID matching based on area code/state
    let fromNumber;
    let matchInfo = null;
    
    if (didRotation.enabled && didRotation.allNumbers.length > 0) {
      // Extract area code from recipient phone
      const recipientAreaCode = extractAreaCode(callItem.user.phone);
      const recipientState = callItem.user.state || getStateFromAreaCode(recipientAreaCode);
      
      console.log(`📍 Recipient: ${callItem.user.phone} | Area Code: ${recipientAreaCode} | State: ${recipientState}`);
      
      // Strategy 1: Match by area code (best)
      if (didRotation.strategy === 'area_code' && recipientAreaCode && didRotation.numbersByAreaCode[recipientAreaCode]) {
        const numbers = didRotation.numbersByAreaCode[recipientAreaCode];
        fromNumber = numbers[Math.floor(Math.random() * numbers.length)];
        matchInfo = `area_code_${recipientAreaCode}`;
        console.log(`✅ DID Match by Area Code ${recipientAreaCode}: ${fromNumber}`);
      }
      // Strategy 2: Match by state (good)
      else if (recipientState && didRotation.numbersByState[recipientState]) {
        const numbers = didRotation.numbersByState[recipientState];
        fromNumber = numbers[Math.floor(Math.random() * numbers.length)];
        matchInfo = `state_${recipientState}`;
        console.log(`✅ DID Match by State ${recipientState}: ${fromNumber}`);
      }
      // Strategy 3: Round-robin fallback
      else {
        fromNumber = didRotation.allNumbers[didRotation.currentIndex];
        didRotation.currentIndex = (didRotation.currentIndex + 1) % didRotation.allNumbers.length;
        matchInfo = 'round_robin_fallback';
        console.log(`🔄 DID Round-Robin (no match): ${fromNumber} (${didRotation.currentIndex}/${didRotation.allNumbers.length})`);
      }
    } else {
      // DID rotation disabled - use first available number
      console.log(`📞 DID Rotation disabled, using first available number`);
      const numbers = await telnyxService.getPurchasedNumbers();
      if (numbers.length === 0) {
        console.error('❌ No phone numbers available');
        // Decrement since we reserved the slot
        agentState.activeCalls--;
        agentState.failedCalls++;
        return { success: false, error: 'No phone numbers available' };
      }
      fromNumber = numbers[0].phone_number;
      matchInfo = 'rotation_disabled';
      console.log(`📞 Using number: ${fromNumber}`);
    }

    console.log(`📞 Calling ${callItem.user.firstname} ${callItem.user.lastname} at ${callItem.user.phone} from ${fromNumber} (Match: ${matchInfo})`);

    // Initiate call
    console.log(`📡 Attempting Telnyx API call for user ${callItem.user.id}...`);
    const call = await telnyxService.initiateCall(
      callItem.user.phone,
      fromNumber,
      callItem.user
    );
    console.log(`📡 Telnyx API response received for user ${callItem.user.id}`);

    // 🔍 CRITICAL VALIDATION: Verify Telnyx actually created the call
    // Only proceed if we have a valid call_control_id from Telnyx
    if (!call || !call.call_control_id) {
      const errorMsg = `Telnyx API returned invalid response - missing call_control_id`;
      console.error(`❌ ${errorMsg}`);
      console.error(`   Call response:`, JSON.stringify(call, null, 2));
      console.error(`   User: ${callItem.user.id} (${callItem.user.phone})`);
      
      // Don't update database status - call was not actually created
      agentState.failedCalls++;
      throw new Error(errorMsg);
    }

    // ✅ Validation passed - Telnyx confirmed call creation
    console.log(`✅ Telnyx call validated: ${call.call_control_id}`);
    console.log(`   📊 Database will be updated for user ${callItem.user.id}`);
    console.log(`   📈 Call metrics: Total=${agentState.totalCalls + 1}, Successful=${agentState.successfulCalls + 1}, Failed=${agentState.failedCalls}`);

    // Mark call as successfully initiated
    callInitiated = true;

    // 🔍 CRITICAL: Record call in telnyx_calls table FIRST (source of truth)
    // This ensures we track actual Telnyx API calls separately from user status
    try {
      await userModel.recordTelnyxCall(
        call.call_control_id,
        callItem.user.id,
        fromNumber,
        callItem.user.phone
      );
      console.log(`   ✅ Telnyx call recorded in telnyx_calls table`);
    } catch (error) {
      console.error(`   ⚠️  Error recording Telnyx call (continuing anyway):`, error.message);
      // Don't fail the call if recording fails - this is for tracking only
    }

    // Initialize conversation
    openaiService.initializeConversation(call.call_control_id, callItem.user);

    // ⚠️ FIX: Track this phone number as actively being called
    const normalizedPhone = callItem.user.phone.replace(/[^0-9]/g, '');
    activePhoneNumbers.set(normalizedPhone, call.call_control_id);
    console.log(`   📞 Tracking active phone number: ${normalizedPhone} -> ${call.call_control_id}`);

    // Update user status with DID number used
    // 🔍 Only update database AFTER confirming Telnyx created the call AND recording in telnyx_calls
    console.log(`📝 Updating database status to 'called' for user ${callItem.user.id}`);
    console.log(`   🔗 Telnyx call_control_id: ${call.call_control_id}`);
    const dbUpdateStart = Date.now();
    await userModel.updateCallStatus(callItem.user.id, 'called', {
      didNumber: fromNumber,
      callControlId: call.call_control_id,
      timestamp: new Date().toISOString()
    });
    const dbUpdateDuration = Date.now() - dbUpdateStart;
    console.log(`   ✅ Database updated in ${dbUpdateDuration}ms - user ${callItem.user.id} marked as 'called'`);
    console.log(`   📊 Verification: Telnyx call created (${call.call_control_id}) → telnyx_calls recorded → Database status updated ('called')`);

    agentState.totalCalls++;
    agentState.successfulCalls++;

    console.log(`⏳ Call ${call.call_control_id} in progress (Active: ${agentState.activeCalls}/${agentConfig.maxConcurrentCalls})`);

    // Wait for call to complete
    const callResult = await waitForCallCompletion(call.call_control_id);
    console.log(`📞 Call completed with status: ${callResult.status}`);
    
    // ⚠️ FIX: Remove phone number from active tracking
    activePhoneNumbers.delete(normalizedPhone);
    console.log(`   📞 Removed phone number from active tracking: ${normalizedPhone}`);
    
    // Decrement active calls counter (slot was reserved in processCallQueue)
    agentState.activeCalls--;
    
    return { success: true, result: callResult };

  } catch (error) {
    console.error(`❌ Error calling user ${callItem.user.id}:`, error);
    
    // ⚠️ FIX: Remove phone number from active tracking on error
    const normalizedPhone = callItem.user.phone.replace(/[^0-9]/g, '');
    if (activePhoneNumbers.has(normalizedPhone)) {
      activePhoneNumbers.delete(normalizedPhone);
      console.log(`   📞 Removed phone number from active tracking due to error: ${normalizedPhone}`);
    }
    
    // 🔍 CRITICAL: Database status is NOT updated when Telnyx API fails
    // This ensures database count matches actual Telnyx call count
    if (!callInitiated) {
      console.log(`   ⚠️  Call was NOT initiated - database status will NOT be updated`);
      console.log(`   📊 User ${callItem.user.id} remains in current status (not marked as 'called')`);
    } else {
      console.log(`   ⚠️  Call was initiated but failed later - database already updated`);
      console.log(`   📊 User ${callItem.user.id} was marked as 'called' but call failed`);
    }
    
    // Always decrement since we reserved the slot in processCallQueue
    agentState.activeCalls--;
    
    // Check if it's a Telnyx channel limit error (90041)
    // Check multiple possible error structures
    const errorCode = error.raw?.errors?.[0]?.code || 
                     error.errors?.[0]?.code ||
                     error.code;
    const errorType = error.type || error.name || '';
    const isTelnyxError = errorType === 'TelnyxPermissionError' || 
                         errorType.includes('Telnyx') ||
                         error.statusCode === 403;
    
    const errorDetail = error.raw?.errors?.[0]?.detail || error.message || '';
    const isChannelLimitError = isTelnyxError && 
                                (errorCode === '90041' || 
                                 errorCode === 90041 ||
                                 errorDetail.includes('channel limit') ||
                                 errorDetail.includes('User channel limit exceeded'));
    
    if (isChannelLimitError) {
      console.log(`⚠️  Telnyx channel limit exceeded (90041) - account limit reached`);
      console.log(`   Skipping retry for user ${callItem.user.id} - will retry when channels free up`);
      console.log(`   📊 Database status NOT updated - user remains in current status`);
      agentState.failedCalls++;
      // Don't retry immediately - Telnyx account limit exceeded
      return { success: false, error: 'Telnyx channel limit exceeded', skipRetry: true };
    }
    
    // Log Telnyx API error details for debugging
    if (isTelnyxError) {
      console.error(`   📋 Telnyx API Error Details:`);
      console.error(`      Code: ${errorCode}`);
      console.error(`      Detail: ${errorDetail}`);
      console.error(`      Status Code: ${error.statusCode}`);
      console.error(`   📊 Database status NOT updated - Telnyx call was not created`);
    }
    
    agentState.failedCalls++;
    
    // Retry logic (only for non-channel-limit errors)
    callItem.attempts = (callItem.attempts || 0) + 1;
    if (callItem.attempts < 3) {
      console.log(`🔄 Retrying user ${callItem.user.id} (Attempt ${callItem.attempts}/3)`);
      callQueue.push(callItem);
    }
    
    return { success: false, error: error.message };
  } finally {
    // Try to process more calls from the queue
    processCallQueue();
  }
}

/**
 * Process call queue with concurrent calls
 */
async function processCallQueue() {
  // Prevent concurrent queue processing (critical for accurate activeCalls counter)
  if (isProcessingQueue) {
    return; // Another instance is already processing
  }
  
  if (agentState.status !== 'running') {
    console.log(`⏸️  Agent not running (status: ${agentState.status}), skipping queue processing`);
    return;
  }

  const maxConcurrent = agentConfig.maxConcurrentCalls || 1;
  const availableSlots = maxConcurrent - agentState.activeCalls;

  if (availableSlots <= 0) {
    console.log(`⏸️  Max concurrent calls reached (${agentState.activeCalls}/${maxConcurrent}), waiting...`);
    return;
  }

  // Process as many calls as we have available slots
  const callsToProcess = Math.min(availableSlots, callQueue.length);
  
  if (callsToProcess === 0) {
    // Queue is empty, check if we should stop the agent
    if (agentState.activeCalls === 0 && agentState.status === 'running') {
      console.log(`🏁 AUTO-STOPPING AGENT (Queue empty, no active calls)`);
      agentState.status = 'stopped';
      console.log('✅ Call queue completed - all calls finished');
    }
    return;
  }

  // Set processing lock
  isProcessingQueue = true;
  
  try {
      console.log(`🚀 Starting ${callsToProcess} concurrent call(s) (Queue: ${callQueue.length}, Active: ${agentState.activeCalls}/${maxConcurrent})`);

    // Reserve slots BEFORE starting calls to prevent race conditions
    // Increment activeCalls for each call we're about to start
    for (let i = 0; i < callsToProcess; i++) {
      const callItem = callQueue.shift();
      if (callItem) {
        // ⚠️ FIX: Normalize phone number and check if already being called
        const normalizedPhone = callItem.user.phone.replace(/[^0-9]/g, '');
        if (activePhoneNumbers.has(normalizedPhone)) {
          const existingCallId = activePhoneNumbers.get(normalizedPhone);
          console.log(`⚠️  Phone ${callItem.user.phone} is already being called (call: ${existingCallId}) - skipping duplicate call`);
          // Put it back in the queue to retry later
          callQueue.push(callItem);
          continue;
        }
        
        // ✅ Reserve the slot immediately to prevent concurrent queue processing from overshooting
        agentState.activeCalls++;
        
        // Process call asynchronously (don't wait for it to complete)
        // Note: processSingleCall will decrement activeCalls if initiation fails
        processSingleCall(callItem).catch(error => {
          console.error('Unhandled error in processSingleCall:', error);
          // Ensure we decrement if there's an unhandled error
          agentState.activeCalls--;
          // Remove from active phone numbers tracking
          activePhoneNumbers.delete(normalizedPhone);
        });
        
        // Small delay between initiating calls to avoid API rate limits
        if (i < callsToProcess - 1) {
          await sleep(500); // 500ms delay between call initiations
        }
      }
    }
  } finally {
    // Always release the lock
    isProcessingQueue = false;
  }
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Clear all costs
 * DELETE /api/agent/costs
 */
router.delete('/costs', async (req, res) => {
  try {
    console.log('🗑️  Clearing all costs...');
    
    // Clear costs using the service method
    await costTracking.clearAllCosts();
    
    res.json({
      success: true,
      message: 'All costs cleared'
    });
  } catch (error) {
    console.error('❌ Error clearing costs:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Clear all cost and conversation history
 * DELETE /api/agent/clear-all-data
 */
router.delete('/clear-all-data', async (req, res) => {
  try {
    console.log('🗑️  Clearing all cost and conversation history...');
    
    // Clear conversations table
    const conversationsResult = await query('DELETE FROM conversations');
    console.log(`✅ Deleted ${conversationsResult.rowCount} conversation records`);
    
    // Clear costs using the service method
    await costTracking.clearAllCosts();
    
    // Also clear in-memory transferred calls
    transferredCalls.length = 0;
    
    // Clear transferred_calls table
    const transferredResult = await query('DELETE FROM transferred_calls');
    console.log(`✅ Deleted ${transferredResult.rowCount} transferred call records`);
    
    res.json({
      success: true,
      message: 'All cost and conversation history cleared',
      deleted: {
        conversations: conversationsResult.rowCount,
        transferredCalls: transferredResult.rowCount
      }
    });
  } catch (error) {
    console.error('❌ Error clearing data:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
module.exports.agentState = agentState;
module.exports.agentConfig = agentConfig;
module.exports.markCallComplete = markCallComplete;
module.exports.transferredCalls = transferredCalls;
module.exports.loadTransferredCalls = loadTransferredCalls;

