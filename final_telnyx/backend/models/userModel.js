const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

class UserModel {
  /**
   * Get all users (use with caution for large datasets)
   */
  async getAllUsers() {
    try {
      const result = await query('SELECT * FROM users ORDER BY created_at DESC');
      return result.rows;
    } catch (error) {
      console.error('Error reading users:', error);
      return [];
    }
  }

  /**
   * Get users with pagination and filtering
   */
  async getUsersPaginated(options = {}) {
    const {
      page = 1,
      limit = 50,
      search = '',
      status = '',
      answerType = ''
    } = options;

    try {
      let whereClause = [];
      let params = [];
      let paramCount = 1;

      // Apply search filter (PostgreSQL ILIKE is case-insensitive)
      if (search) {
        const searchPattern = `%${search}%`;
        whereClause.push(`(
          firstname ILIKE $${paramCount} OR 
          lastname ILIKE $${paramCount + 1} OR 
          phone ILIKE $${paramCount + 2} OR 
          email ILIKE $${paramCount + 3}
        )`);
        params.push(searchPattern, searchPattern, searchPattern, searchPattern);
        paramCount += 4;
      }

      // Apply status filter
      if (status) {
        whereClause.push(`status = $${paramCount}`);
        params.push(status);
        paramCount++;
      }

      // Apply answer type filter
      if (answerType) {
        whereClause.push(`answer_type = $${paramCount}`);
        params.push(answerType);
        paramCount++;
      }

      const whereSQL = whereClause.length > 0 ? `WHERE ${whereClause.join(' AND ')}` : '';

      // Get total count
      const countResult = await query(
        `SELECT COUNT(*) as total FROM users ${whereSQL}`,
        params
      );
      const total = parseInt(countResult.rows[0].total);

      // Calculate pagination
      const totalPages = Math.ceil(total / limit);
      const offset = (page - 1) * limit;

      // Get paginated results
      const result = await query(
        `SELECT * FROM users ${whereSQL} 
         ORDER BY created_at DESC 
         LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
        [...params, limit, offset]
      );

      return {
        users: result.rows,
        page,
        limit,
        total,
        totalPages,
        hasMore: page < totalPages
      };
    } catch (error) {
      console.error('Error in getUsersPaginated:', error);
      return {
        users: [],
        page: 1,
        limit,
        total: 0,
        totalPages: 0,
        hasMore: false
      };
    }
  }

  /**
   * Get user count statistics
   */
  async getUserStats() {
    try {
      // PostgreSQL FILTER clause for better performance
      const result = await query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'pending') as pending,
          COUNT(*) FILTER (WHERE status = 'called') as called,
          COUNT(*) FILTER (WHERE status = 'qualified') as qualified,
          COUNT(*) FILTER (WHERE status = 'disqualified') as disqualified,
          COUNT(*) FILTER (WHERE answered = true) as answered,
          COUNT(*) FILTER (WHERE answer_type = 'voicemail') as voicemail,
          COUNT(*) FILTER (WHERE answer_type = 'no_answer') as no_answer,
          COUNT(*) FILTER (WHERE answer_type = 'not_found') as not_found
        FROM users
      `);

      const stats = result.rows[0];
      return {
        total: parseInt(stats.total) || 0,
        pending: parseInt(stats.pending) || 0,
        called: parseInt(stats.called) || 0,
        qualified: parseInt(stats.qualified) || 0,
        disqualified: parseInt(stats.disqualified) || 0,
        answered: parseInt(stats.answered) || 0,
        voicemail: parseInt(stats.voicemail) || 0,
        no_answer: parseInt(stats.no_answer) || 0,
        not_found: parseInt(stats.not_found) || 0
      };
    } catch (error) {
      console.error('Error in getUserStats:', error);
      return {
        total: 0,
        pending: 0,
        called: 0,
        qualified: 0,
        disqualified: 0,
        answered: 0,
        voicemail: 0,
        no_answer: 0,
        not_found: 0
      };
    }
  }

