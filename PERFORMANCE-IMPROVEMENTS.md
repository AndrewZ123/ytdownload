# Performance & Reliability Improvements for Playback

## Executive Summary

Current bottleneck: **yt-dlp resolution time** (5-30 seconds on first play, 0s on cache hit)

Target: Reduce time-to-play from 5-30s to <500ms for 95% of plays

---

## 🚀 High-Impact, Medium-Effort (Do First)

### 1. **Predictive Pre-Resolution** ⭐⭐⭐⭐⭐
**Impact**: Massive | **Effort**: Medium | **Time-to-implement**: 2-3 hours

**Problem**: First play always requires yt-dlp resolution (5-30s)

**Solution**: Pre-resolve tracks before user clicks play

```javascript
// When user hovers or searches, pre-resolve top 5 results
app.get('/api/music/search', async (req, res) => {
  const results = await searchYouTube(req.query.q);
  
  // Fire-and-forget pre-resolution for top 5 results
  results.slice(0, 5).forEach(track => {
    resolver.resolve(track.id).catch(() => {}); // Don't await
  });
  
  res.json({ results });
});

// Also pre-resolve when viewing library/history
app.get('/api/library', async (req, res) => {
  const library = await getLibrary();
  
  // Pre-resolve recently played tracks (last 10)
  library.recent.slice(0, 10).forEach(track => {
    resolver.resolve(track.id).catch(() => {});
  });
  
  res.json(library);
});
```

**Expected Impact**: 
- 95% of plays hit cache (0s resolution time)
- First search/play in session: 5-30s
- Subsequent plays: <100ms

---

### 2. **Parallel Resolution & Response** ⭐⭐⭐⭐⭐
**Impact**: Massive | **Effort**: Low | **Time-to-implement**: 1 hour

**Problem**: Client waits for full resolution before showing "playing" state

**Solution**: Return metadata immediately, resolve in background

```javascript
// NEW: /api/play-quick endpoint
app.post('/api/play-quick', async (req, res) => {
  const videoId = req.body.videoId;
  
  // Check cache first
  const cached = resolver.getFreshResolution(videoId);
  if (cached) {
    // Fast path: cached, return immediately
    const tokenData = playTokens.createToken({...});
    return res.json({ 
      streamUrl: tokenData.streamUrl,
      ...cached,
      cached: true 
    });
  }
  
  // Slow path: not cached, start resolve but return quick response
  const quickResponse = {
    videoId,
    title: 'Loading...',  // Or fetch from search cache
    artist: '',
    status: 'resolving',
    // Don't wait for resolution
  };
  
  res.json(quickResponse);
  
  // Resolve in background, notify via WebSocket when done
  try {
    const resolution = await resolver.resolve(videoId);
    const tokenData = playTokens.createToken({...});
    ws.send({
      type: 'play_ready',
      videoId,
      streamUrl: tokenData.streamUrl,
      ...resolution
    });
  } catch (err) {
    ws.send({
      type: 'play_failed',
      videoId,
      error: err.message
    });
  }
});
```

**Client-side updates**:
```javascript
async function playTrack(videoId) {
  // Show loading state immediately
  updateUI({ status: 'loading' });
  
  const response = await fetch('/api/play-quick', { 
    body: JSON.stringify({ videoId }),
    method: 'POST'
  });
  const data = await response.json();
  
  if (data.streamUrl) {
    // Cache hit - play immediately
    playStream(data.streamUrl);
  } else {
    // Cache miss - wait for WebSocket notification
    socket.once('play_ready', (playData) => {
      playStream(playData.streamUrl);
    });
  }
}
```

**Expected Impact**:
- UI responsive in <100ms
- Perception of instant playback
- Background resolution doesn't block UI

---

### 3. **Connection Pooling for Stream Proxy** ⭐⭐⭐⭐
**Impact**: High | **Effort**: Low | **Time-to-implement**: 1 hour

**Problem**: New HTTP connection for every stream request

**Solution**: Reuse HTTP agents

```javascript
// lib/stream-proxy.js
const httpAgent = new http.Agent({ 
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30000
});

const httpsAgent = new https.Agent({ 
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30000
});

function proxyStream(resolution, req, res) {
  const httpMod = resolution.upstreamUrl.startsWith('https') ? https : http;
  const agent = resolution.upstreamUrl.startsWith('https') ? httpsAgent : httpAgent;
  
  httpMod.get(resolution.upstreamUrl, { 
    agent,  // Reuse connections
    headers: req.headers 
  }, (upstreamRes) => {
    // ... existing code
  });
}
```

