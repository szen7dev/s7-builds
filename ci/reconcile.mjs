// LƯỚI AN TOÀN KHI WEBHOOK TRỄ / MẤT (LOI-0018, 2026-11-09) — chạy theo lịch (`reconcile.yml`, 10 phút một lần).
//
// GitHub từng gửi webhook push trễ 1–2 giờ ⇒ commit gộp main nằm im, prod chạy bản cũ cho tới khi có người kích tay. Ở đây:
// đỉnh `main` của mỗi ảnh mà QUÁ `MIN_AGE_MIN` phút vẫn chưa có status dựng ảnh nào, VÀ từ commit gần nhất ĐÃ có status tới
// đỉnh có tệp thuộc ảnh đổi ⇒ tự kích `build-image.yml` cho đỉnh (dựng đỉnh = có đủ mọi thay đổi trước nó).
// Webhook trễ tới sau đó vẫn kích thêm một lượt cùng commit — `build-image.yml` bỏ qua lượt trùng (đã gắn `main-` cho
// commit này rồi) nên không khởi động lại pod lần hai.
//
// Không tự dựng lại khi status là failure/error — dựng hỏng thì sửa mã, kích lại vòng vòng chỉ tốn phút.
// ⚠️ Repo PUBLIC: log chỉ in tên ảnh, sha 7 ký tự, kết luận — không in tên tệp.
import { SOURCE_REPO, STATUS_CONTEXT, touchesImage } from './image-paths.mjs';

/** Chờ webhook đường chính bấy nhiêu phút trước khi tự kích — webhook bình thường tới trong vài giây, dựng ảnh ~5–8 phút. */
export const MIN_AGE_MIN = 10;
/** Số commit gần nhất của main lục tìm commit đã có status — quá xa thì để người xem (không tự dựng mù). */
export const LOOKBACK = 30;

/**
 * Quyết định cho MỘT ảnh — hàm thuần để test.
 * @param {{ tipAgeMin: number, tipHasStatus: boolean, baseFound: boolean, filesSinceBase: string[]|null }} s
 * @returns {{ action: 'dispatch'|'skip', reason: string }}
 */
export function reconcileDecision(app, s) {
  if (s.tipHasStatus) return { action: 'skip', reason: 'dinh_da_co_status' };
  if (s.tipAgeMin < MIN_AGE_MIN) return { action: 'skip', reason: 'cho_webhook' };
  if (!s.baseFound) return { action: 'skip', reason: `khong_thay_commit_co_status_trong_${LOOKBACK}` };
  if (!touchesImage(app, s.filesSinceBase)) return { action: 'skip', reason: 'khong_doi_anh_tu_lan_dung_truoc' };
  return { action: 'dispatch', reason: 'webhook_tre_hoac_mat' };
}

async function gh(token, path, init = {}) {
  const res = await fetch(`https://api.github.com/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
      'user-agent': 's7-builds', ...(init.body ? { 'content-type': 'application/json' } : {}) },
  });
  if (!res.ok && res.status !== 204) throw new Error(`${init.method ?? 'GET'} ${path.split('?')[0]} → HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}

const hasContext = async (token, repo, sha, ctx) =>
  ((await gh(token, `repos/${repo}/commits/${sha}/status?per_page=100`)).statuses ?? []).some((x) => x.context === ctx);

async function reconcileApp(token, app, now = Date.now()) {
  const repo = SOURCE_REPO[app];
  const ctx = STATUS_CONTEXT[app];
  const commits = await gh(token, `repos/${repo}/commits?sha=main&per_page=${LOOKBACK}`);
  const tip = commits[0];
  const tipAgeMin = (now - new Date(tip.commit.committer.date).getTime()) / 60000;
  const tipHasStatus = await hasContext(token, repo, tip.sha, ctx);
  let base = null;
  let filesSinceBase = [];
  if (!tipHasStatus && tipAgeMin >= MIN_AGE_MIN) {
    for (const c of commits.slice(1)) if (await hasContext(token, repo, c.sha, ctx)) { base = c; break; }
    if (base) {
      const cmp = await gh(token, `repos/${repo}/compare/${base.sha}...${tip.sha}?per_page=300`);
      const files = (cmp.files ?? []).map((f) => f.filename);
      filesSinceBase = files.length >= 300 ? null : files;
    }
  }
  const d = reconcileDecision(app, { tipAgeMin, tipHasStatus, baseFound: !!base, filesSinceBase });
  console.log(`${app}: đỉnh ${tip.sha.slice(0, 7)} (${Math.round(tipAgeMin)} phút) ⇒ ${d.action} (${d.reason})`);
  // DRY_RUN=1: chỉ in kết luận, không kích dựng / không đặt status — để chạy thử trên máy dev với token thật.
  if (d.action === 'dispatch' && process.env.DRY_RUN !== '1') {
    await gh(token, 'repos/szen7dev/s7-builds/actions/workflows/build-image.yml/dispatches',
      { method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { app, sha: tip.sha, ref_name: 'main' } }) });
    await gh(token, `repos/${repo}/statuses/${tip.sha}`, { method: 'POST', body: JSON.stringify({
      state: 'pending', context: ctx, description: 'Webhook trễ/mất — reconcile tự xếp hàng dựng ảnh',
      target_url: 'https://github.com/szen7dev/s7-builds/actions/workflows/build-image.yml' }) });
  }
  return d;
}

if (process.argv[1]?.endsWith('reconcile.mjs')) {
  const token = process.env.GH_TOKEN;
  let failed = false;
  for (const app of ['be', 'fe', 'stt']) {
    try { await reconcileApp(token, app); } catch (e) { failed = true; console.log(`✖ ${app}: ${e.message}`); }
  }
  if (failed) process.exit(1);
}