  /**
   * Get user by ID
   */
  async getUserById(id) {
    try {
      const result = await query('SELECT * FROM users WHERE id = $1', [id]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('Error in getUserById:', error);
      return null;
    }
  }

  /**
   * Create new user
   * Handles duplicate phone numbers by returning existing user if found
   */
  async createUser(userData) {
    const id = uuidv4();
    const now = new Date().toISOString();

    try {
      // Check if user with this phone number already exists
      if (userData.phone) {
        const normalizedPhone = userData.phone.replace(/[^0-9]/g, '');
        const existing = await query(
          `SELECT * FROM users WHERE REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = $1 LIMIT 1`,
          [normalizedPhone]
        );
        
        if (existing.rows.length > 0) {
          console.log(`⚠️  User with phone ${userData.phone} already exists, returning existing user`);
          return existing.rows[0];
        }
      }

      const result = await query(
        `INSERT INTO users (
          id, firstname, lastname, phone, address, email, notes,
          status, call_attempts, last_call_date, did_number,
          answered, answer_type, answered_at, conversation_stage,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT (phone) DO UPDATE SET
          updated_at = $17
        RETURNING *`,
        [
          id,
          userData.firstname || '',
          userData.lastname || '',
          userData.phone || '',
          userData.address || '',
          userData.email || '',
          userData.notes || '',
          'pending',
          0,
          null,
          null,
          false,
          null,
          null,
          null,
          now,
          now
        ]
      );

      return result.rows[0];
    } catch (error) {
      // If still a duplicate key error, try to return existing user
      if (error.code === '23505' && error.constraint === 'users_phone_key') {
        console.log(`⚠️  Duplicate phone number detected, fetching existing user: ${userData.phone}`);
        try {
          const normalizedPhone = (userData.phone || '').replace(/[^0-9]/g, '');
          const existing = await query(
            `SELECT * FROM users WHERE REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = $1 LIMIT 1`,
            [normalizedPhone]
          );
          if (existing.rows.length > 0) {
            return existing.rows[0];
          }
        } catch (fetchError) {
          console.error('Error fetching existing user:', fetchError);
        }
      }
      console.error('Error in createUser:', error);
      throw error;
    }
  }

  /**
   * Update user
   */
  async updateUser(id, userData) {
    const now = new Date().toISOString();

    try {
      // Build dynamic update query
      const fields = [];
      const values = [];
      let paramCount = 1;

      const allowedFields = [
        'firstname', 'lastname', 'phone', 'address', 'email', 'notes',
        'status', 'call_attempts', 'last_call_date', 'did_number',
        'answered', 'answer_type', 'answered_at', 'conversation_stage',
        'last_call_data'
      ];

      for (const field of allowedFields) {
        if (userData.hasOwnProperty(field)) {
          fields.push(`${field} = $${paramCount}`);
          values.push(userData[field]);
          paramCount++;
        }
      }

      if (fields.length === 0) {
        throw new Error('No fields to update');
      }

      // Always update updated_at
      fields.push(`updated_at = $${paramCount}`);
      values.push(now);
      paramCount++;

      // Add ID as last parameter
      values.push(id);

      const result = await query(
        `UPDATE users SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
        values
      );

      if (result.rows.length === 0) {
        throw new Error('User not found');
      }

      return result.rows[0];
    } catch (error) {
      console.error('Error in updateUser:', error);
      throw error;
    }
  }

  /**
   * Delete user
   */
  async deleteUser(id) {
    try {
      const result = await query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
      
      if (result.rows.length === 0) {
        throw new Error('User not found');
      }

      return true;
    } catch (error) {
      console.error('Error in deleteUser:', error);
      throw error;
    }
  }

  /**
   * Delete all users
   */
  async deleteAllUsers() {
    try {
      const result = await query('DELETE FROM users RETURNING id');
      console.log(`✅ Deleted ${result.rows.length} users from database`);
      return { deletedCount: result.rows.length };
    } catch (error) {
      console.error('Error in deleteAllUsers:', error);
      throw error;
    }
  }

  /**
   * Import users from CSV data
   */
  async importUsers(csvData) {
    const imported = [];
    const skipped = [];
    
    // Helper function to normalize phone number
    const normalizePhone = (phone) => {
      if (!phone && phone !== 0) return null;
      
      // Convert to string and remove any whitespace
      let phoneStr = String(phone).trim();
      
      // Remove .0 suffix if it's a float (e.g., "14802277585.0" -> "14802277585")
      if (phoneStr.endsWith('.0')) {
        phoneStr = phoneStr.slice(0, -2);
      }
      
      // Return null for empty strings
      return phoneStr || null;
    };
    
    for (const row of csvData) {
      try {
        // Build address string with state if available
        let fullAddress = row.address || '';
        if (row.state) {
          fullAddress = fullAddress ? `${fullAddress}, ${row.state}` : row.state;
        }

        // Normalize phone number
        const rawPhone = row.phone || row.phone_number;
        let phone = normalizePhone(rawPhone);
        
        // Use NULL for empty phones (PostgreSQL allows multiple NULLs in UNIQUE columns)
        // This allows importing multiple users without phone numbers

        const id = uuidv4();
        const now = new Date().toISOString();

        const result = await query(
          `INSERT INTO users (
            id, firstname, lastname, phone, address, email, notes,
            status, call_attempts, last_call_date, did_number,
            answered, answer_type, answered_at, conversation_stage,
            created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
          ON CONFLICT (phone) DO NOTHING
          RETURNING *`,
          [
            id,
            row.firstname || row.first_name || '',
            row.lastname || row.last_name || '',
            phone,
            fullAddress,
            row.email || '',
            row.notes || '',
            'pending',
            0,
            null,
            null,
            false,
            null,
            null,
            null,
            now,
            now
          ]
        );

        // Only add to imported if a row was actually inserted
        if (result.rows.length > 0) {
          imported.push(result.rows[0]);
        } else {
          skipped.push({ phone, reason: 'duplicate phone number' });
        }
      } catch (error) {
        console.error('Error importing user:', error);
        // Continue with next user
      }
    }

    console.log(`✅ Imported ${imported.length} users to database`);
    if (skipped.length > 0) {
      console.log(`⚠️  Skipped ${skipped.length} duplicate users`);
    }
    return imported;
  }

  /**
   * Get users pending calls
   */
  async getPendingUsers() {
    try {
      const result = await query(
        `SELECT * FROM users 
         WHERE status = 'pending' OR (status = 'called' AND call_attempts < 3)
         ORDER BY created_at ASC`
      );
      return result.rows;
    } catch (error) {
      console.error('Error in getPendingUsers:', error);
      return [];
    }
  }

  /**
   * Update call status
   */
  async updateCallStatus(id, status, callData = {}) {
    const now = new Date().toISOString();

    try {
      const result = await query(
        `UPDATE users 
         SET status = $1,
             call_attempts = call_attempts + 1,
             last_call_date = $2,
             did_number = COALESCE($3, did_number),
             last_call_data = $4,
             updated_at = $5
         WHERE id = $6
         RETURNING *`,
        [status, now, callData.didNumber, JSON.stringify(callData), now, id]
      );

      if (result.rows.length === 0) {
        throw new Error('User not found');
      }

      return result.rows[0];
    } catch (error) {
      console.error('Error in updateCallStatus:', error);
      throw error;
    }
  }

  /**
   * Mark user as answered (real person responded)
   */
  async markUserAnswered(phone, answerType = 'answered', conversationStage = null) {
    try {
      // Normalize phone number for search
      const normalizedPhone = phone.replace(/[^0-9]/g, '');
      
      // Find user by phone (PostgreSQL REGEXP_REPLACE)
      const findResult = await query(
        `SELECT * FROM users WHERE REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = $1`,
        [normalizedPhone]
      );

      if (findResult.rows.length === 0) {
        console.log(`⚠️  User not found for phone: ${phone}`);
        return null;
      }

      const user = findResult.rows[0];
      const isRealAnswer = answerType === 'answered';
      const now = new Date().toISOString();

      const result = await query(
        `UPDATE users 
         SET answered = $1,
             answer_type = $2,
             answered_at = COALESCE($3, answered_at),
             conversation_stage = COALESCE($4, conversation_stage),
             updated_at = $5
         WHERE id = $6
         RETURNING *`,
        [
          isRealAnswer,
          answerType,
          isRealAnswer ? now : null,
          conversationStage,
          now,
          user.id
        ]
      );

      console.log(`✅ User marked as ${answerType}: ${user.firstname} ${user.lastname}`);
      return result.rows[0];
    } catch (error) {
      console.error('Error in markUserAnswered:', error);
      return null;
    }
  }

  /**
   * Get users by answer type
   */
  async getUsersByAnswerType(answerType) {
    try {
      const result = await query(
        'SELECT * FROM users WHERE answer_type = $1 ORDER BY created_at DESC',
        [answerType]
      );
      return result.rows;
    } catch (error) {
      console.error('Error in getUsersByAnswerType:', error);
      return [];
    }
  }

  /**
   * Get answered users (real people who responded)
   */
  async getAnsweredUsers() {
    try {
      const result = await query(
        'SELECT * FROM users WHERE answered = true ORDER BY answered_at DESC'
      );
      return result.rows;
    } catch (error) {
      console.error('Error in getAnsweredUsers:', error);
      return [];
    }
  }

  /**
   * Mark user as voicemail (convenience method)
   * This is an alias for markUserAnswered with 'voicemail' answer type
   */
  async markUserAsVoicemail(phone, stage = null) {
    return await this.markUserAnswered(phone, 'voicemail', stage);
  }

  /**
   * Record a Telnyx call in the telnyx_calls table (source of truth for actual calls)
   */
  async recordTelnyxCall(callControlId, userId, fromNumber, toNumber) {
    try {
      const result = await query(
        `INSERT INTO telnyx_calls (
          call_control_id, user_id, from_number, to_number, status, initiated_at
        ) VALUES ($1, $2, $3, $4, 'initiated', NOW())
        ON CONFLICT (call_control_id) DO NOTHING
        RETURNING *`,
        [callControlId, userId, fromNumber, toNumber]
      );

      if (result.rows.length > 0) {
        console.log(`✅ Telnyx call recorded: ${callControlId}`);
        return result.rows[0];
      } else {
        console.log(`ℹ️  Telnyx call already recorded: ${callControlId}`);
        return null;
      }
    } catch (error) {
      console.error('Error recording Telnyx call:', error);
      throw error;
    }
  }

  /**
   * Mark Telnyx call webhook as received
   */
  async markTelnyxCallWebhookReceived(callControlId) {
    try {
      const result = await query(
        `UPDATE telnyx_calls 
         SET webhook_received = true,
             webhook_received_at = NOW(),
             updated_at = NOW()
         WHERE call_control_id = $1
         RETURNING *`,
        [callControlId]
      );

      if (result.rows.length > 0) {
        return result.rows[0];
      }
      return null;
    } catch (error) {
      console.error('Error marking Telnyx call webhook received:', error);
      return null;
    }
  }

  /**
   * Get Telnyx call statistics (actual calls made through Telnyx API)
   */
  async getTelnyxCallStats() {
    try {
      const result = await query(`
        SELECT 
          COUNT(*) as total_calls,
          COUNT(*) FILTER (WHERE webhook_received = true) as webhook_confirmed,
          COUNT(*) FILTER (WHERE status = 'initiated') as initiated,
          COUNT(*) FILTER (WHERE initiated_at >= NOW() - INTERVAL '24 hours') as calls_last_24h,
          COUNT(*) FILTER (WHERE initiated_at >= NOW() - INTERVAL '7 days') as calls_last_7d
        FROM telnyx_calls
      `);

      return result.rows[0] || {
        total_calls: 0,
        webhook_confirmed: 0,
        initiated: 0,
        calls_last_24h: 0,
        calls_last_7d: 0
      };
    } catch (error) {
      console.error('Error getting Telnyx call stats:', error);
      return {
        total_calls: 0,
        webhook_confirmed: 0,
        initiated: 0,
        calls_last_24h: 0,
        calls_last_7d: 0
      };
    }
  }

  /**
   * Audit: Find users marked as 'called' but with no actual Telnyx call
   */
  async auditCalledUsersWithoutTelnyxCall() {
    try {
      const result = await query(`
        SELECT 
          u.id,
          u.phone,
          u.firstname,
          u.lastname,
          u.status,
          u.last_call_data,
          u.call_attempts,
          u.updated_at
        FROM users u
        WHERE u.status = 'called'
          AND NOT EXISTS (
            SELECT 1 
            FROM telnyx_calls tc 
            WHERE tc.user_id = u.id
          )
        ORDER BY u.updated_at DESC
        LIMIT 100
      `);

      return result.rows;
    } catch (error) {
      console.error('Error auditing called users:', error);
      return [];
    }
  }
}

module.exports = new UserModel();
