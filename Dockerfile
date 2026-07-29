# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=24.18.0

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json eslint.config.js vitest.config.ts .prettierrc.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tests ./tests
RUN npm run build && npm prune --omit=dev

FROM node:${NODE_VERSION}-bookworm-slim AS runtime-base
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/packages/database/prisma ./packages/database/prisma
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]

FROM runtime-base AS api
EXPOSE 3000
CMD ["node", "dist/apps/api/src/main.js"]

FROM runtime-base AS worker
USER root
ARG YT_DLP_VERSION=2026.06.09
ARG YT_DLP_SHA256=e5d57466682cfa9d61e9cf7c8a4f09b00f4a62af37d3bbdc4bcffdf63615feac
ARG BGUTIL_POT_PLUGIN_URL=https://files.pythonhosted.org/packages/74/5e/c7e388dd92667cb8c1d6ebbef3bd87dd2245a388b6819cbc2bea7c01c1cb/bgutil_ytdlp_pot_provider-1.3.1-py3-none-any.whl
ARG BGUTIL_POT_PLUGIN_SHA256=e62b21f9b2e4479d59af87a8900387c34892e8d7fdb223f266749a90e0be22de
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl gosu python3 \
    && curl --fail --location --silent --show-error \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp" \
      --output /usr/local/bin/yt-dlp \
    && echo "${YT_DLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum --check --strict \
    && chmod 0755 /usr/local/bin/yt-dlp \
    && install -d -m 0755 /etc/yt-dlp/plugins \
    && curl --fail --location --silent --show-error \
      "${BGUTIL_POT_PLUGIN_URL}" \
      --output /etc/yt-dlp/plugins/bgutil-ytdlp-pot-provider.whl \
    && echo "${BGUTIL_POT_PLUGIN_SHA256}  /etc/yt-dlp/plugins/bgutil-ytdlp-pot-provider.whl" \
      | sha256sum --check --strict \
    && chmod 0644 /etc/yt-dlp/plugins/bgutil-ytdlp-pot-provider.whl \
    && yt-dlp --version \
    && ffmpeg -version | head -n 1 \
    && rm -rf /var/lib/apt/lists/*
COPY --chown=root:root infra/worker-entrypoint.sh /usr/local/bin/worker-entrypoint
RUN chmod 0755 /usr/local/bin/worker-entrypoint
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/worker-entrypoint"]
CMD ["node", "dist/apps/worker/src/main.js"]
