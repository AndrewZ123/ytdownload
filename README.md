# 🎵 YT Music Downloader

A self-hosted web app to download YouTube Music playlists, manage your library, and import playlists directly into Apple Music on macOS.

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green) ![Platform](https://img.shields.io/badge/platform-macOS-blue)

## Features

- **⬇️ Playlist Download** — Paste a YouTube Music or YouTube playlist URL and download all tracks as MP3/M4A/FLAC with metadata and album art embedded
- **🔍 Song Search** — Search YouTube for individual songs and download them to any playlist folder
- **📚 Library Management** — Browse all downloaded playlists, search your library, find and remove duplicates
- **🌍 Discover** — Get personalized song suggestions based on your existing library, browse YouTube Music charts, explore artist discographies
- **🛠 Tools** — Spotify playlist import, auto-import watcher, metadata editor, smart playlists with custom rules
- **🍎 Import to Apple Music** — One-click import of any downloaded playlist folder into Apple Music as a proper playlist (not individual songs)

## Prerequisites

- **macOS** (required for Apple Music import)
- **[Node.js](https://nodejs.org/)** >= 18
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — `brew install yt-dlp`
- **[ffmpeg](https://ffmpeg.org/)** — `brew install ffmpeg` (required for audio conversion & metadata)

## Installation

```bash
git clone https://github.com/YOUR_USERNAME/ytdownload.git
cd ytdownload
npm install
npm start
```

Open **http://localhost:3000** in your browser.

## Usage

### Download a Playlist
1. Go to the **⬇️ Download** tab
2. Paste a YouTube Music or YouTube playlist URL
3. Click **Fetch** to preview tracks, then **Download All**
4. Tracks are saved to `downloads/<PlaylistName>/` with embedded metadata and thumbnails

### Import to Apple Music
1. Go to the **🍎 Import** tab
2. You'll see all your downloaded playlists
3. Click **🍎 Import** on any playlist — it creates a playlist in Apple Music with the same name and adds all tracks

### Search & Download Individual Songs
1. Go to the **🔍 Search** tab
2. Search for any song, click **⬇️** to download it to a playlist folder

### Discover New Music
1. Go to the **🌍 Discover** tab
2. Click **🔮 Discover New Music** to get AI-curated suggestions based on your library

## Configuration

A `config.json` file is auto-generated on first run:

```json
{
  "apiKey": "auto-generated-key",
  "format": "mp3",
  "quality": "0"
}
```

- **format**: `mp3`, `m4a`, `flac`, `opus`, `wav`
- **quality**: `0` (best) to `9` (worst) for MP3; varies by format
- **apiKey**: Used for API access (pass via `?apiKey=` query param or `X-API-Key` header)

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/playlist-info?url=` | GET | Fetch playlist metadata |
| `/api/download?url=&format=&quality=` | GET (SSE) | Download playlist with progress |
| `/api/batch-download` | POST | Download multiple URLs |
| `/api/search?q=` | GET | Search YouTube |
| `/api/download-song` | POST | Download a single song |
| `/api/downloaded-playlists` | GET | List all downloaded playlists |
| `/api/import-to-apple-music` | POST | Import playlist to Apple Music |
| `/api/file-metadata?playlist=&file=` | GET/PUT | Read/edit file metadata |
| `/api/duplicates` | GET | Find duplicate songs |
| `/api/suggested` | GET | Library-based recommendations |
| `/api/settings` | GET/PUT | Get/update settings |

## Tech Stack

- **Backend**: Node.js + Express
- **Frontend**: Vanilla HTML/CSS/JS (single-page app)
- **Download Engine**: [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- **Audio Processing**: [ffmpeg](https://ffmpeg.org/)
- **Apple Music Integration**: macOS AppleScript (`osascript`)

## License

MIT