# 🔴 iOS Playback Error When Disconnected from Xcode — Debug Document

## Table of Contents
1. [Problem Statement](#1-problem-statement)
2. [Current Architecture](#2-current-architecture)
3. [Detailed Code Flow](#3-detailed-code-flow)
4. [What Has Been Tried](#4-what-has-been-tried)
5. [Root Cause Analysis](#5-root-cause-analysis)
6. [Where We Are Still Stuck](#6-where-we-are-still-stuck)
7. [Key Files Reference](#7-key-files-reference)
8. [Suggested Next Steps](#8-suggested-next-steps)

---

## 1. Problem Statement

### Symptom
The iOS app (built with Capacitor) plays music **perfectly when connected to Xcode** (debugger attached via USB/WiFi). However, when the iPhone is **disconnected from Xcode and running standalone**, playback fails with a **"Playback Error"** message.

### Context
- The app is a YouTube Music-like client that streams audio from YouTube via a Node.js backend
- Server runs on **Oracle Cloud** (Ubuntu) with **Cloudflare WARP** SOCKS5 proxy for YouTube access
- iOS app is built with **Capacitor 6** wrapping a web app (HTML/JS/CSS)
- Audio playback uses the **HTML5 Audio API** (`new Audio()`) inside the Capacitor WebView

### What "Disconnected from Xcode" Means
When an iOS device is running an app that was built and deployed via Xcode, the app behaves differently depending on whether the debugger is still attached:
- **Debug mode (connected)**: Xcode's debugger keeps the app process alive, allows more memory, relaxes some WebView restrictions, and keeps the debug web inspector connected
- **Standalone mode (disconnected)**: iOS applies normal process lifecycle rules — the app can be suspended, the WebView can be throttled, and network connections can be terminated more aggressively

### Specific Error
The player shows a "Playback Error" toast notification. In `ios-app/web/js/player.js`, the error handler is:

```javascript
audio.onerror = function(e) {
    // ... logs to console
    showError(`Playback Error: ${audio.error ? audio.error.message : 'Unknown error'}`);
};
```

The problem is that when disconnected from Xcode, we **cannot see the console logs**, so the exact `audio.error.message` is unknown. The error could be:
- `MEDIA_ERR_SRC_NOT_SUPPORTED` (4) — the stream URL is not playable
- `MEDIA_ERR_NETWORK` (2) — network failure during loading
- `MEDIA_ERR_DECODE` (3) — audio decode failure
- `MEDIA_ERR_ABORTED` (1) — playback was aborted

---

## 2. Current Architecture

### High-Level Data Flow

```
┌─────────────┐         ┌──────────────────────┐         ┌─────────────────┐
│  iOS App     │         │  Node.js Server      │         │  YouTube / CDN  │
│  (Capacitor) │         │  (Oracle Cloud)      │         │                 │
│              │         │                      │         │                 │
│  HTML5 Audio │──GET──▶ │  GET /api/stream/:tk │──GET──▶ │  Audio CDN URL  │
│              │         │  (stream-proxy.js)   │         │  (expires ~6hr) │
│              │         │                      │◀──200──│                 │
│              │◀──200──│  proxies bytes with   │         │                 │
│              │         │  Range support        │         │                 │
│              │         │                      │         │                 │
│  player.js   │──POST─▶│  POST /api/play      │──yt-dlp▶│  YouTube        │
│              │         │  (streaming.js)      │◀──URL───│  resolves audio │
│              │◀─JSON──│  returns signed token │         │                 │
│              │         │                      │         │                 │
│              │         │  WARP SOCKS5 :40000  │         │                 │
│              │         │  (if available)       │         │                 │
└─────────────┘         └──────────────────────┘         └─────────────────┘
```

### Two-Phase Playback Architecture

**Phase 1: Resolve** (`POST /api/play`)
1. Client sends `{ videoId: "dQw4w9WgXcQ" }` to server
2. Server calls `resolver.resolve(videoId)` which runs `yt-dlp` to get the best audio stream URL from YouTube
3. Server creates a **signed play token** (random 48-char hex, expires in 5 minutes)
4. Server returns JSON with `streamUrl: "https://server.com/api/stream/<token>"` plus track metadata

**Phase 2: Stream** (`GET /api/stream/:token`)
1. Client sets `audio.src = streamUrl`
2. iOS WebView's `<audio>` element makes HTTP requests to the server
3. Server validates the token, gets the cached upstream URL (or re-resolves)
4. Server opens a connection to YouTube's CDN, forwards the client's `Range` header
5. Server pipes the upstream response bytes back to the client
6. Supports HTTP 206 Partial Content for seeking and buffering

### Component Map

| Component | File | Role |
|-----------|------|------|
| **iOS App Shell** | `ios-app/` | Capacitor native wrapper |
| **Audio Player** | `ios-app/web/js/player.js` | HTML5 Audio, playback control, error handling |
| **App State** | `ios-app/web/js/state.js` | Global `audio` element, song state |
| **API Client** | `ios-app/web/js/api.js` | HTTP helpers, `urlWithKey()` auth |
| **Config** | `ios-app/web/js/config.js` | `API` base URL, API key |
| **AppDelegate** | `ios-app/ios/App/App/AppDelegate.swift` | Audio session category, background audio |
| **NowPlayingPlugin** | `ios-app/ios/App/App/NowPlayingPlugin.swift` | iOS lock screen media controls |
| **Server Entry** | `server.js` | Express server, route mounting |
| **Streaming Routes** | `routes/streaming.js` | POST /play, GET /stream/:token |
| **Stream Proxy** | `lib/stream-proxy.js` | Upstream fetch, Range handling, byte piping |
| **Play Tokens** | `lib/play-tokens.js` | Token creation, validation, TTL management |
| **Resolver** | `lib/resolver.js` | yt-dlp integration, URL caching |
| **Utils** | `lib/utils.js` | WARP detection, proxy config |

### Audio Session Configuration (iOS Native)

In `AppDelegate.swift`:
```swift
func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: ...) {
    AVAudioSession.sharedInstance().perform(NSSelectorFromString("setCategory:error:"), with: "playback")
    // Note: This uses performSelector — NOT the standard API
}
```

In `Info.plist`:
```xml
<key>UIBackgroundModes</key>
<array>
    <string>audio</string>
</array>
```

### Capacitor Configuration

In `capacitor.config.json`:
```json
{
    "appId": "com.ytmusic.app",
    "appName": "My Music",
    "webDir": "web",
    "server": {
        "allowNavigation": ["melodia.ddns.net", "157.151.254.26:3000"],
        "cleartext": true
    },
    "plugins": {
        "CapacitorHttp": { "enabled": true }
    }
}
```

**IMPORTANT**: `CapacitorHttp` is enabled. This means Capacitor intercepts HTTP requests from the WebView and routes them through native `URLSession`. This can change cookie handling, timeout behavior, and TLS behavior compared to the WebView's default fetch/XHR.

### Server URL Construction

In `ios-app/web/js/config.js`:
```javascript
const API = window.location.hostname === 'localhost'
    ? 'http://localhost:3000'
    : 'https://melodia.ddns.net';
const API_KEY = '...shared secret...';
```

In `ios-app/web/js/api.js`:
```javascript
function urlWithKey(url) {
    return url + (url.includes('?') ? '&' : '?') + 'key=' + API_KEY;
}
```

All stream URLs become: `https://melodia.ddns.net/api/stream/<token>?key=<API_KEY>`

---

## 3. Detailed Code Flow

### Playback Initiation (`player.js` — `playSong()`)

```javascript
async function playSong(song) {
    currentSong = song;
    updateNowPlayingUI();

    try {
        if (song.isStream) {
            // YouTube streaming path
            if (song._tokenUrl && song._tokenExpiry > Date.now() + 30000) {
                // Reuse cached token URL if still valid (>30s remaining)
                audio.src = song._tokenUrl;
            } else {
                // Get fresh token from server
                const resp = await fetch(urlWithKey(`${API}/api/play`), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ videoId: song.id, trackId: song.id }),
                });
                if (!resp.ok) throw new Error(`Play API returned ${resp.status}`);
                const data = await resp.json();
                song._tokenUrl = data.streamUrl;
                song._tokenExpiry = new Date(data.streamExpiresAt).getTime();
                audio.src = data.streamUrl;
            }
        } else {
            // Local library streaming path
            audio.src = audioUrl(song);
        }

        // Append API key to stream URL
        audio.src = audio.src + (audio.src.includes('?') ? '&' : '?') + 'key=' + API_KEY;

        audio.load();
        await audio.play();

    } catch (e) {
        showError('Playback Error: ' + e.message);
    }
}
```

### Server-Side Stream Handling (`streaming.js` → `stream-proxy.js`)

1. **Token Validation**: `playTokens.validateToken(token)` — checks if token exists and hasn't expired (5 min TTL)
2. **Resolution Lookup**: `resolver.getFreshResolution(videoId)` — checks cache for a non-expired upstream URL
3. **Re-resolve if needed**: If cache expired, calls `resolver.reResolve(videoId)` which re-runs yt-dlp
4. **Proxy**: `streamProxy.proxyStream(resolution, req, res)` — fetches upstream and pipes to client

### Token Lifecycle

```
Create (POST /api/play)
  → token = random 48 hex chars
  → TTL = 5 minutes
  → stored in server memory (Map)

Validate (GET /api/stream/:token)
  → lookup in Map
  → check Date.now() < expiresAt
  → return session or null (403)

After 5 minutes → token is DEAD, client must call POST /api/play again
```

**Critical implication**: If the audio element makes a new request after the token expires (e.g., during seeking, re-buffering, or resuming after background), the server returns **403 Forbidden**. The audio element treats this as a fatal error.

---

## 4. What Has Been Tried

### 4.1 Server-Side Proxing (Current Architecture)
The entire proxy architecture was built to solve the original problem: iOS can't play raw YouTube CDN URLs due to:
- **CORS**: YouTube CDN doesn't send `Access-Control-Allow-Origin` headers
- **ATS (App Transport Security)**: Some CDN URLs use HTTP or have certificate issues
- **IP Binding**: CDN URLs are bound to the server's IP (resolved through WARP), so the client can't fetch them directly

**Result**: Proxing works — the server can successfully fetch and proxy audio. This is not the root cause.

### 4.2 Play Token System
Tokens were introduced to:
- Avoid exposing raw CDN URLs to the client
- Allow URL rotation without client changes
- Prevent unauthorized streaming

**Result**: Tokens work for initial playback but the 5-minute TTL is problematic for long sessions.

### 4.3 WARP SOCKS5 Proxy
The server uses Cloudflare WARP as a SOCKS5 proxy on port 40000 to access YouTube from Oracle Cloud (YouTube blocks some cloud IPs).

```javascript
// In lib/utils.js
function isWarpAvailable() {
    execSync('curl -x socks5://127.0.0.1:40000 --connect-timeout 2 ...');
}
```

**Result**: WARP works for resolution and initial streaming, but the 2-minute re-check interval means WARP outages can cause silent failures.

### 4.4 Audio Session Configuration
In `AppDelegate.swift`:
```swift
AVAudioSession.sharedInstance().perform(NSSelectorFromString("setCategory:error:"), with: "playback")
```

**Concern**: This uses `performSelector` to call `setCategory:error:` which is fragile. The modern Swift API is:
```swift
try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
try AVAudioSession.sharedInstance().setActive(true)
```

### 4.5 CORS and Range Headers
The stream proxy sets:
```javascript
'Access-Control-Allow-Origin': '*',
'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
'Accept-Ranges': 'bytes',
```

**Result**: This should be sufficient for WebView audio playback.

### 4.6 Content-Type Handling
```javascript
// Force audio/mp4 for m4a/aac streams — iOS needs this
if (upstreamUrl.includes('mime=audio%2Fmp4') || upstreamUrl.includes('.m4a') || audioMime === 'audio/mp4') {
    responseContentType = 'audio/mp4';
}
```

**Result**: Content-Type should be correct for iOS.

---

## 5. Root Cause Analysis

Based on the architecture and code review, here are the **most likely causes** of the playback error when disconnected from Xcode:

### 5.1 🔴 MOST LIKELY: CapacitorHttp Native Interception

**The `CapacitorHttp` plugin is enabled** in `capacitor.config.json`:
```json
"CapacitorHttp": { "enabled": true }
```

This means **all fetch() calls and XMLHttpRequests are intercepted** by Capacitor and routed through native `URLSession`. This changes:
- **Timeout behavior**: Native URLSession has different default timeouts than WebView's fetch
- **Header handling**: Native might strip or modify headers
- **Response streaming**: Native URLSession may buffer the entire response before delivering it to the WebView, **breaking audio streaming** which requires chunked transfer
- **Range request handling**: Native may not properly forward Range headers or handle 206 responses

When connected to Xcode, the debugger may alter this behavior or relax timeout constraints.

### 5.2 🔴 MOST LIKELY: Token Expiry During Playback

The play token expires after **5 minutes**. When iOS suspends the app to background and returns:
1. The audio element may try to re-fetch the stream (re-buffering)
2. The token is now expired (403)
3. The audio element fires `onerror`
4. No retry logic exists to get a new token

When connected to Xcode, iOS may not suspend the app as aggressively, so the token stays valid.

### 5.3 🟡 POSSIBLE: Audio Element Behavior Without Debugger

Without the debugger, iOS WebView may be stricter about:
- **Autoplay policy**: Audio can only play after user interaction. If the WebView reloads or state is lost, subsequent playback may be blocked
- **Memory pressure**: iOS may terminate the WebView's render process, losing the audio element state
- **Network connection lifecycle**: The underlying HTTP connection for the audio stream may be killed when the app enters background, and iOS may not allow reconnection

### 5.4 🟡 POSSIBLE: Background Audio Session Not Active

The `AppDelegate.swift` sets the audio session category to `playback` using `performSelector`:
```swift
AVAudioSession.sharedInstance().perform(NSSelectorFromString("setCategory:error:"), with: "playback")
```

Issues:
- `setActive(true)` is **never called** — the session may not be properly activated
- Using `performSelector` is fragile and may not properly forward the `error:` parameter result
- Without an active audio session, iOS may silence audio or terminate playback when the app goes to background

### 5.5 🟡 POSSIBLE: WebView Process Suspension

When disconnected from Xcode, iOS applies normal process lifecycle:
- **WKWebView** process can be suspended when the app is in the background
- When the app returns to foreground, the WebView process may need to be restored
- The audio element's state (src, currentTime, etc.) may be lost
- Network connections backing the audio element may be terminated

### 5.6 🟢 UNLIKELY BUT POSSIBLE: SSL/TLS Issues

The app connects to `https://melodia.ddns.net`. The SSL certificate must be:
- Valid and not expired
- Issued by a trusted CA (Let's Encrypt is fine)
- Properly configured for the domain

If there's a certificate issue, the debugger might bypass it (WKWebView debug mode can ignore some TLS errors).

---

## 6. Where We Are Still Stuck

### The Core Problem
**We cannot reproduce or observe the error when the debugger is attached**, because the debugger changes the app's behavior. And when the debugger is detached, we can't see the console logs or network requests.

### Unknown Answers
1. **What is the exact error code?** — We don't know if it's `MEDIA_ERR_SRC_NOT_SUPPORTED`, `MEDIA_ERR_NETWORK`, `MEDIA_ERR_DECODE`, or `MEDIA_ERR_ABORTED`
2. **Does the audio.src URL work when tested directly?** — We can't test the stream URL in Safari on the device easily
3. **Is the POST /api/play succeeding?** — We don't know if the token is being obtained successfully
4. **Is this a first-play failure or a resume-from-background failure?** — The exact trigger is unknown
5. **Does CapacitorHttp actually intercept audio element requests?** — The HTML5 `<audio>` element uses its own networking stack, not fetch/XHR. But CapacitorHttp might still affect the WebView's networking globally

### Debugging Challenges
- **No remote logging**: When disconnected from Xcode, console.log output is lost
- **No network inspector**: Can't see the HTTP requests the audio element makes
- **No reproduction with debugger**: The issue only happens without the debugger
- **Server logs are insufficient**: The server may show the request succeeded, but the audio element still fails

---

## 7. Key Files Reference

### Server-Side (Node.js)

| File | Lines | Purpose |
|------|-------|---------|
| `server.js` | ~120 | Express server setup, CORS, route mounting |
| `routes/streaming.js` | 453 | POST /api/play, GET /api/stream/:token, search, events |
| `lib/stream-proxy.js` | 314 | Upstream fetch, Range parsing, byte piping |
| `lib/play-tokens.js` | 163 | Token CRUD, 5-min TTL, in-memory Map store |
| `lib/resolver.js` | ~300 | yt-dlp exec, URL caching (CACHE_TTL), re-resolve |
| `lib/utils.js` | 96 | WARP detection, proxy args, helpers |

### iOS App

| File | Lines | Purpose |
|------|-------|---------|
| `ios-app/web/js/player.js` | ~600 | Audio playback, playSong(), error handling, prebuffer |
| `ios-app/web/js/state.js` | 61 | Global `audio` element, song state, URL helpers |
| `ios-app/web/js/api.js` | ~100 | fetch wrapper, API key auth |
| `ios-app/web/js/config.js` | ~15 | API base URL, API key constant |
| `ios-app/web/js/offline.js` | ~200 | Offline playback, service worker, IndexedDB |
| `ios-app/capacitor.config.json` | 17 | Capacitor config ( CapacitorHttp enabled! ) |
| `ios-app/ios/App/App/AppDelegate.swift` | ~50 | Audio session category setup |
| `ios-app/ios/App/App/NowPlayingPlugin.swift` | 54 | Lock screen media info |
| `ios-app/ios/App/App/Info.plist` | 72 | Background modes (audio), ATS exceptions |

---

## 8. Suggested Next Steps

### Step 1: Add Remote Error Logging (CRITICAL)
Before anything else, add a mechanism to send error details to the server so they can be observed when the debugger is not attached.

```javascript
// In player.js error handler
audio.onerror = function(e) {
    const errorInfo = {
        code: audio.error ? audio.error.code : 'unknown',
        message: audio.error ? audio.error.message : 'Unknown',
        src: audio.src ? audio.src.substring(0, 100) : 'none',
        networkState: audio.networkState,
        readyState: audio.readyState,
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent,
    };
    
    // Send to server
    fetch(`${API}/api/events/error?key=${API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(errorInfo),
    }).catch(() => {});
    
    showError(`Playback Error: ${errorInfo.message} (code ${errorInfo.code})`);
};
```

### Step 2: Disable CapacitorHttp Temporarily
Test if disabling `CapacitorHttp` in `capacitor.config.json` fixes the issue:
```json
"plugins": {
    "CapacitorHttp": { "enabled": false }
}
```

### Step 3: Fix Audio Session Activation
Replace the `performSelector` hack in `AppDelegate.swift` with proper API:
```swift
try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.defaultToSpeaker])
try? AVAudioSession.sharedInstance().setActive(true)
```

### Step 4: Increase Token TTL and Add Retry Logic
- Increase `TOKEN_TTL` from 5 minutes to at least 30 minutes
- Add retry logic in `player.js`: when audio.onerror fires with code 4 (SRC_NOT_SUPPORTED), try getting a fresh token and retry once

### Step 5: Use AVPlayer Instead of HTML5 Audio
The most robust solution for iOS audio is to use `AVPlayer` natively rather than the HTML5 `<audio>` element inside a WebView. This gives:
- Proper background audio handling
- Better error recovery
- Native media controls integration
- No WebView process suspension issues

### Step 6: Investigate WebView Process Lifecycle
Add a `Capacitor` plugin or use the `appRestoredListener` to detect when the WebView process is restored after suspension, and re-initialize the audio element.

---

## Appendix A: Server Stream Endpoint Detail

```
GET /api/stream/:token?key=API_KEY
  Range: bytes=0-

Response (success):
  HTTP/1.1 200 OK (or 206 Partial Content)
  Content-Type: audio/mp4
  Accept-Ranges: bytes
  Access-Control-Allow-Origin: *
  Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges
  Cache-Control: no-store
  Content-Length: <size>
  [audio bytes...]

Response (expired token):
  HTTP/1.1 403 Forbidden
  {"error":"Invalid or expired play token"}

Response (upstream failure):
  HTTP/1.1 502 Bad Gateway
  {"error":"Stream source expired and could not be refreshed"}
```

## Appendix B: iOS Audio Error Codes

| Code | Constant | Meaning |
|------|----------|---------|
| 1 | MEDIA_ERR_ABORTED | Loading was aborted (user action or new load()) |
| 2 | MEDIA_ERR_NETWORK | Network error while loading |
| 3 | MEDIA_ERR_DECODE | Audio decode error (corrupt data, unsupported codec) |
| 4 | MEDIA_ERR_SRC_NOT_SUPPORTED | The audio source is not supported (bad URL, wrong format, 403, etc.) |

## Appendix C: Environment Details

- **Server**: Oracle Cloud Ubuntu, Node.js, behind nginx reverse proxy
- **Domain**: `melodia.ddns.net` (DDNS) with HTTPS (Let's Encrypt via nginx)
- **WARP**: Cloudflare WARP SOCKS5 proxy on port 40000 (for YouTube access)
- **iOS**: Built with Capacitor 6, targeting modern iOS
- **Audio format**: Primarily `audio/mp4` (AAC/M4A) from YouTube
- **yt-dlp**: Resolves best audio-only stream from YouTube