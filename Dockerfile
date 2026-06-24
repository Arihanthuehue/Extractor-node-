FROM node:20-slim

# Install system dependencies including ffmpeg, curl, and unzip (needed for Deno installer)
# refresh
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    git \
    unzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp standalone Linux binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

RUN mkdir -p /app/yt-dlp-plugins \
    && curl -L https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/latest/download/bgutil-ytdlp-pot-provider.zip \
       -o /app/yt-dlp-plugins/bgutil-ytdlp-pot-provider.zip

RUN git clone --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil-ytdlp-pot-provider \
    && cd /opt/bgutil-ytdlp-pot-provider/server \
    && npm ci \
    && npx tsc

# Install Deno
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

# Add Deno to path
ENV PATH="/usr/local/bin:${PATH}"

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --only=production

# Copy application source
COPY . .

EXPOSE 8000

CMD ["node", "server.js"]
