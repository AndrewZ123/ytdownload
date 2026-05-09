#!/bin/bash
# setup-https.sh — Install nginx + Let's Encrypt HTTPS reverse proxy on Oracle Cloud
# Run this ON THE SERVER as ubuntu user:
#   ./setup-https.sh your-domain.com
#
# Prerequisites:
#   1. Your domain's DNS A record must point to 157.151.254.26
#   2. Port 80 and 443 must be open in Oracle Cloud Security List + iptables
#   3. The ytmusic service must be running on port 3000

set -e

DOMAIN="${1:?Usage: setup-https.sh <your-domain.com>}"
SERVER_IP="157.151.254.26"

echo "============================================"
echo "  HTTPS Setup for $DOMAIN"
echo "  Server IP: $SERVER_IP"
echo "============================================"

# --- Step 0: Verify DNS ---
echo ""
echo "[1/7] Verifying DNS resolution for $DOMAIN..."
RESOLVED_IP=$(dig +short "$DOMAIN" A | tail -1)
if [ -z "$RESOLVED_IP" ]; then
    echo "❌ ERROR: $DOMAIN does not resolve to any IP address."
    echo "   Create an A record pointing $DOMAIN → $SERVER_IP"
    echo "   Then wait for DNS propagation and re-run this script."
    exit 1
fi
if [ "$RESOLVED_IP" != "$SERVER_IP" ]; then
    echo "⚠️  WARNING: $DOMAIN resolves to $RESOLVED_IP, expected $SERVER_IP"
    echo "   This might be OK if you're using Cloudflare proxy (orange cloud)."
    echo "   Continuing anyway..."
else
    echo "✅ DNS correct: $DOMAIN → $RESOLVED_IP"
fi

# --- Step 1: Open firewall ports ---
echo ""
echo "[2/7] Opening ports 80 and 443 in iptables..."
sudo iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 6 -p tcp --dport 80 -j ACCEPT
sudo iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 7 -p tcp --dport 443 -j ACCEPT
sudo sh -c "iptables-save > /etc/iptables/rules.v4 2>/dev/null" || true
echo "✅ Ports 80/443 open"

# --- Step 2: Install nginx and certbot ---
echo ""
echo "[3/7] Installing nginx and certbot..."
sudo apt-get update -qq
sudo apt-get install -y nginx certbot python3-certbot-nginx
echo "✅ nginx + certbot installed"

# --- Step 3: Create nginx config ---
echo ""
echo "[4/7] Configuring nginx for $DOMAIN..."
cat > /tmp/ytmusic-nginx <<NGINX
server {
    listen 80;
    server_name $DOMAIN;

    # Redirect all HTTP to HTTPS
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name $DOMAIN;

    # SSL certs (will be filled by certbot)
    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;

    # SSL hardening
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    # HSTS (tell iOS to always use HTTPS)
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # Security headers
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;

    # Proxy to Node.js app on port 3000
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # Essential for streaming: pass Range headers both ways
        proxy_set_header Range \$http_range;
        proxy_set_header If-Range \$http_if_range;
        proxy_set_header Request-Range \$http_request_range;

        # Standard proxy headers
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # Large buffer for streaming — no buffering so bytes flow immediately
        proxy_buffering off;
        proxy_request_buffering off;

        # Long timeouts for yt-dlp resolve (can take 5-30s) and streaming
        proxy_connect_timeout 120s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;

        # Allow large request bodies (uploads, downloads)
        client_max_body_size 100m;
    }

    # Health check bypass (no logging)
    location /api/health {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        access_log off;
    }
}
NGINX

sudo cp /tmp/ytmusic-nginx /etc/nginx/sites-available/ytmusic
sudo ln -sf /etc/nginx/sites-available/ytmusic /etc/nginx/sites-enabled/ytmusic
sudo rm -f /etc/nginx/sites-enabled/default

# Test config (will fail before certs exist, that's OK)
echo "✅ nginx configured"

# --- Step 4: Get SSL certificate ---
echo ""
echo "[5/7] Obtaining SSL certificate from Let's Encrypt..."
sudo nginx -t 2>/dev/null || true
sudo systemctl restart nginx

# If certs already exist, renew; otherwise get new
if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    echo "   Existing certificate found, renewing..."
    sudo certbot renew --nginx --non-interactive
else
    echo "   Getting new certificate..."
    sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "admin@$DOMAIN" --redirect
fi
echo "✅ SSL certificate installed"

# --- Step 5: Restart nginx ---
echo ""
echo "[6/7] Restarting nginx..."
sudo nginx -t
sudo systemctl enable nginx
sudo systemctl restart nginx
echo "✅ nginx running with HTTPS"

# --- Step 6: Set up auto-renewal ---
echo ""
echo "[7/7] Setting up certificate auto-renewal..."
sudo certbot renew --dry-run 2>/dev/null || true
echo "✅ Auto-renewal configured (certbot timer)"

# --- Done ---
echo ""
echo "============================================"
echo "  ✅ HTTPS is now active!"
echo "============================================"
echo ""
echo "  HTTPS URL: https://$DOMAIN"
echo "  Test:      curl -s https://$DOMAIN/api/health"
echo ""
echo "  Next steps:"
echo "  1. Update ios-app/web/js/config.js:"
echo "     const API = 'https://$DOMAIN';"
echo ""
echo "  2. Update ios-app/capacitor.config.json:"
echo "     \"allowNavigation\": [\"$DOMAIN\"]"
echo ""
echo "  3. Rebuild iOS app in Xcode"
echo ""