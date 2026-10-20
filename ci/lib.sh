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
  [ -s "$DESC_FILE" ] && [ "$4" != pending ] && desc="$(cat "$DESC_FILE")"
  gh api "repos/$1/statuses/$2" -f state="$4" -f context="$3" -f description="$desc" -f target_url="$6" >/dev/null
}

# job_state <job.status> → in "state" cho status (success|failure|error).
job_state() { case "$1" in success) echo success ;; cancelled) echo error ;; *) echo failure ;; esac; }

# gitleaks_scan <thư mục> — quét cây mã HIỆN TẠI (không quét lịch sử), `--redact` để báo cáo không
# chứa giá trị bí mật. Không bao giờ làm đỏ job — chỉ báo qua status riêng. Ghi ra $RUNNER_TEMP:
#   gitleaks-count (tổng) · gitleaks-real (số NGOÀI thư mục/tệp test) · gitleaks-where (file:dòng
#   ngoài test). Phát hiện trong test là dữ liệu giả của phép thử (s7-be có 13 mẫu kiểu
#   `password: 'mat-khau-hop-le-2026'`) — không làm đỏ status, tránh ❌ thường trực khiến cảnh báo
#   thật bị lờ đi.
GITLEAKS_VERSION=8.30.1
GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
gitleaks_scan() {
  local dir="$1" tgz="$RUNNER_TEMP/gitleaks.tgz" report="$LOGDIR/gitleaks.json"
  curl -fsSL -o "$tgz" "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
  echo "$GITLEAKS_SHA256  $tgz" | sha256sum -c --quiet
  tar -xzf "$tgz" -C "$RUNNER_TEMP" gitleaks
  quiet gitleaks "$RUNNER_TEMP/gitleaks" dir "$dir" --redact --no-banner --no-color \
    --report-format json --report-path "$report" --exit-code 0 || true
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
