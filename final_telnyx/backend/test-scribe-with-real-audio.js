/**
 * Test ElevenLabs Scribe with the EXACT audio data that Telnyx is sending
 * Run with: node test-scribe-with-real-audio.js
 */

require('dotenv').config();
const WebSocket = require('ws');

const API_KEY = process.env.ELEVENLABS_API_KEY;

console.log('🧪 Testing ElevenLabs Scribe with REAL Telnyx audio data...');
console.log(`📝 API Key: ${API_KEY ? API_KEY.substring(0, 15) + '...' : 'NOT SET'}`);
console.log('');

if (!API_KEY) {
  console.error('❌ ELEVENLABS_API_KEY not set in .env file!');
  process.exit(1);
}

// This is the EXACT audio data from Telnyx (from terminal 58, line 149)
const realAudioData = Buffer.from([252,247,249,253,251,252,249,251,252,248,243,246,250,247,248,252,252,123,122,245,118,248,124,56,233,113,246,251,122,239,113,245,253,243,123,251,252,119,243,110,247,115,253,242,109,237,111,250,255,116,248,253,254,124,250,111,248,114,117,253,118,250,115,252,253,118,252,124,125,125,119,248,121,249,124,120,127,118,124,119,124,119,119,119,124,124,123,253,124,118,118,118,126,122,124,126,254,115,255,119,115,120,118,123,255,119,122,126,116,122,253,124,255,126,124,126,122,120,121,255,253,122,124,251,123,255,122,249,213,122,246,255,250,246,126,245,245,251,240,250,249,253,249,248,254,249,243,246,254,250,252,249,254,246,244]);

console.log(`🎵 Audio data:`);
console.log(`   Size: ${realAudioData.length} bytes`);
console.log(`   First 20 bytes: ${Array.from(realAudioData.slice(0, 20)).join(',')}`);
console.log('');

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
let audioSent = false;

ws.on('open', () => {
  console.log('✅ WebSocket OPEN event fired!');
  console.log(`   readyState: ${ws.readyState}`);
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
    console.log('✅ Session started! Sending REAL Telnyx audio data...');
    console.log('');
    
    // Send the REAL audio data from Telnyx
    ws.send(realAudioData);
    audioSent = true;
    console.log(`📤 Sent ${realAudioData.length} bytes of REAL Telnyx audio`);
    console.log('');
    
    // Wait a bit to see if Scribe sends any response or error
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        console.log('⏳ Waiting for Scribe response...');
      }
    }, 500);
    
    // Close after 3 seconds if still open
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        console.log('✅ Scribe accepted the audio! Closing...');
        ws.close();
      }
    }, 3000);
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
  console.log(`   Audio sent: ${audioSent ? 'YES' : 'NO'}`);
  console.log('');
  
  if (!isReady) {
    console.error('❌ FAILED: Session never became ready!');
    process.exit(1);
  } else if (audioSent && messageCount < 2) {
    console.error('❌ FAILED: Scribe closed immediately after receiving audio without sending error!');
    console.error('   This indicates:');
    console.error('   - The audio format may be incompatible');
    console.error('   - Account quota/billing issue');
    console.error('   - Bug in ElevenLabs Scribe');
    process.exit(1);
  } else {
    console.log('✅ SUCCESS: Audio was accepted by Scribe!');
    process.exit(0);
  }
});

// Timeout after 10 seconds
setTimeout(() => {
  if (ws.readyState !== WebSocket.CLOSED) {
    console.error('❌ TIMEOUT: Test took too long');
    ws.close();
    process.exit(1);
  }
}, 10000);

