ARG BUN_IMAGE=oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
FROM ${BUN_IMAGE} AS build
WORKDIR /build
ENV HUSKY=0 ASTRO_TELEMETRY_DISABLED=1
COPY package.json bun.lock ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN BUN_CONFIG_MAX_HTTP_REQUESTS=16 bun install --frozen-lockfile
COPY server/src ./server/src
COPY server/tsconfig.json server/stations.json ./server/
COPY server/test ./server/test
COPY deploy/verify.ts ./deploy/verify.ts
COPY web/src ./web/src
COPY web/astro.config.mjs web/tsconfig.json ./web/
ARG DASHBOARD_LABEL="Self-hosted"
ENV PUBLIC_HOSTING_LABEL=${DASHBOARD_LABEL}
RUN bun run typecheck && bun run test && bun run build

FROM ${BUN_IMAGE} AS runtime
WORKDIR /app/server
ARG RADIO_MAX_REVISION=development
LABEL org.opencontainers.image.source="https://github.com/kylescudder/radio-max" \
      org.opencontainers.image.revision="${RADIO_MAX_REVISION}"
ENV NODE_ENV=production PORT=8080 WEB_ROOT=/app/web \
    RADIO_MAX_REVISION=${RADIO_MAX_REVISION}
COPY --from=build --chown=bun:bun /build/server/src ./src
COPY --from=build --chown=bun:bun /build/server/stations.json ./
COPY --from=build --chown=bun:bun /build/web/dist /app/web
COPY --chown=bun:bun server/audio ./audio
COPY --chown=bun:bun deploy/verify.ts /app/deploy/verify.ts
USER bun
EXPOSE 8080
CMD ["bun", "src/server.ts"]
