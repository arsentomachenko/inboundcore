const { Pool } = require('pg');

// Database configuration
const poolConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'telnyx_voice_ai',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: parseInt(process.env.DB_POOL_MAX) || 20, // Maximum number of clients in the pool
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT) || 30000,
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT) || 10000, // Increased from 2000 to 10000ms
  statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT) || 30000, // 30 seconds for query execution
  query_timeout: parseInt(process.env.DB_QUERY_TIMEOUT) || 30000, // 30 seconds for query timeout
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
};

// Create connection pool
const pool = new Pool(poolConfig);

// Track connection state
let isConnected = false;
let lastConnectionError = null;

// Test connection
pool.on('connect', (client) => {
  if (!isConnected) {
    console.log('✅ Database connected');
    isConnected = true;
    lastConnectionError = null;
  }
});

pool.on('error', (err) => {
  console.error('❌ Unexpected database pool error:', err.message);
  lastConnectionError = err;
  isConnected = false;
  
  // Don't exit the process - allow retries
  // Only exit on critical errors that can't be recovered
  if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
    console.error('⚠️  Database server appears to be unavailable. Will retry on next query.');
  }
});

/**
 * Check if error is retryable
 */
function isRetryableError(error) {
  if (!error) return false;
  
  const retryableCodes = [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    '57P01', // Admin shutdown
    '57P02', // Crash shutdown
    '57P03', // Cannot connect now
    '08003', // Connection does not exist
    '08006', // Connection failure
  ];
  
  const retryableMessages = [
    'Connection terminated',
    'Connection terminated unexpectedly',
    'Connection terminated due to connection timeout',
    'timeout',
    'TIMEOUT',
  ];
  
  return (
    retryableCodes.includes(error.code) ||
    retryableMessages.some(msg => error.message?.includes(msg))
  );
}

/**
 * Sleep helper for retries
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute a query with retry logic
 */
async function query(text, params, retries = 3) {
  const start = Date.now();
  let lastError;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await pool.query(text, params);
      const duration = Date.now() - start;
      
      if (process.env.LOG_QUERIES === 'true') {
        console.log('Executed query', { text, duration, rows: result.rowCount });
      }
      
      // Reset connection state on success
      if (!isConnected) {
        isConnected = true;
        lastConnectionError = null;
      }
      
      return result;
    } catch (error) {
      lastError = error;
      const duration = Date.now() - start;
      
      // Check if error is retryable
      if (isRetryableError(error) && attempt < retries) {
        const waitTime = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // Exponential backoff, max 5s
        console.warn(
          `⚠️  Database query failed (attempt ${attempt}/${retries}), retrying in ${waitTime}ms...`,
          error.message
        );
        await sleep(waitTime);
        continue;
      }
      
      // Log error with context
      console.error('Database query error:', {
        message: error.message,
        code: error.code,
        duration,
        attempt,
        query: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
      });
      
      throw error;
    }
  }
  
  throw lastError;
}

/**
 * Get a client from the pool for transactions with retry logic
 */
async function getClient(retries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const client = await pool.connect();
      const originalQuery = client.query;
      const originalRelease = client.release;
      
      // Set a timeout of 30 seconds, after which we will log this client's last query
      const timeout = setTimeout(() => {
        console.error('⚠️  A client has been checked out for more than 30 seconds!', {
          lastQuery: client.lastQuery?.[0]?.substring(0, 100),
        });
      }, 30000);
      
      // Monkey patch the query method to keep track of the last query executed
      client.query = (...args) => {
        client.lastQuery = args;
        return originalQuery.apply(client, args);
      };
      
      client.release = () => {
        // Clear timeout
        clearTimeout(timeout);
        // Set the methods back to their old un-monkey-patched version
        client.query = originalQuery;
        client.release = originalRelease;
        return originalRelease.apply(client);
      };
      
      // Reset connection state on success
      if (!isConnected) {
        isConnected = true;
        lastConnectionError = null;
      }
      
      return client;
    } catch (error) {
      lastError = error;
      
      if (isRetryableError(error) && attempt < retries) {
        const waitTime = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        console.warn(
          `⚠️  Failed to get database client (attempt ${attempt}/${retries}), retrying in ${waitTime}ms...`,
          error.message
        );
        await sleep(waitTime);
        continue;
      }
      
      console.error('Error getting database client:', error.message);
      throw error;
    }
  }
  
  throw lastError;
}

/**
 * Check database connection health
 */
async function checkConnection() {
  try {
    const result = await query('SELECT NOW() as current_time', [], 1); // Use query function with 1 retry
    isConnected = true;
    lastConnectionError = null;
    return { healthy: true, timestamp: result.rows[0].current_time };
  } catch (error) {
    isConnected = false;
    lastConnectionError = error;
    return { healthy: false, error: error.message };
  }
}

/**
 * Get connection pool statistics
 */
