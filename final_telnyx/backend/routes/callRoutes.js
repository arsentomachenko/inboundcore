const express = require('express');
const router = express.Router();
const telnyxService = require('../services/telnyxService');
const openaiService = require('../services/openaiService');
const userModel = require('../models/userModel');

// Store active calls
const activeCalls = new Map();

/**
 * POST /api/calls/initiate - Initiate outbound call
 */
router.post('/initiate', async (req, res) => {
  try {
    const { userId, fromNumber } = req.body;

    if (!userId || !fromNumber) {
      return res.status(400).json({
        success: false,
        error: 'userId and fromNumber are required'
      });
    }

    // Get user info
    const user = await userModel.getUserById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Initiate call
    const call = await telnyxService.initiateCall(
      user.phone,
      fromNumber,
      user
    );

    // Initialize OpenAI conversation
    openaiService.initializeConversation(call.call_control_id, user);

    // Store active call
    activeCalls.set(call.call_control_id, {
      userId,
      userInfo: user,
      fromNumber,
      toNumber: user.phone,
      status: 'initiated',
      startTime: Date.now()
    });

    // Update user with DID number used
    await userModel.updateCallStatus(userId, 'called', {
      didNumber: fromNumber,
      callControlId: call.call_control_id,
      timestamp: new Date().toISOString()
    });

    res.json({
      success: true,
      data: {
        callControlId: call.call_control_id,
        fromNumber,
        status: 'initiated'
      }
    });
  } catch (error) {
    console.error('Error initiating call:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/calls/hangup - Hangup active call
 */
router.post('/hangup', async (req, res) => {
  try {
    const { callControlId } = req.body;

    if (!callControlId) {
      return res.status(400).json({
        success: false,
        error: 'callControlId is required'
      });
    }

    await telnyxService.hangupCall(callControlId);
    
    // Clean up
    openaiService.endConversation(callControlId);
    activeCalls.delete(callControlId);
    
    // ✨ CRITICAL: Close all websockets (STT and TTS) when call hangs up
    try {
      const { closeAllWebsocketsForCall } = require('../services/mediaStreamingService');
      closeAllWebsocketsForCall(callControlId);
      console.log(`✅ All websockets closed for ${callControlId}`);
    } catch (error) {
      console.error(`❌ Error closing websockets:`, error);
    }
    
    // Cancel any active TTS requests
    try {
      const bidirectionalTTS = require('../services/bidirectionalTTSService');
      bidirectionalTTS.cancel(callControlId);
      console.log(`✅ Cancelled any active TTS requests for ${callControlId}`);
    } catch (error) {
      console.error(`❌ Error cancelling TTS requests:`, error);
    }

    res.json({
      success: true,
      message: 'Call ended successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/calls/active - Get all active calls
 */
router.get('/active', (req, res) => {
  try {
    const calls = Array.from(activeCalls.entries()).map(([id, data]) => ({
      callControlId: id,
      ...data
    }));

    res.json({
      success: true,
      data: calls
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/calls/:callControlId/status - Get call status
 */
router.get('/:callControlId/status', (req, res) => {
  try {
    const callData = activeCalls.get(req.params.callControlId);
    
    if (!callData) {
      return res.status(404).json({
        success: false,
        error: 'Call not found'
      });
    }

    const conversationState = openaiService.getConversationState(req.params.callControlId);

    res.json({
      success: true,
      data: {
        ...callData,
        conversationStage: conversationState?.stage,
        qualificationAnswers: conversationState?.qualificationAnswers
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
module.exports.activeCalls = activeCalls;

