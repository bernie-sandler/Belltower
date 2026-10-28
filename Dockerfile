# syntax=docker/dockerfile:1

# ---- build: compile the web UI and bundle the server ----
FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
# --ignore-scripts: no dependency needs one (better-sqlite3 ships prebuilt binaries), and without it
# `npm ci` falls back to compiling better-sqlite3 with node-gyp, which needs python and a compiler.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build

# ---- deps: production node_modules only (the server's runtime dependencies) ----
FROM node:26-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---- runtime ----
FROM node:26-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    TZ=America/Chicago \
    DATA_DIR=/data \
    PUID=99 \
    PGID=100 \
    UMASK=0002
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && chmod 755 /usr/local/bin/entrypoint.sh

VOLUME ["/data"]
EXPOSE 8080
# No curl in the image; Node's fetch does the job. 127.0.0.1 (not localhost) avoids ::1 surprises.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
