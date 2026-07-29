# Contabo deployment

## 1. Prepare Ubuntu and DNS

Create an `A` record (and `AAAA` only if IPv6 is correctly routed) such as
`classes.example.com` pointing to the VPS. In the Contabo firewall allow only TCP 22, 80, 443 and
UDP 443. Confirm SSH access before enabling UFW.

```bash
sudo apt update
sudo apt install -y ca-certificates curl git ufw
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
newgrp docker
docker version
docker compose version
```

Apply the UFW rules in [security](security.md). Install unattended security updates if consistent
with the server's maintenance policy.

## 2. Install the application

```bash
sudo mkdir -p /opt/etm-class-engine
sudo chown "$USER":"$USER" /opt/etm-class-engine
git clone YOUR_PRIVATE_REPOSITORY_URL /opt/etm-class-engine
cd /opt/etm-class-engine
cp .env.example .env
chmod 600 .env
mkdir -p secrets
install -m 600 /dev/null secrets/youtube_cookies
```

Edit `.env`:

1. Set the real domain and ACME email.
2. Generate PostgreSQL/API/callback secrets with `openssl rand -hex 32`.
3. Select the AI provider, add every required OpenAI/Gemini key, and set the fixed n8n production
   webhook.
4. Set `ALLOWED_CIDRS` to the n8n and administrator public egress addresses.
5. Set the ETM-owned channel IDs. Comma-separate multiple IDs.
6. Keep concurrency at one until CPU, memory, disk, YouTube, and AI-provider behavior is measured.
7. Keep `YOUTUBE_PO_TOKEN_PROVIDER_URL=http://pot-provider:4416`. Cookies are optional and should
   be added only for content that genuinely requires an account.

## 3. Validate and start

```bash
docker compose -f docker-compose.yml config --quiet
docker compose -f docker-compose.yml build
docker compose -f docker-compose.yml up -d
docker compose -f docker-compose.yml ps
docker compose -f docker-compose.yml logs --tail=100 api worker pot-provider caddy
curl --fail https://classes.example.com/health
curl --fail https://classes.example.com/ready
```

Caddy obtains certificates automatically after DNS and ports are correct. The API container runs
`prisma migrate deploy` before starting. The `pot-provider` service must be healthy before the
worker starts and never publishes port `4416` to the host.

Verify plugin discovery with an owned test video:

```bash
docker compose -f docker-compose.yml exec -T worker \
  yt-dlp --verbose --skip-download \
  --extractor-args 'youtube:player_client=mweb' \
  --extractor-args 'youtubepot-bgutilhttp:base_url=http://pot-provider:4416' \
  -- 'https://www.youtube.com/watch?v=DEMOclass01' 2>&1 |
  grep 'PO Token Providers'
```

The output should include `bgutil:http-1.3.1`.

## 4. End-to-end smoke test

Use an owned, short, unrestricted or cookie-authorized video:

```bash
export ETM_API_SECRET='value-from-dot-env'
export ETM_API_BASE_URL='https://classes.example.com'
npm ci
npm run request:test -- --video-id DEMOclass01 \
  --teacher "Alex Morgan" --class-date 2026-07-16
```

Poll the returned status URL with the same signing algorithm. Confirm the callback in n8n,
`completed` in PostgreSQL/API, and no directory for the UUID under the worker's `/data/jobs`.

## 5. Backups and updates

Take encrypted off-host daily PostgreSQL custom-format dumps and periodically test restores. Back
up the Caddy data volume for certificate/account continuity. Queue and job scratch volumes are not
substitutes for PostgreSQL backup.

```bash
cd /opt/etm-class-engine
docker compose -f docker-compose.yml exec -T postgres \
  pg_dump -U etm -d etm -Fc > "/secure-backups/etm-$(date +%F).dump"

git fetch --all --prune
git pull --ff-only
docker compose -f docker-compose.yml build --pull
docker compose -f docker-compose.yml up -d
docker compose -f docker-compose.yml ps
curl --fail https://classes.example.com/ready
```

Review migrations and take a backup before updates. Roll back with the prior Git revision/image;
database migrations may require a forward fix instead of a binary rollback.

## Troubleshooting

- **Caddy certificate failure:** verify DNS, clock, ports 80/443, and `caddy` logs.
- **401 from a valid HMAC:** verify byte-identical JSON/path, Unix clock, and observed source IP.
- **PO provider unhealthy:** inspect `docker compose logs pot-provider`; confirm `/ping` succeeds
  inside its container and that the worker shares the `egress` network.
- **YouTube login required:** first verify that verbose yt-dlp output includes
  `bgutil:http-1.3.1`. Add cookies only when the video itself requires an account.
- **Unexpected channel:** compare `yt-dlp --dump-single-json` channel ID with the allowlist.
- **Stuck queue:** inspect Redis health, worker logs, and PostgreSQL `status/updatedAt`; the sweep
  runs every five minutes for rows stale at least thirty minutes.
- **Low disk:** inspect Docker volumes with `docker system df`; do not delete PostgreSQL volumes.
- **Invalid structured output:** the worker retries; inspect the sanitized code, model availability,
  and output/token constraints without logging the transcript.
- **Callback failed:** distinguish permanent 4xx from 408/429/5xx and verify the fixed URL/secret.
