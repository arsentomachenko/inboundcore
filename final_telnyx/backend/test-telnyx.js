// Test script to verify Telnyx configuration
require('dotenv').config();
const telnyx = require('telnyx')(process.env.TELNYX_API_KEY);

async function testTelnyxSetup() {
  console.log('🔍 Testing Telnyx Configuration...\n');
  
  // Test 1: Verify API Key
  console.log('1️⃣ Testing API Key...');
  console.log(`   API Key: ${process.env.TELNYX_API_KEY.substring(0, 20)}...`);
  
  try {
    // Try to list phone numbers (basic API test)
    const numbers = await telnyx.phoneNumbers.list({ page: { size: 10 } });
    console.log(`   ✅ API Key is valid!`);
    console.log(`   📞 Found ${numbers.data.length} phone number(s)\n`);
    
    if (numbers.data.length === 0) {
      console.log('   ⚠️  WARNING: No phone numbers found!');
      console.log('   You need to purchase at least one phone number.\n');
    } else {
      console.log('   Available Phone Numbers:');
      numbers.data.forEach((num, idx) => {
        console.log(`   ${idx + 1}. ${num.phone_number} (${num.status})`);
        console.log(`      Connection: ${num.connection_name || 'Not assigned'}`);
      });
      console.log('');
    }
    
  } catch (error) {
    console.log(`   ❌ API Key Error: ${error.message}`);
    console.log(`   Status: ${error.statusCode}`);
    console.log(`   Type: ${error.type}\n`);
    console.log('   💡 Solution: Verify your TELNYX_API_KEY in .env file');
    console.log('   Get it from: https://portal.telnyx.com/#/app/auth/v2\n');
    return;
  }
  
  // Test 2: Check Connection
  console.log('2️⃣ Testing Connection ID...');
  console.log(`   Connection ID: ${process.env.TELNYX_CONNECTION_ID}`);
  
  try {
    // Try to get connection details
    const connection = await telnyx.connections.retrieve(process.env.TELNYX_CONNECTION_ID);
    console.log(`   ✅ Connection found!`);
    console.log(`   Name: ${connection.connection_name}`);
    console.log(`   Active: ${connection.active}\n`);
  } catch (error) {
    console.log(`   ❌ Connection Error: ${error.message || 'Connection not found'}`);
    console.log(`   💡 Solution: Verify your TELNYX_CONNECTION_ID in .env file`);
    console.log('   Get it from: https://portal.telnyx.com/#/app/connections\n');
  }
  
  // Test 3: Try a test call (will show exact error)
  console.log('3️⃣ Testing Call Permissions...');
  console.log(`   Attempting to verify call permissions...\n`);
  
  try {
    // This will likely fail but show us the exact error
    const testCall = await telnyx.calls.create({
      connection_id: process.env.TELNYX_CONNECTION_ID,
      to: '+15555555555', // Fake number for testing
      from: '+15555555555', // Fake number for testing
    });
    console.log('   ✅ Call permissions verified!\n');
  } catch (error) {
    console.log(`   ⚠️  Call Test Failed (expected for test):`);
    console.log(`   Error: ${error.raw?.errors?.[0]?.title || error.message}`);
    console.log(`   Detail: ${error.raw?.errors?.[0]?.detail || 'No details'}`);
    
    if (error.raw?.errors?.[0]) {
      const errorDetail = error.raw.errors[0];
      console.log(`\n   📋 Full Error Details:`);
      console.log(JSON.stringify(errorDetail, null, 2));
    }
    
    console.log('\n   💡 Common Solutions:');
    console.log('   1. Verify Connection ID is correct');
    console.log('   2. Ensure phone numbers are assigned to this connection');
    console.log('   3. Check that Voice API is enabled on your connection');
    console.log('   4. Verify your Telnyx account has calling enabled');
    console.log('   5. Make sure you have credits in your Telnyx account\n');
  }
  
  // Summary
  console.log('═══════════════════════════════════════════════════════');
  console.log('📝 Configuration Summary:');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`API Key: ${process.env.TELNYX_API_KEY ? '✓ Set' : '✗ Missing'}`);
  console.log(`Connection ID: ${process.env.TELNYX_CONNECTION_ID || '✗ Missing'}`);
  console.log(`App ID: ${process.env.TELNYX_APP_ID || '✗ Missing'}`);
  console.log(`Webhook URL: ${process.env.WEBHOOK_BASE_URL || '✗ Missing'}`);
  console.log('═══════════════════════════════════════════════════════\n');
}

testTelnyxSetup().catch(console.error);

