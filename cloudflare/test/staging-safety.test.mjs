import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const txt=(p)=>readFileSync(new URL(p,import.meta.url),'utf8');
test('staging requires explicit Access confirmation in addition to original two opt-in gates',()=>{
 const workflow=txt('../../.github/workflows/deploy-staging.yml');
 assert.match(workflow,/STAGING_ACCESS_CONFIRMED:.*vars\.ACCESS_POLICY_VERIFIED/);
 assert.match(workflow,/test "\$STAGING_ACCESS_CONFIRMED" = "true"/);
 assert.match(workflow,/verify-staging-db\.mjs/);
 assert.match(workflow,/vars\.ENABLE_STAGING_DEPLOY == 'true'/);
 assert.match(workflow,/inputs\.confirm == 'deploy-private-staging'/);
 assert.match(workflow,/grep -qx 'workers_dev = false'/);
});
test('reusable staging workflow cannot run on branch pushes and pins the reviewed source',()=>{
 const workflow=txt('../../.github/workflows/deploy-staging.yml');
 assert.match(workflow,/^  workflow_call:$/m);
 assert.doesNotMatch(workflow,/^  push:$/m);
 assert.doesNotMatch(workflow,/^  workflow_dispatch:$/m);
 assert.match(workflow,/github\.ref == 'refs\/heads\/main'/);
 assert.match(workflow,/github\.repository == 'LeoKYChen\/multi-ai-review-desk'/);
 assert.ok(workflow.includes('ref: "${{ inputs.source_sha }}"'));
 assert.match(workflow,/git rev-parse HEAD/);
 assert.match(workflow,/MODEL_API_ENABLED = "false"/);
 assert.match(workflow,/BACKGROUND_JOBS_ENABLED = "false"/);
});
test('default Worker never creates a public workers.dev host',()=>{
 const sample=txt('../wrangler.toml.example');
 assert.match(sample,/^workers_dev = false$/m);
 assert.doesNotMatch(sample,/^workers_dev = true$/m);
});
test('staging generator explicitly disables background tasks and model API',()=>{
 const script=txt('../scripts/prepare-staging.mjs');
 assert.ok(script.includes('MODEL_API_ENABLED = "false"'));
 assert.ok(script.includes('BACKGROUND_JOBS_ENABLED = "false"'));
});
