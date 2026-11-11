// TRẠNG THÁI STATUS gửi về commit nguồn — `ci/lib.sh#job_state` (sửa 2026-11-11, s7-be YC-0265).
//
// ⭐ VÌ SAO BÀI THỬ NÀY ĐÁNG CÓ: đây là loại lỗi KHÔNG bao giờ làm gì đỏ, nên không có gì báo. Job bị huỷ trước
// đợt này báo `error` — commit hiện ĐỎ y như khi phép thử thật sự hỏng. Người xem không phân biệt được "mã hỏng"
// với "lần chạy bị huỷ", và mất thời gian thật đi truy một PR đỏ mà mã không có lỗi nào (đã xảy ra 2026-11-11).
//
// Hàm là shell nên bài thử gọi thẳng `bash`. Rẻ, và canh đúng thứ cần canh: ánh xạ trạng thái.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ci', 'lib.sh');
const jobState = (s) => execFileSync('bash', ['-c', `. "${LIB}"; job_state "${s}"`], { encoding: 'utf8' }).trim();

describe('job_state: trạng thái job → state của commit status', () => {
  test('⚠️ job BỊ HUỶ ⇒ pending, KHÔNG phải error', () => {
    /* Job bị huỷ không nói gì về mã — nó dừng TRƯỚC khi gate/test chạy xong. `error` là khẳng định một điều
       chưa đo. `pending` là câu trả lời đúng: "chưa biết". Đổi lại thành `error` thì bài này ĐỎ. */
    assert.equal(jobState('cancelled'), 'pending');
  });

  test('⚠️ job bị huỷ TUYỆT ĐỐI không được báo success — không cho gộp nhầm mã chưa kiểm', () => {
    assert.notEqual(jobState('cancelled'), 'success');
  });

  test('⭐ xanh ⇒ success; đỏ ⇒ failure', () => {
    assert.equal(jobState('success'), 'success');
    assert.equal(jobState('failure'), 'failure');
  });

  test('⭐ trạng thái lạ ⇒ failure (đóng, không mở) — không bao giờ coi cái chưa hiểu là xanh', () => {
    for (const x of ['skipped', 'timed_out', '', 'linh tinh']) {
      assert.equal(jobState(x), 'failure', `"${x}" phải là failure`);
    }
  });
});
