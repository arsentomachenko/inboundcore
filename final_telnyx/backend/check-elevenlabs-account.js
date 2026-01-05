/**
 * Check ElevenLabs Account Status and Scribe Access
 */

const https = require('https');

const API_KEY = 'sk_c68b1b22cad914fba34f9f051994628634e99ac77ab36c9a';

console.log('🔍 Checking ElevenLabs Account Status...');
console.log(`📝 API Key: ${API_KEY.substring(0, 15)}...`);
console.log('');

// Function to make HTTPS request
function makeRequest(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.elevenlabs.io',
      port: 443,
      path: path,
      method: method,
      headers: {
        'xi-api-key': API_KEY,
        'Accept': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.end();
  });
}

async function checkAccount() {
  try {
    // 1. Check user info
    console.log('1️⃣  Checking user account...');
    const userInfo = await makeRequest('/v1/user');
    console.log(`   Status: ${userInfo.status}`);
    if (userInfo.status === 200) {
      console.log('   ✅ API Key is VALID');
      console.log(`   User: ${userInfo.data.email || userInfo.data.first_name || 'N/A'}`);
      console.log(`   Subscription: ${userInfo.data.subscription?.tier || 'N/A'}`);
      console.log(`   Character count: ${userInfo.data.character_count || 0}`);
      console.log(`   Character limit: ${userInfo.data.character_limit || 'N/A'}`);
    } else {
      console.error('   ❌ API Key is INVALID or EXPIRED');
      console.error(`   Response:`, userInfo.data);
      return;
    }
    console.log('');

    // 2. Check available models
    console.log('2️⃣  Checking available models...');
    const models = await makeRequest('/v1/models');
    console.log(`   Status: ${models.status}`);
    if (models.status === 200 && Array.isArray(models.data)) {
      const scribeModels = models.data.filter(m => 
        m.model_id && m.model_id.includes('scribe')
      );
      
      if (scribeModels.length > 0) {
        console.log(`   ✅ Found ${scribeModels.length} Scribe model(s):`);
        scribeModels.forEach(m => {
          console.log(`      - ${m.model_id} (${m.name || 'N/A'})`);
        });
      } else {
        console.log(`   ⚠️  NO Scribe models found!`);
        console.log(`   Available models: ${models.data.slice(0, 5).map(m => m.model_id).join(', ')}...`);
      }
    } else {
      console.log(`   ❌ Failed to fetch models`);
      console.log(`   Response:`, models.data);
    }
    console.log('');

    // 3. Check subscription info
    console.log('3️⃣  Checking subscription details...');
    const subscription = await makeRequest('/v1/user/subscription');
    console.log(`   Status: ${subscription.status}`);
    if (subscription.status === 200) {
      console.log('   Subscription details:', JSON.stringify(subscription.data, null, 2));
    } else {
      console.log(`   Response:`, subscription.data);
    }
    console.log('');

    // 4. Summary
    console.log('📊 SUMMARY:');
    console.log('─'.repeat(50));
    
    if (userInfo.status !== 200) {
      console.log('❌ API Key is INVALID - get a new key from ElevenLabs');
    } else if (models.status === 200 && Array.isArray(models.data)) {
      const hasScribe = models.data.some(m => m.model_id && m.model_id.includes('scribe'));
      if (!hasScribe) {
        console.log('❌ Your account does NOT have access to Scribe models');
        console.log('   Action: Upgrade your ElevenLabs plan to include Scribe');
        console.log('   OR: Use Deepgram/AssemblyAI instead');
      } else {
        console.log('✅ Account has Scribe access');
        console.log('⚠️  But Scribe is still disconnecting - possible reasons:');
        console.log('   - Quota exceeded for Scribe specifically');
        console.log('   - Billing issue');
        console.log('   - Contact ElevenLabs support');
      }
    }
    
  } catch (error) {
    console.error('❌ Error checking account:', error);
  }
}

checkAccount();

