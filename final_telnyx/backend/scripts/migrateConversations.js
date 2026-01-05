/**
 * Migration Script: Backfill Conversations from Costs Data
 * 
 * This script creates conversation records for calls that only have cost data
 * but no conversation records (typically due to AMD detection or early hangup)
 */

const fs = require('fs').promises;
const path = require('path');

async function migrateConversations() {
  const dataDir = path.join(__dirname, '../data');
  const costsFile = path.join(dataDir, 'costs.json');
  const conversationsFile = path.join(dataDir, 'conversations.json');
  
  console.log('📊 Starting conversation migration...\n');
  
  try {
    // Load costs data
    const costsData = JSON.parse(await fs.readFile(costsFile, 'utf8'));
    const costCallIds = Object.keys(costsData);
    console.log(`✅ Loaded ${costCallIds.length} calls from costs.json`);
    
    // Load existing conversations
    let conversations = [];
    try {
      conversations = JSON.parse(await fs.readFile(conversationsFile, 'utf8'));
      console.log(`✅ Loaded ${conversations.length} existing conversations`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      console.log('ℹ️  No existing conversations.json found, starting fresh');
    }
    
    // Create a Set of existing conversation IDs for quick lookup
    const existingIds = new Set(conversations.map(c => c.callControlId));
    console.log(`ℹ️  ${existingIds.size} conversations already exist\n`);
    
    // Track statistics
    let migratedCount = 0;
    let skippedCount = 0;
    
    // Migrate each call from costs
    for (const callControlId of costCallIds) {
      // Skip if conversation already exists
      if (existingIds.has(callControlId)) {
        skippedCount++;
        continue;
      }
      
      const costData = costsData[callControlId];
      
      // Create conversation record from cost data
      const conversation = {
        callControlId: callControlId,
        fromNumber: 'Unknown', // Not available in cost data
        toNumber: 'Unknown',   // Not available in cost data
        startTime: costData.startTime,
        endTime: costData.endTime,
        duration: costData.durationSeconds || 0,
        cost: costData.totalCost || 0,
        model: costData.openai?.model || 'gpt-4o-mini',
        messages: [],  // No message history available
        status: determineStatus(costData),
        costBreakdown: {
          total: costData.totalCost || 0,
          telnyx: costData.telnyx?.total || 0,
          openai: costData.openai?.cost || 0,
          details: {
            telnyx: {
              callCost: costData.telnyx?.callCost || 0,
              transcriptionCost: costData.telnyx?.transcriptionCost || 0,
              ttsCost: costData.telnyx?.ttsCost || 0,
              transferCost: costData.telnyx?.transferCost || 0,
            },
            openai: {
              inputTokens: costData.openai?.inputTokens || 0,
              outputTokens: costData.openai?.outputTokens || 0,
              apiCalls: costData.openai?.apiCalls || 0,
            }
          }
        },
        migrated: true  // Flag to indicate this was backfilled
      };
      
      // Add note about migration
      if (conversation.messages.length === 0) {
        conversation.messages.push({
          speaker: 'AI',
          text: '[No conversation history available - Call may have been voicemail/AMD detected or ended before conversation started]',
          timestamp: costData.startTime
        });
      }
      
      conversations.push(conversation);
      migratedCount++;
      
      if (migratedCount % 10 === 0) {
        console.log(`  Migrated ${migratedCount} conversations...`);
      }
    }
    
    // Sort by startTime descending (newest first)
    conversations.sort((a, b) => b.startTime - a.startTime);
    
    // Save updated conversations
    await fs.writeFile(conversationsFile, JSON.stringify(conversations, null, 2), 'utf8');
    
    console.log('\n✅ Migration complete!');
    console.log(`   Migrated: ${migratedCount} new conversations`);
    console.log(`   Skipped: ${skippedCount} existing conversations`);
    console.log(`   Total: ${conversations.length} conversations in database`);
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

/**
 * Determine conversation status from cost data
 */
function determineStatus(costData) {
  // If there were OpenAI API calls, there was likely a conversation
  if (costData.openai?.apiCalls > 0) {
    // Check if transferred
    if (costData.telnyx?.transferCost > 0) {
      return 'transferred';
    }
    return 'completed';
  }
  
  // If there was TTS but no OpenAI calls, AI spoke but no user response
  if (costData.telnyx?.ttsCost > 0) {
    return 'no_response';
  }
  
  // Very short call with no TTS - likely AMD/voicemail
  if (costData.durationSeconds < 10) {
    return 'voicemail';
  }
  
  // Default to no_answer
  return 'no_answer';
}

// Run migration
migrateConversations().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});



