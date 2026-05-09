#!/bin/bash
# ============================================================
# YouTube Music Downloader - Oracle Cloud Free Tier Setup
# Run this on your Oracle Cloud Ubuntu VM after SSH-ing in
# ============================================================
# Oracle Cloud Free Tier gives you:
#   - 1 AMD VM (1 vCPU, 1GB RAM) + 200GB block storage  OR
#   - Up to 4 ARM Ampere VMs (24GB RAM total) + 200GB block storage
#   - 10 TB outbound data/month
#   - ALWAYS FREE - no charges ever
# ============================================================

set -e

echo "🎵 YouTube Music Downloader - Oracle Cloud Setup"
echo "================================================"

# 1. Update system
echo ""
echo "📦 Updating system..."
sudo apt-get update && sudo apt-get upgrade -y

# 2. Install Docker
echo ""
echo "🐳 Installing Docker..."
sudo apt-get install -y \
    ca-certificates curl gnupg lsb-release git

sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null || true

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
$(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker $USER

echo "✅ Docker installed"

# 3. Create app directory and download files
echo ""
echo "📥 Downloading app..."
sudo mkdir -p /opt/ytmusic
cd /opt/ytmusic

# Clone from GitHub
sudo git clone https://github.com/AndrewZ123/ytdownload.git .

# 4. Build and run with Docker
echo ""
echo "🔨 Building Docker image (this takes a few minutes)..."
sudo docker build -t ytmusic .

# 5. Create persistent data directory
sudo mkdir -p /opt/ytmusic-data

# 5b. Create .env file for secrets (API keys etc - NOT in git)
if [ ! -f /opt/ytmusic/.env ]; then
  sudo tee /opt/ytmusic/.env > /dev/null << 'ENVEOF'
# YouTube Data API key (get from https://console.cloud.google.com/apis/credentials)
YT_API_KEY=REPLACE_WITH_YOUR_KEY
ENVEOF
  echo "⚠️  Edit /opt/ytmusic/.env and add your YouTube API key!"
fi

# 6. Open port 3000 in iptables (Oracle Cloud Ubuntu blocks it by default!)
echo ""
echo "🔓 Opening port 3000 in iptables (Oracle Cloud requires this)..."
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3000 -j ACCEPT
sudo apt-get install -y iptables-persistent
sudo netfilter-persistent save
echo "✅ Port 3000 opened"

# 7. Create systemd service so it starts on boot
echo ""
echo "🔧 Setting up auto-start service..."
sudo tee /etc/systemd/system/ytmusic.service > /dev/null << 'EOF'
[Unit]
Description=YouTube Music Downloader
After=docker.service
Requires=docker.service

[Service]
Type=simple
Restart=always
RestartSec=5
ExecStart=/usr/bin/docker run --name ytmusic --rm --network host -v /opt/ytmusic-data:/app/downloads -v /opt/ytmusic/.env:/app/.env:ro ytmusic
ExecStop=/usr/bin/docker stop ytmusic

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable ytmusic
sudo systemctl start ytmusic

echo ""
echo "✅ Setup complete!"
echo ""
echo "Your server is running at: http://$(curl -s ifconfig.me):3000"
echo ""
echo "📱 Point your iPhone app to that URL"
echo ""
echo "📝 Useful commands:"
echo "   sudo systemctl status ytmusic   # Check if running"
echo "   sudo systemctl restart ytmusic  # Restart after updates"
echo "   sudo journalctl -u ytmusic -f   # View live logs"
echo "   df -h /opt/ytmusic-data         # Check storage usage"
echo ""
echo "🔄 To update the app:"
echo "   cd /opt/ytmusic && sudo git pull"
echo "   sudo docker build -t ytmusic ."
echo "   sudo systemctl restart ytmusic"