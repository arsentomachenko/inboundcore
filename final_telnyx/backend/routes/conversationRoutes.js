/**
 * Conversation API Routes
 * Endpoints for fetching conversation history
 */

const express = require('express');
const router = express.Router();
const conversationService = require('../services/conversationService');
const { query } = require('../config/database');

/**
 * GET /api/conversations
 * Get all conversations with pagination and filtering
 * Query params: 
 *   - page (default: 1)
 *   - limit (default: 20)
 *   - filter (default: 'all') - 'all', 'with_responses', 'completed'
 *   - durationFilter (optional) - '0-15', '16-30', '30-60', '60+' (only applies when filter='completed')
 */
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const filter = req.query.filter || 'all';
    const durationFilter = req.query.durationFilter || null;
    
    const result = await conversationService.getAllConversations(page, limit, filter, durationFilter);
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/conversations/:callControlId
 * Get single conversation by ID
 */
router.get('/:callControlId', async (req, res) => {
  try {
    const { callControlId } = req.params;
    const conversation = await conversationService.getConversation(callControlId);
    
    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: 'Conversation not found'
      });
    }
    
    res.json({
      success: true,
      conversation
    });
  } catch (error) {
    console.error('Error fetching conversation:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


/**
 * DELETE /api/conversations
 * Clear all conversations (for testing)
 */
router.delete('/', async (req, res) => {
  try {
    await conversationService.clearAllConversations();
    
    res.json({
      success: true,
      message: 'All conversations cleared'
    });
  } catch (error) {
    console.error('Error clearing conversations:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;

