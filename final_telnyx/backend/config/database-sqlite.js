/**
 * SQLite Database Configuration (Alternative to PostgreSQL)
 * 
 * To use SQLite instead of PostgreSQL:
 * 1. Run: npm install better-sqlite3
 * 2. Rename this file from database-sqlite.js to database.js
 * 3. Backup the PostgreSQL version if needed
 * 4. No database server setup required!
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/telnyx.db');

// Create connection
const db = new Database(DB_PATH, { verbose: console.log });

console.log(`✅ SQLite database: ${DB_PATH}`);

/**
 * Execute a query (SQLite version)
 */
function query(sql, params = []) {
  try {
    // Convert PostgreSQL placeholders ($1, $2) to SQLite (?, ?)
    let sqliteSql = sql;
    if (params && params.length > 0) {
      // Replace $1, $2, etc. with ?
      for (let i = params.length; i >= 1; i--) {
        sqliteSql = sqliteSql.replace(new RegExp(`\\$${i}`, 'g'), '?');
      }
    }

    if (sql.trim().toUpperCase().startsWith('SELECT')) {
      const stmt = db.prepare(sqliteSql);
      const rows = stmt.all(...params);
      return { rows, rowCount: rows.length };
    } else {
      const stmt = db.prepare(sqliteSql);
      const info = stmt.run(...params);
      
      // For INSERT statements, return the inserted row if RETURNING clause exists
      if (sql.includes('RETURNING')) {
        const id = info.lastInsertRowid;
        const tableName = sql.match(/INSERT INTO (\w+)/i)?.[1];
        if (tableName && id) {
          const row = db.prepare(`SELECT * FROM ${tableName} WHERE rowid = ?`).get(id);
          return { rows: [row], rowCount: 1 };
        }
      }
      
      return { rows: [], rowCount: info.changes };
    }
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  }
}

/**
 * Get a client (SQLite doesn't use connection pooling)
 */
async function getClient() {
  return {
    query: (sql, params) => Promise.resolve(query(sql, params)),
    release: () => {}
  };
}

/**
 * Initialize database - create tables if they don't exist
 */
async function initializeDatabase() {
  try {
    console.log('🔄 Initializing SQLite database...');
    
    // Create users table
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        firstname TEXT,
        lastname TEXT,
        phone TEXT UNIQUE,
        address TEXT,
        email TEXT,
        notes TEXT,
        status TEXT DEFAULT 'pending',
        call_attempts INTEGER DEFAULT 0,
        last_call_date TEXT,
        did_number TEXT,
        answered INTEGER DEFAULT 0,
        answer_type TEXT,
        answered_at TEXT,
        conversation_stage TEXT,
        last_call_data TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    
    // Create indexes for better performance
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_answer_type ON users(answer_type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_answered ON users(answered)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_last_call_date ON users(last_call_date)');
    
    console.log('✅ SQLite database initialized successfully');
    return true;
  } catch (error) {
    console.error('❌ Error initializing database:', error);
    throw error;
  }
}

/**
 * Close database connection
 */
async function close() {
  db.close();
  console.log('✅ Database closed');
}

// Make pool compatible with PostgreSQL code
const pool = {
  query: (sql, params) => Promise.resolve(query(sql, params)),
  end: close
};

module.exports = {
  query: (sql, params) => Promise.resolve(query(sql, params)),
  getClient,
  pool,
  initializeDatabase,
  close,
  db
};