**Expected Impact**:
- 50-100ms faster stream initiation
- Reduced server CPU
- Better handling of concurrent streams

---

## 🎯 High-Impact, High-Effort (Do If Time Permits)

### 4. **Redis Cache Layer** ⭐⭐⭐⭐⭐
**Impact**: Massive | **Effort**: High | **Time-to-implement**: 4-6 hours

**Problem**: In-memory cache lost on server restart

**Solution**: Add Redis for persistent, shared cache

```bash
# Install Redis on server
sudo apt install redis-server
```

```javascript
// lib/redis-cache.js
const redis = require('redis');
const client = redis.createClient();

async function getCachedResolution(videoId) {
  const cached = await client.get(`resolve:${videoId}`);
  if (cached) {
    const data = JSON.parse(cached);
    // Check if expired
    if (Date.now() - data.resolvedAt < RESOLVER_CACHE_TTL) {
      return data;
    }
    await client.del(`resolve:${videoId}`);
  }
  return null;
}

async function setCachedResolution(videoId, data) {
  await client.setEx(
    `resolve:${videoId}`,
    RESOLVER_CACHE_TTL / 1000,  // TTL in seconds
    JSON.stringify(data)
  );
}

async function preWarmCache(topVideoIds) {
  const pipeline = client.pipeline();
  topVideoIds.forEach(id => {
    pipeline.get(`resolve:${id}`);
  });
  const results = await pipeline.exec();
  
  // Resolve any missing IDs
  const missingIds = topVideoIds.filter((_, i) => !results[i][1]);
  await Promise.all(missingIds.map(id => resolver.resolve(id)));
}
```

**Expected Impact**:
- Cache survives server restarts
- Can share cache across multiple server instances
- Instant playback for popular tracks

---

### 5. **CDN for Stream Proxy** ⭐⭐⭐⭐
**Impact**: High | **Effort**: High | **Time-to-implement**: 1-2 days

**Problem**: All traffic goes through your Oracle Cloud instance

**Solution**: Use Cloudflare Workers or similar to proxy streams

```javascript
// cloudflare-worker.js
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const token = url.pathname.split('/').pop();
    
    // Validate token with your server
    const validation = await fetch(`https://your-server.com/api/validate/${token}`);
    if (!validation.ok) return new Response('Invalid token', { status: 403 });
    
    const session = await validation.json();
    
    // Proxy from YouTube to user
    return fetch(session.upstreamUrl, {
      headers: request.headers
    });
  }
};
```

**Expected Impact**:
- 50-200ms faster stream start (edge locations)
- Reduced bandwidth costs
- Better DDoS protection
- Higher reliability

---

### 6. **YouTube API Fallback** ⭐⭐⭐
**Impact**: Medium-High | **Effort**: Medium | **Time-to-implement**: 3-4 hours

**Problem**: yt-dlp can be unreliable (rate limits, updates)

**Solution**: Add YouTube Data API v3 as fallback

```javascript
// lib/resolver.js
const youtube = google.youtube('v3');

