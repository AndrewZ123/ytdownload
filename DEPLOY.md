# 🚀 Cloud Deployment Guide

Deploy your YouTube Music Downloader to the cloud so your iPhone app works **without your Mac being on**.

## Option 1: Fly.io (Recommended - Always On, Free Tier)

### Prerequisites
- [Fly.io account](https://fly.io/app/sign-up) (free - no credit card needed)
- [Fly CLI](https://fly.io/docs/hands-on/install-flyctl/)

### Deploy Steps

```bash
# 1. Install Fly CLI
brew install flyctl

# 2. Login
fly auth signup   # or: fly auth login

# 3. Launch the app (first time only)
fly launch --dockerfile Dockerfile
# Say YES to: "Would you like to set up a database?" → NO
# Say YES to: "Do you want to deploy now?" → YES

# 4. Create persistent storage (1GB free)
fly volumes create ytmusic_data --size 1

# 5. Deploy updates (any time after code changes)
fly deploy

# 6. Your app URL will be: https://ytdownload-music.fly.dev
```

### Fly.io Free Tier
- ✅ **3 shared-cpu-1x VMs** with 256MB RAM
- ✅ **3GB persistent volume** 
- ✅ **160GB outbound data/month**
- ✅ Machines auto-start when requests come in (cold start ~2-3 sec)
- ✅ No credit card required

---

## Option 2: Render.com (Easiest, Free Tier)

### Deploy Steps

1. **Push your code to GitHub** (if not already):
   ```bash
   git push origin main
   ```

2. **Go to [dashboard.render.com](https://dashboard.render.com)** → New → Web Service

3. **Connect your GitHub repo** `AndrewZ123/ytdownload`

4. Render will auto-detect the `render.yaml` config

5. Click **Create Web Service**

6. Your app URL will be: `https://ytdownload-music.onrender.com`

### Render Free Tier
- ✅ **750 hours/month** (enough for 1 always-on instance)
- ⚠️ **Spins down after 15 min inactivity** (~30 sec cold start)
- ⚠️ **Ephemeral disk** - downloads lost on restart (use for streaming only)
- ✅ No credit card required

---

## Connect Your iPhone App

After deploying, update your iOS app settings:

1. Open the iOS app
2. Go to **Settings** (gear icon)
3. Change **Server URL** to your cloud URL:
   - Fly.io: `https://ytdownload-music.fly.dev`
   - Render: `https://ytdownload-music.onrender.com`
4. Enter your **API Key** (shown in server logs or `config.json`)

That's it! Your Mac can be completely off. Songs stream directly from the cloud.

---

## How It Works

```
┌──────────────┐         ┌──────────────────┐         ┌──────────┐
│  iPhone App  │ ──────► │  Cloud Server    │ ──────► │ YouTube  │
│  (your hand) │ ◄────── │  (Fly/Render)    │ ◄────── │ /Spotify │
└──────────────┘  stream │  yt-dlp+ffmpeg   │  download│          │
                  or save │  24/7 free tier  │          └──────────┘
└──────────────┘         └──────────────────┘
```

- **Search** → App calls cloud API → cloud searches YouTube → returns results
- **Download** → App sends URL → cloud runs yt-dlp + ffmpeg → stores MP3
- **Play** → App streams audio directly from cloud server
- **Offline** → App downloads MP3 file to iPhone storage

---

## Updating After Code Changes

```bash
# Fly.io
fly deploy

# Render - just push to GitHub
git add . && git commit -m "update" && git push
```

---

## Troubleshooting

### Cold starts too slow? (Render)
- Upgrade to Render Starter ($7/month) for always-on

### Running out of storage? (Fly.io)
- Free volume is 1GB (~200 songs)
- Upgrade: `fly volumes extend ytmusic_data --size 5` ($0.15/GB/month)

### Spotify import not working?
- Ensure Chromium is installed in container (already in Dockerfile)
- Check logs: `fly logs` or Render dashboard