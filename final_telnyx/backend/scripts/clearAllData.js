#!/usr/bin/env node
/**
 * Clear All Cost & Conversation History
 * This script deletes all data from the costs and conversations tables
 */

const { query, close } = require('../config/database');

async function clearAllData() {
  try {
    console.log('🗑️  Starting data cleanup...\n');

    // Clear conversations table
    console.log('📋 Clearing conversations table...');
    const conversationsResult = await query('DELETE FROM conversations');
    console.log(`✅ Deleted ${conversationsResult.rowCount} conversation records\n`);

    // Clear costs table
    console.log('💰 Clearing costs table...');
    const costsResult = await query('DELETE FROM costs');
    console.log(`✅ Deleted ${costsResult.rowCount} cost records\n`);

    // Reset sequences to start from 1 again
    console.log('🔄 Resetting ID sequences...');
    await query('ALTER SEQUENCE conversations_id_seq RESTART WITH 1');
    await query('ALTER SEQUENCE costs_id_seq RESTART WITH 1');
    console.log('✅ Sequences reset\n');

    console.log('🎉 All cost and conversation history cleared successfully!');
    
  } catch (error) {
    console.error('❌ Error clearing data:', error.message);
    process.exit(1);
  } finally {
    // Close database connection
    await close();
  }
}

// Run the cleanup
clearAllData();

