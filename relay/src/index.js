// s7-builds-relay — nhận webhook GitHub từ repo nguồn PRIVATE (s7-be / s7-fe / s7-app) rồi dispatch
// workflow tương ứng ở repo PUBLIC szen7dev/s7-builds (Actions miễn phí).
//
// Vì sao không dùng `trigger.yml` như trixgo-builds: một job trigger dù chỉ 10 giây vẫn bị GitHub làm tròn
// thành 1 phút tính phí trong repo private (~500 sự kiện/tuần ≈ 2.200 phút/tháng, vượt hạn mức miễn phí).
// Webhook thì không tốn phút nào.
//
// Secrets (wrangler secret put): WEBHOOK_SECRET — chuỗi ký webhook, khai giống hệt ở 3 repo nguồn;
// GH_TOKEN — fine-grained PAT (Actions RW trên s7-builds, Commit statuses RW + Contents R trên 3 repo nguồn).

const OWNER = 'szen7dev';
const BUILDS_REPO = `${OWNER}/s7-builds`;

// Bộ lọc paths chép từ `build.yml`/`test.yml` cũ của từng repo — đổi ở đây nếu Dockerfile COPY thêm thư mục.
const BE_IMAGE_PATHS = ['src/', 'scripts/', 'public/', 'templates/', 'integrations/', 'package.json', 'package-lock.json', 'Dockerfile'];
const BE_TEST_PATHS = ['src/', 'scripts/', 'test/', 'package.json', 'package-lock.json'];
// Worker Giọng nói → Văn bản (BR-07-155): ảnh RIÊNG ghcr.io/szen7dev/s7-stt dựng từ s7-be/workers/stt — ảnh API không COPY thư mục này.
const STT_IMAGE_PATHS = ['workers/stt/'];
const FE_IMAGE_PATHS = ['src/', 'public/', 'index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'nginx.conf', 'Dockerfile'];

const PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('s7-builds-relay', { status: 200 });

    const body = await request.text();
    if (!(await verifySignature(env.WEBHOOK_SECRET, body, request.headers.get('x-hub-signature-256')))) {
      return json({ error: 'bad signature' }, 401);
    }

    const event = request.headers.get('x-github-event');
    const payload = JSON.parse(body);
    if (event === 'ping') return json({ ok: true, zen: payload.zen });

    const jobs = plan(event, payload);
    const results = [];
    for (const job of jobs) results.push(await dispatch(env, job));
    // GitHub ghi lại thân trả lời ở mục "Recent Deliveries" của webhook — xem ở đó khi cần soi.
    const failed = results.some((r) => !r.ok);
    return json({ event, jobs: results }, failed ? 502 : 200);
  },
};

// Quyết định chạy gì cho một sự kiện. Trả về danh sách { workflow, inputs, repo, sha, context }.
export function plan(event, p) {
  const repoName = p.repository?.name;
  const jobs = [];

  if (event === 'push') {
    if (p.ref !== 'refs/heads/main' || p.deleted || /^0+$/.test(p.after || '')) return jobs;
    const sha = p.after;
    const files = changedFiles(p);
    const touches = (paths) => files === null || files.some((f) => paths.some((x) => (x.endsWith('/') ? f.startsWith(x) : f === x)));

    if (repoName === 's7-be') {
      if (touches(BE_IMAGE_PATHS)) jobs.push({ workflow: 'build-image.yml', repo: repoName, sha, context: 's7-builds/image', inputs: { app: 'be', sha, ref_name: 'main' } });
      if (touches(STT_IMAGE_PATHS)) jobs.push({ workflow: 'build-image.yml', repo: repoName, sha, context: 's7-builds/image-stt', inputs: { app: 'stt', sha, ref_name: 'main' } });
      if (touches(BE_TEST_PATHS)) jobs.push({ workflow: 'test-be.yml', repo: repoName, sha, context: 's7-builds/test', inputs: { sha, key: 'main' } });
    } else if (repoName === 's7-fe') {
      if (touches(FE_IMAGE_PATHS)) jobs.push({ workflow: 'build-image.yml', repo: repoName, sha, context: 's7-builds/image', inputs: { app: 'fe', sha, ref_name: 'main' } });
    } else if (repoName === 's7-app') {
      jobs.push({ workflow: 'ci-app.yml', repo: repoName, sha, context: 's7-builds/ci', inputs: { sha, key: 'main' } });
    }
    return jobs;
  }

  if (event === 'pull_request') {
    const pr = p.pull_request;
    if (!PR_ACTIONS.has(p.action) || pr?.state !== 'open') return jobs;
    // Chỉ PR nội bộ (repo private, không có fork) — chặn phòng hờ nếu sau này có fork.
    if (pr.head?.repo?.full_name !== p.repository?.full_name) return jobs;
    const sha = pr.head.sha;
    const key = `pr-${pr.number}`;
    if (repoName === 's7-be') {
      jobs.push({ workflow: 'test-be.yml', repo: repoName, sha, context: 's7-builds/test', inputs: { sha, base: pr.base.ref, key } });
    } else if (repoName === 's7-app') {
      jobs.push({ workflow: 'ci-app.yml', repo: repoName, sha, context: 's7-builds/ci', inputs: { sha, key } });
    }
  }
  return jobs;
}

// Tệp đổi trong một lần push. null = không chắc (không có danh sách commit) → coi như đổi tất cả, thà build thừa
// còn hơn để prod lặng lẽ chạy bản cũ.
function changedFiles(p) {
  const commits = p.commits || [];
  if (commits.length === 0 || p.forced) return null;
  const files = new Set();
  for (const c of commits) for (const f of [...(c.added || []), ...(c.modified || []), ...(c.removed || [])]) files.add(f);
  return [...files];
}

async function dispatch(env, job) {
  const res = await gh(env, `repos/${BUILDS_REPO}/actions/workflows/${job.workflow}/dispatches`, { ref: 'main', inputs: job.inputs });
  const ok = res.status === 204;
  // Đặt status ngay trên commit nguồn: dispatch lỗi thì commit hiện ❌ thay vì im lặng.
  await gh(env, `repos/${OWNER}/${job.repo}/statuses/${job.sha}`, {
    state: ok ? 'pending' : 'error',
    context: job.context,
    description: ok ? 'Đã xếp hàng ở s7-builds' : `Không kích được s7-builds (HTTP ${res.status})`,
    target_url: `https://github.com/${BUILDS_REPO}/actions/workflows/${job.workflow}`,
  });
  return { workflow: job.workflow, inputs: job.inputs, ok, status: res.status, error: ok ? undefined : await res.text() };
}

function gh(env, path, data) {
  return fetch(`https://api.github.com/${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 's7-builds-relay',
      'content-type': 'application/json',
    },
    body: JSON.stringify(data),
  });
}

async function verifySignature(secret, body, header) {
  if (!secret || !header?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  const got = header.slice(7);
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
