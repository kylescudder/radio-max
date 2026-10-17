# RadioMax on Herman: preview deployment

Checkout: `/Users/kyle/platform/apps/radio-max`, local branch `deploy/herman`.
Source base: `cc8f78c` on `kylescudder/radio-max`'s `master` branch.

The Bun container serves the built Vite dashboard, WebSocket/state API and
continuous MP3 stream on `radio-max:8080` inside external `platform-web`.
It uses the same non-root, read-only filesystem, no host ports, bounded logs,
resource limits and restart policy as the other Herman apps. There is no database.
The repository's MP3 is packaged in the image and loops without a listener;
it is 128 kbps MPEG-1 Layer III at 48 kHz. The ICY sample-rate header now matches.

## Status and public routing

The preview dashboard is `https://radio-max-preview.kylescudder.co.uk`.
Its `/radio/*` paths return 404: `STREAM_HOSTS` restricts audio to private
`localhost`, `127.0.0.1` and `radio-max` hostnames. The actual public radio
hostname and remote audio service remain unchanged. Browser requests use
same-origin WebSockets; `DASHBOARD_ORIGIN` is the exact preview origin.

The protected deploy receiver and `com.herman.radio-max-deploy` LaunchAgent are
installed. The first GitHub release is being activated; consult `state/public/`
for the exact completed acceptance and `state/deployment.json` for the retained
image/revision. No public-audio cutover is implied by a successful preview release.

The existing audio URL is `http://api.radio-max.kylescudder.co.uk/radio/main`.
That remote API answers HTTP; its HTTPS handshake failed during assessment.
The current dashboard uses that API origin. A future production deployment
can serve the dashboard and API together at `radio-max.kylescudder.co.uk`, avoiding
the nested API hostname's HTTPS problem. Its stream URL must still support plain
HTTP for ETS2, without forced HTTPS redirects or interactive authentication.

Before routing continuous public audio through the shared Cloudflare route,
resolve its suitability under the current CDN terms:
<https://www.cloudflare.com/service-specific-terms-application-services/>.
A dedicated public relay or another suitable ingress can forward the audio while
the dashboard uses the existing Tunnel/Caddy path. Selecting or provisioning that
route is deferred by Kyle's instruction. Do not cut over or remove the old services
until public audio, dashboard WebSockets and a real ETS2 session are accepted.

## Build and private acceptance

Use a unique release tag and identify uncommitted candidate code clearly:

```sh
docker build --build-arg RADIO_MAX_REVISION=cc8f78c-herman-cicd-preview \
  -t radio-max:cc8f78c-herman-cicd-preview-20261017 .
python3 deploy/release.py radio-max:cc8f78c-herman-cicd-preview-20261017
docker compose ps
docker compose exec -T web bun /app/deploy/verify.ts
```

The build installs both frozen Bun lockfiles, typechecks the server and builds
the dashboard. The image pins the platform-tested Bun version by digest.
The release command selects the image through ignored `.env`, waits for health,
then checks the dashboard/assets, private-file isolation, station data, HEAD
headers, actual stream pacing, ICY metadata framing, WebSocket origin restrictions
and listener cleanup. Failure restores and verifies the previous image; a failed
first installation is removed. The successful image ID and checks are recorded
in ignored `state/deployment.json`. Source and the MP3 remain in GitHub; the NAS
backup discovers `.env`, Compose, Dockerfile, deployment tools and state under
the existing application discovery contract. This does not establish a completed
NAS backup/restore test for this candidate.

Runtime `.env` settings are `STREAM_HOSTS` (an optional allowlist for HTTP Host
values permitted to stream), `PUBLIC_URL` (the advertised ETS2 stream origin)
and `DASHBOARD_ORIGIN` (the exact browser origin accepted for WebSockets).
The active preview retains the existing advertised audio URL and uses the HTTPS
preview dashboard origin. These settings are not secrets. Do not use the container's private alias in
a production browser build.

Acceptance evidence is in `state/acceptance.json`. The candidate passed its build,
private acceptance suite and the same suite through a temporary Caddy 2.11.7 proxy.
A deliberately broken image that passed basic health but lacked the dashboard
was rejected, and the previous image, configuration and acceptance record were
restored. The stream remained connected for 65 seconds through Caddy at approximately
15.8 kB/s. Temporary test resources were removed afterward.

## Rollback and stopping

Retain previous image references and use `deploy/release.py <previous-image>`
to select a prior release with acceptance checks. This project has no durable
application data; restarting resets uptime, track position and listener connections.
`docker compose down` stops only RadioMax and removes its private candidate container.

