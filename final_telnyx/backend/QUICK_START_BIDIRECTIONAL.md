# Quick Start: Bidirectional Streaming

## 🚀 Setup (5 minutes)

### 1. Install FFmpeg
```bash
# Ubuntu/Debian
sudo apt install -y ffmpeg

# macOS
brew install ffmpeg

# Verify installation
ffmpeg -version
```

### 2. Install Node Dependencies
```bash
cd backend
npm install
```

### 3. Environment Variables
Ensure your `.env` has these keys:
```bash
TELNYX_API_KEY=KEY...
ELEVENLABS_API_KEY=sk_...
OPENAI_API_KEY=sk-...
WEBHOOK_BASE_URL=https://your-domain.com
```

### 4. Start Server
```bash
npm start
```

Look for this in logs:
```
✅ Audio converter initialized with ffmpeg
✅ ElevenLabs TTS Service initialized
✅ Bidirectional TTS Service initialized
```

## 📞 Make a Test Call

1. Start agent from frontend
2. Watch logs for:
```
🎙️  BIDIRECTIONAL audio streaming started successfully
   Bidirectional: us → caller via RTP
   Codec: PCMU (µ-law) @ 8kHz
```

3. When AI speaks, you'll see:
```
🎙️  Bidirectional TTS: Speaking to call_xxx
   [1/3] Requesting TTS from ElevenLabs...
   [2/3] Converting MP3 → PCMU (streaming)...
   [3/3] Streaming PCMU to Telnyx...
✅ Bidirectional TTS complete
```

## 🔧 API Usage

### Standard Mode (Recommended)
```javascript
const bidirectionalTTS = require('./services/bidirectionalTTSService');

// Speak with default settings
await bidirectionalTTS.speak(callControlId, 'Hello world!');

// With custom voice
await bidirectionalTTS.speak(callControlId, 'Hello!', {
  voiceId: '21m00Tcm4TlvDq8ikWAM',  // Different voice
  stability: 0.7,
  similarity_boost: 0.8
});
```

### Ultra-Low Latency Mode (Experimental)
```javascript
// Uses chunked streaming - audio starts playing faster
await bidirectionalTTS.speakStreaming(callControlId, 'Hello world!');
```

### Check Status
```javascript
// Check if call is currently speaking
const isSpeaking = bidirectionalTTS.isSpeaking(callControlId);

// Get detailed status
const status = bidirectionalTTS.getStatus(callControlId);
// Returns: { requestId, text, startTime, status: 'starting'|'converting'|'streaming' }

// Cancel active speech
bidirectionalTTS.cancel(callControlId);
```

## 🐛 Troubleshooting

### "FFmpeg not found"
```bash
# Check if FFmpeg is in PATH
which ffmpeg

# If not found, install it (see Setup step 1)
```

### "ElevenLabs API error 401"
```bash
# Check API key
cat .env | grep ELEVENLABS_API_KEY

# Test API key
curl -H "xi-api-key: YOUR_KEY" https://api.elevenlabs.io/v1/voices
```

### "WebSocket not open"
Check these in order:
1. Is call still active? `telnyxService.activeStreams.has(callControlId)`
2. Did streaming start? Look for "BIDIRECTIONAL audio streaming started"
3. Did call answer? Check for "Call answered" event

### Audio Quality Issues

**Choppy audio:**
- Reduce concurrent calls (high CPU usage)
- Check network latency to Telnyx
- Verify FFmpeg is converting correctly

**Distorted audio:**
- Ensure sample rate is 8kHz throughout
- Check FFmpeg version (should be 4.0+)

**Silent audio:**
- Check base64 encoding/decoding
- Verify WebSocket messages are being sent
- Look for "Sent audio packet #1" in logs

## 📊 Performance Monitoring

### Enable Detailed Logging
```javascript
// In your service files, logs are already verbose
// Look for these patterns:

// TTS Request
"🎙️  Bidirectional TTS: Speaking to [id]"

// Audio Conversion
"🔄 Audio conversion #N: Converting to PCMU"
"✅ Audio conversion #N complete: Xms"

// Streaming
"🔊 Sent audio packet #N (X bytes)"
"✅ Finished streaming X/Y bytes"
```

### Measure Latency
```javascript
// Check duration in logs
"✅ Bidirectional TTS complete for [id]"
"   Total duration: 450ms"  // <-- Look for this
```

### Resource Usage
```bash
# CPU per call (during TTS)
top -p $(pgrep -f 'node.*server.js')

# Memory usage
ps aux | grep node

# Network bandwidth
iftop  # Shows real-time bandwidth
```

## 🎯 Best Practices

### 1. Short, Natural Responses
```javascript
// ✅ GOOD - Natural, concise
"Got it! Let me check that for you."

// ❌ BAD - Too long, formal
"I have received your request and I am now proceeding to verify the information you provided in our system database."
```

### 2. Handle Errors Gracefully
```javascript
try {
  await bidirectionalTTS.speak(callControlId, text);
} catch (error) {
  console.error('TTS failed:', error);
  // Fallback: Could use Telnyx built-in TTS
  // await telnyxService.speak(callControlId, text);
}
```

### 3. Cancel Old Speech When Needed
```javascript
// If user interrupts AI
if (userSpokeWhileAISpeaking) {
  bidirectionalTTS.cancel(callControlId);
}
```

### 4. Monitor Active Requests
```javascript
// Track all active TTS requests
const activeCount = bidirectionalTTS.activeSpeechRequests.size;
console.log(`Active TTS requests: ${activeCount}`);
```

## 🔄 Differences from Old System

| Feature | Old (Telnyx Built-in) | New (Bidirectional) |
|---------|----------------------|---------------------|
| Latency | 1-2 seconds | 300-600ms |
| Control | Limited | Full control |
| Codec | Telnyx decides | PCMU @ 8kHz |
| Streaming | No | Yes |
| Cost | Same | Same |
| Voice options | Limited | All ElevenLabs voices |

## 📚 Related Files

```
backend/
├── services/
│   ├── bidirectionalTTSService.js      # Main TTS orchestration
│   ├── elevenLabsTTSService.js         # ElevenLabs API calls
│   ├── audioFormatConverter.js         # MP3 → PCMU conversion
│   ├── mediaStreamingService.js        # WebSocket audio streaming
│   └── telnyxService.js                # Telnyx API (modified)
├── routes/
│   └── webhookRoutes.js                # Updated to use bidirectional TTS
└── QUICK_START_BIDIRECTIONAL.md        # This file
```

## 💡 Next Steps

1. **Test in production** with real calls
2. **Monitor latency** and adjust if needed
3. **Experiment with voices** to find best one
4. **Tune voice settings** (stability, similarity)
5. **Consider caching** common phrases

## 🆘 Need Help?

1. Check main documentation: `../BIDIRECTIONAL_STREAMING.md`
2. Review logs: `tail -f logs/app.log`
3. Test individual components:
   ```bash
   # Test TTS
   node -e "require('./services/elevenLabsTTSService').textToSpeech('test')"
   
   # Test FFmpeg
   node -e "require('./services/audioFormatConverter').checkFFmpeg()"
   ```

---

**Implementation Complete! 🎉**

Your system now supports ultra-low latency bidirectional streaming with full control over the audio pipeline.












