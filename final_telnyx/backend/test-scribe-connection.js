/**
 * Standalone test script to verify ElevenLabs Scribe connection
 * Run with: node test-scribe-connection.js
 */

require('dotenv').config();
const WebSocket = require('ws');

const API_KEY = process.env.ELEVENLABS_API_KEY;

console.log('🧪 Testing ElevenLabs Scribe Connection...');
console.log(`📝 API Key: ${API_KEY ? API_KEY.substring(0, 15) + '...' : 'NOT SET'}`);
console.log('');

if (!API_KEY) {
  console.error('❌ ELEVENLABS_API_KEY not set in .env file!');
  process.exit(1);
}

const wsUrl = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=ulaw_8000`;

console.log(`🔗 Connecting to: ${wsUrl}`);
console.log('');

const ws = new WebSocket(wsUrl, {
  headers: {
    'xi-api-key': API_KEY
  }
});

let messageCount = 0;
let isReady = false;

ws.on('open', () => {
  console.log('✅ WebSocket OPEN event fired!');
  console.log(`   readyState: ${ws.readyState}`);
  console.log(`   Waiting for session_started message...`);
  console.log('');
});

ws.on('message', (data) => {
  messageCount++;
  const message = JSON.parse(data.toString());
  
  console.log(`📨 Message #${messageCount}:`);
  console.log(JSON.stringify(message, null, 2));
  console.log('');
  
  if (message.message_type === 'session_started') {
    isReady = true;
    console.log('✅ Session started! Scribe is ready!');
    console.log('');
    
    // Send a test audio chunk (silence)
    const testAudio = Buffer.alloc(160, 127); // 127 = silence in µ-law
    console.log('📤 Sending test audio chunk (160 bytes of silence)...');
    ws.send(testAudio);
  }
});

ws.on('error', (error) => {
  console.error('❌ WebSocket ERROR:');
  console.error(`   Message: ${error.message}`);
  console.error(`   Code: ${error.code}`);
  console.error(`   Full error:`, error);
  console.log('');
});

ws.on('close', (code, reason) => {
  console.log('📝 WebSocket CLOSED:');
  console.log(`   Code: ${code}`);
  console.log(`   Reason: ${reason.toString() || 'No reason provided'}`);
  console.log(`   Total messages received: ${messageCount}`);
  console.log(`   Session ready: ${isReady ? 'YES' : 'NO'}`);
  console.log('');
  
  if (!isReady) {
    console.error('❌ FAILED: Session never became ready!');
    console.error('   This indicates:');
    console.error('   - Invalid or expired API key');
    console.error('   - No access to Scribe model');
    console.error('   - Billing/quota issue');
    console.error('   - Wrong model_id');
    process.exit(1);
  } else {
    console.log('✅ SUCCESS: Connection worked!');
    process.exit(0);
  }
});

// Timeout after 10 seconds
setTimeout(() => {
  if (!isReady) {
    console.error('❌ TIMEOUT: No session_started after 10 seconds');
    ws.close();
  }
}, 10000);

