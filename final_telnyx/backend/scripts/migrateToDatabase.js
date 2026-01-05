#!/usr/bin/env node

/**
 * Migration script to transfer user data from JSON file to PostgreSQL database
 * 
 * Usage:
 *   node scripts/migrateToDatabase.js
 * 
 * This script will:
 * 1. Read all users from users.json
 * 2. Initialize the PostgreSQL database
 * 3. Insert all users into the database in batches
 * 4. Create a backup of the JSON file
 * 5. Verify the migration was successful
 */

require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { query, initializeDatabase, pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

const DATA_FILE = path.join(__dirname, '../data/users.json');
const BACKUP_FILE = path.join(__dirname, '../data/users-pre-migration-backup.json');
const BATCH_SIZE = 1000; // Insert 1000 users at a time for performance

async function readJSONUsers() {
  console.log('📖 Reading users from JSON file...');
  
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    const users = JSON.parse(data);
    
    if (!Array.isArray(users)) {
      throw new Error('users.json is not an array');
    }
    
    console.log(`✅ Loaded ${users.length.toLocaleString()} users from JSON`);
    return users;
  } catch (error) {
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
    console.error('❌ Error creating backup:', error.message);
    throw error;
  }
}

async function migrateUsers(users) {
  console.log(`🔄 Migrating ${users.length.toLocaleString()} users to database...`);
  
  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  // Process in batches for better performance
  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    const batch = users.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(users.length / BATCH_SIZE);
    
    console.log(`   Processing batch ${batchNum}/${totalBatches} (${batch.length} users)...`);
    
    for (const user of batch) {
      try {
        // Skip if phone number already exists (avoid duplicates)
        if (user.phone) {
          const existing = await query(
            'SELECT id FROM users WHERE phone = $1',
            [user.phone]
          );
          
          if (existing.rows.length > 0) {
            skipped++;
            continue;
          }
        }

        // Ensure user has an ID
        const userId = user.id || uuidv4();

        // Insert user
        await query(
          `INSERT INTO users (
            id, firstname, lastname, phone, address, email, notes,
            status, call_attempts, last_call_date, did_number,
            answered, answer_type, answered_at, conversation_stage,
            last_call_data, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
          [
            userId,
            user.firstname || '',
            user.lastname || '',
            user.phone || '',
            user.address || '',
            user.email || '',
            user.notes || '',
            user.status || 'pending',
            user.callAttempts || 0,
            user.lastCallDate || null,
            user.didNumber || null,
            user.answered || false,
            user.answerType || null,
            user.answeredAt || null,
            user.conversationStage || null,
            user.lastCallData ? JSON.stringify(user.lastCallData) : null,
            user.createdAt || new Date().toISOString(),
            user.updatedAt || new Date().toISOString()
          ]
        );

        migrated++;
      } catch (error) {
        console.error(`   ❌ Error migrating user ${user.id || 'unknown'}:`, error.message);
        errors++;
      }
    }
    
    // Show progress
    const progress = ((i + batch.length) / users.length * 100).toFixed(1);
    console.log(`   Progress: ${progress}% (${migrated.toLocaleString()} migrated, ${skipped.toLocaleString()} skipped, ${errors} errors)`);
  }

  return { migrated, skipped, errors };
}

async function verifyMigration(originalCount) {
  console.log('🔍 Verifying migration...');
  
  try {
    const result = await query('SELECT COUNT(*) as count FROM users');
    const dbCount = parseInt(result.rows[0].count);
    
    console.log(`   Original JSON users: ${originalCount.toLocaleString()}`);
    console.log(`   Database users: ${dbCount.toLocaleString()}`);
    
    if (dbCount >= originalCount) {
      console.log('✅ Migration verified successfully!');
      return true;
    } else {
      console.log(`⚠️  Warning: Database has fewer users than original (${dbCount} vs ${originalCount})`);
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
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'called') as called,
        COUNT(*) FILTER (WHERE status = 'qualified') as qualified,
        COUNT(*) FILTER (WHERE status = 'disqualified') as disqualified,
        COUNT(*) FILTER (WHERE answered = true) as answered,
        COUNT(*) FILTER (WHERE answer_type = 'voicemail') as voicemail,
        COUNT(*) FILTER (WHERE answer_type = 'no_answer') as no_answer
      FROM users
    `);
    
    const s = stats.rows[0];
    console.log(`   Total users: ${parseInt(s.total).toLocaleString()}`);
    console.log(`   Pending: ${parseInt(s.pending).toLocaleString()}`);
    console.log(`   Called: ${parseInt(s.called).toLocaleString()}`);
    console.log(`   Qualified: ${parseInt(s.qualified).toLocaleString()}`);
    console.log(`   Disqualified: ${parseInt(s.disqualified).toLocaleString()}`);
    console.log(`   Answered (real people): ${parseInt(s.answered).toLocaleString()}`);
    console.log(`   Voicemail: ${parseInt(s.voicemail).toLocaleString()}`);
    console.log(`   No answer: ${parseInt(s.no_answer).toLocaleString()}`);
  } catch (error) {
    console.error('❌ Error fetching stats:', error.message);
  }
}

async function main() {
  console.log('🚀 Starting database migration...\n');
  
  const startTime = Date.now();
  
  try {
    // Step 1: Initialize database
    await initializeDatabase();
    
    // Step 2: Read JSON users
    const users = await readJSONUsers();
    
    if (users.length === 0) {
      console.log('⚠️  No users to migrate');
      process.exit(0);
    }
    
    // Step 3: Create backup
    await createBackup();
    
    // Step 4: Migrate users
    const { migrated, skipped, errors } = await migrateUsers(users);
    
    // Step 5: Verify migration
    const verified = await verifyMigration(users.length);
    
    // Step 6: Show statistics
    await showStats();
    
    // Summary
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log('\n' + '='.repeat(60));
    console.log('📋 Migration Summary:');
    console.log('='.repeat(60));
    console.log(`✅ Successfully migrated: ${migrated.toLocaleString()} users`);
    console.log(`⏭️  Skipped (duplicates): ${skipped.toLocaleString()} users`);
    console.log(`❌ Errors: ${errors} users`);
    console.log(`⏱️  Duration: ${duration} seconds`);
    console.log(`🎉 Migration ${verified ? 'COMPLETED' : 'COMPLETED (with warnings)'}`);
    console.log('='.repeat(60));
    
    if (verified && errors === 0) {
      console.log('\n✅ Next steps:');
      console.log('   1. Update your .env file with database credentials');
      console.log('   2. Restart your application');
      console.log('   3. Test the application thoroughly');
      console.log('   4. Once verified, you can optionally delete the JSON file');
      console.log('      (Backup saved at: users-pre-migration-backup.json)');
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

