# RadioMax on Herman

Checkout: `/Users/kyle/platform/apps/radio-max`, branch `master`.
The Bun container serves the built Vite dashboard, WebSocket/state API and
continuous MP3 broadcaster on `radio-max:8080` inside external `platform-web`.
It follows Herman's non-root, read-only filesystem, no host ports, bounded logs,
resource limits and restart policy. There is no database. The packaged MP3 loops
continuously at 128 kbps MPEG-1 Layer III, 48 kHz; the ICY headers match it.

## Public routing

The production dashboard is `https://radio-max.kylescudder.co.uk`:
Cloudflare Tunnel → shared Herman Caddy → `radio-max:8080`.
The dashboard uses same-origin WebSockets and its exact HTTPS origin is the
configured `DASHBOARD_ORIGIN`. The container shows a small `Herman` badge.
The temporary preview hostname has been removed through the platform hostname tool.
The Netlify project remains available as a fallback, but the production DNS no
longer points to it.

Public audio retains `http://api.radio-max.kylescudder.co.uk/radio/main`.
HTTPS works on the same hostname with a valid origin certificate. The API DNS
record is a **DNS-only** A record to `178.105.134.176`, not a Cloudflare proxy.
Audio bypasses the shared Cloudflare CDN/Tunnel route entirely:

```text
HTTP/HTTPS client
  → existing Linux edge Caddy (ports 80/443, existing TLS certificate)
  → unprivileged relay on localhost:8080
  → WireGuard/Tailscale radio-max-origin.tail4a869e.ts.net:8080
  → Herman radio-max:8080
```

Broadcasting and station state run on Herman. The existing Linux server remains
required for public ingress; its root Caddy configuration and systemd unit are
unchanged. Plain HTTP is retained without redirects or login for ETS2.
`STREAM_HOSTS=localhost,127.0.0.1,radio-max` allows only private origin hostnames
to stream. The relay sends `Host: radio-max`; requests to `/radio/*` on the
Cloudflare dashboard hostname return 404, including spoofed forwarded hosts.
`PUBLIC_URL` advertises the existing public HTTP audio origin.

ETS2's six fields are URL, name, genre, language, bitrate and favorite:

```text
stream_data[]: "http://api.radio-max.kylescudder.co.uk/radio/main|RadioMax|Gaming Music|EN|128|1"
```

## Private origin and edge operation

The dedicated Tailscale sidecar has no host ports, TUN device or Docker socket.
It uses userspace networking as UID/GID 501:20, with a read-only filesystem,
dropped capabilities and memory/CPU limits. Its pinned image is in
`deploy/compose.origin.yaml`; `deploy/tailscale-serve.json` forwards TCP 8080 only
to the private app alias. Start/recover it separately from routine image releases:

```sh
docker compose -f deploy/compose.origin.yaml config --quiet
docker compose -f deploy/compose.origin.yaml up -d --wait --wait-timeout 90
```

The enrolled machine is `radio-max-origin` (`100.78.227.72`), not Herman's host
Tailscale identity. Its persisted identity is under protected `secrets/tailscale/`.
Key expiry is disabled for this server node only; authentication is still required.
Restart persistence was verified. Restore the backed-up identity rather than
registering a duplicate node. Keep the secret files private and never print state.
The compose healthcheck confirms Tailscale readiness; acceptance through the edge
also checks that the app is reachable.

The edge is the existing Tailscale machine `herman` (`100.110.233.67`). Authorized
SSH uses `/Users/kyle/.ssh/herman_old_review_ed25519` as user `kyle`. The edge
runs Caddy's unprivileged relay with the source/config in `/opt/radio-max/relay/`:

- `Caddyfile` forwards continuously with `flush_interval -1`.
- `server.ts` runs that Caddy process under the existing Bun systemd service.
- `/opt/radio-max/server/src/server.ts` contains the same wrapper.
- `deployment.json` records the source hashes and original service PID.

To validate a relay change before installing it, copy the reviewed config/source
to that directory and run `deploy/relay/verify.py` on the edge with Python 3. It
starts a separate loopback listener on 18080, checks health, ICY headers, eight
seconds of decoded audio and a WebSocket with the production dashboard origin,
then removes its temporary files and stops the candidate. `DASHBOARD_ORIGIN` may
be set for a staging origin. Never start a second listener on the active port.

