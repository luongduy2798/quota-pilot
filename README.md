# Quota Pilot

Ứng dụng độc lập theo dõi tài khoản Claude Code/Codex, quota thật và lịch chạy inference do server xử lý. Gồm đúng ba tab: **Accounts**, **Quota Tracker**, **Scheduler**. React/Vite static assets + Cloudflare Workers + D1 + Cron Triggers; frontend không nhận API key hoặc OAuth token.

## Chạy local

Yêu cầu Node.js 20.19+ (hoặc 22.12+) và npm.

```sh
npm install
npm run setup
npm run dev
```

`npm run setup` hỏi password quản trị và sinh `.dev.vars` chứa PBKDF2 hash, AES-256-GCM key, session secret. File được tạo với mode `0600`, bị `.gitignore`; cần sao lưu `.dev.vars` an toàn vì mất encryption key khiến credentials đã lưu không đọc được. `npm run dev` build Vite, tạo DB D1 local độc lập, chạy Workers trên `http://127.0.0.1:8788` và gọi Cron endpoint mỗi phút (Wrangler không tự chạy Cron trong local mode). Trên deploy, Cloudflare Cron Trigger chạy độc lập với trình duyệt. Cổng cục bộ là `8788`; 9Router đang cài dùng cổng riêng. Tab Accounts hỗ trợ import Claude Code/Codex OAuth từ file backup JSON hoặc DB SQLite của 9Router; dừng 9Router trước khi đọc DB SQLite. Account trùng upstream ID được bỏ qua, credential đang có không bị ghi đè.

## OAuth

Tab Accounts → Connect. Đăng nhập ở provider, copy callback URL trên thanh địa chỉ và dán lại nếu trình duyệt không truy cập được loopback. Authorization code, PKCE verifier, đổi token và mã hóa credentials đều ở server. Tài khoản được nhận diện bằng upstream ID; reconnect không tạo trùng. Nhiều tài khoản cùng provider được tách riêng.

Codex dùng cùng flow cục bộ của 9Router/LCA: app mở popup, listener local tại `http://localhost:1455/auth/callback` nhận callback rồi chuyển vào Worker; popup tự đóng sau khi server đổi code. Nếu cổng 1455 đang do 9Router/LCA giữ, hãy đóng phiên OAuth đang chạy rồi khởi động lại app. Nếu OAuth app chấp nhận một callback khác, đặt `CODEX_REDIRECT_URI` đúng URI đã đăng ký; khi đó cần hoàn tất callback theo hướng dẫn thủ công. Claude mặc định gọi callback `APP_ORIGIN/api/oauth/claude/callback`; override bằng `CLAUDE_REDIRECT_URI` khi dùng redirect URI đăng ký khác. Hosted OAuth cần public HTTPS hostname và URI khớp registration trước khi connect.

Local 9Router đánh dấu Claude Code OAuth **deprecated / RISK_NOTICE**. Scheduler Claude được chặn mặc định; chỉ bật `CLAUDE_SCHEDULER_ENABLED=true` khi sư tổ xác minh quyền dùng OAuth subscription inference theo điều khoản và tài khoản của mình. Codex scheduler chỉ gửi inference thật qua Codex model registry.

## Accounts và quota

Chỉ hỗ trợ hai OAuth provider Claude/Codex và hai custom kind OpenAI-compatible/Anthropic-compatible. Credential mã hóa AES-256-GCM với ID bản ghi làm AAD, API luôn mask keys. Local app nhập Claude Code/Codex OAuth từ backup JSON hoặc DB SQLite của 9Router qua nút trong Accounts; account trùng upstream ID bị bỏ qua và token hiện có không bị ghi đè. Với DB SQLite, chọn `~/.9router/db/data.sqlite` sau khi tắt 9Router. OAuth quota được lưu theo account, trả `Unknown` nếu upstream không trả window; giữ snapshot cũ rõ `stale` khi poll lỗi. Poll thủ công tối đa một lần/phút, lỗi 429 có cooldown ba phút. Window 5h và weekly độc lập; reset hiển thị đúng timestamp upstream. Custom providers không có quota API tương thích chuẩn nên hiển thị `Not available`. Test cả hai loại custom provider gọi GET `/models`, không gửi inference.

