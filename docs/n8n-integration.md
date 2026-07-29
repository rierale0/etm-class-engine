# n8n integration

The local browser form is the primary input. Every submission is one batch containing one or more
classes. After all classes complete, the operator clicks **Send to n8n** and n8n receives one
combined, signed JSON. n8n does not need inbound access to the computer running ETM Class Engine.
The service-to-service request below remains supported for optional single-class automation.

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

The local batch callback body is the combined result itself:

```json
{
  "schema_version": 1,
  "batch": {
    "id": "batch-uuid",
    "name": "English Usage — 30 de julio de 2026",
    "status": "ready",
    "class_count": 2,
    "created_at": "2026-07-30T18:00:00.000Z",
    "completed_at": "2026-07-30T20:00:00.000Z"
  },
  "order": ["VIDEO000001", "VIDEO000002"],
  "classes": {
    "VIDEO000001": {
      "job_id": "job-uuid-1",
      "video_url": "https://www.youtube.com/watch?v=VIDEO000001",
      "submission": {
        "title": "ETM English Class",
        "class_date": "2026-07-30",
        "teacher": "Sebastián Mesías",
        "course": "English Usage",
        "analyze_visuals": true
      },
      "analysis": {}
    },
    "VIDEO000002": {
      "job_id": "job-uuid-2",
      "video_url": "https://www.youtube.com/watch?v=VIDEO000002",
      "submission": {},
      "analysis": {}
    }
  }
}
```

The `classes` object preserves every validated class analysis without asking AI to combine or
rewrite it. `order` carries the explicit form order. The stable idempotency key is
`batch-{batchId}-completed`; deduplicate callbacks by that header and return a 2xx for an already
processed batch. Return 408 or 429 only when a retry is genuinely useful. Other 4xx responses are
permanent; 5xx responses retry with exponential backoff and jitter.

If delivery exhausts all callback attempts, every class analysis remains durably stored and the
batch delivery status becomes `failed`. The dashboard offers **Retry send**. Callback outages never
rerun the paid media or AI pipeline.

The existing signed `/v1/classes/{videoId}/analyze` API still sends its legacy single-job callback
for compatibility. That payload uses `jobId`, `videoId`, `status`, `analysis`, and
`analysisCharacterCount`.
