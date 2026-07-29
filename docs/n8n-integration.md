# n8n integration

The local browser form is the primary input. n8n receives the final signed callback and does not
need inbound access to the computer running ETM Class Engine. The service-to-service request below
remains supported for optional automation.

## Sending the analysis request

In an n8n Code node, build the raw JSON once. Do not let a later node reserialize it differently
after signing.

```javascript
const crypto = require('crypto');
const videoId = 'DEMOclass01';
const path = `/v1/classes/${videoId}/analyze`;
const body = JSON.stringify({
  title: 'ETM English Class',
  classDate: '2026-07-16',
  teacher: 'Alex Morgan',
  course: 'ETM English',
  analyzeVisuals: false,
});
const timestamp = Math.floor(Date.now() / 1000).toString();
const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
const canonical = `${timestamp}\nPOST\n${path}\n${bodyHash}`;
const signature = crypto.createHmac('sha256', $env.ETM_API_SECRET).update(canonical).digest('hex');

return [
  {
    json: {
      url: `${$env.ETM_API_BASE_URL}${path}`,
      body,
      headers: {
        'Content-Type': 'application/json',
        'X-ETM-Timestamp': timestamp,
        'X-ETM-Signature': signature,
        'Idempotency-Key': crypto.randomUUID(),
      },
    },
  },
];
```

Configure the HTTP Request node to send the expression body as raw JSON text and the generated
headers. Store secrets in n8n credentials/environment, not workflow source. Reuse the same
idempotency key for a workflow retry of the same body.

## Verifying callbacks

The fixed callback receives `X-ETM-Timestamp`, `X-ETM-Signature`, and a stable `Idempotency-Key`.
The callback canonical value is:

```text
timestamp + "\n" + SHA256(rawCallbackBody)
```

Verify the timestamp is within 300 seconds and compare the expected 64-character hex HMAC with a
timing-safe comparison before parsing/using the body. See `scripts/verify-callback.ts`.

Completed payload:

```json
{
  "jobId": "uuid",
  "videoId": "DEMOclass01",
  "status": "completed",
  "analysis": {},
  "analysisCharacterCount": 48231,
  "error": null
}
```

Failed payload has `analysis: null` and a sanitized `{code,message}` error. Deduplicate callbacks
by `Idempotency-Key`; return a 2xx for already processed callbacks. Return 408 or 429 only when a
retry is genuinely useful. Other 4xx responses are permanent; 5xx responses retry with
exponential backoff and jitter.

If delivery of a completed result exhausts all callback attempts, the analysis remains durably
stored with job status `completed` and callback status `failed`. Callback outages never rerun the
paid media or AI pipeline; operators can retrieve the result from the job status API and replay
delivery separately.

Before inserting into Airtable, compare `analysisCharacterCount` to 95,000 and inspect
`ANALYSIS_OVERSIZE`. The complete result remains in PostgreSQL/status API; do not slice its
transcript to force insertion.