async function resolveWithFallback(videoId) {
  // Try yt-dlp first (faster, no quota)
  try {
    return await resolveViaYtdlp(videoId);
  } catch (ytdlpErr) {
    console.warn(`[resolver] yt-dlp failed for ${videoId}, trying YouTube API`);
    
    // Fallback to YouTube API
    const response = await youtube.videos.list({
      part: 'contentDetails,snippet',
      id: videoId,
      key: process.env.YOUTUBE_API_KEY
    });
    
    if (!response.data.items || response.data.items.length === 0) {
      throw new Error('Video not found');
    }
    
    const video = response.data.items[0];
    // Get stream URL from yt-dlp with --skip-download flag
    // (or use another method - YouTube API doesn't give direct URLs)
    return await resolveViaYtdlp(videoId, { fallbackMode: true });
  }
}
```

**Expected Impact**:
- Higher reliability (99.9% vs 95%)
- Faster recovery from yt-dlp failures
- Better error messages to users

---

## 🛠️ Medium-Impact, Low-Effort (Quick Wins)

### 7. **Increase Resolver Timeout** ⭐⭐⭐
**Impact**: Medium | **Effort**: Trivial | **Time-to-implement**: 5 minutes

```javascript
// lib/resolver.js line 129
const timeout = setTimeout(() => {
  ytdlp.kill('SIGKILL');
  reject(new Error('yt-dlp timed out after 60s'));  // Was 30s
}, 60000);  // Was 30000
```

**Why**: WARP proxy can be slow; 30s is too short

---

### 8. **Exponential Backoff** ⭐⭐⭐
**Impact**: Medium | **Effort**: Low | **Time-to-implement**: 30 minutes

```javascript
function _resolveWithRetry(videoId, retriesLeft) {
  return _runYtDlp(videoId).catch(err => {
    if (retriesLeft > 0) {
      const backoffDelay = Math.min(1500 * Math.pow(2, 3 - retriesLeft), 10000);
      console.warn(`[resolver] Retrying ${videoId} in ${backoffDelay}ms (${retriesLeft} left)`);
      return new Promise(resolve => setTimeout(resolve, backoffDelay))
        .then(() => _resolveWithRetry(videoId, retriesLeft - 1));
    }
    throw err;
  });
}
```

**Why**: Gives YouTube/WARP time to recover

---

### 9. **Health Check & Circuit Breaker** ⭐⭐⭐
**Impact**: Medium | **Effort**: Medium | **Time-to-implement**: 1 hour

```javascript
// lib/health-check.js
let consecutiveFailures = 0;
const MAX_FAILURES = 5;
const FAILURE_COOLDOWN = 60000; // 1 minute

async function healthCheck() {
  try {
    const start = Date.now();
    await resolver.resolve('dQw4w9WgXcQ', { 
      retries: 0, 
      timeout: 10000 
    });
    const duration = Date.now() - start;
    
    consecutiveFailures = 0;
    return { 
      status: 'healthy', 
      latency: duration,
      proxy: isWarpAvailable() ? 'warp' : 'direct'
    };
  } catch (err) {
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_FAILURES) {
      // Circuit breaker: temporarily disable WARP
      _warpAvailable = false;
      setTimeout(() => { 
        consecutiveFailures = 0; 
        resetWarpCheck(); 
      }, FAILURE_COOLDOWN);
    }
    return { 
      status: 'degraded', 
      error: err.message,
      consecutiveFailures 
    };
  }
}

// Run health check every minute
setInterval(healthCheck, 60000);
```

---

### 10. **Optimize yt-dlp Arguments** ⭐⭐
**Impact**: Low-Medium | **Effort**: Trivial | **Time-to-implement**: 10 minutes

```javascript
// lib/resolver.js line 106-118
const args = [
  ...getProxyArgs(),
  '-f', 'bestaudio[ext=m4a]/bestaudio[acodec=aac]/bestaudio/best',
  '--no-check-certificates',
  '--no-warnings',
  '--socket-timeout', '15',
  '--retries', '3',
  '--fragment-retries', '3',
  '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  '--dump-json',
  '--no-download',
  '--no-playlist',  // Skip playlist extraction (faster)
  '--extract-flat',  // Don't extract additional metadata
  url,
];
```

---

## 📊 Monitoring & Analytics

### 11. **Performance Metrics Dashboard** ⭐⭐⭐⭐
**Impact**: High | **Effort**: Medium | **Time-to-implement**: 2-3 hours

```javascript
// lib/metrics.js
const metrics = {
  resolveTimes: [],
  cacheHitRate: { hits: 0, misses: 0 },
  streamLatencies: [],
  errorCounts: {},
};

function recordResolve(duration, cached) {
  metrics.resolveTimes.push(duration);
  if (cached) metrics.cacheHitRate.hits++;
  else metrics.cacheHitRate.misses++;
  
  // Keep only last 1000 data points
  if (metrics.resolveTimes.length > 1000) metrics.resolveTimes.shift();
}

function getMetrics() {
  const avgResolve = metrics.resolveTimes.reduce((a,b) => a+b, 0) / metrics.resolveTimes.length;
  const hitRate = metrics.cacheHitRate.hits / (metrics.cacheHitRate.hits + metrics.cacheHitRate.misses);
  
  return {
    avgResolveTime: Math.round(avgResolve),
    cacheHitRate: (hitRate * 100).toFixed(1) + '%',
    totalResolves: metrics.cacheHitRate.hits + metrics.cacheHitRate.misses,
    errorCounts: metrics.errorCounts,
  };
}

