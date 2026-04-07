# ── Stage: Production ────────────────────────────────────────────
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files first (better layer caching)
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy source files
COPY server.js ./
COPY imagemodel.html ./

# App runs on port 4000
EXPOSE 4000

# Start the server
CMD ["node", "server.js"]
