# s7-builds

Repo **public** dựng/kiểm tra cho các repo private `s7-be`, `s7-fe`, `s7-app` — chạy GitHub Actions miễn phí,
repo nguồn không tốn phút nào.

```
push/PR ở repo nguồn ──webhook──► Cloudflare Worker `s7-builds-relay` (relay/)
        kiểm chữ ký HMAC, lọc nhánh main + paths ──► status "pending" trên commit + workflow_dispatch
s7-builds: build-image (be|fe) → ghcr.io/szen7dev/s7-<app>:main-<run_id>-<sha7>
           test-be (gate + test + checklist PR) · ci-app (typecheck/lint/test)
           ──► status s7-builds/{image,test,checklist,ci,secrets} gửi về đúng commit nguồn
ImageUpdater (s7-kubernetes-prod) nhận tag mới → ArgoCD rollout — phía GitOps không đổi gì.
cleanup: xoá run xanh ngay, run đỏ/huỷ xoá lúc 00:00 (lớp phụ — log đã không chứa mã private).
```

## Chạy tay (khi webhook/Worker trục trặc)

```bash
gh workflow run build-image.yml --repo szen7dev/s7-builds -f app=be -f sha=<full sha>
gh workflow run test-be.yml     --repo szen7dev/s7-builds -f sha=<full sha> [-f base=main]
gh workflow run ci-app.yml      --repo szen7dev/s7-builds -f sha=<full sha>
```

## Bí mật

| Ở đâu | Tên | Là gì |
|---|---|---|
| s7-builds (Actions secret) | `SRC_TOKEN` | fine-grained PAT: Contents R + Commit statuses RW trên s7-be/s7-fe/s7-app, Actions RW trên s7-builds |
| s7-builds (Actions secret) | `LOG_KEY` | khoá mã hoá log đầy đủ của run đỏ (artifact `logs-encrypted`); bản sao ở máy dev `~/.s7-builds-logkey` |
| Worker | `GH_TOKEN` | cùng PAT trên |
| Worker + webhook 3 repo nguồn | `WEBHOOK_SECRET` | chuỗi ký webhook |
| ghcr package s7-be, s7-fe | Manage Actions access | thêm `s7-builds` quyền **Write** (để `GITHUB_TOKEN` đẩy được ảnh) |

PAT có hạn — hết hạn thì mọi commit hiện status ❌ "Không kích được s7-builds (HTTP 401)".

## An toàn khi repo public
- Mọi job có `if: github.repository == 'szen7dev/s7-builds'`; không workflow nào chạy theo `pull_request`.
- Workflow từ PR fork phải được duyệt tay (fork PR approval = all external contributors).
- Cache Docker để ở ghcr (private), **không** dùng `type=gha` — cache Actions repo public có thể bị đọc từ PR fork.
- **Log không in mã private** (kể cả lúc run ĐANG chạy — ai cũng xem trực tiếp được): install/gate/test/
  docker build/gitleaks chạy qua `quiet` trong `ci/lib.sh`, log công khai chỉ có dòng ✔/✖ + số pass/fail.
  Chi tiết (tên file test đỏ, file:dòng gitleaks) gửi về **mô tả status trên commit private**; log đầy đủ
  của run đỏ là artifact **mã hoá** 1 ngày → `scripts/xem-log.sh <run_id>`.
- Checkout `fetch-depth: 1` + fetch lịch sử **im lặng** (`git fetch -q`) — `fetch-depth: 0` in tên mọi nhánh.
- `SRC_TOKEN` chỉ nằm ở env của bước checkout/fetch/status — `npm ci`/`yarn install` (script cài đặt của
  thư viện bên thứ ba) và `docker build` không đọc được. Action bên thứ ba ghim theo **SHA**.
- Không gọi `docker/build-push-action` (tự đính bản ghi build + summary vào run công khai) — gọi thẳng `docker buildx build`.
- Không ghi bất kỳ chuỗi giống khoá nào vào file (JWT test sinh ngẫu nhiên mỗi run).
- `gitleaks` (`--redact`) quét cây mã be/fe (build-image) và app (ci-app) → status `s7-builds/secrets`,
  **không chặn** build/deploy. Chỉ ra số lượng ở log công khai; file:dòng ở status commit private.
  Phát hiện chỉ nằm trong `test/`, `*.test.*`, `fixtures/`… (dữ liệu giả của phép thử) ⇒ status vẫn xanh,
  mô tả ghi số mẫu; có phát hiện NGOÀI test mới đỏ.

## Xem log đầy đủ của run đỏ
```bash
scripts/xem-log.sh <run_id>     # cần ~/.s7-builds-logkey; giải vào ./log-<run_id>/
```

## Worker
```bash
cd relay && npm i && npm test && npx wrangler deploy
```
Bộ lọc paths nằm ở đầu `relay/src/index.js` — Dockerfile repo nguồn COPY thêm thư mục thì nhớ thêm vào đây.
