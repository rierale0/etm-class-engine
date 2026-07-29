# Architecture

## Request and processing flow

```mermaid
sequenceDiagram
    participant N as n8n/client
    participant C as Caddy
    participant A as Fastify API
    participant P as PostgreSQL
    participant Q as Redis/BullMQ
    participant W as Worker
    participant T as PO Token provider
    participant O as Selected AI provider

    N->>C: Signed POST with video ID
    C->>A: Proxied request
    A->>A: CIDR, timestamp, HMAC, body validation
    A->>P: Serializable idempotent job insert
    A->>Q: Enqueue durable job ID
    A-->>N: 202 + status URL
    Q->>W: Attempt with exponential retry
    W->>P: Stage/progress updates
    W->>T: Request video-bound PO Token
    T-->>W: Short-lived attestation
    W->>W: yt-dlp metadata, download, FFmpeg chunks
    W->>O: Sequential timestamped transcription
    opt Visual analysis enabled twice
        W->>W: Periodic + scene frame extraction
        W->>O: Bounded visible-evidence batches
    end
    W->>O: Strict structured class analysis
    W->>P: Full JSON + exact character count
    W->>N: Fixed, signed, idempotent callback
    W->>P: Terminal/callback status
    W->>W: finally cleanup /data/jobs/{jobId}
```

The worker routes transcription, visual analysis, and synthesis independently to OpenAI or Gemini.
`AI_PROVIDER` supplies the default and the three stage-specific provider variables can override it.
Both adapters return the same internal types, and final output is always checked against the same
strict schema before it reaches PostgreSQL or n8n.

The API and databases use the internal `172.29.0.0/24` Docker network. Caddy uses the reserved
address `172.29.0.10` on that network and has an edge network
for ACME and HTTPS. The worker has a separate egress network for YouTube, the configured AI
providers, n8n, and the private PO Token sidecar. The sidecar has no host port and the matching
yt-dlp plugin is checksum-pinned in the worker image. No service other than Caddy publishes a host
port.

## Durability and retries

PostgreSQL is authoritative for job state and results. BullMQ stores work delivery in append-only
Redis and retries four times with exponential backoff. BullMQ stalled-job recovery handles worker
loss; a periodic database sweep re-enqueues old active rows missing from Redis. Processing checks
for cancellation at safe boundaries (the current public status set has no cancellation endpoint).
Non-final retryable attempts return the durable row to `queued`; terminal attempts store a
sanitized failure and deliver a failure callback.

The partial unique PostgreSQL index `Job_one_active_video_key` prevents concurrent active jobs for
one video, including races. A completed or failed video may be intentionally submitted again with
a new key; there is no administrative override endpoint.

## Data boundaries

PostgreSQL stores request metadata, job/error/callback state, warnings, and final analysis. It never
stores API secrets, YouTube cookies, or raw temporary media. Redis contains queue payloads with
only the durable job UUID. `/data/jobs/{uuid}` is mode-restricted worker scratch space and is
removed in a `finally` block. The worker entrypoint initializes the mounted volume as root and
immediately drops privileges with `gosu`; the Node process itself runs as `node`.
