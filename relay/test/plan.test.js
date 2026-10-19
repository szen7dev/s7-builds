import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { plan } from '../src/index.js';
import { createHmac } from 'node:crypto';

const push = (repo, files, extra = {}) => ({
  ref: 'refs/heads/main', after: 'a'.repeat(40), repository: { name: repo, full_name: `szen7dev/${repo}` },
  commits: [{ added: [], modified: files, removed: [] }], ...extra,
});
const names = (jobs) => jobs.map((j) => `${j.workflow}:${j.inputs.app ?? ''}`).sort();

test('BE push đổi src → build + test', () => {
  assert.deepEqual(names(plan('push', push('s7-be', ['src/server.js']))), ['build-image.yml:be', 'test-be.yml:']);
});
test('BE push chỉ đổi test → chỉ test, không build', () => {
  assert.deepEqual(names(plan('push', push('s7-be', ['test/a.test.js']))), ['test-be.yml:']);
});
test('BE push chỉ đổi templates → build, không test', () => {
  assert.deepEqual(names(plan('push', push('s7-be', ['templates/cdc_grow.xlsx']))), ['build-image.yml:be']);
});
test('BE push chỉ đổi docs → không gì', () => {
  assert.deepEqual(plan('push', push('s7-be', ['docs/x.md'])), []);
});
test('FE push đổi src → build fe', () => {
  assert.deepEqual(names(plan('push', push('s7-fe', ['src/App.tsx']))), ['build-image.yml:fe']);
});
test('push nhánh khác main → bỏ qua', () => {
  assert.deepEqual(plan('push', push('s7-be', ['src/a.js'], { ref: 'refs/heads/sale' })), []);
});
test('push xoá nhánh → bỏ qua', () => {
  assert.deepEqual(plan('push', push('s7-be', ['src/a.js'], { deleted: true, after: '0'.repeat(40) })), []);
});
test('force push / không có commits → coi như đổi hết', () => {
  assert.deepEqual(names(plan('push', push('s7-fe', [], { commits: [] }))), ['build-image.yml:fe']);
  assert.deepEqual(names(plan('push', push('s7-be', ['docs/x.md'], { forced: true }))), ['build-image.yml:be', 'test-be.yml:']);
});
test('app push → ci', () => {
  assert.deepEqual(names(plan('push', push('s7-app', ['README.md']))), ['ci-app.yml:']);
});

const pr = (repo, action, headRepo = `szen7dev/${repo}`) => ({
  action, repository: { name: repo, full_name: `szen7dev/${repo}` },
  pull_request: { number: 7, state: 'open', head: { sha: 'b'.repeat(40), repo: { full_name: headRepo } }, base: { ref: 'main' } },
});
test('PR BE → test kèm base + key', () => {
  const [j] = plan('pull_request', pr('s7-be', 'synchronize'));
  assert.deepEqual(j.inputs, { sha: 'b'.repeat(40), base: 'main', key: 'pr-7' });
});
test('PR closed / PR FE / PR từ fork → bỏ qua', () => {
  assert.deepEqual(plan('pull_request', pr('s7-be', 'closed')), []);
  assert.deepEqual(plan('pull_request', pr('s7-fe', 'opened')), []);
  assert.deepEqual(plan('pull_request', pr('s7-be', 'opened', 'evil/s7-be')), []);
});

test('chữ ký sai → 401, đúng (ping) → 200', async () => {
  const env = { WEBHOOK_SECRET: 'sec' };
  const body = JSON.stringify({ zen: 'hi' });
  const sig = 'sha256=' + createHmac('sha256', 'sec').update(body).digest('hex');
  const mk = (s) => new Request('https://x/', { method: 'POST', body, headers: { 'x-github-event': 'ping', 'x-hub-signature-256': s } });
  assert.equal((await worker.fetch(mk('sha256=' + '0'.repeat(64)), env)).status, 401);
  assert.equal((await worker.fetch(mk(sig), env)).status, 200);
});
