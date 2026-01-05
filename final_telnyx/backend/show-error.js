// Show the detailed error from Telnyx
require('dotenv').config();
const telnyx = require('telnyx')(process.env.TELNYX_API_KEY);

async function showError() {
  console.log('🔍 Attempting call to show detailed error...\n');
  
  try {
    const call = await telnyx.calls.create({
      connection_id: process.env.TELNYX_CONNECTION_ID,
      to: '+15555555555',
      from: '+18434028556', // One of your numbers
    });
  } catch (error) {
    console.log('❌ ERROR DETAILS:');
    console.log('═══════════════════════════════════════════════════════\n');
    
    if (error.raw && error.raw.errors) {
      console.log('Telnyx Error Response:');
      console.log(JSON.stringify(error.raw.errors, null, 2));
    }
    
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('📋 WHAT THIS MEANS:');
    console.log('═══════════════════════════════════════════════════════\n');
    
    console.log('Your current Connection ID:', process.env.TELNYX_CONNECTION_ID);
    console.log('\nThis Connection ID is NOT a Call Control Application.');
    console.log('You MUST create a Call Control Application to make calls.\n');
    
    console.log('═══════════════════════════════════════════════════════');
    console.log('✅ HOW TO FIX:');
    console.log('═══════════════════════════════════════════════════════\n');
    
    console.log('1. Open Telnyx Portal:');
    console.log('   https://portal.telnyx.com/#/app/call-control/applications\n');
    
    console.log('2. Click "Create Call Control App" or "Add Application"\n');
    
    console.log('3. Fill in these settings:');
    console.log('   ┌─────────────────────────────────────────────────────┐');
    console.log('   │ Name: Voice AI Agent                                │');
    console.log('   │ Webhook URL: http://18.220.74.208:3000/webhooks... │');
    console.log('   │ Webhook API Version: V2                             │');
    console.log('   │ Status: Enabled                                     │');
    console.log('   └─────────────────────────────────────────────────────┘\n');
    
    console.log('4. After creating, COPY the Application/Connection ID\n');
    
    console.log('5. Go to Numbers → My Numbers');
    console.log('   - Click on +18434028556 (or any number)');
    console.log('   - Under "Voice Settings"');
    console.log('   - Change "Connection" to "Voice AI Agent"');
    console.log('   - Save\n');
    
    console.log('6. Update backend/.env:');
    console.log('   TELNYX_CONNECTION_ID=<paste_new_id_here>\n');
    
    console.log('7. Restart your backend server\n');
    
    console.log('═══════════════════════════════════════════════════════\n');
  }
}

showError().catch(console.error);

