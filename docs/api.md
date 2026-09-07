# API

## HMAC authentication

Every `/v1` request requires:

```text
X-ETM-Timestamp: Unix time in seconds (milliseconds are also accepted)
X-ETM-Signature: lowercase or uppercase 64-character hex HMAC-SHA256
Idempotency-Key: required on POST; 8-200 printable non-space ASCII characters
```

The signature input is:

```text
timestamp + "\n" +
method.toUpperCase() + "\n" +
requestPath + "\n" +
SHA256(rawRequestBody)
```

`requestPath` is the exact path and query sent to Caddy, for example
`/v1/classes/DEMOclass01/analyze`. GET uses an empty body. Timestamps outside a 300-second window,
malformed HMACs, and disallowed source IPs all return the same generic `401`. Health endpoints are
unauthenticated and disclose only process/dependency availability.

## Start analysis

```http
POST /v1/classes/DEMOclass01/analyze
Content-Type: application/json
```

```json
{
  "title": "ETM English Class",
  "classDate": "2026-07-16",
  "teacher": "Alex Morgan",
  "course": "ETM English",
  "analyzeVisuals": false
}
```

Returns `202`:

```json
{
  "jobId": "39f5a245-b69d-4b99-95e9-a0e43c5e9ef9",
  "videoId": "DEMOclass01",
  "status": "queued",
  "statusUrl": "/v1/jobs/39f5a245-b69d-4b99-95e9-a0e43c5e9ef9"
}
```

The API constructs the YouTube URL. It never accepts a media URL. Replaying the exact path/body
with the same idempotency key returns the existing job. Reusing the key for another path/body
returns `409`. Another active job for the video also returns `409`.

## Job status

```http
GET /v1/jobs/{uuid}
```

Returns stage, integer progress, timestamps, callback state, warnings, and sanitized error. The
`analysis` field is non-null only for `completed`; it contains the complete stored result.

Statuses:

```text
queued
validating_video
downloading
extracting_audio
transcribing
extracting_frames
analyzing_visuals
synthesizing
sending_callback
completed
failed
```

## Operations

- `GET /health`: API event loop is serving requests.
- `GET /ready`: API can query PostgreSQL and connect to Redis; otherwise `503`.

Request bodies are capped at 64 KiB. Zod rejects unknown body properties and malformed IDs.

## Private operator interface

The browser UI is served at `/` when `WEB_UI_ENABLED=true`. Its `/ui-api` routes use a signed,
HTTP-only operator session rather than exposing the `/v1` HMAC secret to JavaScript.

```text
POST /ui-api/session
POST /ui-api/session/logout
GET  /ui-api/batches
POST /ui-api/batches
GET  /ui-api/batches/{uuid}
POST /ui-api/jobs/{uuid}/retry
POST /ui-api/batches/{uuid}/deliver
```

Mutating requests require the same-origin `X-ETM-UI: 1` marker. Login attempts are rate limited.
Batch delivery is allowed only after every job completes and uses one stable idempotency key per
batch. Once n8n accepts a batch, the UI prevents accidental duplicate delivery.
