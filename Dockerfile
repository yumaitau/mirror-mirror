FROM node:24.18.0-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24.18.0-bookworm-slim AS builder

WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24.18.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

RUN apt-get update \
    && apt-get install --yes --no-install-recommends git git-lfs ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=oven/bun:1.4.0-debian /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/worker ./worker
COPY --from=builder --chown=node:node /app/lib ./lib
COPY --from=builder --chown=node:node /app/scripts/git-askpass.sh ./scripts/git-askpass.sh
RUN chmod 0555 /usr/local/bin/bun \
    && chmod 0555 /app/scripts/git-askpass.sh

EXPOSE 3000

ENTRYPOINT ["sh", "-c", "chown node:node /data && chmod u+rwx /data && if [ -L /data/mirrors ]; then echo 'Refusing symbolic link at /data/mirrors.' >&2; exit 1; fi && mkdir -p /data/mirrors && if [ ! -d /data/mirrors ] || [ -L /data/mirrors ]; then echo 'Mirror path must be a directory.' >&2; exit 1; fi && chown -h node:node /data/mirrors && setpriv --reuid=node --regid=node --init-groups -- chmod u+rwx /data/mirrors && exec setpriv --reuid=node --regid=node --init-groups -- \"$@\"", "--"]
CMD ["sh", "-c", "bun --bun worker/index.ts --check-config && exec node server.js"]
