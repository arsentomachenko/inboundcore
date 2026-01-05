// Check phone number connection details
require('dotenv').config();
const telnyx = require('telnyx')(process.env.TELNYX_API_KEY);

async function checkPhoneConnection() {
  console.log('🔍 Checking Phone Number Connection Details...\n');
  
  try {
    const numbers = await telnyx.phoneNumbers.list({ page: { size: 10 } });
    
    if (numbers.data.length === 0) {
      console.log('❌ No phone numbers found!\n');
      return;
    }
    
    // Get details of first number
    const firstNumber = numbers.data[0];
    console.log(`Checking: ${firstNumber.phone_number}`);
    console.log(`Connection Name: ${firstNumber.connection_name || 'Not set'}`);
    console.log(`Connection ID: ${firstNumber.connection_id || 'Not set'}\n`);
    
    // Get full details
    try {
      const details = await telnyx.phoneNumbers.retrieve(firstNumber.id);
      console.log('═══════════════════════════════════════════════════════');
      console.log('📋 Full Phone Number Details:');
      console.log('═══════════════════════════════════════════════════════\n');
      console.log(JSON.stringify(details, null, 2));
      console.log('\n');
      
      if (details.voice && details.voice.connection_id) {
        console.log('═══════════════════════════════════════════════════════');
        console.log('✅ Found Connection ID from phone number:');
        console.log('═══════════════════════════════════════════════════════\n');
        console.log(`TELNYX_CONNECTION_ID=${details.voice.connection_id}\n`);
        
        // Try to retrieve this connection
        try {
          const conn = await telnyx.connections.retrieve(details.voice.connection_id);
          console.log('Connection Details:');
          console.log(`  Name: ${conn.connection_name || 'Unnamed'}`);
          console.log(`  Active: ${conn.active ? '✅ Yes' : '❌ No'}`);
          console.log(`  Type: ${conn.record_type}`);
          console.log('');
          
          if (!conn.active) {
            console.log('⚠️  WARNING: This connection is DISABLED!');
            console.log('You need to enable it in Telnyx Portal:\n');
            console.log('   https://portal.telnyx.com/#/app/call-control/applications\n');
          } else if (conn.record_type !== 'call_control_application') {
            console.log('⚠️  WARNING: This is not a Call Control Application!');
            console.log(`   Type: ${conn.record_type}`);
            console.log('   You need a Call Control Application to make calls.\n');
          } else {
            console.log('✅ This connection looks good!');
            console.log('Update your .env file with the Connection ID above.\n');
          }
        } catch (err) {
          console.log(`❌ Could not retrieve connection: ${err.message}`);
          console.log('   The connection ID might be invalid or from a different account.\n');
        }
      }
    } catch (error) {
      console.error('Error retrieving details:', error.message);
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.raw && error.raw.errors) {
      console.error('Details:', JSON.stringify(error.raw.errors, null, 2));
    }
  }
}

checkPhoneConnection().catch(console.error);




