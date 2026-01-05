/**
 * Clear all conversations and costs data
 * - Clears conversations.json
 * - Clears costs.json
 * - Clears conversations table in PostgreSQL
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs').promises;
const { query, close } = require('../config/database');
const costTrackingService = require('../services/costTrackingService');

const CONVERSATIONS_FILE = path.join(__dirname, '../data/conversations.json');
const COSTS_FILE = path.join(__dirname, '../data/costs.json');

async function clearJSONFiles() {
  console.log('📁 Clearing JSON files...');
  
  try {
    // Clear conversations.json
    await fs.writeFile(CONVERSATIONS_FILE, JSON.stringify([], null, 2), 'utf8');
    console.log('   ✅ Cleared conversations.json');
    
    // Clear costs.json
    await fs.writeFile(COSTS_FILE, JSON.stringify({}, null, 2), 'utf8');
    console.log('   ✅ Cleared costs.json');
  } catch (error) {
    console.error('   ❌ Error clearing JSON files:', error.message);
    throw error;
  }
}

async function clearDatabase() {
  console.log('🗄️  Clearing PostgreSQL database...');
  
  try {
    // Delete all conversations from database
    const result = await query('DELETE FROM conversations');
    console.log(`   ✅ Deleted ${result.rowCount} conversations from database`);
  } catch (error) {
    console.error('   ❌ Error clearing database:', error.message);
    throw error;
  }
}

async function clearInMemoryCosts() {
  console.log('💾 Clearing in-memory cost tracking...');
  
  try {
    // Clear the in-memory Map and save empty state
    await costTrackingService.clearAllCosts();
    console.log('   ✅ Cleared in-memory cost tracking');
  } catch (error) {
    console.error('   ❌ Error clearing in-memory costs:', error.message);
    throw error;
  }
}

async function main() {
  console.log('🧹 Starting data cleanup...\n');
  
  try {
    // Clear JSON files
    await clearJSONFiles();
    
    // Clear in-memory costs (must be done before database to avoid loading old data)
    await clearInMemoryCosts();
    
    // Clear database
    await clearDatabase();
    
    console.log('\n✅ All data cleared successfully!');
    console.log('   - conversations.json: cleared');
    console.log('   - costs.json: cleared');
    console.log('   - In-memory cost tracking: cleared');
    console.log('   - PostgreSQL conversations table: cleared');
    console.log('\n⚠️  NOTE: If the server is running, restart it to reload empty costs.');
  } catch (error) {
    console.error('\n❌ Error during cleanup:', error.message);
    process.exit(1);
  } finally {
    await close();
  }
}

// Run the script
main();

