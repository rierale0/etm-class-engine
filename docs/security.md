# Security

HMAC is mandatory even for an allowed IP. Verification hashes the exact raw body, applies a
five-minute replay window, validates fixed-length hex, and uses `crypto.timingSafeEqual`. The API
logs neither signatures nor secrets. Caddy access logging deletes HMAC, timestamp, cookie,
authorization, and idempotency headers.

`ALLOWED_CIDRS` supports IPv4, IPv6, mapped IPv4, and CIDR. Fastify trusts forwarded addresses only
when the immediate peer is the fixed Caddy backend address `172.29.0.10`. Do not change
`CADDY_TRUSTED_PROXIES` to `true` or a public range.

Important networking detail: a request made from the VPS to its own public domain normally
hairpins through the public interface and reaches Caddy with the VPS's public IP, not `127.0.0.1`.
Allowlist the actual observed public egress address. Do not weaken HMAC to solve an IP mismatch.

## Host firewall

On Ubuntu with SSH already confirmed:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw enable
sudo ufw status verbose
```

Do not open 3000, 5432, or 6379 in UFW or the Contabo firewall. Docker publishes only Caddy.

## Media and process isolation

Video IDs match `^[A-Za-z0-9_-]{11}$`; the service constructs the URL. `yt-dlp`, FFmpeg, and
FFprobe are invoked through `spawn` with argument arrays and `shell: false`. Duration, channel,
livestream, playlist, disk, frame, request, and output limits bound resource use. Both Node
containers use `tini` and run as the unprivileged `node` user. Scratch directories are UUID scoped,
mode `0700`, and removed after every attempt.

## Secret handling

- `.env`, cookies, dumps, and logs must not enter Git.
- Keep `secrets/youtube_cookies` mode `0600`; an empty file disables cookies.
- Rotate HMAC/callback secrets and API keys after suspected disclosure.
- Limit `.env` to root/operator read access: `chmod 600 .env`.
- Enable GitHub/host secret scanning where the repository is stored. Locally use a scanner such as
  Gitleaks in CI against every commit.
- Never paste signed callback bodies into shared tickets; result JSON may contain student data.

Rate limiting is keyed by the authenticated service's source IP. The deployment uses one HMAC
principal; introduce distinct client keys before supporting multiple independent callers.

## Known residual risks

Cookie-based YouTube access can expire and may trigger provider challenges. Frame deduplication
uses a small grayscale perceptual fingerprint and can still retain some semantically redundant
screens. No public cancellation endpoint exists (operators can set `cancelRequestedAt` in
PostgreSQL). PostgreSQL result access is protected by the same shared HMAC principal rather than
per-user authorization.
