# syntax=docker/dockerfile:1

# ---- build ----------------------------------------------------------------
# Pinned to the build platform so the Angular build always runs natively, even
# when producing arm64 images. Only the tiny runtime stage is emulated.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build:prod

# ---- runtime --------------------------------------------------------------
FROM node:22-alpine AS runtime

# openssl generates the self-signed certificate on first start; tini reaps
# zombies and forwards signals so `docker stop` is not a 10s wait.
RUN apk add --no-cache openssl tini

ENV NODE_ENV=production \
    PORT=8443 \
    CERT_DIR=/data/certs

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

COPY server ./server
COPY --from=build /app/dist/vidaa-edge/browser ./dist/vidaa-edge/browser

# The API server writes scan sessions and exported files next to itself, so
# those paths are symlinked into /data - one volume keeps everything that must
# survive a container replacement, without patching the server.
RUN mkdir -p /data/certs /data/scan-data /data/public \
    && ln -s /data/scan-data /app/scan-data \
    && ln -s /data/public /app/public \
    && chown -R node:node /data /app

USER node
EXPOSE 8443
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-check-certificate -q -O /dev/null https://127.0.0.1:${PORT}/ || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/serve.js"]
