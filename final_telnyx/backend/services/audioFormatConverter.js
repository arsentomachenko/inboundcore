/**
 * Audio Format Converter Service
 * 
 * Converts audio between different formats for use with Telnyx bidirectional streaming.
 * Primary use case: Convert ElevenLabs MP3 output to PCMU (µ-law) @ 8kHz for Telnyx.
 * 
 * Uses fluent-ffmpeg for audio conversion with low latency streaming support.
 */

const ffmpeg = require('fluent-ffmpeg');
const { Readable, PassThrough } = require('stream');
const path = require('path');

class AudioFormatConverter {
  constructor() {
    // Try to set ffmpeg path (may be needed in some environments)
    try {
      const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
      ffmpeg.setFfmpegPath(ffmpegPath);
      console.log(`✅ Audio converter initialized with ffmpeg: ${ffmpegPath}`);
    } catch (error) {
      console.log(`ℹ️  Using system ffmpeg (ffmpeg-installer not found)`);
    }
    
    this.conversionCount = 0;
  }

  /**
   * Convert audio stream to PCMU (µ-law) @ 8kHz for Telnyx
   * 
   * @param {Stream|Buffer} input - Input audio stream or buffer (MP3, PCM, WAV, etc.)
   * @param {object} options - Conversion options
   * @param {boolean} options.streaming - If true, returns stream; if false, returns complete buffer
   * @returns {Promise<Buffer|Stream>} - PCMU audio data @ 8kHz mono
   */
  async convertToPCMU(input, options = {}) {
    const streaming = options.streaming !== undefined ? options.streaming : false;
    const conversionId = ++this.conversionCount;
    
    console.log(`🔄 Audio conversion #${conversionId}: Converting to PCMU (µ-law) @ 8kHz`);
    console.log(`   Input type: ${input instanceof Buffer ? 'Buffer (' + input.length + ' bytes)' : 'Stream'}`);
    console.log(`   Streaming mode: ${streaming ? 'YES (low latency)' : 'NO (buffered)'}`);
    
    return new Promise((resolve, reject) => {
      // Create input stream if input is a buffer
      let inputStream;
      if (input instanceof Buffer) {
        inputStream = new Readable();
        inputStream.push(input);
        inputStream.push(null);  // End stream
      } else {
        inputStream = input;
      }
      
      // Create output stream
      const outputStream = new PassThrough();
      const chunks = [];
      
      // Track progress
      let inputBytes = 0;
      let outputBytes = 0;
      const startTime = Date.now();
      
      // Configure ffmpeg for PCMU conversion with BALANCED filters
      const command = ffmpeg(inputStream)
        .audioCodec('pcm_mulaw')       // PCMU (µ-law) codec
        .audioFrequency(8000)          // 8kHz sample rate (phone quality)
        .audioChannels(1)              // Mono
        .format('mulaw')               // Raw µ-law format (no container)
        .audioQuality(0)               // Highest quality
        .audioFilters([
          'highpass=f=200',            // Remove low-frequency noise/rumble
          'lowpass=f=3400',            // Phone bandwidth (300-3400Hz standard)
          'afftdn=nf=-35',             // FFT denoise (stronger: -35dB instead of -25dB)
          'volume=1.15',               // Slightly higher volume for clarity
          'alimiter=limit=0.9'         // Prevent clipping/distortion
        ])
        .on('start', (commandLine) => {
          // console.log(`   FFmpeg command: ${commandLine}`);
        })
        .on('codecData', (data) => {
          // console.log(`   Input format: ${data.audio || 'unknown'}`);
          // console.log(`   Duration: ${data.duration || 'unknown'}`);
        })
        .on('progress', (progress) => {
          // Only log every 500ms to reduce spam
          if (Date.now() - startTime > 500 && progress.timemark) {
            console.log(`   Progress: ${progress.timemark} processed`);
          }
        })
        .on('error', (error, stdout, stderr) => {
          console.error(`❌ Audio conversion #${conversionId} failed:`, error.message);
          if (stderr) {
            console.error(`   FFmpeg stderr:`, stderr.substring(0, 500));
          }
          reject(error);
        })
        .on('end', () => {
          const duration = Date.now() - startTime;
          // console.log(`✅ Audio conversion #${conversionId} complete:`);
          // console.log(`   Duration: ${duration}ms`);
          // console.log(`   Input: ${inputBytes} bytes`);
          // console.log(`   Output: ${outputBytes} bytes (PCMU @ 8kHz)`);
          // console.log(`   Ratio: ${(outputBytes / inputBytes * 100).toFixed(1)}% of input size`);
          
          if (!streaming) {
            const buffer = Buffer.concat(chunks);
            resolve(buffer);
          }
        });
      
      // Handle output stream
      outputStream.on('data', (chunk) => {
        outputBytes += chunk.length;
        chunks.push(chunk);
        
        // Log first chunk
        if (chunks.length === 1) {
          console.log(`   First chunk received: ${chunk.length} bytes`);
        }
      });
      
      outputStream.on('error', (error) => {
        console.error(`❌ Output stream error:`, error);
        reject(error);
      });
      
      // Track input bytes
      inputStream.on('data', (chunk) => {
        inputBytes += chunk.length;
      });
      
      // Pipe to output stream
      command.pipe(outputStream, { end: true });
      
      // If streaming mode, resolve with the output stream immediately
      if (streaming) {
        resolve(outputStream);
      }
    });
  }

