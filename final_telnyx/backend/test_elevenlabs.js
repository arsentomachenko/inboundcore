// Test ElevenLabs Scribe API key
const WebSocket = require('ws');

const API_KEY = process.env.ELEVENLABS_API_KEY;

if (!API_KEY) {
  console.error('❌ ELEVENLABS_API_KEY not found in environment');
  process.exit(1);
}

console.log('🔑 Testing ElevenLabs API Key...');
console.log(`   Key: ${API_KEY.substring(0, 15)}...`);
console.log('');

const wsUrl = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=ulaw_8000`;

const ws = new WebSocket(wsUrl, {
  headers: {
    'xi-api-key': API_KEY
  }
});

let testPassed = false;

ws.on('open', () => {
  console.log('✅ WebSocket connection opened successfully!');
  console.log('   Authentication: PASSED');
});

ws.on('message', (data) => {
  try {
    const message = JSON.parse(data.toString());
    console.log(`📨 Received: ${message.message_type || message.type}`);
    
    if (message.message_type === 'session_started') {
      console.log('✅ SESSION STARTED - Scribe is working!');
      console.log('   Config:', JSON.stringify(message.config, null, 2));
      testPassed = true;
      
      setTimeout(() => {
        ws.close();
        console.log('');
        console.log('🎉 TEST PASSED! Your ElevenLabs Scribe is working correctly!');
        process.exit(0);
      }, 1000);
    } else if (message.message_type === 'auth_error') {
      console.error('❌ AUTHENTICATION FAILED');
      console.error('   Error:', message.error || message.message);
      console.error('');
      console.error('🔧 FIX: Check your API key at https://elevenlabs.io/app/settings/api-keys');
      ws.close();
      process.exit(1);
    } else if (message.message_type === 'quota_exceeded') {
      console.error('❌ QUOTA EXCEEDED');
      console.error('   Your ElevenLabs account has run out of credits/quota');
      console.error('');
      console.error('🔧 FIX: Check billing at https://elevenlabs.io/app/settings/billing');
      ws.close();
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error parsing message:', error);
  }
});

ws.on('error', (error) => {
  console.error('❌ WebSocket Error:', error.message);
  console.error('');
  console.error('Possible issues:');
  console.error('  - Invalid API key');
  console.error('  - No internet connection');
  console.error('  - ElevenLabs service is down');
  process.exit(1);
});

ws.on('close', (code, reason) => {
  if (!testPassed) {
    console.error('❌ Connection closed before test completed');
    console.error(`   Code: ${code}`);
    console.error(`   Reason: ${reason.toString() || 'None'}`);
    console.error('');
    console.error('🔧 This usually means:');
    console.error('  - Invalid API key');
    console.error('  - API key expired');
    console.error('  - Scribe not available in your plan');
    console.error('');
    console.error('👉 Check: https://elevenlabs.io/app/settings');
    process.exit(1);
  }
});

// Timeout after 10 seconds
setTimeout(() => {
  if (!testPassed) {
    console.error('❌ Test timed out after 10 seconds');
    ws.close();
    process.exit(1);
  }
}, 10000);
