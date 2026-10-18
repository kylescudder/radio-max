ARG BUN_IMAGE=oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
FROM ${BUN_IMAGE} AS build
WORKDIR /build/server
COPY server/package.json server/bun.lock ./
RUN bun install --frozen-lockfile
COPY server/src ./src
COPY server/tsconfig.json server/stations.json ./
COPY deploy/verify.ts /build/deploy/verify.ts
RUN bun run typecheck
WORKDIR /build/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/src ./src
COPY web/index.html web/tsconfig.json web/vite.config.ts ./
ARG DASHBOARD_LABEL="Herman"
ENV VITE_HOSTING_LABEL=${DASHBOARD_LABEL}
RUN bun run build

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