  /**
   * Convert audio stream to PCMU with chunked output for real-time streaming
   * Yields chunks as they're converted (lowest latency)
   * 
   * @param {Stream|Buffer} input - Input audio stream or buffer
   * @param {number} chunkSize - Size of output chunks in bytes (default: 160 = 20ms @ 8kHz)
   * @returns {AsyncGenerator<Buffer>} - Async generator yielding PCMU chunks
   */
  async* convertToPCMUChunked(input, chunkSize = 160) {
    console.log(`🔄 Chunked conversion: Converting to PCMU with ${chunkSize}-byte chunks (${chunkSize / 8}ms @ 8kHz)`);
    
    const outputStream = await this.convertToPCMU(input, { streaming: true });
    
    let buffer = Buffer.alloc(0);
    let chunkCount = 0;
    
    for await (const chunk of outputStream) {
      // Accumulate data
      buffer = Buffer.concat([buffer, chunk]);
      
      // Yield complete chunks
      while (buffer.length >= chunkSize) {
        const outputChunk = buffer.slice(0, chunkSize);
        buffer = buffer.slice(chunkSize);
        
        chunkCount++;
        if (chunkCount % 50 === 1) {
          console.log(`   Yielding chunk #${chunkCount} (${outputChunk.length} bytes)`);
        }
        
        yield outputChunk;
      }
    }
    
    // Yield remaining data
    if (buffer.length > 0) {
      chunkCount++;
      console.log(`   Yielding final chunk #${chunkCount} (${buffer.length} bytes)`);
      yield buffer;
    }
    
    console.log(`✅ Chunked conversion complete: ${chunkCount} chunks yielded`);
  }

  /**
   * Check if ffmpeg is available
   * 
   * @returns {Promise<boolean>} - True if ffmpeg is available
   */
  async checkFFmpeg() {
    return new Promise((resolve) => {
      ffmpeg.getAvailableFormats((err, formats) => {
        if (err) {
          console.error('❌ FFmpeg not available:', err.message);
          resolve(false);
        } else {
          console.log('✅ FFmpeg is available');
          resolve(true);
        }
      });
    });
  }

  /**
   * Get audio metadata (duration, format, bitrate, etc.)
   * 
   * @param {Stream|Buffer|string} input - Input audio (stream, buffer, or file path)
   * @returns {Promise<Object>} - Audio metadata
   */
  async getMetadata(input) {
    return new Promise((resolve, reject) => {
      let inputStream;
      
      if (typeof input === 'string') {
        // File path
        inputStream = input;
      } else if (input instanceof Buffer) {
        // Buffer
        inputStream = new Readable();
        inputStream.push(input);
        inputStream.push(null);
      } else {
        // Stream
        inputStream = input;
      }
      
      ffmpeg.ffprobe(inputStream, (err, metadata) => {
        if (err) {
          reject(err);
        } else {
          resolve(metadata);
        }
      });
    });
  }
}

module.exports = new AudioFormatConverter();

