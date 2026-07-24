# ---------- BUILD STAGE ----------
FROM node:22-alpine AS builder

WORKDIR /app

# Puppeteer's bundled Chromium is a glibc binary that can't run on Alpine
# (musl), and we never launch a browser in the build stage anyway. Skip the
# ~150MB download during `npm ci` in both stages; the production stage uses the
# apk-installed system Chromium instead (see below).
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Only install deps first (cache friendly)
COPY package*.json ./
RUN npm ci

# Copy source
COPY . .

# Generate prisma + build
RUN npx prisma generate
RUN npm run build


# ---------- PRODUCTION STAGE ----------
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

# --- Puppeteer / Chromium (Reports module, aexa-frontend#94) ---
# Report PDFs are rendered with headless Chromium via Puppeteer. On Alpine we
# must use the system Chromium (apk) rather than Puppeteer's bundled one, and
# point Puppeteer at it via PUPPETEER_EXECUTABLE_PATH. The extra packages
# (nss/freetype/harfbuzz/ttf-freefont/ca-certificates) are Chromium's runtime
# font/cert dependencies. This is a genuine new production system requirement
# introduced by this feature.
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Only install production deps
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy Prisma generated client + schema
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/prisma ./prisma

# Copy built app
COPY --from=builder /app/dist ./dist

# Uploads folder
RUN mkdir -p /app/uploads

EXPOSE 5002

CMD ["node", "dist/server.js"]
