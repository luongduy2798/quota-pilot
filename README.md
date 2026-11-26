# Quota Pilot

Dashboard Codex gồm Accounts, Quota Tracker, Scheduler. Một Node service duy nhất: SQLite file, scheduler chạy trong process, gọi trực tiếp `auth.openai.com` và `chatgpt.com`. Docker là cách chạy local và production.

## Ubuntu / Docker

Cùng mô hình triển khai với Viora: SSH qua Tailscale để quản trị; Docker Compose chạy app và Cloudflare Tunnel phục vụ `https://quota.chillix.me`. Tunnel chuyển request thẳng đến `quota-pilot:8788`; Node phục vụ cả giao diện và API. HTTPS do Cloudflare xử lý, không cần mở cổng router hay thêm Caddy.

Ubuntu cần Docker Engine, Compose v2, Git, Make và CLI `cloudflared` (dùng các công cụ đã cài cho Viora nếu cùng server). Không cần Node/npm trên host. Image dùng Node 24.16 vì chức năng import SQLite cần `DatabaseSync.deserialize()`.

### Cài mới

SSH vào Ubuntu, clone repository rồi tạo cấu hình:

```sh
ssh <USER>@<IP_TAILSCALE>
git clone <REPOSITORY_URL> quota-pilot
cd quota-pilot
make setup
```

`make setup` tạo `.env` quyền `0600` với mật khẩu admin đã băm, key, session secret, origin `https://quota.chillix.me` và UID/GID của người chạy. Lệnh giữ `.env` hiện có và chuẩn bị `deploy/cloudflared.yml` từ mẫu nếu thiếu. Profile `tunnel` bật mặc định. Đặt `COMPOSE_PROFILES=` trong `.env` để chỉ chạy local. Giữ `CODEX_REDIRECT_URI=http://localhost:1455/auth/callback`.

Tạo tunnel riêng cho Quota Pilot:

```sh
cloudflared tunnel login
cloudflared tunnel create quota-pilot
```

Mở URL đăng nhập được in ra bằng trình duyệt trên máy cá nhân, chọn zone `chillix.me`. Trỏ DNS vào tunnel vừa tạo rồi khởi động:

```sh
cloudflared tunnel route dns quota-pilot quota.chillix.me
make up
```

Nếu `quota.chillix.me` đang có bản ghi DNS cũ, thay riêng bản ghi đó để trỏ tunnel mới; không sửa root `chillix.me` hay hostname của Viora. Tunnel và credential riêng của Quota Pilot không dùng chung với Viora. Credential và cấu hình tunnel được loại khỏi Git và Docker build context.

Mở `https://quota.chillix.me`; kiểm tra service bằng `https://quota.chillix.me/healthz`. Extension OAuth cài trên Chrome máy cá nhân, Ubuntu không cần trình duyệt.

### Cập nhật và logs

```sh
cd quota-pilot
make pull
make ps
```

`make pull` cập nhật Git bằng `--ff-only` rồi gọi `make upgrade`. `make upgrade` triển khai code đang có và tạo lại connector nếu profile `tunnel` đang bật. `make run` là bí danh của `make up`. Dùng `make build` để chỉ build, `make logs` để xem log, `make restart` để khởi động lại container và `make down` để dừng stack. Dữ liệu SQLite nằm trong volume `quota-pilot-data`. Giữ `.env`, nhất là `ENCRYPTION_KEY`. Cổng host bind `127.0.0.1:8788`.

`make up` và `make upgrade` chờ `/healthz` rồi gọi `make tunnel` khi profile `tunnel` đang bật. `make tunnel` có thể chạy riêng khi app đã chạy. Lần đầu, lệnh điền UUID của `quota-pilot` vào cấu hình từ mẫu. Khi thiếu credential hoặc Cloudflare báo `Invalid tunnel secret`, lệnh lấy lại credential cho UUID đã xác nhận và tạo lại riêng `cloudflared`. Dùng cùng user đã chạy `make setup` và đã đăng nhập CLI Cloudflare trên Ubuntu.

### Sao lưu SQLite

Backup online bằng API SQLite có sẵn, không cần `sqlite3` CLI:

```sh
docker compose exec quota-pilot node --input-type=module -e 'import { DatabaseSync, backup } from "node:sqlite"; const db = new DatabaseSync("/data/quota-pilot.sqlite"); try { await backup(db, "/data/quota-pilot.backup.sqlite"); } finally { db.close(); }'
docker compose cp quota-pilot:/data/quota-pilot.backup.sqlite ./quota-pilot.backup.sqlite
```

Sao lưu cả `.env` vào nơi riêng tư; thiếu key gốc sẽ không giải mã được credential trong database.

## Local development

Máy local dùng Node 24.16 trở lên:

```sh
npm install
npm run setup
npm run dev
```

Local cũng chạy đúng Node service, lưu DB ở `./data/quota-pilot.sqlite`, gọi upstream trực tiếp và tự chạy scheduler mỗi phút.

## OAuth

1. Clone hoặc tải repo [OpenAI OAuth Relay](https://github.com/luongduy2798/openai-oauth-relay). Mở `chrome://extensions`, bật **Developer mode**, chọn **Load unpacked** rồi chọn thư mục repo.
2. Trong OpenAI OAuth Relay, thêm địa chỉ dashboard đang dùng, kèm cổng nếu có. Cấp quyền Chrome, bật relay rồi tải lại dashboard.
3. Vào **Accounts** và bấm **Connect** để đăng nhập Codex.

Giữ `CODEX_REDIRECT_URI` là `http://localhost:1455/auth/callback`. OpenAI OAuth Relay chuyển callback từ localhost về dashboard.

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

Muốn đăng xuất tất cả phiên cũ, thay `SESSION_SECRET` bằng giá trị ngẫu nhiên mới rồi cập nhật container. Giữ nguyên `ENCRYPTION_KEY` và database.
