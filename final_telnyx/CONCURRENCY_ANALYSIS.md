# Bidirectional Stream Concurrency Analysis

## Executive Summary

**Current Status**: ⚠️ **NOT FULLY READY** for 50 concurrent calls due to critical event listener leak and lack of resource limits.

## Critical Issues Found

### 1. 🚨 **Event Listener Leak** (CRITICAL)
**Location**: `backend/services/mediaStreamingService.js:203-204`

**Problem**: 
- `removeAllListeners()` removes ALL listeners for ALL calls, not just the current call
- Event listeners are NEVER removed when calls end
- With 50 concurrent calls: 100+ listeners accumulate on the same EventEmitter
- Each listener fires for every event (even though only one processes it)
- Causes memory leak and performance degradation

**Impact**: 
- Memory usage grows with each call
- CPU overhead from unnecessary listener invocations
- Potential race conditions

**Fix Required**: Store listener references per call and remove them on disconnect

### 2. ⚠️ **No Connection Limits**
**Location**: `backend/services/mediaStreamingService.js:18-22`

**Problem**:
- WebSocket server has no `maxConnections` limit
- No protection against connection exhaustion
- Could accept unlimited connections (limited only by system resources)

**Impact**:
- Server could be overwhelmed with too many connections
- No graceful degradation

**Recommendation**: Add connection limits and monitoring

### 3. ⚠️ **Memory Management**
**Location**: Multiple services

**Resources per call**:
- Telnyx WebSocket connection (~8KB)
- ElevenLabs WebSocket connection (~8KB)
- Audio buffers (varies, ~50-200KB per call)
- Event listeners (minimal, but accumulates)
- Map entries in activeStreams, activeConnections, activeSpeechRequests

**Estimated per call**: ~100-300KB
**50 calls**: ~5-15MB (acceptable, but should monitor)

**Potential Issues**:
- Audio buffers not explicitly cleared
- Event listeners accumulate
- Maps grow without cleanup

### 4. ✅ **Database Pool** (OK)
**Location**: `backend/config/database.js:10`

**Status**: Max 20 connections - sufficient for 50 concurrent calls
- Not all calls hit DB simultaneously
- Pool handles connection reuse

### 5. ⚠️ **No Resource Monitoring**
**Problem**: No metrics for:
- Active WebSocket connections
- Memory usage per call
- Connection failures
- Buffer sizes

## Recommendations

### Immediate Fixes (Required for 50 concurrent calls)

1. **Fix Event Listener Leak**
   - Store listener references per callControlId
   - Remove listeners in `disconnect()` method
   - Use `off()` instead of `removeAllListeners()`

2. **Add Connection Limits**
   - Set `maxConnections` on WebSocket servers
   - Implement graceful rejection when limit reached
   - Log connection count metrics

3. **Improve Cleanup**
   - Ensure all resources cleaned on call end
   - Clear audio buffers explicitly
   - Remove all event listeners per call

### Performance Optimizations

1. **Single Shared Listener Pattern**
   - Use one listener that routes events by callControlId
   - More efficient than per-call listeners

2. **Connection Pooling**
   - Reuse WebSocket connections where possible
   - Implement connection health checks

3. **Resource Monitoring**
   - Add metrics endpoint
   - Monitor active connections, memory usage
   - Alert on resource exhaustion

### Testing Recommendations

1. **Load Testing**
   - Test with 10, 25, 50 concurrent calls
   - Monitor memory usage
   - Check for listener leaks
   - Verify cleanup on call end

2. **Stress Testing**
   - Test with 100+ concurrent calls
   - Verify graceful degradation
   - Check error handling

## Current Architecture

### Per-Call Resources:
```
1. Telnyx WebSocket (incoming audio)
   └─> mediaStreamingService.activeStreams Map
   
2. ElevenLabs Scribe WebSocket (STT)
   └─> elevenLabsScribeService.activeConnections Map
   
3. Bidirectional TTS (outgoing audio)
   └─> bidirectionalTTSService.activeSpeechRequests Map
   
4. Event Listeners (PROBLEM: Not cleaned up)
   └─> scribeService EventEmitter (accumulates listeners)
```

### Data Flow:
```
Telnyx → WebSocket → mediaStreamingService → ElevenLabs Scribe
                                                      ↓
                                              Transcript Events
                                                      ↓
                                              webhookRoutes (AI)
                                                      ↓
                                              bidirectionalTTS → Telnyx
```

## Conclusion

**Can handle 50 concurrent calls?** 
- **Technically**: Yes, but with risks
- **Safely**: No, until event listener leak is fixed
- **Optimally**: No, needs resource limits and monitoring

**Priority Actions**:
1. 🔴 **CRITICAL**: Fix event listener leak
2. 🟡 **HIGH**: Add connection limits
3. 🟡 **HIGH**: Improve cleanup
4. 🟢 **MEDIUM**: Add monitoring


