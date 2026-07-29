# API

## Local browser routes

These routes exist only when `LOCAL_UI_ENABLED=true`, which is set by
`docker-compose.local.yml`. They are intended for same-computer access through
`http://localhost:8080`; mutating requests require the configured same-origin header.

```text
POST /ui/jobs
GET  /ui/config
GET  /ui/jobs
GET  /ui/jobs/{jobId}
GET  /ui/jobs/{jobId}/result
POST /ui/jobs/{jobId}/retry-callback
```

`POST /ui/jobs` accepts `videoUrl`, `title`, `classDate`, `teacher`, `course`, and
`analyzeVisuals`. The server accepts supported YouTube URL forms, extracts the fixed eleven
character ID, generates idempotency internally, and queues one durable job. Callback retry is
available only for terminal jobs with a failed callback and never requeues media or AI work.
`GET /ui/config` exposes only non-secret UI capabilities, such as whether visual analysis is
enabled.

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