Khai báo chính xác custom provider hostname trong `CUSTOM_PROVIDER_HOSTS`; mặc định chỉ có `api.openai.com` và `api.anthropic.com`. Chỉ HTTPS, host allowlist, DNS public, redirect tắt, không thể gọi localhost/private/internal IP. Provider khác cần thêm domain được kiểm soát vào allowlist. API key không được dùng cho scheduler.

## Scheduler và quota

Ví dụ: tạo `07:00 Asia/Ho_Chi_Minh`, chọn account Codex, model có sẵn, chạy mỗi ngày. Server Cron chạy mỗi phút, lưu lần đến hạn bằng UTC, timezone-aware occurrence và unique `(schedule, occurrence)`. DST nonexistent time bị bỏ; repeated time chạy lần đầu. Chạy trễ tối đa 5 phút; chạy trễ hơn thành `missed`, không catch-up sau downtime. Tối đa hai occurrence mỗi phút trên free plan.

Mỗi lần chạy gửi tối đa một request inference ngắn. `Run test now` cảnh báo quota consumption, có xác nhận và idempotency key. Lỗi HTTP/quota/auth/network không tự retry. Request có thể tới provider nhưng trả timeout sẽ được ghi failure/unknown; app không tuyên bố thành công hoặc tự gửi lại. Kết quả thành công nghĩa inference thành công, không chứng minh cửa sổ quota mới. Lịch sử chỉ lưu mã lỗi chuẩn hóa, HTTP status và quota snapshot, không lưu prompt/response/tokens.

Tắt Claude scheduler mặc định. Không có quota reset/purchased credit API, account rotation, chain lịch tự động, external notifications hoặc generic proxy gateway.

## Kiểm tra

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run check:worker
npm run test:integration
```

Test integration chạy Cloudflare Miniflare local, độc lập DB production. Không có test inference thật; provider OAuth cần kiểm thử thủ công một lần với tài khoản riêng trước khi lập lịch.

## Cloudflare free tier và domain

Workers phục vụ web/API; D1 lưu accounts, schedules, history; Cron Triggers thức worker mỗi phút kể cả khi không mở trang. Free tier từng giới hạn Cron Trigger chạy thấp nhất một phút và D1 theo mức gói hiện hành; xác minh dashboard billing quota trước deployment. Network egress và provider OAuth sẽ được edge thực thi.

Khi yêu cầu deploy: tạo database `quota-pilot`, chạy `wrangler d1 migrations apply quota-pilot --remote`, cập nhật `database_id`, gán custom domain `chillix.me`, đặt `APP_ORIGIN=https://chillix.me`, tạo secrets `ADMIN_PASSWORD_HASH`, `ENCRYPTION_KEY`, `SESSION_SECRET` bằng Cloudflare secrets, xác minh OAuth redirect registration, deploy Worker. Không chạy bất cứ bước production/deploy nào trong quá trình local setup.

HTTPS public access bắt buộc ngoài local. Đổi mật khẩu local: dừng Worker, thay ADMIN_PASSWORD_HASH bằng PBKDF2 hash mới tạo theo scripts/setup.mjs, xóa các session cũ trong D1 local. Trên Cloudflare, cập nhật secret và xóa sessions trong production D1 bằng D1 console. Không gửi `.dev.vars` qua chat/log. 9Router source license mapping ở [`docs/EXTRACTION_MAP.md`](docs/EXTRACTION_MAP.md); MIT notice ở [`licenses/9router-MIT.txt`](licenses/9router-MIT.txt).
