FROM node:20-slim

# Install yt-dlp, ffmpeg, and chromium for Spotify support
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    chromium \
    ca-certificates \
    curl \
    python3 \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use installed Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV CHROME_PATH=/usr/bin/chromium

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app
COPY server.js .
COPY lib/ ./lib/
COPY routes/ ./routes/
COPY public/ ./public/
COPY .env* ./

# Load .env at runtime if present

# Create downloads and data dirs
RUN mkdir -p /app/downloads /app/data

# Expose port
EXPOSE 3000

# Persistent volume for downloads
VOLUME /app/downloads

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:3000/api/settings || exit 1

CMD ["node", "server.js"]