The original broadcaster source is preserved on the edge as
`/opt/radio-max/relay/pre-herman-server.ts` (0600), and in the protected local
`secrets/legacy-origin/pre-relay-server.tar.gz`. The original MP3 matches the
repository's SHA-256. To restore the old broadcaster, atomically restore that
source into the existing server working directory, then send SIGTERM to the
verified, kyle-owned MainPID of `radio-max.service`. Its existing `Restart=always`
policy starts the restored source. Check health and decoded audio afterward.
No root service/config changes or sudo access are needed. This restores old
broadcasting only; dashboard/state would need an explicit corresponding rollback.
**Keep audio DNS-only during rollback** so audio stays off the Cloudflare CDN.

## Image acceptance and rollback

For a manual fallback, use a clean, committed checkout and an exact revision:

```sh
release_revision="$(git rev-parse HEAD)"
docker build --build-arg RADIO_MAX_REVISION="$release_revision" \
  -t "radio-max:$release_revision" .
python3 deploy/release.py "radio-max:$release_revision"
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
`DASHBOARD_ORIGIN`. `secrets/before-public.env` preserves the pre-cutover settings;
`state/original-public-dns.json` records original DNS. Restore those only as part
of a deliberate routing rollback, not a normal image rollback. The saved original
API record was Cloudflare-proxied and must not be restored unchanged.
Restarting the app resets uptime, track position and listener connections.
`docker compose down` stops only the app; the origin sidecar is a separate project.

## CI/CD: Suggestions pattern

Every PR runs `ci.yml`: both frozen lockfiles, server/verification typechecks,
frontend build, deployment/provenance/rollback tests, signed receiver tests,
origin/relay config validation, then the restricted production container's actual
stream and WebSocket acceptance. Listener cleanup is checked on an isolated
container so unrelated production listeners cannot fail a release.

Every `master` push runs `release.yml`. CI gates native AMD64/ARM64 builds, then
an immutable GHCR manifest with GitHub build provenance is published. The mutable
`master` tag advances only after attestation exists. `DEPLOY_ENABLED=true` enables
CD. The GitHub `Production` environment permits only `master`, with dedicated
`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` and `DEPLOY_WEBHOOK_SECRET`.
`RADIO_MAX_BASE_URL=https://radio-max.kylescudder.co.uk` supplies public acceptance.

Cloudflare Access protects the whole `deploy-radio-max.kylescudder.co.uk` host
with its dedicated `github-radio-max-deploy` service token (expires 17 October
2027). Only exact path `/hooks/radio-max` reaches `radio-max-deploy-hook:9000`.
The queue-only receiver has no Docker socket, host ports or database network.
Its acceptance metadata mount is read-only. Unauthenticated, invalid-signature
and incorrect-path requests are rejected.

`com.herman.radio-max-deploy` is event-driven through launchd QueueDirectories.
The host deployer independently requires this repository's `release.yml`,
`refs/heads/master` and GitHub-hosted-runner provenance. It pulls the exact digest,
checks the image revision, runs acceptance and restores/verifies the previous
image on failure. GitHub receives no shell access. A read-only, job-lifetime
registry token arrives in the signed request, is used in temporary private
registry configuration and removed; it is never persisted in release metadata.
The manual and queued release share `state/deploy.lock`.
Routine image releases do not pull source or replace host deployment tools.

Herman acknowledges only completed acceptance. GitHub requires both that exact
digest/revision acknowledgement and the public `X-Radio-Max-Revision` header
from `/healthz`. A running container or accepted webhook alone cannot complete CD.

To reinstall the receiver/LaunchAgent from the protected existing configuration:

```sh
docker compose -f deploy/compose.deploy-hook.yaml --env-file .env.deploy-hook config --quiet
docker compose -f deploy/compose.deploy-hook.yaml --env-file .env.deploy-hook up -d --wait
python3 -B deploy/install-launchd.py
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
Dockerfile, `deploy/`, protected `secrets/` (including the Tailscale identity and
original broadcaster archive), JSON release/routing state and verification
artifacts. Refresh it with the shared backup script and verify its manifest plus
selected restored-file hashes after changing routing, secrets or host tooling.
The decryption identity remains outside its own archive.
