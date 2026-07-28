import { parseArgs } from 'node:util';
import { signRequest } from '../packages/security/src/index.js';
import { videoIdSchema } from '../packages/shared/src/index.js';

const { values } = parseArgs({
  options: {
    'video-id': { type: 'string' },
    title: { type: 'string', default: 'ETM English Class' },
    'class-date': { type: 'string', default: new Date().toISOString().slice(0, 10) },
    teacher: { type: 'string', default: 'ETM Teacher' },
    course: { type: 'string', default: 'ETM English' },
    visuals: { type: 'boolean', default: false },
  },
});
const videoId = videoIdSchema.parse(values['video-id']);
const secret = process.env['ETM_API_SECRET'];
const baseUrl = process.env['ETM_API_BASE_URL'];
if (!secret || secret.length < 32) {
  throw new Error('Set ETM_API_SECRET in the environment; it will not be printed');
}
if (!baseUrl || !URL.canParse(baseUrl)) {
  throw new Error('Set ETM_API_BASE_URL to the Caddy HTTPS origin');
}
const path = `/v1/classes/${videoId}/analyze`;
const body = JSON.stringify({
  title: values.title,
  classDate: values['class-date'],
  teacher: values.teacher,
  course: values.course,
  analyzeVisuals: values.visuals,
});
const timestamp = Math.floor(Date.now() / 1000).toString();
const response = await fetch(new URL(path, baseUrl), {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-etm-timestamp': timestamp,
    'x-etm-signature': signRequest(secret, timestamp, 'POST', path, body),
    'idempotency-key': crypto.randomUUID(),
  },
  body,
});
console.log(`HTTP ${String(response.status)}`);
console.log(await response.text());
