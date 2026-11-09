// KIỂM ĐỘ MỚI TRƯỚC KHI GẮN TAG `main-<run>-<sha>` (LOI-0018, 2026-11-09).
//
// ⭐ Sự cố thật: GitHub gửi webhook push TRỄ tới 1–2 giờ (s7-be f47b669 gộp 09:40 UTC, webhook tới 11:24; s7-fe ec10c7b
// gộp 09:22, webhook tới 11:11). Relay vẫn kích dựng đúng commit đó ⇒ run mới có run_id LỚN HƠN run của commit mới hơn ⇒
// ImageUpdater (`updateStrategy: alphabetical` trên `main-<run_id>-<sha>`) chọn ảnh CŨ ⇒ prod s7-fe LÙI về ec10c7b, mất
// mọi thay đổi gộp sau đó (nút QR báo đơn YC-0158, landing page…).
//
// Luật: chỉ gắn `main-…` khi commit vừa dựng NẰM TRÊN `main` VÀ sau nó KHÔNG có commit nào đổi tệp thuộc ảnh này. So
// "là đỉnh main" thôi thì SAI: một commit chỉ đổi docs (bot, checklist) chen sau sẽ làm commit code thật mất tag, mà
// commit docs đó lại không kích dựng ⇒ prod đứng yên. Có commit mới hơn đổi ảnh ⇒ lượt dựng của commit ĐÓ sẽ gắn tag.
//
// ⚠️ Repo PUBLIC: chỉ in kết luận + mã lý do, KHÔNG in tên tệp / nội dung commit.
import { touchesImage } from './image-paths.mjs';

/**
 * @param {string} app be|fe|stt
 * @param {object} cmp thân JSON của GET /repos/{repo}/compare/{sha}...main
 * @returns {{ latest: boolean, reason: string }}
 */
export function freshnessVerdict(app, cmp) {
  const status = cmp?.status;
  if (status === 'identical') return { latest: true, reason: 'dinh_main' };
  // `behind`: main ĐỨNG SAU commit (commit không nằm trên main) · `diverged`: lịch sử rẽ nhánh (force-push…) — đều không phải bản main.
  if (status !== 'ahead') return { latest: false, reason: `khong_tren_main_${status ?? 'khong_ro'}` };
  const files = Array.isArray(cmp.files) ? cmp.files.map((f) => f.filename) : null;
  // API cắt ở 300 tệp ⇒ không chắc ⇒ coi như có đổi ảnh (lượt dựng commit mới hơn lo phần gắn tag).
  const truncated = files !== null && files.length >= 300;
  if (touchesImage(app, truncated ? null : files)) return { latest: false, reason: 'main_co_commit_moi_hon_doi_anh' };
  return { latest: true, reason: 'chi_commit_khong_doi_anh_sau_no' };
}

async function compareWithRetry(repo, sha, token, fetchImpl = fetch, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/compare/${sha}...main?per_page=300`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 's7-builds' },
      });
      if (res.ok) return await res.json();
      last = `HTTP ${res.status}`;
    } catch (e) { last = e?.message ?? String(e); }
    await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
  }
  throw new Error(`compare lỗi: ${last}`);
}

// CLI: APP, SRC_REPO, SRC_SHA, GH_TOKEN ở env ⇒ ghi `latest=…` + `reason=…` vào $GITHUB_OUTPUT. Lỗi API ⇒ thoát 1
// (bước gọi đánh ❌ status — KHÔNG đoán: gắn bừa có thể lùi prod, bỏ bừa có thể làm prod đứng yên).
if (process.argv[1]?.endsWith('freshness.mjs')) {
  const { APP, SRC_REPO, SRC_SHA, GH_TOKEN, GITHUB_OUTPUT } = process.env;
  try {
    const v = freshnessVerdict(APP, await compareWithRetry(SRC_REPO, SRC_SHA, GH_TOKEN));
    const out = `latest=${v.latest}\nreason=${v.reason}\n`;
    if (GITHUB_OUTPUT) (await import('node:fs')).appendFileSync(GITHUB_OUTPUT, out); else process.stdout.write(out);
    console.log(`độ mới: latest=${v.latest} (${v.reason})`);
  } catch (e) {
    console.log(`✖ không kiểm được độ mới: ${e.message}`);
    process.exit(1);
  }
}
