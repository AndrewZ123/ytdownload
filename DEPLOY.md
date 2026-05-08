# 🚀 Cloud Deployment Guide

## ⚡ Quick Deploy Reference

**Server IP**: `157.151.254.26`  
**SSH Key**: `~/.oci/instance_ssh_key`  
**SSH User**: `ubuntu`  
**App Path**: `/opt/ytmusic`  
**Service**: `ytmusic` (systemd)  
**Port**: `3000`

### SSH into the server
```bash
ssh -i ~/.oci/instance_ssh_key ubuntu@157.151.254.26
```

### Deploy latest code (one command from your Mac)
```bash
# Push to GitHub first, then:
ssh -i ~/.oci/instance_ssh_key ubuntu@157.151.254.26 \
  "cd /opt/ytmusic && sudo git pull && sudo docker build -t ytmusic . && sudo systemctl restart ytmusic"
```

### Check server status
```bash
ssh -i ~/.oci/instance_ssh_key ubuntu@157.151.254.26 \
  "sudo systemctl status ytmusic && curl -s http://localhost:3000/api/health"
```

### View live logs
```bash
ssh -i ~/.oci/instance_ssh_key ubuntu@157.151.254.26 \
  "sudo journalctl -u ytmusic -f"
```

### iPhone App Connection
The app has the server URL **hardcoded** (`http://157.151.254.26:3000`). No settings needed — it auto-connects and fetches the API key from `/api/health`.

---

## Oracle Cloud Free Tier Details

- **200 GB block storage** — ~40,000+ songs
- **VM.Standard.E2.1.Micro** (AMD, 1 vCPU, 1GB RAM)
- **10 TB outbound data/month**
- **Always on** — never spins down
- No credit card charges — permanent free tier

---

## Initial Setup (already done)

### Open Port 3000
1. **Networking → Virtual Cloud Networks → your VCN → Security Lists**
2. **Add Ingress Rules**: Source CIDR `0.0.0.0/0`, Port `3000`, Protocol TCP

### Server Setup (already done via oracle-cloud-setup.sh)
```bash
# Was run on the server during initial setup:
sudo git clone https://github.com/AndrewZ123/ytdownload.git /opt/ytmusic
cd /opt/ytmusic && chmod +x oracle-cloud-setup.sh && ./oracle-cloud-setup.sh
```

This creates:
- Docker image `ytmusic` from `/opt/ytmusic/Dockerfile`
- Systemd service `/etc/systemd/system/ytmusic.service`
- Persistent data at `/opt/ytmusic-data`

---

## Useful Server Commands

```bash
# Check if running
sudo systemctl status ytmusic

# Restart
sudo systemctl restart ytmusic

# Live logs
sudo journalctl -u ytmusic -f

# Shell inside Docker container
sudo docker exec -it ytmusic bash

# Check disk usage
df -h /opt/ytmusic-data

# Check memory
free -h
```

---

## Architecture

```
┌──────────────┐         ┌──────────────────┐         ┌──────────┐
│  iPhone App  │ ──────► │  Oracle Cloud VM │ ──────► │ YouTube  │
│  (Melodia)   │ ◄────── │  157.151.254.26  │ ◄────── │  API     │
│  hardcoded   │  stream │  Ubuntu + Docker │  search │          │
│  connection  │  or save│  yt-dlp+ffmpeg   │         └──────────┘
└──────────────┘         │  200GB storage   │
                         └──────────────────┘