// Add to /api/stats endpoint
app.get('/api/stats', (req, res) => {
  res.json({
    resolver: resolver.getStats(),
    tokens: playTokens.getStats(),
    events: events.getListenStats(),
    performance: getMetrics(),  // New
  });
});
```

---

## 🎯 Priority Implementation Order

### Week 1 (Quick Wins)
1. ✅ Predictive pre-resolution (2-3 hours)
2. ✅ Parallel resolution & response (1 hour)
3. ✅ Connection pooling (1 hour)
4. ✅ Increase timeout (5 minutes)
5. ✅ Exponential backoff (30 minutes)

### Week 2 (Medium Effort)
6. ✅ Health check & circuit breaker (1 hour)
7. ✅ Optimize yt-dlp args (10 minutes)
8. ✅ Performance metrics dashboard (2-3 hours)

### Week 3-4 (If Time Permits)
9. ⏳ Redis cache layer (4-6 hours)
10. ⏳ YouTube API fallback (3-4 hours)
11. ⏳ CDN for stream proxy (1-2 days)

---

## 📈 Expected Results

### Before Implementation
- First play: 5-30 seconds
- Cache hit rate: ~30%
- Average time-to-play: 8-15 seconds
- Reliability: ~95%

### After Week 1
- First play: 5-30 seconds (but UI responsive instantly)
- Cache hit rate: ~80%
- Average time-to-play: 1-3 seconds
- Reliability: ~97%

### After Week 2
- Cache hit rate: ~90%
- Average time-to-play: <1 second
- Reliability: ~98%
- Better error handling & recovery

### After Week 3-4 (Optional)
- Cache hit rate: ~95%
- Average time-to-play: <500ms
- Reliability: ~99.9%
- Global edge caching

---

## 🔧 Additional Recommendations

### Client-Side Optimizations
1. **Preload next track**: While playing current track, resolve and pre-cache the next one
2. **Smart buffer strategy**: Preload 5-10 seconds of audio, not entire track
3. **Optimize image loading**: Lazy load thumbnails, use WebP format
4. **Service Worker caching**: Cache metadata and thumbnails for offline use

### Server-Side Optimizations
1. **Enable HTTP/2**: Better multiplexing for concurrent streams
2. **Gzip compression**: Compress JSON responses
3. **Rate limiting**: Protect against abuse without affecting normal users
4. **Horizontal scaling**: Load balance across multiple instances (if using Redis)

### Network Optimizations
1. **Multiple WARP instances**: Run 2-3 WARP proxies for redundancy
2. **Geographic testing**: Test from different regions
3. **Fallback to direct**: If WARP fails 3x in a row, use direct for 5 minutes
4. **DNS optimization**: Use fast DNS resolvers (Cloudflare 1.1.1.1)

---

## 🚦 Success Metrics

Track these metrics to measure improvement:

```javascript
// Add to metrics
const successMetrics = {
  p50TimeToPlay: 0,  // Median time to start playback
  p95TimeToPlay: 0,  // 95th percentile
  p99TimeToPlay: 0,  // 99th percentile
  cacheHitRate: 0,   // Percentage of cache hits
  errorRate: 0,      // Percentage of failed plays
  concurrentStreams: 0, // Max concurrent streams
};

// Update these on every play
function recordPlay(timeToPlay, fromCache, error) {
  successMetrics.p50TimeToPlay = calculatePercentile(50);
  successMetrics.p95TimeToPlay = calculatePercentile(95);
  successMetrics.p99TimeToPlay = calculatePercentile(99);
  successMetrics.cacheHitRate = calculateHitRate();
  successMetrics.errorRate = calculateErrorRate();
}
```

**Targets**:
- P50 time-to-play: <100ms
- P95 time-to-play: <500ms
- P99 time-to-play: <2s
- Cache hit rate: >90%
- Error rate: <1%

---

## 💡 Pro Tips

1. **Measure before optimizing**: Use metrics to identify actual bottlenecks
2. **Optimize the common case**: Focus on cache hits, not misses
3. **Progressive enhancement**: Start with cache, add layers of sophistication
4. **Monitor in production**: Real-world data beats benchmarks
5. **Have a rollback plan**: Every optimization can introduce bugs

---

**Last Updated**: 2026-05-10
**Next Review**: After implementing Week 1 improvements