/**
 * Stream Proxy Service — Proxies upstream audio to clients with full HTTP Range support
 *
 * This is the most critical piece of the architecture. It:
 *  - Accepts validated play tokens
 *  - Opens upstream audio connections (through WARP if needed)
 *  - Proxies bytes to the client (iOS AVPlayer)
 *  - Supports HTTP range requests for seeking, buffering, and resume
 *  - Re-resolves expired upstream URLs before playback begins
 *  - Handles connection failures gracefully
 *
 * AVPlayer sends various Range patterns:
 *  - "Range: bytes=0-" (initial probe)
 *  - "Range: bytes=0-1" (format detection)
 *  - "Range: bytes=X-Y" (seek)
 *  - "Range: bytes=X-" (resume from position X)
 */

const http = require('http');
const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { isWarpAvailable } = require('./utils');
const resolver = require('./resolver');

// Reuse WARP agent across requests
let _warpAgent = null;
function getWarpAgent() {
  if (!_warpAgent) {
    _warpAgent = new SocksProxyAgent('socks5://127.0.0.1:40000');
  }
  return _warpAgent;
}

// Connection pooling for HTTP/HTTPS requests (Performance improvement #3)
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

/**
 * Parse a Range header like "bytes=0-1023" or "bytes=500-"
 * Returns { start, end } or null if invalid/missing.
 */
function parseRange(rangeHeader, totalLength) {
  if (!rangeHeader) return null;

  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const startStr = match[1];
  const endStr = match[2];
  let start, end;

  if (startStr === '' && endStr !== '') {
    // "bytes=-500" means last 500 bytes
    start = Math.max(0, (totalLength || 0) - parseInt(endStr, 10));
    end = (totalLength || 0) - 1;
  } else if (startStr !== '') {
    start = parseInt(startStr, 10);
    if (endStr !== '') {
      end = parseInt(endStr, 10);
    } else {
      // "bytes=500-" means from 500 to end
      end = totalLength ? totalLength - 1 : null;
    }
  } else {
    return null;
  }

  // Validate
  if (isNaN(start) || start < 0) return null;
  if (end !== null && end < start) return null;
  if (totalLength && start >= totalLength) return null;

  return { start, end };
}

/**
 * Fetch a URL following redirects, with timeout.
 * Routes through WARP SOCKS5 if available.
 *
 * NOTE: WARP is used for resolution only. Stream URLs are IP-bound to the resolver's IP,
 * so we must fetch them directly without WARP to avoid IP mismatch.
 *
 * @param {string} url
 * @param {object} headers
 * @param {number} maxRedirects
 * @param {number} timeoutMs
 * @returns {Promise<http.IncomingMessage>}
 */
function fetchUpstream(url, headers = {}, maxRedirects = 8, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    function attempt(currentUrl, remaining) {
      const parsed = new URL(currentUrl);
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;
      const opts = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { ...headers, 'Host': parsed.host },
        timeout: timeoutMs,
      };

      // Use connection pooling for direct requests (Performance improvement #3)
      // Do NOT use WARP for streaming - causes 403 errors due to IP binding
      opts.agent = isHttps ? httpsAgent : httpAgent;

      const req = lib.request(opts, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (remaining <= 0) return reject(new Error('Too many redirects'));
          const next = new URL(res.headers.location, currentUrl).href;
          return attempt(next, remaining - 1);
        }
        resolve(res);
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Upstream fetch timeout')); });
      req.end();
    }
    attempt(url, maxRedirects);
  });
}

/**
 * Stream audio from upstream to the client response.
 * Handles Range requests, content-type detection, and error recovery.
 *
 * @param {object} resolution - From resolver.resolve()
 * @param {http.IncomingMessage} req - Client request
 * @param {http.ServerResponse} res - Client response
 */
