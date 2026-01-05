/**
 * Test if we can generate a Scribe single-use token
 */

require('dotenv').config();
const https = require('https');

const API_KEY = process.env.ELEVENLABS_API_KEY;

console.log('🔍 Testing ElevenLabs Scribe Token Generation...');
console.log(`📝 API Key: ${API_KEY ? API_KEY.substring(0, 15) + '...' : 'NOT SET'}`);
console.log('');

if (!API_KEY) {
  console.error('❌ ELEVENLABS_API_KEY not set in .env file!');
  process.exit(1);
}

// Test token generation
const options = {
  hostname: 'api.elevenlabs.io',
  port: 443,
  path: '/v1/single-use-token/realtime_scribe',
  method: 'POST',
  headers: {
    'xi-api-key': API_KEY,
    'Content-Type': 'application/json'
  }
};

console.log('🔗 Requesting token from: https://api.elevenlabs.io/v1/single-use-token/realtime_scribe');
console.log('');

const req = https.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    console.log(`📥 Response Status: ${res.statusCode}`);
    console.log('');

    if (res.statusCode === 200) {
      try {
        const parsed = JSON.parse(data);
        console.log('✅ SUCCESS! Scribe token generated!');
        console.log('');
        console.log('Token response:', JSON.stringify(parsed, null, 2));
        console.log('');
        console.log('🎉 Your API key HAS access to Scribe v2 Realtime!');
        console.log('   We just need to use token-based authentication instead of direct API key.');
      } catch (error) {
        console.error('❌ Error parsing response:', error);
        console.error('Raw response:', data);
      }
    } else if (res.statusCode === 401) {
      console.error('❌ 401 Unauthorized - Invalid API key');
      console.error('Raw response:', data);
    } else if (res.statusCode === 403) {
      console.error('❌ 403 Forbidden - Your account does NOT have access to Scribe');
      console.error('   You need to upgrade your ElevenLabs plan to include Scribe');
      console.error('Raw response:', data);
    } else {
      console.error(`❌ Error ${res.statusCode}:`, data);
    }
  });
});

req.on('error', (error) => {
  console.error('❌ Request error:', error);
});

req.end();

