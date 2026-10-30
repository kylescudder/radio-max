# RadioMax on the host

## Shared deployment service

This app is registered as `radio-max` in the central deployment registry
`/Users/kyle/platform/deploy-core/apps.json`. LaunchAgent
`com.kylescudder.deploy-core` runs the single installed engine. Application hooks
are `deploy/hooks.py`; the receiver, credentials, queues,
state and database contracts below remain app-specific. Manual deployment uses
`./deploy/host-deploy.sh sha256:<digest>`.

Engine updates, application registration, failure inspection and service rollback
are documented in [deploy-core](https://github.com/kylescudder/deploy-core).
There are no vendored engine files, lock files or sync PRs. Do not install an
app-specific LaunchAgent. Apply future engine changes once through the central service.

Checkout: `/Users/kyle/platform/apps/radio-max`, branch `main`.
The Bun container serves the built Astro dashboard, WebSocket/state API and
continuous MP3 broadcaster on `radio-max:8080` inside external `platform-web`.
It follows the host's non-root, read-only filesystem, no host ports, bounded logs,
resource limits and restart policy. There is no database. The packaged MP3 loops
continuously at 128 kbps MPEG-1 Layer III, 48 kHz; the ICY headers match it.

## Deployer

Application-specific behavior is in `hooks.py`; deployment definitions are central.

## Public routing

The production dashboard is `https://radio-max.kylescudder.co.uk`:
Cloudflare Tunnel → shared host Caddy → `radio-max:8080`.
The dashboard uses same-origin WebSockets and its exact HTTPS origin is the
configured `DASHBOARD_ORIGIN`. The container shows a small `the host` badge.
The temporary preview hostname has been removed through the platform hostname tool.
The old Netlify fallback has been retired: `netlify.toml` is gone and the
production DNS no longer points to Netlify.

Public audio is `http://radio-max-audio.kylescudder.co.uk/radio/main`; HTTPS
works on the same hostname. It is a one-level name so Cloudflare's free
certificate covers it (two-level names such as `api.radio-max` are not covered).
Plain HTTP is served without redirects or login for ETS2:

```text
HTTP/HTTPS client
  → Cloudflare (proxied DNS) → Cloudflare Tunnel → shared host Caddy
  → radio-max-public-relay:8080 (deploy/compose.public-relay.yaml)
  → radio-max:8080
```

The relay is pinned Caddy 2.11.7 on `platform-web` only, with no host ports, a
read-only filesystem and dropped capabilities. It exposes only `/radio/main` and
`/healthz` (GET/HEAD/OPTIONS; everything else is 404/405), sends `Host: radio-max`,
injects the origin token and passes Cloudflare's `Cf-Connecting-IP` as
`X-Radio-Max-Client-IP`. Cloudflare rejects client-supplied `Cf-Connecting-IP`;
a request without it reaches the origin with no identity and gets 403.
`STREAM_HOSTS=localhost,127.0.0.1,radio-max` allows only private origin hostnames
to stream, so `/radio/*` on the dashboard hostname returns 404, including spoofed
forwarded hosts. `PUBLIC_URL` advertises the public audio origin. Start or
recreate the relay from the checkout root:

```sh
docker compose -f deploy/compose.public-relay.yaml --env-file .env up -d --wait
```

Audio crosses Cloudflare's CDN proxy. Its CDN terms allow it to limit
non-Enterprise zones that serve a disproportionate share of audio; this is one
128 kbps station capped at 32 listeners. Until 30 October 2026 audio went through
a DNS-only `api.radio-max` record and a relay on an older Linux server; that
server, its relay and the `api.radio-max` hostname are retired.

ETS2's six fields are URL, name, genre, language, bitrate and favorite:

```text
stream_data[]: "http://radio-max-audio.kylescudder.co.uk/radio/main|RadioMax|Gaming Music|EN|128|1"
```

## Private Tailscale origin

`deploy/compose.origin.yaml` runs a Tailscale sidecar enrolled as
`radio-max-origin` (`100.78.227.72`). It is not in the public audio path; it
remains for a possible Tailscale Funnel ingress. It has no host ports, TUN device
or Docker socket, and runs with userspace networking as UID/GID 501:20, a
read-only filesystem, dropped capabilities and memory/CPU limits.
`deploy/tailscale-serve.json` forwards TCP 8080 only to the private app alias.

```sh
docker compose -f deploy/compose.origin.yaml config --quiet
docker compose -f deploy/compose.origin.yaml up -d --wait --wait-timeout 90
```

Its persisted identity is under protected `secrets/tailscale/`; restore that
rather than registering a duplicate node, and never print state.

## Stream admission and relay hardening

Defaults are 32 simultaneous players in total, four per public IP, and a per-IP
reconnect token bucket with 12 initial attempts and 12 replenished per minute.
Excess per-IP requests return 429; total capacity returns 503. Both include
`Retry-After`. Active players are not interrupted by someone else's rejected
connection. NAT users share a public-IP quota; adjust deliberately for larger
groups using `STREAM_MAX_LISTENERS`, `STREAM_MAX_PER_IP` and
`STREAM_CONNECTS_PER_MINUTE`. Client bookkeeping is bounded to 4096 recent IPs;
idle records expire after five minutes. Disconnects and server-side slow-player
eviction return their capacity exactly once. Existing backpressure eviction stays
in place. WebSocket clients may receive state only; inbound messages close the
connection and payloads are bounded to 1 KiB.

Production `RADIO_MAX_RELAY_TOKEN` is a generated 64-character hexadecimal secret
in mode-0600 `.env`, with a protected copy in `secrets/relay-origin-token`. Change
both together and recreate the app and relay. Never log the value or export
resolved Caddy/Compose configuration. The relay overwrites its token header and
`X-Radio-Max-Client-IP`, and drops `X-Forwarded-For`, so publicly supplied
identity/credential headers cannot change the quota. The origin accepts forwarded
identities only with the token; non-loopback stream requests without it return 403. Container-local acceptance keeps a loopback-only exception. An unset token
supports isolated development/CI and trusts no forwarding headers; it is not the
production setting.

The relay bounds headers and bodies, allows 64 active upstream requests and has
header/body/idle/upstream timeouts, but no timeout on a healthy audio response.
Admin and configuration persistence are disabled, so secret headers are never
autosaved. A rollback to an image before these controls also rolls back their
protection; repeat the live protection checks after any image rollback.

`deploy/check-stream-proxy.py` (run in CI) tests the actual application behind the
real relay config and a front that stands in for Cloudflare: forged headers,
capacity rejection, cleanup, reconnection and token enforcement from a different
container. `deploy/relay/verify-limits.ts` repeats the capacity test against the
live relay (`VERIFY_BASE_URL`, with `VERIFY_STATE_URL` for listener counts); it
refuses to run if there are existing listeners.

These controls bound application resource use. Upstream DDoS mitigation comes
from Cloudflare, within the limits of its free plan.

## Image acceptance and rollback

For a manual fallback, use a clean, committed checkout and an exact revision:

```sh
release_revision="$(git rev-parse HEAD)"
docker build --build-arg RADIO_MAX_REVISION="$release_revision" \
  -t "radio-max:$release_revision" .
DEPLOY_HOSTNAME=<host name> python3 deploy/release.py "radio-max:$release_revision"
docker compose ps
docker compose exec -T web bun /app/deploy/verify.ts
```

The build installs both frozen Bun lockfiles, typechecks the server and builds
the dashboard. The release selects the image through ignored `.env`, waits for
health, then checks dashboard/assets, private-file isolation, station data,
HEAD headers, actual stream pacing, ICY metadata framing, WebSocket origin
restrictions and listener cleanup. Failure restores and verifies the previous
image; a failed first installation is removed. The previous image reference is
in `state/deployment.json`; use `deploy/release.py <previous-image>` to roll back.
A health-only candidate missing dashboard assets was deliberately rejected and
the previous release/configuration/acceptance record restored during testing.

Runtime `.env` settings include `STREAM_HOSTS`, `PUBLIC_URL` and
`DASHBOARD_ORIGIN`. Routing changes are not part of a normal image rollback.
Restarting the app resets uptime, track position and listener connections.
`docker compose down` stops only the app; the origin sidecar is a separate project.

## CI/CD: Suggestions pattern

Every PR runs `ci.yml`: both frozen lockfiles, server/verification typechecks,
frontend build, deployment/provenance/rollback tests, signed receiver tests,
origin/relay config validation, then the restricted production container's actual
stream and WebSocket acceptance. Listener cleanup is checked on an isolated
container so unrelated production listeners cannot fail a release.

Every `main` push runs `release.yml`. CI gates native AMD64/ARM64 builds, then
an immutable GHCR manifest with GitHub build provenance is published. The mutable
`main` tag advances only after attestation exists. `DEPLOY_ENABLED=true` enables
CD. The GitHub `Production` environment permits only `main`, with dedicated
`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` and `DEPLOY_WEBHOOK_SECRET`.
`RADIO_MAX_BASE_URL=https://radio-max.kylescudder.co.uk` supplies public acceptance.

Cloudflare Access protects the whole `deploy-radio-max.kylescudder.co.uk` host
with its dedicated `github-radio-max-deploy` service token (expires 17 October
2027). Only exact path `/hooks/radio-max` reaches `radio-max-deploy-hook:9000`.
The queue-only receiver has no Docker socket, host ports or database network.
Its acceptance metadata mount is read-only. Unauthenticated, invalid-signature
and incorrect-path requests are rejected.

`com.kylescudder.deploy-core` supervises independent workers for each app queue.
The host deployer independently requires this repository's `release.yml`,
`refs/heads/main` and GitHub-hosted-runner provenance. It pulls the exact digest,
checks the image revision, runs acceptance and restores/verifies the previous
image on failure. GitHub receives no shell access. A read-only, job-lifetime
registry token arrives in the signed request, is used in temporary private
registry configuration and removed; it is never persisted in release metadata.
The manual and queued release share `state/deploy.lock`.
Routine image releases do not pull source or replace host deployment tools.

The host acknowledges only completed acceptance. GitHub requires both that exact
digest/revision acknowledgement and the public `X-Radio-Max-Revision` header
from `/healthz`. A running container or accepted webhook alone cannot complete CD.

To reinstall the receiver/LaunchAgent from the protected existing configuration:

```sh
docker compose -f deploy/compose.deploy-hook.yaml --env-file .env.deploy-hook config --quiet
docker compose -f deploy/compose.deploy-hook.yaml --env-file .env.deploy-hook up -d --wait
```

The receiver environment uses `DEPLOY_HOOK_USER=501:20`, absolute
`DEPLOY_SPOOL_DIR` and `DEPLOY_WEBHOOK_SECRET_FILE`. Preserve protected
`state/public` and `deploy-spool/requests` directories. Use the shared hostname
workflow for dashboard/receiver routing changes, not manual edits to its registry.

## Accepted releases and recovery evidence

PR #8 installed the CI/CD path. Runs `39068980986` and `39069165762` completed
all five jobs and matched host acknowledgement, immutable image and public
revision. Before/after preview screenshots and evidence remain in the platform's
`verification/radio-max-cicd/` and `verification/radio-max-cicd.json`.

PR #9 cut production over. Run `39071085492` passed all five jobs for revision
`295aff4df74381aaa4618e9c58677bf1a774883d` and immutable image
`ghcr.io/kylescudder/radio-max@sha256:f13ee714b675063a4c7eeded9878e39723cd488e7a73de3be05c840a21f9aa7d`.
It also corrects the ETS2 field order and the container's production badge.
Current release pointers are in `state/public/deployment.json` and
`state/deployment.json`. Public routing, decoding, browser and backup evidence
are in the platform's `verification/radio-max-production.json` and screenshots
under `verification/radio-max-production/`. Actual ETS2 in-game playback requires
a game machine; protocol/decoder checks do not establish an in-game result.

The encrypted NAS backup discovers `.env`, `.env.deploy-hook`, Compose,
Dockerfile, `deploy/` (including the public relay), protected `secrets/`
(including the Tailscale identity and original broadcaster archive), JSON release/routing state and verification
artifacts. Refresh it with the shared backup script and verify its manifest plus
selected restored-file hashes after changing routing, secrets or host tooling.
The decryption identity remains outside its own archive.
