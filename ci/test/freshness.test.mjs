// LOI-0018 — luật gắn tag `main-` và lưới an toàn reconcile. Chạy: `node --test ci/test/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshnessVerdict } from '../freshness.mjs';
import { reconcileDecision, MIN_AGE_MIN } from '../reconcile.mjs';
import { IMAGE_PATHS, touchesImage } from '../image-paths.mjs';
import { RELAY_IMAGE_PATHS } from '../../relay/src/index.js';

const cmp = (status, files) => ({ status, files: files?.map((filename) => ({ filename })) });

test('đỉnh main ⇒ gắn tag', () => {
  assert.equal(freshnessVerdict('fe', cmp('identical', [])).latest, true);
});

test('⭐ sự cố 2026-11-09: commit cũ dựng muộn, main đã có commit mới đổi src ⇒ KHÔNG gắn tag (không lùi prod)', () => {
  const v = freshnessVerdict('fe', cmp('ahead', ['src/pages/store/PartnerOrderReports.tsx']));
  assert.equal(v.latest, false);
  assert.equal(v.reason, 'main_co_commit_moi_hon_doi_anh');
});

test('⭐ sau commit chỉ có commit docs/bot ⇒ VẪN gắn tag (không để prod đứng yên)', () => {
  assert.equal(freshnessVerdict('be', cmp('ahead', ['docs/CHECKLIST-TONG-QUAN.md', 'docs/specs/x.md'])).latest, true);
});

test('BE: commit mới hơn chỉ đổi workers/stt ⇒ ảnh be vẫn là mới nhất; ảnh stt thì không', () => {
  const c = cmp('ahead', ['workers/stt/worker.py']);
  assert.equal(freshnessVerdict('be', c).latest, true);
  assert.equal(freshnessVerdict('stt', c).latest, false);
});

test('commit không nằm trên main (behind / diverged) ⇒ không gắn tag', () => {
  assert.equal(freshnessVerdict('be', cmp('behind', [])).latest, false);
  assert.equal(freshnessVerdict('be', cmp('diverged', ['docs/a.md'])).latest, false);
});

test('compare cắt 300 tệp ⇒ coi như có đổi ảnh', () => {
  const many = Array.from({ length: 300 }, (_, i) => `docs/f${i}.md`);
  assert.equal(freshnessVerdict('be', cmp('ahead', many)).latest, false);
});

test('reconcile: đỉnh chưa có status, quá hạn chờ, có đổi ảnh ⇒ dispatch', () => {
  assert.equal(reconcileDecision('be', { tipAgeMin: MIN_AGE_MIN + 1, tipHasStatus: false, baseFound: true, filesSinceBase: ['src/a.js'] }).action, 'dispatch');
});

test('reconcile: còn trong thời gian chờ webhook / đã có status / chỉ docs / không tìm được mốc ⇒ bỏ qua', () => {
  const base = { tipAgeMin: MIN_AGE_MIN + 1, tipHasStatus: false, baseFound: true, filesSinceBase: ['src/a.js'] };
  assert.equal(reconcileDecision('be', { ...base, tipAgeMin: 3 }).action, 'skip');
  assert.equal(reconcileDecision('be', { ...base, tipHasStatus: true }).action, 'skip');
  assert.equal(reconcileDecision('be', { ...base, filesSinceBase: ['docs/x.md'] }).action, 'skip');
  assert.equal(reconcileDecision('be', { ...base, baseFound: false }).action, 'skip');
});

test('danh sách đường dẫn ảnh khớp relay (relay không cần deploy lại khi workflow đổi)', () => {
  assert.deepEqual(IMAGE_PATHS, RELAY_IMAGE_PATHS);
  assert.equal(touchesImage('fe', null), true);
});
