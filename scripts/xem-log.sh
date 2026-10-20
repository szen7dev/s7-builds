#!/usr/bin/env bash
# Xem log ĐẦY ĐỦ của một run đỏ (log công khai chỉ có dòng ✔/✖ — xem ci/lib.sh).
#   scripts/xem-log.sh <run_id>
# Cần: gh đã đăng nhập + khoá LOG_KEY ở ~/.s7-builds-logkey (chmod 600; giống secret LOG_KEY của repo).
# Artifact chỉ giữ 1 ngày. Giải nén vào ./log-<run_id>/.
set -euo pipefail
RUN="${1:?Cách dùng: scripts/xem-log.sh <run_id>}"
KEY_FILE="${LOG_KEY_FILE:-$HOME/.s7-builds-logkey}"
[ -r "$KEY_FILE" ] || { echo "Không đọc được $KEY_FILE" >&2; exit 1; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
gh run download "$RUN" --repo szen7dev/s7-builds -n logs-encrypted -D "$TMP"
mkdir -p "log-$RUN"
LOG_KEY="$(cat "$KEY_FILE")" openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:LOG_KEY \
  -in "$TMP/logs.enc" | tar -xzf - -C "log-$RUN"
ls -la "log-$RUN"
