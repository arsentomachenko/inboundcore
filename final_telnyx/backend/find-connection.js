// Find the correct connection ID for your phone numbers
require('dotenv').config();
const telnyx = require('telnyx')(process.env.TELNYX_API_KEY);

async function findConnection() {
  console.log('🔍 Finding your connections...\n');
  
  try {
    const connections = await telnyx.connections.list({ page: { size: 50 } });
    
    console.log(`Found ${connections.data.length} connection(s):\n`);
    
    connections.data.forEach((conn, idx) => {
      console.log(`${idx + 1}. Connection ID: ${conn.id}`);
      console.log(`   Name: ${conn.connection_name || 'Unnamed'}`);
      console.log(`   Active: ${conn.active}`);
      console.log(`   Type: ${conn.record_type}`);
      console.log('');
    });
    
    // Find the one named "inboudcore"
    const targetConn = connections.data.find(c => 
      c.connection_name === 'inboudcore'
    );
    
    if (targetConn) {
      console.log('✅ Found your connection!');
      console.log('═══════════════════════════════════════════════════════');
      console.log(`📝 Use this Connection ID in your .env file:`);
      console.log(`TELNYX_CONNECTION_ID=${targetConn.id}`);
      console.log('═══════════════════════════════════════════════════════\n');
    } else {
      console.log('⚠️  Could not find "inboudcore" connection.');
      console.log('Please check the list above and use the correct Connection ID.\n');
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

findConnection().catch(console.error);