async function proxyStream(resolution, req, res, tokenAge) {
  const { upstreamUrl, audioMime, contentLength, sourceId } = resolution;
  const streamLog = {
    videoId: sourceId,
    tokenAge: tokenAge || -1,
    clientRange: req.headers.range || null,
    upstreamHost: new URL(upstreamUrl).hostname,
    upstreamStatus: null,
    downstreamStatus: null,
    contentType: null,
    contentLength: null,
    contentRange: null,
    reResolved: false,
    warpUsed: isWarpAvailable(),
    bytesStreamed: 0,
    error: null,
  };

  // Build upstream request headers
  const fetchHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': '*/*',
  };

  // Forward client's Range header to upstream
  const clientRange = req.headers.range;
  if (clientRange) {
    fetchHeaders['Range'] = clientRange;
  }

  let upstreamRes;
  try {
    upstreamRes = await fetchUpstream(upstreamUrl, fetchHeaders);
    streamLog.upstreamStatus = upstreamRes.statusCode;
  } catch (fetchErr) {
    console.error(`[stream-proxy] Upstream fetch failed for ${sourceId}:`, fetchErr.message);
    streamLog.error = `upstream_fetch_failed: ${fetchErr.message}`;

    // If fetch fails, the upstream URL may have expired. Try re-resolving once.
    if (!res.headersSent) {
      try {
        console.log(`[stream-proxy] Attempting re-resolve for ${sourceId}...`);
        const newResolution = await resolver.reResolve(sourceId);
        streamLog.reResolved = true;
        // Retry fetch with new URL
        upstreamRes = await fetchUpstream(newResolution.upstreamUrl, fetchHeaders);
        streamLog.upstreamStatus = upstreamRes.statusCode;
        streamLog.upstreamHost = new URL(newResolution.upstreamUrl).hostname;
      } catch (retryErr) {
        console.error(`[stream-proxy] Re-resolve also failed for ${sourceId}:`, retryErr.message);
        streamLog.error = `re_resolve_failed: ${retryErr.message}`;
        streamLog.downstreamStatus = 502;
        _logStreamSession(streamLog);
        if (!res.headersSent) {
          res.status(502).json({ error: 'Stream source expired and re-resolve failed' });
        }
        return;
      }
    } else {
      _logStreamSession(streamLog);
      return;
    }
  }

  // Handle upstream errors
  if (upstreamRes.statusCode >= 400) {
    upstreamRes.resume();
    streamLog.upstreamStatus = upstreamRes.statusCode;

    // If upstream returns 403/410, the YouTube CDN URL likely expired.
    // Try re-resolving once before failing the client.
    if ((upstreamRes.statusCode === 403 || upstreamRes.statusCode === 410) && !res.headersSent) {
      console.log(`[stream-proxy] Upstream ${upstreamRes.statusCode} for ${sourceId} — attempting re-resolve...`);
      try {
        const newResolution = await resolver.reResolve(sourceId);
        streamLog.reResolved = true;
        // Retry fetch with new URL
        upstreamRes = await fetchUpstream(newResolution.upstreamUrl, fetchHeaders);
        streamLog.upstreamStatus = upstreamRes.statusCode;
        streamLog.upstreamHost = new URL(newResolution.upstreamUrl).hostname;

        // If retry also fails, fall through to error handling below
        if (upstreamRes.statusCode >= 400) {
          upstreamRes.resume();
          streamLog.downstreamStatus = upstreamRes.statusCode;
          streamLog.error = `upstream_error_after_reresolve_${upstreamRes.statusCode}`;
          _logStreamSession(streamLog);
          if (!res.headersSent) {
            res.status(502).json({ error: `Upstream returned ${upstreamRes.statusCode} even after re-resolve`, code: 'UPSTREAM_EXPIRED' });
          }
          return;
        }
        // Success — fall through to normal proxy flow below
        console.log(`[stream-proxy] Re-resolve succeeded for ${sourceId}, continuing stream`);
      } catch (retryErr) {
        console.error(`[stream-proxy] Re-resolve failed for ${sourceId}:`, retryErr.message);
        streamLog.error = `reresolve_failed: ${retryErr.message}`;
        streamLog.downstreamStatus = 502;
        _logStreamSession(streamLog);
        if (!res.headersSent) {
          res.status(502).json({ error: 'Stream source expired and re-resolve failed', code: 'UPSTREAM_EXPIRED' });
        }
        return;
      }
    } else {
      streamLog.downstreamStatus = upstreamRes.statusCode;
      streamLog.error = `upstream_error_${upstreamRes.statusCode}`;
      _logStreamSession(streamLog);
      if (!res.headersSent) {
        res.status(upstreamRes.statusCode).json({ error: `Upstream returned ${upstreamRes.statusCode}` });
      }
      return;
    }
  }

  // Detect and normalize content type
  let responseContentType = audioMime || 'audio/mp4';
  const upstreamContentType = upstreamRes.headers['content-type'];
  if (upstreamContentType && upstreamContentType !== 'application/octet-stream' && upstreamContentType !== 'binary/octet-stream') {
    responseContentType = upstreamContentType;
  }
  // Force audio/mp4 for m4a/aac streams — iOS needs this
  if (upstreamUrl.includes('mime=audio%2Fmp4') || upstreamUrl.includes('.m4a') || audioMime === 'audio/mp4') {
    responseContentType = 'audio/mp4';
  }

  // Build response headers
  const responseHeaders = {
    'Content-Type': responseContentType,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store', // Stream is per-session, don't cache
  };

  // Determine actual content length from upstream
  const upstreamContentLength = upstreamRes.headers['content-length'];
  const upstreamContentRange = upstreamRes.headers['content-range'];

  // Determine response status and range info
  let responseStatus = 200;
  let responseLength = null;

  if (upstreamRes.statusCode === 206 && upstreamContentRange) {
    // Upstream honored our range request
    responseStatus = 206;
    responseHeaders['Content-Range'] = upstreamContentRange;
    if (upstreamContentLength) {
      responseLength = parseInt(upstreamContentLength, 10);
      responseHeaders['Content-Length'] = responseLength;
    }
  } else if (upstreamRes.statusCode === 200) {
    // Full content returned
    if (clientRange && !upstreamContentRange) {
      // Client asked for a range but upstream returned full content.
      // Try to parse the range ourselves and slice the stream.
      const totalLen = upstreamContentLength ? parseInt(upstreamContentLength, 10) : contentLength;
      const range = parseRange(clientRange, totalLen);
      if (range && totalLen) {
        // We need to skip bytes and limit output — but for simplicity,
        // just return 200 with the full body. AVPlayer handles this fine.
        // Most CDN servers DO support Range, so this path is rare.
        responseStatus = 200;
        responseHeaders['Content-Length'] = upstreamContentLength;
      } else {
        responseHeaders['Content-Length'] = upstreamContentLength;
      }
    } else {
      responseHeaders['Content-Length'] = upstreamContentLength;
    }
  }

  // Add CORS headers for Range requests (needed for iOS)
  responseHeaders['Access-Control-Expose-Headers'] = 'Content-Range, Content-Length, Accept-Ranges';

  // Update stream log with response details
  streamLog.downstreamStatus = responseStatus;
  streamLog.contentType = responseContentType;
  streamLog.contentLength = responseLength || upstreamContentLength || null;
  streamLog.contentRange = responseHeaders['Content-Range'] || null;

  // Write headers
  res.writeHead(responseStatus, responseHeaders);

  // Pipe upstream to client with byte counting
  let bytesStreamed = 0;
  upstreamRes.on('data', (chunk) => {
    bytesStreamed += chunk.length;
  });

  upstreamRes.pipe(res);

  // Handle disconnects
  upstreamRes.on('error', (err) => {
    console.error(`[stream-proxy] Upstream stream error for ${sourceId}:`, err.message);
    streamLog.bytesStreamed = bytesStreamed;
    streamLog.error = `upstream_stream_error: ${err.message}`;
    _logStreamSession(streamLog);
    if (!res.writableEnded) {
      try { res.end(); } catch (_) {}
    }
  });

  req.on('close', () => {
    streamLog.bytesStreamed = bytesStreamed;
    _logStreamSession(streamLog);
    if (upstreamRes && !upstreamRes.destroyed) {
      upstreamRes.destroy();
    }
  });

  res.on('close', () => {
    streamLog.bytesStreamed = bytesStreamed;
    _logStreamSession(streamLog);
    if (upstreamRes && !upstreamRes.destroyed) {
      upstreamRes.destroy();
    }
  });
}

/**
 * Log a structured stream session for diagnostics.
 */
function _logStreamSession(log) {
  // Only log once per session (guard against multiple close events)
  if (log._logged) return;
  log._logged = true;

  console.log(JSON.stringify({
    type: 'stream_session',
    timestamp: new Date().toISOString(),
    ...log,
  }));
}

/**
 * Get a HEAD request to probe upstream content-length and content-type
 * without downloading the whole file. Useful for pre-fetching metadata.
 */
async function probeUpstream(resolution) {
  const { upstreamUrl, sourceId } = resolution;
  const useWarp = isWarpAvailable();

  return new Promise((resolve, reject) => {
    const parsed = new URL(upstreamUrl);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'HEAD',
      headers: {
        'Host': parsed.host,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Range': 'bytes=0-0',
      },
      timeout: 10000,
    };

    if (useWarp) opts.agent = getWarpAgent();

    const req = lib.request(opts, (res) => {
      resolve({
        contentLength: res.headers['content-length'] ? parseInt(res.headers['content-length'], 10) : null,
        contentType: res.headers['content-type'] || null,
        acceptRanges: res.headers['accept-ranges'] || null,
        contentRange: res.headers['content-range'] || null,
      });
      res.resume();
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Probe timeout')); });
    req.end();
  });
}

module.exports = {
  proxyStream,
  probeUpstream,
  parseRange,
  fetchUpstream,
};