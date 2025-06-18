# Use official Node base image
FROM node:20-slim

# Install necessary dependencies for Chrome
RUN apt-get update && apt-get install -y \
  wget \
  ca-certificates \
  fonts-liberation \
  libappindicator3-1 \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdbus-1-3 \
  libgdk-pixbuf2.0-0 \
  libnspr4 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  libgbm1 \                      
  xdg-utils \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package.json files
COPY package*.json ./

# Install Node dependencies (this includes puppeteer and puppeteer-extra)
RUN npm install

# Copy source code
COPY . .

# Expose port (Render uses $PORT)
EXPOSE 3000

# Start the app
CMD ["node", "index.js"]
