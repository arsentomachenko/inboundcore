// Find the "Voice AI Agent" connection ID
require('dotenv').config();
const telnyx = require('telnyx')(process.env.TELNYX_API_KEY);

async function findVoiceAIAgent() {
  console.log('🔍 Finding "Voice AI Agent" Connection...\n');
  
  try {
    // List all connections
    const connections = await telnyx.connections.list({ page: { size: 50 } });
    
    console.log(`Found ${connections.data.length} connection(s):\n`);
    
    // Find "Voice AI Agent"
    const voiceAIAgent = connections.data.find(
      conn => conn.connection_name === 'Voice AI Agent'
    );
    
    if (voiceAIAgent) {
      console.log('✅ Found "Voice AI Agent" connection!');
      console.log('═══════════════════════════════════════════════════════');
      console.log(`Connection ID: ${voiceAIAgent.id}`);
      console.log(`Name: ${voiceAIAgent.connection_name}`);
      console.log(`Active: ${voiceAIAgent.active ? '✅ Yes' : '❌ No'}`);
      console.log(`Type: ${voiceAIAgent.record_type}`);
      console.log('═══════════════════════════════════════════════════════\n');
      
      if (voiceAIAgent.active) {
        console.log('✅ This connection is ACTIVE!');
        console.log('📝 Update your .env file with:');
        console.log(`TELNYX_CONNECTION_ID=${voiceAIAgent.id}\n`);
      } else {
        console.log('❌ This connection is DISABLED!');
        console.log('\nYou need to enable it in Telnyx Portal:');
        console.log('   https://portal.telnyx.com/#/app/call-control/applications');
        console.log(`\n   Find "Voice AI Agent" and enable it.\n`);
      }
    } else {
      console.log('❌ "Voice AI Agent" connection not found!\n');
      console.log('Available connections:');
      connections.data.forEach((conn, idx) => {
        console.log(`${idx + 1}. ${conn.connection_name || 'Unnamed'} (${conn.id})`);
        console.log(`   Active: ${conn.active ? 'Yes' : 'No'}, Type: ${conn.record_type}`);
      });
    }
    
    // Also check phone numbers
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('📞 Phone Numbers Status:');
    console.log('═══════════════════════════════════════════════════════\n');
    
    const numbers = await telnyx.phoneNumbers.list({ page: { size: 50 } });
    const voiceAIAgentNumbers = numbers.data.filter(
      num => num.connection_name === 'Voice AI Agent'
    );
    
    console.log(`Found ${voiceAIAgentNumbers.length} number(s) assigned to "Voice AI Agent":`);
    voiceAIAgentNumbers.slice(0, 5).forEach(num => {
      console.log(`  - ${num.phone_number}`);
    });
    if (voiceAIAgentNumbers.length > 5) {
      console.log(`  ... and ${voiceAIAgentNumbers.length - 5} more`);
    }
    console.log('');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.raw && error.raw.errors) {
      console.error('Details:', JSON.stringify(error.raw.errors, null, 2));
    }
  }
}

findVoiceAIAgent().catch(console.error);




