#!/bin/bash
# ============================================
# Quick deploy — pull latest code & restart
# Usage: ssh root@YOUR_IP "bash /home/scraper/brandled-scraper/deploy/update.sh"
# ============================================

set -e

APP_DIR="/home/scraper/brandled-scraper"
cd "$APP_DIR"

echo "Pulling latest code..."
sudo -u scraper git pull

echo "Installing dependencies..."
sudo -u scraper npm ci --omit=dev

echo "Restarting service..."
systemctl restart brandled-scraper

echo "✅ Deployed! Checking status..."
sleep 2
systemctl status brandled-scraper --no-pager
