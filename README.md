# s7-builds

Repo **public** dựng/kiểm tra cho các repo private `s7-be`, `s7-fe`, `s7-app` — chạy GitHub Actions miễn phí,
repo nguồn không tốn phút nào.

```
push/PR ở repo nguồn ──webhook──► Cloudflare Worker `s7-builds-relay` (relay/)
        kiểm chữ ký HMAC, lọc nhánh main + paths ──► status "pending" trên commit + workflow_dispatch
s7-builds: build-image (be|fe) → ghcr.io/szen7dev/s7-<app>:main-<run_id>-<sha7>
           test-be (gate + test + checklist PR) · ci-app (typecheck/lint/test)
           ──► status s7-builds/{image,test,checklist,ci} gửi về đúng commit nguồn
ImageUpdater (s7-kubernetes-prod) nhận tag mới → ArgoCD rollout — phía GitOps không đổi gì.
cleanup: xoá run xanh ngay, run đỏ/huỷ xoá lúc 00:00 (log của repo public ai cũng đọc được).
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
| Worker | `GH_TOKEN` | cùng PAT trên |
| Worker + webhook 3 repo nguồn | `WEBHOOK_SECRET` | chuỗi ký webhook |
| ghcr package s7-be, s7-fe | Manage Actions access | thêm `s7-builds` quyền **Write** (để `GITHUB_TOKEN` đẩy được ảnh) |

PAT có hạn — hết hạn thì mọi commit hiện status ❌ "Không kích được s7-builds (HTTP 401)".

## An toàn khi repo public
- Mọi job có `if: github.repository == 'szen7dev/s7-builds'`; không workflow nào chạy theo `pull_request`.
- Workflow từ PR fork phải được duyệt tay (fork PR approval = all external contributors).
- Cache Docker để ở ghcr (private), **không** dùng `type=gha` — cache Actions repo public có thể bị đọc từ PR fork.

## Worker
```bash
cd relay && npm i && npm test && npx wrangler deploy
```
Bộ lọc paths nằm ở đầu `relay/src/index.js` — Dockerfile repo nguồn COPY thêm thư mục thì nhớ thêm vào đây.
