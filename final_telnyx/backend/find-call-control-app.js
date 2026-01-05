// Find Call Control Applications (needed for making calls)
require('dotenv').config();
const telnyx = require('telnyx')(process.env.TELNYX_API_KEY);

async function findCallControlApps() {
  console.log('🔍 Finding Call Control Applications...\n');
  
  try {
    // List all connections and filter for Call Control Applications
    const connections = await telnyx.connections.list({ page: { size: 50 } });
    
    console.log(`Found ${connections.data.length} total connection(s):\n`);
    
    const callControlApps = connections.data.filter(
      conn => conn.record_type === 'call_control_application'
    );
    
    if (callControlApps.length === 0) {
      console.log('❌ No Call Control Applications found!\n');
      console.log('═══════════════════════════════════════════════════════');
      console.log('📋 WHAT THIS MEANS:');
      console.log('═══════════════════════════════════════════════════════\n');
      console.log('You need to create a Call Control Application in Telnyx.\n');
      console.log('═══════════════════════════════════════════════════════');
      console.log('✅ HOW TO FIX:');
      console.log('═══════════════════════════════════════════════════════\n');
      console.log('1. Open Telnyx Portal:');
      console.log('   https://portal.telnyx.com/#/app/call-control/applications\n');
      console.log('2. Click "Create Call Control App" or "Add Application"\n');
      console.log('3. Fill in these settings:');
      console.log('   ┌─────────────────────────────────────────────────────┐');
      console.log('   │ Name: Voice AI Agent                                │');
      console.log(`   │ Webhook URL: ${process.env.WEBHOOK_BASE_URL || 'http://your-server:3000'}/webhooks/telnyx │`);
      console.log('   │ Webhook API Version: V2                             │');
      console.log('   │ Status: Enabled                                     │');
      console.log('   └─────────────────────────────────────────────────────┘\n');
      console.log('4. After creating, COPY the Application ID\n');
      console.log('5. Update backend/.env:');
      console.log('   TELNYX_CONNECTION_ID=<paste_new_id_here>\n');
      console.log('6. Restart your backend server\n');
      console.log('═══════════════════════════════════════════════════════\n');
    } else {
      console.log(`✅ Found ${callControlApps.length} Call Control Application(s):\n`);
      
      callControlApps.forEach((app, idx) => {
        console.log(`${idx + 1}. Application ID: ${app.id}`);
        console.log(`   Name: ${app.connection_name || 'Unnamed'}`);
        console.log(`   Active: ${app.active ? '✅ Yes' : '❌ No'}`);
        console.log(`   Type: ${app.record_type}`);
        console.log('');
      });
      
      // Find active ones
      const activeApps = callControlApps.filter(app => app.active);
      
      if (activeApps.length > 0) {
        console.log('═══════════════════════════════════════════════════════');
        console.log('✅ ACTIVE Call Control Applications:');
        console.log('═══════════════════════════════════════════════════════\n');
        
        activeApps.forEach((app, idx) => {
          console.log(`${idx + 1}. ${app.connection_name || 'Unnamed'}`);
          console.log(`   ID: ${app.id}`);
          console.log('');
        });
        
        console.log('═══════════════════════════════════════════════════════');
        console.log('📝 Use one of these IDs in your .env file:');
        console.log('═══════════════════════════════════════════════════════\n');
        console.log(`TELNYX_CONNECTION_ID=${activeApps[0].id}\n`);
      } else {
        console.log('⚠️  All Call Control Applications are disabled!\n');
        console.log('You need to enable one in the Telnyx Portal:\n');
        console.log('   https://portal.telnyx.com/#/app/call-control/applications\n');
      }
    }
    
    // Show current connection ID status
    console.log('═══════════════════════════════════════════════════════');
    console.log('📋 Current Configuration:');
    console.log('═══════════════════════════════════════════════════════\n');
    console.log(`Current TELNYX_CONNECTION_ID: ${process.env.TELNYX_CONNECTION_ID || 'Not set'}`);
    
    if (process.env.TELNYX_CONNECTION_ID) {
      const currentConn = connections.data.find(
        c => c.id === process.env.TELNYX_CONNECTION_ID
      );
      
      if (currentConn) {
        console.log(`   Name: ${currentConn.connection_name || 'Unnamed'}`);
        console.log(`   Active: ${currentConn.active ? '✅ Yes' : '❌ No'}`);
        console.log(`   Type: ${currentConn.record_type}`);
        
        if (currentConn.record_type !== 'call_control_application') {
          console.log(`   ⚠️  WARNING: This is NOT a Call Control Application!`);
          console.log(`   You need a Call Control Application to make calls.`);
        }
        
        if (!currentConn.active) {
          console.log(`   ⚠️  WARNING: This connection is DISABLED!`);
        }
      } else {
        console.log(`   ❌ Connection ID not found in your account!`);
      }
    }
    console.log('');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.raw && error.raw.errors) {
      console.error('Details:', JSON.stringify(error.raw.errors, null, 2));
    }
  }
}

findCallControlApps().catch(console.error);




