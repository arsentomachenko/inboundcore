#!/usr/bin/env node

/**
 * Migration script to transfer conversation data from JSON file to PostgreSQL database
 * 
 * Usage:
 *   node scripts/migrateConversationsToDatabase.js
 * 
 * This script will:
 * 1. Read all conversations from conversations.json
 * 2. Initialize the PostgreSQL conversations table
 * 3. Insert all conversations into the database
 * 4. Create a backup of the JSON file
 * 5. Verify the migration was successful
 */

require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { query, initializeDatabase, pool } = require('../config/database');

const DATA_FILE = path.join(__dirname, '../data/conversations.json');
const BACKUP_FILE = path.join(__dirname, '../data/conversations-pre-migration-backup.json');

async function readJSONConversations() {
  console.log('📖 Reading conversations from JSON file...');
  
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    const conversations = JSON.parse(data);
    
    if (!Array.isArray(conversations)) {
      throw new Error('conversations.json is not an array');
    }
    
    console.log(`✅ Loaded ${conversations.length.toLocaleString()} conversations from JSON`);
    return conversations;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('⚠️  No conversations.json file found - nothing to migrate');
      return [];
    }
    console.error('❌ Error reading JSON file:', error.message);
    throw error;
  }
}

async function createBackup() {
  console.log('💾 Creating backup of JSON file...');
  
  try {
    await fs.copyFile(DATA_FILE, BACKUP_FILE);
    console.log(`✅ Backup created: ${BACKUP_FILE}`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('⚠️  No file to backup');
      return;
    }
    console.error('❌ Error creating backup:', error.message);
    throw error;
  }
}

async function migrateConversations(conversations) {
  console.log(`🔄 Migrating ${conversations.length.toLocaleString()} conversations to database...`);
  
  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const conv of conversations) {
    try {
      // Check if conversation already exists
      const existing = await query(
        'SELECT id FROM conversations WHERE call_control_id = $1',
        [conv.callControlId]
      );
      
      if (existing.rows.length > 0) {
        skipped++;
        continue;
      }

      // Insert conversation
      await query(
        `INSERT INTO conversations (
          call_control_id, from_number, to_number, start_time, end_time,
          duration, cost, model, messages, status, cost_breakdown, hangup_cause,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())`,
        [
          conv.callControlId,
          conv.fromNumber,
          conv.toNumber,
          conv.startTime,
          conv.endTime,
          conv.duration,
          conv.cost,
          conv.model,
          JSON.stringify(conv.messages || []),
          conv.status,
          JSON.stringify(conv.costBreakdown || {}),
          conv.hangupCause || null
        ]
      );

      migrated++;
      
      if (migrated % 100 === 0) {
        console.log(`   Progress: ${migrated} conversations migrated...`);
      }
    } catch (error) {
      console.error(`   ❌ Error migrating conversation ${conv.callControlId}:`, error.message);
      errors++;
    }
  }

  return { migrated, skipped, errors };
}

async function verifyMigration(originalCount) {
  console.log('🔍 Verifying migration...');
  
  try {
    const result = await query('SELECT COUNT(*) as count FROM conversations');
    const dbCount = parseInt(result.rows[0].count);
    
    console.log(`   Original JSON conversations: ${originalCount.toLocaleString()}`);
    console.log(`   Database conversations: ${dbCount.toLocaleString()}`);
    
    if (dbCount >= originalCount) {
      console.log('✅ Migration verified successfully!');
      return true;
    } else {
      console.log(`⚠️  Warning: Database has fewer conversations than original (${dbCount} vs ${originalCount})`);
      return false;
    }
  } catch (error) {
    console.error('❌ Error verifying migration:', error.message);
    return false;
  }
}

async function showStats() {
  console.log('\n📊 Database Statistics:');
  
  try {
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
    console.log(`   Total conversations: ${parseInt(s.total).toLocaleString()}`);
    console.log(`   Completed: ${parseInt(s.completed).toLocaleString()}`);
    console.log(`   Transferred: ${parseInt(s.transferred).toLocaleString()}`);
    console.log(`   No Answer: ${parseInt(s.no_answer).toLocaleString()}`);
    console.log(`   No Response: ${parseInt(s.no_response).toLocaleString()}`);
    console.log(`   Voicemail: ${parseInt(s.voicemail).toLocaleString()}`);
    console.log(`   Avg Duration: ${parseFloat(s.avg_duration).toFixed(1)}s`);
    console.log(`   Total Cost: $${parseFloat(s.total_cost).toFixed(4)}`);
  } catch (error) {
    console.error('❌ Error fetching stats:', error.message);
  }
}

async function main() {
  console.log('🚀 Starting conversation database migration...\n');
  
  const startTime = Date.now();
  
  try {
    // Step 1: Initialize database
    await initializeDatabase();
    
    // Step 2: Read JSON conversations
    const conversations = await readJSONConversations();
    
    if (conversations.length === 0) {
      console.log('⚠️  No conversations to migrate');
      process.exit(0);
    }
    
    // Step 3: Create backup
    await createBackup();
    
    // Step 4: Migrate conversations
    const { migrated, skipped, errors } = await migrateConversations(conversations);
    
    // Step 5: Verify migration
    const verified = await verifyMigration(conversations.length);
    
    // Step 6: Show statistics
    await showStats();
    
    // Summary
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log('\n' + '='.repeat(60));
    console.log('📋 Migration Summary:');
    console.log('='.repeat(60));
    console.log(`✅ Successfully migrated: ${migrated.toLocaleString()} conversations`);
    console.log(`⏭️  Skipped (duplicates): ${skipped.toLocaleString()} conversations`);
    console.log(`❌ Errors: ${errors} conversations`);
    console.log(`⏱️  Duration: ${duration} seconds`);
    console.log(`🎉 Migration ${verified ? 'COMPLETED' : 'COMPLETED (with warnings)'}`);
    console.log('='.repeat(60));
    
    if (verified && errors === 0) {
      console.log('\n✅ Next steps:');
      console.log('   1. Conversations are now in PostgreSQL');
      console.log('   2. Restart your application');
      console.log('   3. Test the conversation history feature');
      console.log('   4. Once verified, you can optionally delete the JSON file');
      console.log('      (Backup saved at: conversations-pre-migration-backup.json)');
    }
    
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  } finally {
    // Close database connection
    await pool.end();
  }
}

// Run migration
main();

