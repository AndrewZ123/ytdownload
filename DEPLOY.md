# 🚀 Cloud Deployment Guide

Deploy your YouTube Music Downloader to the cloud so your iPhone app works **without your Mac being on** — completely free.

---

## 🏆 Option 1: Oracle Cloud Free Tier (Recommended - 200GB Storage)

### What You Get (ALWAYS FREE, forever)
- **200 GB block storage** — ~40,000+ songs
- **ARM Ampere A1**: Up to 4 VMs, 24GB RAM total (or AMD: 1 vCPU, 1GB RAM)
- **10 TB outbound data/month**
- **Always on** — never spins down
- No credit card charges — it's a permanent free tier, not a trial

### Step 1: Create Oracle Cloud Account
1. Go to [cloud.oracle.com/free](https://cloud.oracle.com/free)
2. Sign up (requires phone + credit card for verification, but **never charged**)
3. Wait for account activation (usually instant, sometimes takes a few hours)

### Step 2: Create a VM Instance
1. Go to **Compute → Instances → Create Instance**
2. **Image**: Ubuntu 22.04 (Canonical)
3. **Shape**: 
   - For best performance: **Ampere A1** (ARM, 1 OCPU, 6GB RAM) — free forever
   - Alternative: **VM.Standard.E2.1.Micro** (AMD, 1 vCPU, 1GB RAM) — also free
4. **Networking**: Create new VCN with default settings, ensure **public IP** is assigned
5. **SSH Key**: Upload your public key or download the generated one
6. **Boot volume**: Set to **50 GB** (free, up to 200GB total across volumes)
7. Click **Create**

### Step 3: Open Port 3000
1. Go to **Networking → Virtual Cloud Networks → your VCN**
2. Click **Security Lists** → Default Security List
3. Click **Add Ingress Rules**:
   - Source CIDR: `0.0.0.0/0`
   - Destination Port: `3000`
   - Protocol: TCP
4. Click **Add**

### Step 4: SSH In and Run Setup
```bash
# SSH into your VM (use the public IP from the instance page)
ssh -i /path/to/ssh-key ubuntu@YOUR_VM_PUBLIC_IP

# Download and run the one-click setup script
curl -fsSL https://raw.githubusercontent.com/AndrewZ123/ytdownload/main/oracle-cloud-setup.sh | bash
```

Or run it manually:
```bash
# Clone the repo
sudo git clone https://github.com/AndrewZ123/ytdownload.git /opt/ytmusic
cd /opt/ytmusic

# Run the setup script
chmod +x oracle-cloud-setup.sh
./oracle-cloud-setup.sh
```

### Step 5: Connect Your iPhone App
1. Find your VM's public IP in the Oracle Cloud console
2. Open your iPhone app → Settings
3. Server URL: `http://YOUR_VM_PUBLIC_IP:3000`
4. Enter your API Key

**That's it.** Your Mac can be off. Songs are stored on the 200GB Oracle disk.

### Storage Management
```bash
# Check storage usage
df -h /opt/ytmusic-data

# Your songs are in:
ls /opt/ytmusic-data/

# To add more storage (up to 200GB free):
# 1. Go to Oracle Cloud → Block Storage → Create Volume
# 2. Attach it to your VM
# 3. Mount it to /opt/ytmusic-data
```

### Updating the App
```bash
cd /opt/ytmusic
sudo git pull
sudo docker build -t ytmusic .
sudo systemctl restart ytmusic
```

### Useful Commands
```bash
sudo systemctl status ytmusic    # Check if running
sudo systemctl restart ytmusic   # Restart
sudo journalctl -u ytmusic -f    # Live logs
sudo docker exec -it ytmusic bash # Shell inside container
```

---

## Option 2: Render.com (Easiest, Limited Storage)

> ⚠️ Ephemeral disk — downloads lost on restart. Best for testing only.

1. Push code to GitHub
2. Go to [dashboard.render.com](https://dashboard.render.com) → New → Web Service
3. Connect your repo — Render auto-detects `render.yaml`
4. Your URL: `https://ytdownload-music.onrender.com`

---

## Comparison

| Feature | Oracle Cloud | Fly.io | Render |
|---------|-------------|--------|--------|
| **Storage** | **200 GB** | 3 GB | Ephemeral |
| **Songs** | **~40,000+** | ~600 | Lost on restart |
| **Always On** | ✅ Yes | ✅ Auto-start | ❌ Spins down |
| **RAM** | Up to 24GB | 256MB | 512MB |
| **Bandwidth** | 10 TB/mo | 160 GB/mo | 100 GB/mo |
| **Cost** | **Free forever** | Free tier | Free tier |
| **Setup** | 10 min | 5 min | 2 min |

**Oracle Cloud is the clear winner** — 200GB of permanent storage, always on, powerful ARM processors, and completely free.

---

## Architecture

```
┌──────────────┐         ┌──────────────────┐         ┌──────────┐
│  iPhone App  │ ──────► │  Oracle Cloud VM │ ──────► │ YouTube  │
│  (your hand) │ ◄────── │  Ubuntu + Docker │ ◄────── │ /Spotify │
└──────────────┘  stream │  yt-dlp+ffmpeg   │  download│          │
                  or save │  200GB storage   │          └──────────┘
└──────────────┘         └──────────────────┘