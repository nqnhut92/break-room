# Deploy và vận hành

[English](DEPLOYMENT.md) · Tiếng Việt · [Tài liệu](README.md)

Bản deploy Vercel dùng Functions với WebSocket native và Fluid Compute. Trang tĩnh trong `public/` do Vercel phục vụ, còn kết nối WebSocket vào hàm `api/ws.js` tại `wss://<domain>/api/ws`.

State dùng chung cần Redis khi chạy nhiều instance. Vercel không nhận người chơi nếu thiếu `REDIS_URL`/`KV_URL`; chi tiết lưu trữ và pub/sub nằm ở [Kiến trúc](ARCHITECTURE.vi.md) và [ADR 0001](adr/0001-shared-state.md).

## Các bước

1. Đẩy repo lên GitHub, trên Vercel chọn **Add New Project** và import repo. `vercel.json` chạy `npm run build` để gắn phiên bản cho asset, đặt thư mục tĩnh là `public` và cấu hình `maxDuration` của `api/ws.js`.
2. Tạo Redis qua **Storage > Marketplace** (ví dụ Upstash Redis) và nối vào project. Integration sẽ tự thêm biến môi trường `KV_URL` hoặc `REDIS_URL` (dạng `rediss://...`, kết nối TCP, cần cho pub/sub). Game đọc `REDIS_URL` trước, rồi `KV_URL`. Nếu integration của bạn chỉ cho biến REST (`KV_REST_API_URL`) thì thêm tay `REDIS_URL` bằng chuỗi kết nối TCP/TLS của database.
3. Kiểm tra project đang bật **Fluid Compute** (mặc định bật với project tạo từ 23/04/2025; project cũ bật ở Settings > Functions rồi deploy lại).
4. Deploy. Mở `https://<domain>/api/health`: trả `{"ok":true,"store":"redis"}` là đã có Redis. Rồi mở trang chính, vào phòng bằng hai trình duyệt.

## Biến môi trường

