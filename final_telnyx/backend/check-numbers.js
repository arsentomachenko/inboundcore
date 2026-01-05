// Check phone number details and their connections
require('dotenv').config();
const telnyx = require('telnyx')(process.env.TELNYX_API_KEY);

async function checkNumbers() {
  console.log('📞 Checking Phone Number Details...\n');
  
  try {
    const numbers = await telnyx.phoneNumbers.list({ page: { size: 50 } });
    
    console.log(`Found ${numbers.data.length} phone number(s):\n`);
    
    for (const num of numbers.data) {
      console.log(`Number: ${num.phone_number}`);
      console.log(`  Status: ${num.status}`);
      console.log(`  Connection ID: ${num.connection_id || 'Not assigned'}`);
      console.log(`  Connection Name: ${num.connection_name || 'Not assigned'}`);
      console.log(`  Messaging Profile: ${num.messaging_profile_name || 'None'}`);
      
      // Try to get full details
      try {
        const details = await telnyx.phoneNumbers.retrieve(num.id);
        if (details.voice) {
          console.log(`  Voice Settings:`);
          console.log(`    - Connection: ${details.voice.connection_id || 'Not set'}`);
        }
      } catch (e) {
        // Skip if can't get details
      }
      console.log('');
    }
    
    // Show available connections
    console.log('═══════════════════════════════════════════════════════');
    console.log('Available Connections:');
    console.log('═══════════════════════════════════════════════════════');
    
    const connections = await telnyx.connections.list({ page: { size: 50 } });
    connections.data.forEach((conn) => {
      console.log(`ID: ${conn.id}`);
      console.log(`  Name: ${conn.connection_name || 'Unnamed'}`);
      console.log(`  Type: ${conn.record_type}`);
      console.log('');
    });
    
    console.log('═══════════════════════════════════════════════════════');
    console.log('💡 SOLUTION:');
    console.log('═══════════════════════════════════════════════════════');
    console.log('Update your backend/.env file with:');
    console.log('');
    
    // Get the first number's connection
    if (numbers.data.length > 0 && numbers.data[0].connection_id) {
      console.log(`TELNYX_CONNECTION_ID=${numbers.data[0].connection_id}`);
    } else if (connections.data.length > 0) {
      console.log(`TELNYX_CONNECTION_ID=${connections.data[0].id}`);
    }
    
    console.log('');
    console.log('Then restart your backend server.');
    console.log('═══════════════════════════════════════════════════════\n');
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

checkNumbers().catch(console.error);

