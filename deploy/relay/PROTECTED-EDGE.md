# Protected public audio edge

Prepared on 18 October 2026. This configuration is tested locally, but no new
hosting account, VPS or billable resource has been created.

The existing DNS-only relay does not provide upstream DDoS mitigation. Application
quotas bound resource use; they cannot prevent an attack from filling that relay's
internet link. The full solution is a dedicated provider-protected public edge.
The host retains the broadcaster, dashboard and existing Suggestions-style CD.

## Concrete candidate

OVHcloud's UK VPS page advertises its entry VPS from **£3.97 including VAT/month**,
with included anti-DDoS protection, 500 Mbps public bandwidth and unlimited traffic.
This is a published starting price, not an accepted checkout quote; location,
commitment, renewal price and any extras must be checked before purchase.
At 128 kbps, the default 32-player cap is approximately 4.1 Mbps of audio payload.

Sources checked:

- https://www.ovhcloud.com/en-gb/vps/
- https://developers.cloudflare.com/spectrum/

Cloudflare Spectrum custom TCP protection requires an Enterprise plan and paid
add-on. Re-enabling the ordinary Cloudflare web proxy would not resolve the
previously identified audio-traffic suitability restriction.
No accessible existing protected-hosting account was found in the host vault.
A provider account and an approved checkout cost are needed before provisioning.

## Prepared files

- `Caddyfile.public`: direct HTTP/HTTPS listeners on the existing API hostname,
  managed TLS, unchanged ETS2 HTTP URL, bounded headers/bodies/timeouts, maximum
  64 active upstream requests, overwritten client identity and private origin token.
- `radio-max-edge.service`: dedicated non-login service user, read-only system/home
  isolation, private temp/devices, only the low-port capability, 256 MiB/50% CPU,
  128 tasks and 4096 file descriptors. Writable state is limited to its TLS data.
- `install-caddy.py`: installs pinned upstream Caddy 2.11.7 on x86_64 Linux and checks
  its official GitHub release-asset SHA-256 before execution. No package/root binary
  is replaced. It runs as the installing user and writes only `/opt/radio-max/relay/bin`.
- `check-stream-proxy.py --public-edge`: tests the direct-edge routing in isolated
  containers without host ports. It checks forged-header resistance, excess-client
  rejection, disconnect/reconnect, and origin authentication. Staging disables
  automatic HTTPS; a real certificate test requires the actual new host/DNS.

## Provision and accept after account/cost approval

1. Create a dedicated Ubuntu 24.04 x86_64 VPS in a standard UK/EU datacentre with
   provider anti-DDoS included and a verified monthly quote. Install only an
   authorized SSH public key; keep the private key out of chat/repository.
2. Install Tailscale through its signed Ubuntu package repository, enroll the
   machine as `radio-max-edge`, and verify access to the host origin. Prefer a
   narrowly scoped tailnet grant for the origin's TCP 8080. Disable key expiry for
   this server node only after enrollment; preserve authenticated private access.
3. Create the non-login `radio-max-edge` user and `/var/lib/radio-max-edge` owned by
   it. Install the pinned Caddy binary; put the reviewed public config at
   `/etc/radio-max-edge/Caddyfile`, root-owned and read-only to the service.
4. Transfer the existing origin token privately into root-owned mode-0600
   `/etc/radio-max-edge/private.env` as `RADIO_MAX_RELAY_TOKEN=...`. systemd reads
   that file before dropping privileges. Never put it in shell arguments, logs,
   source control or a public configuration export. Caddy config persistence is off.
5. Install/validate the prepared unit. Permit public TCP 80/443, use Tailscale for
   administration, and apply the provider/host firewall. Verify private SSH before
   removing any temporary public SSH route. Tailscale's direct UDP transport may
   also be allowed; blocked UDP falls back to encrypted relay transport.
6. Test the new edge before switching the API record: health/revision, HTTP MP3
   decoding, ICY metadata, token enforcement and capacity recovery. Use a temporary
   approved DNS-only validation hostname to obtain and test an origin certificate.
7. Preserve the current API DNS record and relay. Switch only that DNS-only A record
   to the accepted VPS; do not touch the dashboard/CD hostnames or proxy audio through
   the shared Cloudflare web route. Obtain/verify the existing API hostname's TLS
   certificate, then repeat public HTTP/HTTPS decoding and forged-header tests.
8. Verify exact revision, normal player reconnection and zero stale listeners.
   Back up new edge configuration/identity/credentials securely. Retain the old
   relay until public acceptance completes, then remove its audio ingress deliberately.

Rollback restores the saved DNS-only A record to the old working relay. Keep the
same private origin token available on both edges during the transition. Do not
restore the original Cloudflare-proxied API record. No game machine is required
for these transport tests; actual ETS2 playback remains a separate acceptance check.
