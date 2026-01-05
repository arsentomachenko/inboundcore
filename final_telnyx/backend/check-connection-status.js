// Check connection status using direct API call
require('dotenv').config();
const axios = require('axios');

async function checkConnectionStatus() {
  console.log('🔍 Checking Connection Status...\n');
  console.log(`Connection ID: ${process.env.TELNYX_CONNECTION_ID}\n`);
  
  try {
    const response = await axios.get(
      `https://api.telnyx.com/v2/connections/${process.env.TELNYX_CONNECTION_ID}`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    const conn = response.data.data;
    
    console.log('═══════════════════════════════════════════════════════');
    console.log('📋 Connection Details:');
    console.log('═══════════════════════════════════════════════════════\n');
    console.log(`ID: ${conn.id}`);
    console.log(`Name: ${conn.connection_name || 'Unnamed'}`);
    console.log(`Active: ${conn.active ? '✅ Yes' : '❌ No'}`);
    console.log(`Type: ${conn.record_type || 'Unknown'}`);
    console.log(`Created: ${conn.created_at || 'Unknown'}`);
    console.log(`Updated: ${conn.updated_at || 'Unknown'}`);
    
    if (conn.webhook_event_url) {
      console.log(`Webhook URL: ${conn.webhook_event_url}`);
    }
    if (conn.webhook_event_failover_url) {
      console.log(`Failover URL: ${conn.webhook_event_failover_url}`);
    }
    
    console.log('\n');
    
    if (!conn.active) {
      console.log('═══════════════════════════════════════════════════════');
      console.log('❌ CONNECTION IS DISABLED!');
      console.log('═══════════════════════════════════════════════════════\n');
      console.log('To enable this connection:');
      console.log('1. Go to: https://portal.telnyx.com/#/app/call-control/applications');
      console.log(`2. Find connection: ${conn.connection_name || conn.id}`);
      console.log('3. Click on it and enable it\n');
    } else if (conn.record_type !== 'call_control_application') {
      console.log('═══════════════════════════════════════════════════════');
      console.log('⚠️  WARNING: Not a Call Control Application!');
      console.log('═══════════════════════════════════════════════════════\n');
      console.log(`Type: ${conn.record_type}`);
      console.log('You need a Call Control Application to make calls.\n');
    } else {
      console.log('✅ Connection is active and ready to use!\n');
    }
    
  } catch (error) {
    console.log('❌ Error checking connection:');
    if (error.response) {
      console.log(`   Status: ${error.response.status}`);
      console.log(`   Message: ${JSON.stringify(error.response.data, null, 2)}`);
    } else {
      console.log(`   ${error.message}`);
    }
    console.log('');
  }
}

checkConnectionStatus().catch(console.error);




