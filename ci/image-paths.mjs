// Đường dẫn mà Dockerfile của từng ảnh thật sự dùng — đổi tệp ngoài các đường này thì ảnh không đổi.
// ⚠️ PHẢI khớp `relay/src/index.js` (BE_IMAGE_PATHS / FE_IMAGE_PATHS / STT_IMAGE_PATHS). `ci/test/image-paths.test.mjs`
// so hai bên và đỏ khi lệch — không import thẳng từ relay để đổi workflow không bắt phải deploy lại Worker.
export const IMAGE_PATHS = {
  be: ['src/', 'scripts/', 'public/', 'templates/', 'integrations/', 'package.json', 'package-lock.json', 'Dockerfile'],
  fe: ['src/', 'public/', 'index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'nginx.conf', 'Dockerfile'],
  stt: ['workers/stt/'],
};

/** Repo nguồn của từng ảnh (stt dựng từ thư mục con của s7-be). */
export const SOURCE_REPO = { be: 'szen7dev/s7-be', fe: 'szen7dev/s7-fe', stt: 'szen7dev/s7-be' };

/** Context status trên commit nguồn của từng ảnh — trùng `build-image.yml` (STATUS_CTX). */
export const STATUS_CONTEXT = { be: 's7-builds/image', fe: 's7-builds/image', stt: 's7-builds/image-stt' };

/** Có tệp nào trong `files` thuộc đường dẫn ảnh `app` không. `files === null` (không chắc) ⇒ coi như có. */
export function touchesImage(app, files) {
  if (files === null) return true;
  const paths = IMAGE_PATHS[app];
  return files.some((f) => paths.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));
}
