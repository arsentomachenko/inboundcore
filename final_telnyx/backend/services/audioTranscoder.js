/**
 * Audio Transcoder Service
 * Converts Telnyx µ-law @ 8kHz to PCM @ 16kHz for ElevenLabs Scribe
 */

// µ-law decode table (standard ITU-T G.711)
const ULAW_DECODE_TABLE = new Int16Array(256);

// Initialize µ-law decode table
(function initUlawTable() {
  for (let i = 0; i < 256; i++) {
    const sign = (i & 0x80) ? -1 : 1;
    const exponent = (i >> 4) & 0x07;
    const mantissa = i & 0x0F;
    const value = ((mantissa << 3) + 132) << exponent;
    ULAW_DECODE_TABLE[i] = sign * (value - 132);
  }
})();

/**
 * Decode µ-law to 16-bit PCM
 * @param {Buffer} ulawBuffer - µ-law encoded audio (8-bit samples)
 * @returns {Buffer} PCM 16-bit little-endian buffer
 */
function ulawToPcm16(ulawBuffer) {
  const pcmBuffer = Buffer.allocUnsafe(ulawBuffer.length * 2);
  
  for (let i = 0; i < ulawBuffer.length; i++) {
    const pcmValue = ULAW_DECODE_TABLE[ulawBuffer[i]];
    pcmBuffer.writeInt16LE(pcmValue, i * 2);
  }
  
  return pcmBuffer;
}

/**
 * Upsample PCM from 8kHz to 16kHz using linear interpolation
 * @param {Buffer} pcm8k - PCM @ 8kHz (16-bit samples)
 * @returns {Buffer} PCM @ 16kHz (16-bit samples)
 */
function upsample8to16(pcm8k) {
  const numSamples8k = pcm8k.length / 2;
  const numSamples16k = numSamples8k * 2;
  const pcm16k = Buffer.allocUnsafe(numSamples16k * 2);
  
  for (let i = 0; i < numSamples8k - 1; i++) {
    const sample1 = pcm8k.readInt16LE(i * 2);
    const sample2 = pcm8k.readInt16LE((i + 1) * 2);
    
    // Write original sample
    pcm16k.writeInt16LE(sample1, (i * 2) * 2);
    
    // Write interpolated sample (average of current and next)
    const interpolated = Math.round((sample1 + sample2) / 2);
    pcm16k.writeInt16LE(interpolated, (i * 2 + 1) * 2);
  }
  
  // Handle last sample (duplicate it)
  const lastSample = pcm8k.readInt16LE((numSamples8k - 1) * 2);
  pcm16k.writeInt16LE(lastSample, (numSamples8k * 2 - 2) * 2);
  pcm16k.writeInt16LE(lastSample, (numSamples8k * 2 - 1) * 2);
  
  return pcm16k;
}

/**
 * Convert Telnyx µ-law @ 8kHz to PCM @ 16kHz for ElevenLabs Scribe
 * @param {Buffer} ulawBuffer - µ-law encoded audio from Telnyx
 * @returns {Buffer} PCM 16-bit @ 16kHz for Scribe
 */
function telnyxToScribe(ulawBuffer) {
  // Step 1: Decode µ-law to PCM @ 8kHz
  const pcm8k = ulawToPcm16(ulawBuffer);
  
  // Step 2: Upsample to 16kHz
  const pcm16k = upsample8to16(pcm8k);
  
  return pcm16k;
}

module.exports = {
  ulawToPcm16,
  upsample8to16,
  telnyxToScribe
};

