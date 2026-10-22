import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import worker from '../src/staging-bootstrap.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('staging bootstrap returns 503 without disclosing any app data', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/tasks'));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(await response.text(), /not available/i);
});

test('native Cloudflare Builds config is closed and does not attach D1', () => {
  const config = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
  assert.match(config, /"name"\s*:\s*"multi-ai-review-desk-staging"/);
  assert.match(config, /"main"\s*:\s*"src\/staging-bootstrap\.mjs"/);
  assert.match(config, /"workers_dev"\s*:\s*false/);
  assert.match(config, /"preview_urls"\s*:\s*false/);
  assert.match(config, /"MODEL_API_ENABLED"\s*:\s*"false"/);
  assert.match(config, /"BACKGROUND_JOBS_ENABLED"\s*:\s*"false"/);
  assert.doesNotMatch(config, /"d1_databases"|"routes"|"route"|"assets"|"queues"/);
});
