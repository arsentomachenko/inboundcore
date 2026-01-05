const express = require('express');
const router = express.Router();
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const userModel = require('../models/userModel');

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

/**
 * GET /api/users - Get all users with pagination and search
 * Query params: page, limit, search, status, answerType
 */
router.get('/', async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 50, 
      search = '', 
      status = '', 
      answerType = '' 
    } = req.query;

    const result = await userModel.getUsersPaginated({
      page: parseInt(page),
      limit: parseInt(limit),
      search,
      status,
      answerType
    });

    res.json({ 
      success: true, 
      data: result.users,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
        hasMore: result.hasMore
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/users/:id - Get user by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const user = await userModel.getUserById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    res.json({ success: true, data: user });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/users - Create new user
 */
router.post('/', async (req, res) => {
  try {
    const user = await userModel.createUser(req.body);
    res.json({ success: true, data: user });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/users/:id - Update user
 */
router.put('/:id', async (req, res) => {
  try {
    const user = await userModel.updateUser(req.params.id, req.body);
    res.json({ success: true, data: user });
  } catch (error) {
    res.status(404).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/users - Delete all users
 */
router.delete('/', async (req, res) => {
  try {
    const result = await userModel.deleteAllUsers();
    res.json({ 
      success: true, 
      message: `Successfully deleted ${result.deletedCount} users`,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/users/:id - Delete user
 */
router.delete('/:id', async (req, res) => {
  try {
    await userModel.deleteUser(req.params.id);
    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    res.status(404).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/users/import - Import users from CSV
 */
router.post('/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const results = [];
    
    // Parse CSV file
    fs.createReadStream(req.file.path)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', async () => {
        try {
          // Clean up uploaded file
          fs.unlinkSync(req.file.path);

          // Import users
          const imported = await userModel.importUsers(results);
          
          res.json({
            success: true,
            message: `Successfully imported ${imported.length} users`,
            data: imported
          });
        } catch (error) {
          res.status(500).json({ success: false, error: error.message });
        }
      })
      .on('error', (error) => {
        res.status(500).json({ success: false, error: error.message });
      });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/users/pending/list - Get pending users for calling
 */
router.get('/pending/list', async (req, res) => {
  try {
    const users = await userModel.getPendingUsers();
    res.json({ success: true, data: users });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/users/answered/list - Get users who were answered by real people
 */
router.get('/answered/list', async (req, res) => {
  try {
    const users = await userModel.getAnsweredUsers();
    res.json({ 
      success: true, 
      data: users,
      count: users.length 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/users/answer-type/:type - Get users by answer type
 * Types: answered, voicemail, no_answer, not_found, busy
 */
router.get('/answer-type/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const validTypes = ['answered', 'voicemail', 'no_answer', 'not_found', 'busy'];
    
    if (!validTypes.includes(type)) {
      return res.status(400).json({ 
        success: false, 
        error: `Invalid answer type. Valid types: ${validTypes.join(', ')}` 
      });
    }
    
    const users = await userModel.getUsersByAnswerType(type);
    res.json({ 
      success: true, 
      data: users,
      count: users.length,
      answerType: type
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/users/stats/answer-breakdown - Get statistics on answer types
 */
router.get('/stats/answer-breakdown', async (req, res) => {
  try {
    const stats = await userModel.getUserStats();
    
    // Calculate answer rate
    const answerRate = stats.total > 0 
      ? ((stats.answered / stats.total) * 100).toFixed(2) + '%'
      : '0%';
    
    res.json({ 
      success: true, 
      data: {
        ...stats,
        answerRate
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;