| Biến | Ý nghĩa |
| --- | --- |
| `REDIS_URL` hoặc `KV_URL` | Chuỗi kết nối Redis (TCP). Bắt buộc trên Vercel. Local có thể bỏ trống |
| `WS_MAX_DURATION_S` | Thời gian tối đa của một kết nối WebSocket. Mặc định 300 trên Vercel, 0 (không giới hạn) khi chạy local. Đặt bằng `maxDuration` nếu bạn nâng lên (gói Pro) |
| `RESPAWN_MS` | Override dương: thời gian thay đồ cố định (ms). Bỏ trống/0/không hợp lệ: tự tính 25000–60000 ms. Xoá cấu hình `25000` cũ nếu muốn bật chế độ tự tính |
| `AFK_MS` | Người chơi đứng yên (không đi, đập, emoji) quá từng này mili giây thì bị ngắt với mã 4002, mặc định 180000 (3 phút). Client không tự kết nối lại, hiện nút vào lại, điểm vẫn còn. Chặn tab bỏ quên giữ instance Vercel sống (bộ nhớ tính theo thời gian instance còn sống) |
| `MAX_CONNECTIONS` | Số kết nối tối đa mỗi instance. Mặc định 200 trên Vercel, không giới hạn khi chạy local |
| `MAX_ROOMS` | Số phòng tối đa mỗi instance. Mặc định 40 trên Vercel, không giới hạn khi chạy local. Với danh sách phòng cố định thì gần như không còn tác dụng |
| `FIXED_ROOMS=0` | Cho phép vào phòng có tên bất kỳ thay vì chỉ các phòng trong `ROOMS` (dùng khi thử nghiệm hoặc chạy test) |
| `GAME_DISABLED=1` | Công tắc tắt khẩn cấp: mọi người vào đều nhận "Game đang tạm đóng" và server không mở kết nối Redis nào. Đặt biến rồi redeploy |
| `REDIS_TLS_CA` | Chứng chỉ CA (nội dung PEM) cho nhà cung cấp Redis dùng chứng chỉ tự ký, ví dụ gói trả phí của Redis Cloud. Có thể viết `\n` thay cho xuống dòng |
| `HEALTH_KEY` | Nếu đặt, `/api/health?deep=<HEALTH_KEY>` mới được kiểm tra sâu (xem dưới) |
| `ROOM_TTL_S` | Phòng không có ai thì state bị xóa sau từng này giây, mặc định 1800 |
| `PORT` | Cổng khi chạy local, mặc định 3000 |
| `SCORE_PERSIST=0`, `CHAT_HISTORY=0`, `SCORE_QUEUE_MAX`, `MAINTENANCE_SECRET` / `CRON_SECRET`, `DB_POOL_MAX` | Lưu điểm ngày, lịch sử chat, giới hạn hàng đợi và secret của job maintenance. Cần một scheduler gọi `/api/maintenance` (hoặc `npm run maintenance`); xem [BXH ngày](SCORES.vi.md#vận-hành). Health check sâu còn báo `queue.<room>.len/dropped/syncAt` |
| `TRUST_PROXY=1` | Chỉ cần khi chạy `server.js` sau reverse proxy ngoài Vercel (Render, Railway, Nginx...) để đếm kết nối theo IP thật. Trên Vercel luôn bật sẵn |

## Kết nối bị cắt sau 5 phút thì sao

Kết nối WebSocket bị đóng khi hàm hết `maxDuration` (repo đang đặt 300 giây). Kiểm tra giới hạn Vercel hiện tại trước khi nâng và đặt `WS_MAX_DURATION_S` tương ứng. Game xử lý việc này theo hai lớp:

- **Chuyển kết nối êm**: khoảng 25 giây trước hạn, server báo `renew`. Client mở socket mới, vào lại bằng cùng token, rồi mới đóng socket cũ. Chuyển kết nối theo kế hoạch tránh thông báo rời/vào phòng.
- **Reconnect khi rớt bất ngờ** (mạng, deploy mới, instance bị thu hồi): client thử lại với exponential backoff 1s, 2s, 4s... tối đa 10s, có jitter. Mỗi tab giữ một token trong `sessionStorage`, nên vào lại vẫn giữ nguyên id, điểm, vị trí và đồ đã đập. Người chơi chỉ rời khỏi danh sách online nếu thật sự mất kết nối.

Nếu một instance chết mà không kịp dọn, các instance còn lại tự loại người chơi đó sau 20 giây không có nhịp tim.

Web Analytics: `public/index.html` nạp `/_vercel/insights/script.js` của Vercel (không dùng cookie, bỏ qua trên localhost). Chỉ cần bật một lần ở tab **Analytics** của project trên Vercel, không cần làm gì thêm.

## Người chơi thấy gì khi bạn deploy

Mỗi lần build trên Vercel ghi ra `lib/build-info.json` (`scripts/stamp-assets.js`): cùng phiên bản với con số gắn vào URL các module của trang, kèm giờ build. Trang tự biết phiên bản của mình qua URL `game.js?v=...`.

- **Vào server mới bằng trang cũ**: thông điệp `welcome` mang `build` của server. Nếu khác phiên bản của trang thì người chơi thấy hộp thoại "có bản mới" với nút tải lại.
- **Đang chơi mà có deploy mới**: instance đầu tiên của bản mới phát `{ v, t }` lên kênh chung `__build`. Các instance bản cũ (còn chạy một lúc, tối đa `maxDuration`) nghe thấy, gửi cho mọi người chơi của mình thông điệp `update` (cùng hộp thoại đó) rồi ngắt kết nối bằng mã **4003** sau 20 giây (`updateGraceMs`). Client không tự kết nối lại khi gặp 4003; nút sẽ tải lại trang.
- **Trang đang mở tự nhận ra**: bản build còn ghi thêm file tĩnh `public/version.json` (cùng phiên bản). Mỗi trang đang mở lấy file đó mỗi 30 giây và khi tab quay lại phía trước; phiên bản khác nghĩa là vừa có deploy, người chơi thấy hộp thoại ngay, kèm đếm ngược 20 giây, rồi bị ngắt kết nối. Cách này chạy kể cả khi chưa có server nào báo, và không tốn lượt gọi function (chỉ là file tĩnh).
- **Chỉ phản ứng với bản mới hơn**: instance bỏ qua thông báo của bản cũ hơn hoặc cùng giờ build, nên một instance bản cũ khởi động muộn không đá ai ra. Chạy local (`npm start`) thì phiên bản là `dev` và không có gì trong số này chạy.
- Việc server báo cần function mới khởi động, tức là có người chơi đầu tiên vào được; còn cách kiểm tra `version.json` ở trên thì không, nên nó đảm bảo mọi người được báo trong khoảng 30 giây.

## Giới hạn của bản beta

- Bản deploy này dùng WebSocket native của Vercel. Kiểm tra khả dụng, giới hạn và giá hiện tại trong [tài liệu nền tảng](https://vercel.com/docs/functions) trước khi deploy; chúng có thể đổi độc lập với repo.
- Tài liệu không nêu con số giới hạn kết nối đồng thời mỗi instance. Chưa có số liệu tải thực tế cho game này.
- Các thao tác state dùng chung và tin nhắn xuyên instance phụ thuộc độ trễ Redis; tin vị trí ở cùng một instance được gửi nội bộ. Hãy đặt hai cái cùng region.
- Chi phí: tính theo Active CPU, Provisioned Memory, Invocations của Fluid Compute, cộng số lệnh Redis. Housekeeping, nhịp tim, hành động dùng chung và vị trí xuyên instance đều tốn lệnh Redis; đo tốc độ lệnh với tải dự kiến. Kiểm tra hạn mức của gói Redis bạn chọn.
- Pub/sub của Redis không đảm bảo giao tin. Nếu đứt kết nối Redis giữa chừng, một tin có thể rơi mất. Client được đồng bộ lại đầy đủ ở lần vào phòng kế tiếp.
- Firewall và rate limit của Vercel áp dụng cho mỗi request upgrade, đừng đặt rule quá chặt.

## Phương án dự phòng

`server.js` chạy được trên mọi host Node thường trực (Render, Railway, Fly.io, VPS): `npm install && npm start`. Một tiến trình duy nhất thì không cần Redis (state nằm trong RAM, mất khi khởi động lại). Muốn chạy nhiều instance thì đặt `REDIS_URL` như trên. Repo hiện không có Dockerfile.

Health check: `GET /healthz` khi chạy `server.js`, `GET /api/health` trên Vercel (chỉ kiểm tra đã có biến Redis). `GET /api/health?deep=<HEALTH_KEY>` kết nối thật tới Redis, ghi một khoá `br:keepalive` có hạn 3 ngày và trả `pingMs`. Nếu provider xoá database khi không hoạt động, dùng uptime monitor gọi URL này với chu kỳ phù hợp chính sách gói; monitor cũng báo khi game lỗi.

## Chọn và kiểm tra nhà cung cấp Redis

Trước khi dán `REDIS_URL` vào Vercel, chạy thử trên máy:

```bash
REDIS_URL='rediss://user:password@host:port' npm run check:store
```

Script kiểm tra: kết nối, độ trễ, `SET`/`GET`, Lua (`EVAL`), pub/sub, 20 kết nối cùng lúc, và chạy thử chính store của game (vào phòng, đập, snapshot, dọn dẹp, gọi IT). Nó chỉ tạo khoá trong một phòng tạm rồi xoá, và không in chuỗi kết nối.

Nhà cung cấp phải hỗ trợ Redis TCP/TLS, Lua (`EVAL`) và pub/sub; REST-only không đủ. Kiểm tra hạn mức kết nối, ops/giây, số lệnh/tháng, băng thông, TLS và chính sách xoá database khi không hoạt động trên gói đang dùng. Giá và hạn mức thay đổi; xem [Redis Cloud](https://redis.io/cloud/) hoặc [Upstash](https://upstash.com/pricing) rồi chạy `check:store` trước khi deploy. Vị trí được gửi nội bộ khi mọi người ở cùng instance, nhưng housekeeping và các cú đập vẫn dùng lệnh Redis.

## Google login và Neon

Xem [cấu hình và rollout identity](IDENTITY.vi.md#cấu-hình) để tạo Google app/callback, cấu hình `AUTH_URL`, `AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DATABASE_URL` pooled và `MIGRATION_DATABASE_URL` tùy chọn (cùng DB). App tự áp dụng migration còn thiếu trước lần dùng DB hồ sơ đầu tiên; các instance chờ transaction advisory lock và bỏ qua version đã chạy. Không cần migration tay nếu role DB có quyền quản lý schema. Build không kết nối database. Local chỉ chơi khách không cần các biến này. Phiên account production dùng Redis chung. Không bật tạo account khi instance cũ còn bỏ qua protocol giữ tên.
