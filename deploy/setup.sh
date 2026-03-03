#!/bin/bash
# ============================================
# Brandled Scraper — DigitalOcean Droplet Setup
# Run this ONCE on a fresh Ubuntu 22.04/24.04 droplet
# Usage: ssh root@YOUR_IP "bash -s" < deploy/setup.sh
# ============================================

set -e

echo "=== Brandled Scraper — Droplet Setup ==="

# 1. System updates
echo "[1/7] Updating system..."
apt-get update && apt-get upgrade -y

# 2. Install Node.js 20
echo "[2/7] Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# 3. Install Playwright system dependencies
echo "[3/7] Installing Chromium dependencies..."
apt-get install -y --no-install-recommends \
    wget ca-certificates fonts-liberation \
    libasound2t64 libatk-bridge2.0-0 libatk1.0-0 \
    libcups2t64 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0t64 \
    libnspr4 libnss3 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libxshmfence1 xdg-utils git

# 4. Create app user (non-root)
echo "[4/7] Creating app user..."
id -u scraper &>/dev/null || useradd -m -s /bin/bash scraper

# 5. Clone repo
echo "[5/7] Cloning repository..."
APP_DIR="/home/scraper/brandled-scraper"
if [ -d "$APP_DIR" ]; then
    echo "  App directory exists, pulling latest..."
    cd "$APP_DIR" && sudo -u scraper git pull
else
    sudo -u scraper git clone https://github.com/ismailwrapplut/brandled-scraper.git "$APP_DIR"
    cd "$APP_DIR"
fi

# 6. Install dependencies + Playwright Chromium
echo "[6/7] Installing npm dependencies..."
cd "$APP_DIR"
sudo -u scraper npm ci --omit=dev
sudo -u scraper npx playwright install chromium

# 7. Create .env template
echo "[7/7] Setting up environment..."
if [ ! -f "$APP_DIR/.env" ]; then
    cat > "$APP_DIR/.env" << 'ENVEOF'
# === Azure OpenAI ===
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_API_VERSION=2024-04-01-preview
AZURE_EMBEDDING_DEPLOYMENT=text-embedding-3-small
AZURE_CLASSIFIER_DEPLOYMENT=gpt-5-mini

# === Pinecone ===
PINECONE_API_KEY=
PINECONE_INDEX_NAME=brandled-knowledge

# === X/Twitter ===
# Legacy browser-based scraper credentials (no longer needed with x-api-client)
TWITTER_SCRAPER_USERNAME=
TWITTER_SCRAPER_PASSWORD=
TWITTER_SCRAPER_EMAIL=
# Direct API credentials (get from x.com DevTools → Application → Cookies)
TWITTER_AUTH_TOKEN=
TWITTER_CT0=

# === LinkedIn ===
LINKEDIN_LI_AT_COOKIE=
LINKEDIN_JSESSIONID=

# === Server ===
SCRAPER_PORT=3001
SCRAPER_API_SECRET=brandled-scraper-secret
NODE_ENV=production
ENVEOF
    chown scraper:scraper "$APP_DIR/.env"
    echo ""
    echo "⚠️  IMPORTANT: Edit /home/scraper/brandled-scraper/.env with your actual values!"
    echo "   nano /home/scraper/brandled-scraper/.env"
fi

# 8. Install systemd service
echo "Installing systemd service..."
cp "$APP_DIR/deploy/brandled-scraper.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable brandled-scraper

echo ""
echo "============================================"
echo "✅ Setup complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Edit the .env file:    nano /home/scraper/brandled-scraper/.env"
echo "  2. Start the service:     systemctl start brandled-scraper"
echo "  3. Check status:          systemctl status brandled-scraper"
echo "  4. View logs:             journalctl -u brandled-scraper -f"
echo ""