function getPoolStats() {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    isConnected,
    lastConnectionError: lastConnectionError?.message,
  };
}

/**
 * Initialize database - create tables if they don't exist
 */
async function initializeDatabase() {
  try {
    console.log('🔄 Initializing database...');
    
    // Create users table
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        firstname VARCHAR(255),
        lastname VARCHAR(255),
        phone VARCHAR(50) UNIQUE,
        address TEXT,
        email VARCHAR(255),
        notes TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        call_attempts INTEGER DEFAULT 0,
        last_call_date TIMESTAMP,
        did_number VARCHAR(50),
        answered BOOLEAN DEFAULT false,
        answer_type VARCHAR(50),
        answered_at TIMESTAMP,
        conversation_stage VARCHAR(100),
        last_call_data JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Create indexes for better performance
    await query('CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone)');
    await query('CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)');
    await query('CREATE INDEX IF NOT EXISTS idx_users_answer_type ON users(answer_type)');
    await query('CREATE INDEX IF NOT EXISTS idx_users_answered ON users(answered)');
    await query('CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at)');
    await query('CREATE INDEX IF NOT EXISTS idx_users_last_call_date ON users(last_call_date)');
    
    // Create full-text search index
    await query(`
      CREATE INDEX IF NOT EXISTS idx_users_search 
      ON users USING gin(to_tsvector('english', 
        COALESCE(firstname, '') || ' ' || 
        COALESCE(lastname, '') || ' ' || 
        COALESCE(email, '')
      ))
    `);
    
    // Create conversations table
    await query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        call_control_id VARCHAR(255) UNIQUE NOT NULL,
        from_number VARCHAR(50),
        to_number VARCHAR(50),
        start_time BIGINT,
        end_time BIGINT,
        duration INTEGER,
        cost DECIMAL(10, 4),
        model VARCHAR(100),
        messages JSONB,
        status VARCHAR(50),
        cost_breakdown JSONB,
        hangup_cause VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Create indexes for conversations table
    await query('CREATE INDEX IF NOT EXISTS idx_conversations_call_control_id ON conversations(call_control_id)');
    await query('CREATE INDEX IF NOT EXISTS idx_conversations_from_number ON conversations(from_number)');
    await query('CREATE INDEX IF NOT EXISTS idx_conversations_to_number ON conversations(to_number)');
    await query('CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status)');
    await query('CREATE INDEX IF NOT EXISTS idx_conversations_start_time ON conversations(start_time DESC)');
    await query('CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at DESC)');
    
    // Create costs table
    await query(`
      CREATE TABLE IF NOT EXISTS costs (
        id SERIAL PRIMARY KEY,
        call_control_id VARCHAR(255) UNIQUE NOT NULL,
        initiated_time BIGINT,
        connected_time BIGINT,
        end_time BIGINT,
        duration_seconds INTEGER DEFAULT 0,
        transcription_started BOOLEAN DEFAULT false,
        transcription_start_time BIGINT,
        telnyx_call_minutes DECIMAL(10, 4) DEFAULT 0,
        telnyx_call_cost DECIMAL(10, 6) DEFAULT 0,
        telnyx_transcription_minutes DECIMAL(10, 4) DEFAULT 0,
        telnyx_transcription_cost DECIMAL(10, 6) DEFAULT 0,
        telnyx_tts_characters INTEGER DEFAULT 0,
        telnyx_tts_cost DECIMAL(10, 6) DEFAULT 0,
        telnyx_streaming_minutes DECIMAL(10, 4) DEFAULT 0,
        telnyx_streaming_cost DECIMAL(10, 6) DEFAULT 0,
        telnyx_transfer_cost DECIMAL(10, 6) DEFAULT 0,
        telnyx_amd_cost DECIMAL(10, 6) DEFAULT 0,
        telnyx_total DECIMAL(10, 6) DEFAULT 0,
        elevenlabs_tts_minutes DECIMAL(10, 4) DEFAULT 0,
        elevenlabs_tts_cost DECIMAL(10, 6) DEFAULT 0,
        elevenlabs_stt_hours DECIMAL(10, 4) DEFAULT 0,
        elevenlabs_stt_cost DECIMAL(10, 6) DEFAULT 0,
        elevenlabs_total DECIMAL(10, 6) DEFAULT 0,
        openai_model VARCHAR(100),
        openai_input_tokens INTEGER DEFAULT 0,
        openai_output_tokens INTEGER DEFAULT 0,
        openai_api_calls INTEGER DEFAULT 0,
        openai_cost DECIMAL(10, 6) DEFAULT 0,
        total_cost DECIMAL(10, 6) DEFAULT 0,
        breakdown JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Add new columns if they don't exist (for existing databases)
    await query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='costs' AND column_name='telnyx_streaming_minutes') THEN
          ALTER TABLE costs ADD COLUMN telnyx_streaming_minutes DECIMAL(10, 4) DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='costs' AND column_name='telnyx_streaming_cost') THEN
          ALTER TABLE costs ADD COLUMN telnyx_streaming_cost DECIMAL(10, 6) DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='costs' AND column_name='elevenlabs_tts_minutes') THEN
          ALTER TABLE costs ADD COLUMN elevenlabs_tts_minutes DECIMAL(10, 4) DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='costs' AND column_name='elevenlabs_tts_cost') THEN
          ALTER TABLE costs ADD COLUMN elevenlabs_tts_cost DECIMAL(10, 6) DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='costs' AND column_name='elevenlabs_stt_hours') THEN
          ALTER TABLE costs ADD COLUMN elevenlabs_stt_hours DECIMAL(10, 4) DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='costs' AND column_name='elevenlabs_stt_cost') THEN
          ALTER TABLE costs ADD COLUMN elevenlabs_stt_cost DECIMAL(10, 6) DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='costs' AND column_name='elevenlabs_total') THEN
          ALTER TABLE costs ADD COLUMN elevenlabs_total DECIMAL(10, 6) DEFAULT 0;
        END IF;
      END $$;
    `);
    
    // Create indexes for costs table
    await query('CREATE INDEX IF NOT EXISTS idx_costs_call_control_id ON costs(call_control_id)');
    await query('CREATE INDEX IF NOT EXISTS idx_costs_created_at ON costs(created_at DESC)');
    await query('CREATE INDEX IF NOT EXISTS idx_costs_total_cost ON costs(total_cost DESC)');
    
    // Create transferred_calls table
    await query(`
      CREATE TABLE IF NOT EXISTS transferred_calls (
        id SERIAL PRIMARY KEY,
        call_control_id VARCHAR(255) UNIQUE NOT NULL,
        user_id UUID,
        phone VARCHAR(50),
        name VARCHAR(255),
        address TEXT,
        from_number VARCHAR(50),
        to_number VARCHAR(50),
        transferred_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Create indexes for transferred_calls table
    await query('CREATE INDEX IF NOT EXISTS idx_transferred_calls_call_control_id ON transferred_calls(call_control_id)');
    await query('CREATE INDEX IF NOT EXISTS idx_transferred_calls_user_id ON transferred_calls(user_id)');
    await query('CREATE INDEX IF NOT EXISTS idx_transferred_calls_transferred_at ON transferred_calls(transferred_at DESC)');
    
    // Create telnyx_calls table to track actual Telnyx API calls (source of truth)
    await query(`
      CREATE TABLE IF NOT EXISTS telnyx_calls (
        id SERIAL PRIMARY KEY,
        call_control_id VARCHAR(255) UNIQUE NOT NULL,
        user_id UUID,
        from_number VARCHAR(50),
        to_number VARCHAR(50),
        initiated_at TIMESTAMP DEFAULT NOW(),
        telnyx_initiated_at TIMESTAMP,
        status VARCHAR(50) DEFAULT 'initiated',
        webhook_received BOOLEAN DEFAULT false,
        webhook_received_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Create indexes for telnyx_calls table
    await query('CREATE INDEX IF NOT EXISTS idx_telnyx_calls_call_control_id ON telnyx_calls(call_control_id)');
    await query('CREATE INDEX IF NOT EXISTS idx_telnyx_calls_user_id ON telnyx_calls(user_id)');
    await query('CREATE INDEX IF NOT EXISTS idx_telnyx_calls_initiated_at ON telnyx_calls(initiated_at DESC)');
    await query('CREATE INDEX IF NOT EXISTS idx_telnyx_calls_status ON telnyx_calls(status)');
    
    // Create call_recordings table
    await query(`
      CREATE TABLE IF NOT EXISTS call_recordings (
        id SERIAL PRIMARY KEY,
        call_control_id VARCHAR(255) UNIQUE NOT NULL,
        recording_id VARCHAR(255),
        recording_url TEXT,
        duration_seconds INTEGER,
        recording_started_at TIMESTAMP,
        recording_ended_at TIMESTAMP,
        status VARCHAR(50) DEFAULT 'pending',
        error_message TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Create indexes for call_recordings table
    await query('CREATE INDEX IF NOT EXISTS idx_call_recordings_call_control_id ON call_recordings(call_control_id)');
    await query('CREATE INDEX IF NOT EXISTS idx_call_recordings_status ON call_recordings(status)');
    await query('CREATE INDEX IF NOT EXISTS idx_call_recordings_created_at ON call_recordings(created_at DESC)');
    
    console.log('✅ Database initialized successfully');
    return true;
  } catch (error) {
    console.error('❌ Error initializing database:', error);
    throw error;
  }
}

/**
 * Close all connections
 */
async function close() {
  await pool.end();
  console.log('✅ Database pool closed');
}

module.exports = {
  query,
  getClient,
  pool,
  initializeDatabase,
  close,
  checkConnection,
  getPoolStats,
};

