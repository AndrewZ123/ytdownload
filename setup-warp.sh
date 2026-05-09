#!/bin/bash
# ============================================================
# Cloudflare WARP Setup for Oracle Cloud / Ubuntu
# Provides SOCKS5 proxy on 127.0.0.1:40000 for yt-dlp YouTube access
# Also creates a systemd service so WARP starts on boot
# ============================================================
set -e

echo "🔧 Setting up Cloudflare WARP proxy..."

# 1. Install Cloudflare WARP
if ! command -v warp-cli &> /dev/null; then
  echo "📦 Installing Cloudflare WARP..."
  curl -fsSL https://pkg.cloudflareclient.com/install.sh | sudo bash
else
  echo "✅ warp-cli already installed"
fi

# 2. Create systemd service for warp-svc (the WARP daemon)
if [ ! -f /etc/systemd/system/warp-svc.service ]; then
  echo "📝 Creating systemd service for WARP daemon..."
  sudo tee /etc/systemd/system/warp-svc.service > /dev/null << 'EOF'
[Unit]
Description=Cloudflare WARP Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/warp-svc
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable warp-svc
fi

# 3. Start the WARP daemon
echo "🔌 Starting WARP daemon..."
sudo systemctl start warp-svc || true
sleep 2

# 4. Register if not already registered
if ! warp-cli --accept-tos status 2>/dev/null | grep -qi "connected\|registration"; then
  echo "📝 Registering WARP..."
  warp-cli --accept-tos registration new 2>/dev/null || true
fi

# 5. Configure SOCKS5 proxy mode (proxy-only, doesn't change system routing)
echo "🌐 Setting WARP to proxy mode..."
warp-cli --accept-tos mode proxy 2>/dev/null || true

# 6. Connect
echo "🔌 Connecting WARP..."
warp-cli --accept-tos connect 2>/dev/null || true

# 7. Wait for connection
echo "⏳ Waiting for WARP to connect..."
for i in $(seq 1 20); do
  if curl -x socks5://127.0.0.1:40000 --connect-timeout 3 -s -o /dev/null https://www.youtube.com 2>/dev/null; then
    echo ""
    echo "✅ WARP SOCKS5 proxy is working on 127.0.0.1:40000!"
    echo ""
    echo "yt-dlp will now route YouTube requests through Cloudflare WARP."
    echo "The ytmusic Docker container uses --network host so it can access the proxy."
    echo ""
    echo "WARP status: warp-cli status"
    echo "Restart server: sudo systemctl restart ytmusic"
    exit 0
  fi
  echo "  Attempt $i/20..."
  sleep 3
done

echo ""
echo "⚠️  WARP proxy didn't respond on port 40000 after 60s"
echo "   Check daemon: sudo systemctl status warp-svc"
echo "   Check WARP:   warp-cli status"
echo "   Try:          warp-cli disconnect && warp-cli connect"
echo "   Logs:         sudo journalctl -u warp-svc -f"
exit 1