import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { signRequest } from '../packages/security/src/index.js';

const { values } = parseArgs({
  options: {
    'job-id': { type: 'string' },
    output: { type: 'string' },
  },
});

const jobId = z.string().uuid().parse(values['job-id']);
const secret = process.env['ETM_API_SECRET'];
const baseUrl = process.env['ETM_API_BASE_URL'];
if (!secret || secret.length < 32) {
  throw new Error('Set ETM_API_SECRET in the environment; it will not be printed');
}
if (!baseUrl || !URL.canParse(baseUrl)) {
  throw new Error('Set ETM_API_BASE_URL to the Caddy origin');
}

const path = `/v1/jobs/${jobId}`;
const timestamp = Math.floor(Date.now() / 1000).toString();
const response = await fetch(new URL(path, baseUrl), {
  headers: {
    'x-etm-timestamp': timestamp,
    'x-etm-signature': signRequest(secret, timestamp, 'GET', path, ''),
  },
});
if (!response.ok) {
  throw new Error(`Job API returned HTTP ${String(response.status)}`);
}

const job = z
  .object({
    status: z.string(),
    analysis: z.unknown().nullable(),
  })
  .passthrough()
  .parse(await response.json());
if (job.status !== 'completed' || job.analysis === null) {
  throw new Error(`Job is ${job.status}; a complete analysis is not available`);
}

const outputPath = resolve(values.output ?? join('outputs', `${jobId}.json`));
await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
await writeFile(outputPath, `${JSON.stringify(job, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(outputPath);
