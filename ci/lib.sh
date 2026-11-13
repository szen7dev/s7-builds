# Thư viện dùng chung cho mọi workflow — nạp bằng `. "$RUNNER_TEMP/lib.sh"` (tải ở bước đầu job).
#
# ⚠️ REPO NÀY PUBLIC: log run ai cũng đọc được, kể cả LÚC ĐANG CHẠY. Nên:
#   - lệnh chạm mã nguồn private (install, gate, test, docker build, gitleaks) chạy qua `quiet`:
#     toàn bộ output vào $LOGDIR, log công khai chỉ còn một dòng ✔/✖;
#   - chi tiết lỗi (tên file test đỏ, số phát hiện gitleaks) chỉ gửi về STATUS trên commit của
#     repo nguồn private (`status`), mô tả đọc từ file — không đi qua `${{ }}`/env (GitHub in
#     nguyên giá trị env ở đầu mỗi bước);
#   - log đầy đủ đóng gói MÃ HOÁ (`pack_logs`, khoá secret LOG_KEY) → artifact; xem bằng
#     `scripts/xem-log.sh <run_id>` trên máy có khoá.

LOGDIR="$RUNNER_TEMP/logs"
DESC_FILE="$RUNNER_TEMP/status-desc"
mkdir -p "$LOGDIR"

# quiet <nhãn> <lệnh...> — chạy lệnh, output vào $LOGDIR/<nhãn>.log, in một dòng kết quả.
quiet() {
  local label="$1"; shift
  local start=$SECONDS rc=0
  "$@" >>"$LOGDIR/$label.log" 2>&1 || rc=$?
  if [ "$rc" = 0 ]; then echo "✔ $label ($((SECONDS - start))s)"; else echo "✖ $label (mã thoát $rc, $((SECONDS - start))s)"; fi
  return "$rc"
}

# set_desc <chuỗi> — mô tả chi tiết cho status kết quả (≤140 ký tự, GitHub tự cắt phần dư).
set_desc() { printf '%s' "$1" | cut -c1-140 >"$DESC_FILE"; }

# status <repo> <sha> <context> <state> <mô tả mặc định> <target_url> — cần GH_TOKEN ở env của bước gọi.
status() {
  local desc="$5"
  # `pending` lúc BẮT ĐẦU dùng mô tả mặc định; `pending` lúc KẾT THÚC (job bị huỷ) cần nói rõ vì sao
  # còn treo ⇒ cho phép `set_desc` ghi đè nếu bước gọi đã đặt mô tả.
  [ -s "$DESC_FILE" ] && desc="$(cat "$DESC_FILE")"
  gh api "repos/$1/statuses/$2" -f state="$4" -f context="$3" -f description="$desc" -f target_url="$6" >/dev/null
}

# job_state <job.status> → in "state" cho status (success|failure|error|pending).
#
# ⭐ `cancelled` ⇒ `pending`, KHÔNG phải `error` (sửa 2026-11-11, s7-be YC-0265).
#
# Job bị huỷ KHÔNG nói gì về mã: nó bị huỷ TRƯỚC khi gate/test chạy xong. Báo `error` là khẳng định một điều
# chưa đo — commit hiện ĐỎ y như khi phép thử thật sự hỏng, và người xem không phân biệt được hai ca.
# Đã mất thời gian thật vì chuyện này (2026-11-11): một PR hiện đỏ "Bị huỷ", tưởng mã hỏng, truy mất nhiều phút
# mới ra là lần chạy bị huỷ do có lượt gộp khác chen vào.
#
# `pending` là câu trả lời ĐÚNG: "chưa biết". Nó cũng không cho gộp nhầm như `success` giả, và lần chạy mới
# (nếu có) sẽ ghi đè bằng kết quả thật. Không bao giờ dùng `success` cho job bị huỷ.
job_state() { case "$1" in success) echo success ;; cancelled) echo pending ;; *) echo failure ;; esac; }

