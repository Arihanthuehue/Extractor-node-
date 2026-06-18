FROM node:20-slim

# Install system dependencies including ffmpeg, curl, and unzip (needed for Deno installer)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    unzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp standalone Linux binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

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
