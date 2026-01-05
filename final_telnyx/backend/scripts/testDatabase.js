#!/usr/bin/env node

/**
 * Test database connection and show table status
 */

require('dotenv').config();
const { query, pool } = require('../config/database');

async function testConnection() {
  console.log('🔍 Testing PostgreSQL connection...\n');
  
  try {
    // Test basic connection
    const result = await query('SELECT NOW() as current_time, version() as pg_version');
    console.log('✅ Database connection successful!');
    console.log(`   Time: ${result.rows[0].current_time}`);
    console.log(`   Version: ${result.rows[0].pg_version.split(',')[0]}\n`);
    
    // Check if tables exist
    console.log('📊 Checking tables...\n');
    
    const tables = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    
    if (tables.rows.length === 0) {
      console.log('⚠️  No tables found. Run the server once to initialize tables.');
      return;
    }
    
    console.log(`Found ${tables.rows.length} table(s):`);
    for (const table of tables.rows) {
      console.log(`   ✓ ${table.table_name}`);
      
      // Get row count
      try {
        const count = await query(`SELECT COUNT(*) as count FROM ${table.table_name}`);
        console.log(`     Records: ${parseInt(count.rows[0].count).toLocaleString()}`);
      } catch (err) {
        console.log(`     Error getting count: ${err.message}`);
      }
    }
    
    // Show conversation statistics if conversations table exists
    const hasConversations = tables.rows.some(t => t.table_name === 'conversations');
    if (hasConversations) {
      console.log('\n📞 Conversation Statistics:');
      const stats = await query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'completed') as completed,
          COUNT(*) FILTER (WHERE status = 'transferred') as transferred,
          COUNT(*) FILTER (WHERE status = 'no_answer') as no_answer,
          COUNT(*) FILTER (WHERE status = 'no_response') as no_response,
          COUNT(*) FILTER (WHERE status = 'voicemail') as voicemail,
          AVG(duration) as avg_duration,
          SUM(cost) as total_cost
        FROM conversations
      `);
      
      const s = stats.rows[0];
      console.log(`   Total: ${parseInt(s.total).toLocaleString()}`);
      console.log(`   Completed: ${parseInt(s.completed).toLocaleString()}`);
      console.log(`   Transferred: ${parseInt(s.transferred).toLocaleString()}`);
      console.log(`   No Answer: ${parseInt(s.no_answer).toLocaleString()}`);
      console.log(`   No Response: ${parseInt(s.no_response).toLocaleString()}`);
      console.log(`   Voicemail: ${parseInt(s.voicemail).toLocaleString()}`);
      if (s.avg_duration) {
        console.log(`   Avg Duration: ${parseFloat(s.avg_duration).toFixed(1)}s`);
      }
      if (s.total_cost) {
        console.log(`   Total Cost: $${parseFloat(s.total_cost).toFixed(4)}`);
      }
    }
    
    // Show user statistics if users table exists
    const hasUsers = tables.rows.some(t => t.table_name === 'users');
    if (hasUsers) {
      console.log('\n👥 User Statistics:');
      const userStats = await query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'pending') as pending,
          COUNT(*) FILTER (WHERE status = 'called') as called,
          COUNT(*) FILTER (WHERE answered = true) as answered
        FROM users
      `);
      
      const u = userStats.rows[0];
      console.log(`   Total: ${parseInt(u.total).toLocaleString()}`);
      console.log(`   Pending: ${parseInt(u.pending).toLocaleString()}`);
      console.log(`   Called: ${parseInt(u.called).toLocaleString()}`);
      console.log(`   Answered: ${parseInt(u.answered).toLocaleString()}`);
    }
    
    console.log('\n✅ Database test completed successfully!');
    
  } catch (error) {
    console.error('\n❌ Database connection failed!');
    console.error('Error:', error.message);
    console.error('\n🔧 Troubleshooting:');
    console.error('   1. Make sure PostgreSQL is running');
    console.error('   2. Check your .env file has correct database credentials:');
    console.error('      - DB_HOST (default: localhost)');
    console.error('      - DB_PORT (default: 5432)');
    console.error('      - DB_NAME (default: telnyx_voice_ai)');
    console.error('      - DB_USER (default: postgres)');
    console.error('      - DB_PASSWORD');
    console.error('   3. Verify the database exists in PostgreSQL');
    console.error('   4. Check PostgreSQL logs for connection errors');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

testConnection();