# gitleaks_scan <thư mục> — quét cây mã HIỆN TẠI (không quét lịch sử), `--redact` để báo cáo không
# chứa giá trị bí mật. Không bao giờ làm đỏ job — chỉ báo qua status riêng. Ghi ra $RUNNER_TEMP:
#   gitleaks-count (tổng) · gitleaks-real (số NGOÀI thư mục/tệp test) · gitleaks-where (file:dòng
#   ngoài test). Phát hiện trong test là dữ liệu giả của phép thử (s7-be có 13 mẫu kiểu
#   `password: 'mat-khau-hop-le-2026'`) — không làm đỏ status, tránh ❌ thường trực khiến cảnh báo
#   thật bị lờ đi.
GITLEAKS_VERSION=8.30.1
GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
# Dự phòng khi tải bản phát hành từ github.com lỗi (2026-11-08: releases trả 504 liên tục, chặn mọi lần dựng ảnh) — image chính chủ
# trên ghcr.io, CÙNG phiên bản, ghim theo digest (thay cho kiểm sha256 tarball).
GITLEAKS_IMAGE=ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f
gitleaks_scan() {
  local dir="$1" tgz="$RUNNER_TEMP/gitleaks.tgz" report="$LOGDIR/gitleaks.json"
  local -a gl scan_args
  if curl -fsSL --retry 4 --retry-all-errors --retry-delay 5 -o "$tgz" \
       "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
     && echo "$GITLEAKS_SHA256  $tgz" | sha256sum -c --quiet; then
    tar -xzf "$tgz" -C "$RUNNER_TEMP" gitleaks
    gl=("$RUNNER_TEMP/gitleaks"); scan_args=(dir "$dir" --report-path "$report")
  else
    echo "Tải gitleaks từ github.com lỗi — dùng image ghcr.io (cùng v${GITLEAKS_VERSION}, ghim digest)"
    docker pull -q "$GITLEAKS_IMAGE" >/dev/null
    gl=(docker run --rm -v "$(cd "$dir" && pwd):/scan:ro" -v "$LOGDIR:/out" "$GITLEAKS_IMAGE")
    scan_args=(dir /scan --report-path /out/gitleaks.json)
  fi
  quiet gitleaks "${gl[@]}" "${scan_args[@]}" --redact --no-banner --no-color \
    --report-format json --exit-code 0 || true
  local not_test='[.[] | select(.File | test("(^|/)(test|tests|__tests__|__mocks__|fixtures)/|\\.(test|spec)\\.[cm]?[jt]sx?$") | not)]'
  jq 'length' "$report" >"$RUNNER_TEMP/gitleaks-count" 2>/dev/null || echo "?" >"$RUNNER_TEMP/gitleaks-count"
  jq "$not_test | length" "$report" >"$RUNNER_TEMP/gitleaks-real" 2>/dev/null || echo "?" >"$RUNNER_TEMP/gitleaks-real"
  jq -r "$not_test | [.[] | \"\\(.File | ltrimstr(\"./\")):\\(.StartLine)\"] | unique | join(\", \")" "$report" \
    >"$RUNNER_TEMP/gitleaks-where" 2>/dev/null || true
  echo "gitleaks: $(cat "$RUNNER_TEMP/gitleaks-count") phát hiện, $(cat "$RUNNER_TEMP/gitleaks-real") ngoài test"
}

# gitleaks_status <repo> <sha> <target_url> — gửi status `s7-builds/secrets`. Cần GH_TOKEN.
gitleaks_status() {
  local n real
  n="$(cat "$RUNNER_TEMP/gitleaks-count" 2>/dev/null || echo "?")"
  real="$(cat "$RUNNER_TEMP/gitleaks-real" 2>/dev/null || echo "?")"
  if [ "$real" = 0 ]; then
    local d="gitleaks: không thấy bí mật trong mã"
    [ "$n" != 0 ] && d="gitleaks: không có ngoài test ($n mẫu dữ liệu giả trong test)"
    gh api "repos/$1/statuses/$2" -f state=success -f context=s7-builds/secrets \
      -f description="$d" -f target_url="$3" >/dev/null
  else
    gh api "repos/$1/statuses/$2" -f state=failure -f context=s7-builds/secrets \
      -f description="$(printf 'gitleaks %s ngoài test: %s' "$real" "$(cat "$RUNNER_TEMP/gitleaks-where" 2>/dev/null)" | cut -c1-140)" \
      -f target_url="$3" >/dev/null
  fi
}

# pack_logs — nén $LOGDIR rồi mã hoá AES-256 bằng LOG_KEY (env của bước gọi) → $RUNNER_TEMP/logs.enc.
pack_logs() {
  [ -n "$LOG_KEY" ] || { echo "Thiếu LOG_KEY — bỏ qua đóng gói log"; return 0; }
  tar -czf "$RUNNER_TEMP/logs.tgz" -C "$LOGDIR" .
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:LOG_KEY \
    -in "$RUNNER_TEMP/logs.tgz" -out "$RUNNER_TEMP/logs.enc"
  rm -f "$RUNNER_TEMP/logs.tgz"
}
