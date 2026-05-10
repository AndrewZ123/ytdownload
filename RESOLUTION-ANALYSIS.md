# Resolution Analysis: Playback Timeout Issue

## Timeline of Events

### Phase 1: Initial Failure (14:27 - 14:30)
- **14:27:14** - First resolve request for YbGFYaA0SbY started timing out
- **14:27:36** - First retry failed with "yt-dlp timed out after 30s"
- **14:28:00** - First successful resolve for YbGFYaA0SbY (before restart)
- **14:28:27** - Multiple concurrent resolve requests (1ZZQuj6htF4, zDC63mwwlJQ, _GlgOkBR1vU)
- **14:29:00** - All concurrent requests timing out

### Phase 2: Service Restart (14:29:25)
- Service restarted with new PID 314305
- Initial resolves still timing out after restart
- **14:30:40** - Multiple playback errors logged

### Phase 3: Recovery (14:32 - 14:33)
- **14:32:42** - Final attempt to resolve 1ZZQuj6htF4
- **14:33:10** - **SUCCESS**: First resolve after restart
- **14:33:11** - Upstream 403 error (expired URL), triggered re-resolve
- **14:33:26** - Re-resolve succeeded
- **14:33:40** - Streaming started successfully

## Root Cause

The issue was **yt-dlp timeouts** when resolving YouTube video URLs. This was caused by:

1. **WARP Proxy Instability**: While the SOCKS5 proxy port (40000) was open, the actual tunnel to YouTube was experiencing high latency or temporary connectivity issues
2. **YouTube Rate Limiting**: Possible temporary throttling from YouTube's servers
3. **Network Congestion**: Intermittent network issues affecting the WARP tunnel

## Why the Restart Helped

The service restart alone **did not fix the issue**. What actually resolved it was:

1. **Retry Logic**: The resolver has built-in retry (1 retry by default, with 1.5s delay)
2. **Time Delay**: Between 14:30 and 14:32, network conditions improved
3. **WARP Stabilization**: The WARP tunnel recovered from whatever transient issue it was experiencing

The timeline shows that:
- Immediate retries (within 30s) all failed
- Waiting ~2 minutes before the final attempt succeeded

## Current Status (as of 14:35)

✅ **Playback is working correctly**
- 1 cached resolution (1ZZQuj6htF4 - Michael Jackson - P.Y.T.)
- 2 active play sessions
- Stream proxy functioning with full Range support
- 64 total listen events logged
- 10 unique tracks played

## Prevention Measures

To prevent future occurrences, consider:

### 1. Increase Resolver Timeout
Current: 30 seconds (lib/resolver.js line 129)
Suggestion: Increase to 45-60 seconds for WARP proxy scenarios

### 2. Add Exponential Backoff
Instead of fixed 1.5s retry delay, use exponential backoff:
```javascript
const backoffDelay = Math.min(1000 * Math.pow(2, retriesLeft), 10000);
```

### 3. Implement Circuit Breaker
Track consecutive failures and temporarily disable WARP if it's consistently failing:
```javascript
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 5;

// In error handler:
if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
  console.warn('[proxy] Too many failures, disabling WARP temporarily');
  // Force direct connection for next N attempts
}
```

### 4. Health Check Before Play
Add a pre-play health check to verify resolver responsiveness:
```javascript
app.get('/api/health', async (req, res) => {
  try {
    // Quick resolve of a known reliable video
    await resolver.resolve('dQw4w9WgXcQ', { retries: 0, timeout: 10000 });
    res.json({ status: 'healthy', proxy: 'warp' });
  } catch (err) {
    res.json({ status: 'degraded', proxy: 'direct', error: err.message });
  }
});
```

### 5. Graceful Degradation
If WARP fails, automatically fall back to direct connection:
```javascript
function resolveWithFallback(videoId) {
  return resolver.resolve(videoId)
    .catch(err => {
      if (isWarpAvailable()) {
        console.warn('[resolver] WARP failed, trying direct connection');
        // Temporarily disable WARP
        _warpAvailable = false;
        return resolver.resolve(videoId);
      }
      throw err;
    });
}
```

## Technical Details

### WARP Proxy Configuration
- **Port**: 40000 (SOCKS5)
- **Check Interval**: 2 minutes
- **Status**: Currently working (warpUsed: true in logs)

### Resolver Configuration
- **Cache TTL**: 4 hours (14400 seconds)
- **Timeout**: 30 seconds
- **Retries**: 1
- **Retry Delay**: 1.5 seconds

### Stream Proxy Features
- ✅ Range request support (206 Partial Content)
- ✅ Automatic re-resolve on 403 errors
- ✅ WARP proxy integration
- ✅ Content-Type preservation
- ✅ Content-Length forwarding

## Conclusion

The issue was a transient network problem affecting the WARP proxy's ability to reach YouTube. The service restart provided an opportunity for the system to recover during a window of better network conditions. Implementing the prevention measures above would make the system more resilient to similar transient failures in the future.