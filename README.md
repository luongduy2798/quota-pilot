# Quota Pilot

Dashboard Codex gồm Accounts, Quota Tracker, Scheduler. Một Node service duy nhất: SQLite file, scheduler chạy trong process, gọi trực tiếp `auth.openai.com` và `chatgpt.com`. Docker là cách chạy local và production.

## Ubuntu / Docker

Yêu cầu Docker Engine và Docker Compose. SQLite dùng `node:sqlite`, nên chạy Node 22.5+ nếu chạy ngoài Docker.

```sh
npm run setup
```

Lệnh trên tạo `.env`, hỏi mật khẩu admin, sinh encryption key và session secret. Sửa `APP_ORIGIN` thành hostname HTTPS thật trước khi mở public. Giữ `CODEX_REDIRECT_URI=http://localhost:1455/auth/callback`; OAuth client hiện chỉ cho phép localhost.

Chạy service:

```sh
docker compose up -d --build
```

SQLite nằm trong volume `quota-pilot-data`; restart hoặc deploy lại không mất account. Health check: `GET /healthz`. Cổng mặc định `8788`; đặt reverse proxy HTTPS phía trước nếu cần domain public.

## Local development

```sh
npm install
npm run setup
npm run dev
```

Local cũng chạy đúng Node service, lưu DB ở `./data/quota-pilot.sqlite`, gọi upstream trực tiếp và tự chạy scheduler mỗi phút.

`npm run dev` chạy dashboard và scheduler; OAuth callback dùng extension trong thư mục `extension/`.

## OAuth

Đăng nhập ở Accounts → Connect. Provider redirect về `http://localhost:1455/auth/callback`, vì OAuth client chỉ cho phép localhost. Tải `quota-pilot-oauth-extension.zip` từ dashboard, giải nén, rồi vào `chrome://extensions` → Developer mode → Load unpacked và chọn thư mục đã giải nén. Extension chỉ bắt callback localhost rồi chuyển `code/state` về dashboard; không xử lý quota hoặc credential. Không cần đăng ký redirect URI public. `CODEX_REDIRECT_URI` giữ nguyên `http://localhost:1455/auth/callback`.

## Account và quota

Credential mã hóa AES-256-GCM. Codex OAuth tự refresh khi token sắp hết hạn; refresh có lock để tránh nhiều request cùng đổi token. Quota lưu snapshot, giữ snapshot cũ khi upstream lỗi, cooldown request thủ công tối đa một lần/phút. Custom provider chỉ kiểm tra `GET /models`.

Accounts hỗ trợ import backup JSON hoặc DB SQLite 9Router trực tiếp trên server; file giới hạn 25 MB. Không cần cài `sqlite3` CLI.

## Scheduler

Process tick mỗi phút, claim occurrence bằng transaction SQLite và unique `(schedule_id, occurrence_at)`. Chạy trễ hơn năm phút thành `missed`; không catch-up. `Run test now` cần xác nhận quota, ghi execution history và không tự retry inference.

## Đổi mật khẩu

Tạo hash mới bằng `npm run setup` trên thư mục khác, sau đó thay `ADMIN_PASSWORD_HASH` trong `.env` và chạy:

```sh
docker compose up -d
```

Xóa session cũ bằng cách xóa file SQLite chỉ khi chấp nhận mất toàn bộ account, lịch và history.
