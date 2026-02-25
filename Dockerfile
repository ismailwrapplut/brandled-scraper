# ============================================
# Brandled Scraper — Production Dockerfile
# Playwright + Chromium for headless scraping
# ============================================

FROM node:20-slim

# Install system dependencies required by Playwright Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxshmfence1 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first (Docker layer caching)
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci --omit=dev

# Install only Chromium browser for Playwright (saves ~400MB vs all browsers)
RUN npx playwright install chromium

# Copy application code
COPY . .

# Create data output directory
RUN mkdir -p data/output

# Expose the API server port
EXPOSE 3001

# Health check for Render
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/health || exit 1

# Start the API server
CMD ["node", "server.js"]