## CI/CD: Suggestions pattern

This preparation follows the verified Suggestions thread and its current
`.github/workflows/release.yml` and `deploy/` implementation, adapted for this
repository's `master` branch and streaming acceptance checks. No database or
Clerk setup is needed for RadioMax.

Every pull request runs `ci.yml`: both frozen lockfiles, server/verification
typechecks, frontend build, deployment/provenance/rollback tests, signed receiver
tests, then the restricted production container's actual stream and WebSocket
checks. Exact listener cleanup is checked on that isolated CI container so
unrelated production listeners cannot cause a release to fail.

Every `master` push runs `release.yml`. CI must pass before native AMD64/ARM64
images are built. It publishes `ghcr.io/kylescudder/radio-max` by immutable digest
with GitHub build provenance, and updates `master` only after the attestation
exists. Deployment runs only when `DEPLOY_ENABLED=true`.

The `production` environment must permit only `master`. Its separate credentials
are `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` and `DEPLOY_WEBHOOK_SECRET`.
Repository variable `RADIO_MAX_BASE_URL` supplies the final HTTPS dashboard/API
origin. GitHub receives no shell access. Like Suggestions, a read-only,
job-lifetime registry token travels inside the signed request; Herman uses
temporary private registry configuration, then removes it. The token is omitted
from logs, release history and persisted request metadata.

Cloudflare Access must protect the entire future hostname
`deploy-radio-max.kylescudder.co.uk` with its own `github-radio-max-deploy` service
token. Only exact path `/hooks/radio-max` is routed to
`radio-max-deploy-hook:9000`. `compose.deploy-hook.yaml` defines a queue-only
receiver with no Docker socket, host ports or database network. The receiver has
only a read-only mount of the host's public acceptance metadata.

`install-launchd.py` installs `com.herman.radio-max-deploy` using QueueDirectories,
without polling. `herman-deploy.py` independently requires this repository's
`release.yml`, `refs/heads/master` and GitHub-hosted-runner provenance before
pulling an image. It verifies the requested revision, starts the candidate, runs
the full RadioMax acceptance suite and restores/verifies the previous image on
failure. The manual local release and queued release share `state/deploy.lock`.
Routine image releases never `git pull` or replace host deployment tools.

Herman publishes an acknowledgement only after acceptance completes. The
workflow requires both that exact digest/revision acknowledgement and the
public `X-Radio-Max-Revision` header from `/healthz` before it reports success.
A merely running container or accepted webhook request cannot complete CD.

## Operation and final public routing

Private settings are mode 0600 under ignored `secrets/` and `.env.deploy-hook`.
The dedicated `github-radio-max-deploy` Access token expires on 17 October 2027.
The existing `Production` GitHub environment allows only `master`, holds the
separate Access/HMAC credentials, and uses `RADIO_MAX_BASE_URL` for the preview.
`DEPLOY_ENABLED` controls automatic delivery. It is enabled only after endpoint
protection and preview availability are checked.

The receiver environment needs `DEPLOY_HOOK_USER=501:20`, an absolute
`DEPLOY_SPOOL_DIR` for this app's `deploy-spool/`, and an absolute
`DEPLOY_WEBHOOK_SECRET_FILE` for its private HMAC secret. Create protected
`state/public` and `deploy-spool/requests` directories before starting it.

```sh
docker compose -f deploy/compose.deploy-hook.yaml --env-file .env.deploy-hook config --quiet
docker compose -f deploy/compose.deploy-hook.yaml --env-file .env.deploy-hook up -d --wait
python3 -B deploy/install-launchd.py
```

The deploy hostname was registered after Access protection using the platform
hostname tool and `--upstream radio-max-deploy-hook:9000 --path /hooks/radio-max`.
Unauthenticated rejection, invalid-signature rejection, exact-path routing
and the receiver/host queue must pass before enabling CD.
The receiver's private configuration and deployment state follow the platform's
existing encrypted NAS discovery contract; refresh and verify the backup once
those production settings are installed.

Choose and verify public audio ingress, then register approved dashboard/API
routes through the platform's `scripts/hostname.py` workflow. Preserve the old DNS
and services until the candidate is accepted. Before declaring the migration
complete, repeat Suggestions' real push-to-production acceptance: make a small
visible change, capture before/after screenshots at the same size, and verify
GitHub success, completed host acknowledgement and the public revision against
the exact commit/digest. Check public HTTP streaming and a real ETS2 session too.
The preview pipeline can be accepted independently. Real public audio ingress
and ETS2 acceptance remain deferred with the routing decision.
