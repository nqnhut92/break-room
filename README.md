# Break Room

Văn phòng đập phá nhiều người chơi. Vào phòng, đi quanh văn phòng cùng đồng nghiệp và đập laptop, màn hình, máy in, tủ server. Mỗi món vỡ sẽ cộng vào "tổng thiệt hại" của cả phòng, ai đập nhiều nhất lên bảng xếp hạng. IT sẽ thay đồ mới sau 25 giây, hoặc bấm nút "Gọi IT" để thay hết ngay.

## Chạy thử trên máy

```bash
npm install
npm start
```

Mở http://localhost:3000. Muốn chơi chung thì mở thêm tab khác (hoặc gửi link cho người khác nếu máy bạn truy cập được từ ngoài).

Chạy local không cần Redis: toàn bộ state nằm trong RAM của tiến trình `npm start`. Muốn thử đúng như bản Vercel (nhiều server dùng chung state) thì đặt `REDIS_URL=redis://localhost:6379` rồi chạy `npm start` ở hai terminal với `PORT` khác nhau, mở mỗi cổng một tab, hai tab vẫn thấy cùng một văn phòng. `vercel dev` cũng dùng được nếu bạn cần chạy chính xác hàm `api/ws.js`, nhưng không bắt buộc.

## Chơi chung với đồng nghiệp

Mỗi phòng có một tên, nằm trong link: `/?room=ten-phong`. Bấm "Copy link phòng" rồi gửi cho mọi người. Ai vào cùng link là vào cùng phòng, mỗi phòng tối đa 40 người.

## Điều khiển

| Hành động | Cách làm |
| --- | --- |
| Di chuyển | WASD / phím mũi tên, hoặc chạm vào nền |
| Đập | Space (giữ để đập liên tục), hoặc bấm thẳng vào đồ vật, hoặc nút ĐẬP! |
| Thả emoji | Phím 1 đến 8 hoặc bấm các nút emoji |

Bấm vào một món ở xa thì nhân vật tự chạy tới và đập cho tới khi vỡ.

## Deploy lên Vercel

Game chạy trên Vercel Functions với WebSocket native (public beta, Fluid Compute). Trang tĩnh trong `public/` do Vercel phục vụ, còn kết nối WebSocket vào hàm `api/ws.js` tại `wss://<domain>/api/ws`.

### Vì sao cần Redis

Vercel có thể chạy nhiều instance của hàm cùng lúc. Mỗi kết nối WebSocket bị ghim vào instance nhận nó, nhưng kết nối mới (kể cả reconnect) có thể rơi vào instance khác, và RAM không dùng chung. Nếu giữ state trong RAM thì hai người cùng phòng có thể thấy hai văn phòng khác nhau. Vì vậy mọi state dùng chung nằm trong Redis, và mọi broadcast đi qua Redis pub/sub. **Không có `REDIS_URL` thì trên Vercel game không cho vào phòng** (hiện thông báo lỗi) thay vì âm thầm chia đôi thế giới.

| Nằm trong Redis (dùng chung) | Nằm trong từng kết nối (an toàn vì kết nối bị ghim) |
| --- | --- |
| máu và trạng thái vỡ của đồ vật, điểm, tổng thiệt hại, ai đang online, vị trí cuối của mỗi người, cooldown "Gọi IT", số kết nối theo IP, kênh pub/sub | vị trí hiện tại để chống teleport, cooldown đập và emote, giới hạn số tin nhắn mỗi giây |

Các lớp kiểm tra phía server giữ nguyên: tầm với, tốc độ di chuyển, cooldown, rate limit, làm sạch tên, kích thước tin nhắn tối đa. Việc trừ máu và tính điểm là một script Lua chạy nguyên tử trong Redis, nên hai người ở hai instance đập cùng một món chỉ làm nó vỡ đúng một lần và điểm chỉ cộng một lần.

Giới hạn kết nối theo IP (10 kết nối mỗi IP) được chuyển sang Redis luôn. Nếu để trong RAM thì mỗi instance đếm riêng và giới hạn thực tế thành 10 nhân số instance. Lease của mỗi kết nối tự hết hạn sau 60 giây nếu instance chết, nên không bị kẹt chỗ.

### Các bước

1. Đẩy repo lên GitHub, trên Vercel chọn **Add New Project** và import repo. Không cần Build Command. `vercel.json` đã đặt thư mục tĩnh là `public` và `maxDuration` của `api/ws.js`.
2. Tạo Redis qua **Storage > Marketplace** (ví dụ Upstash Redis) và nối vào project. Integration sẽ tự thêm biến môi trường `KV_URL` hoặc `REDIS_URL` (dạng `rediss://...`, kết nối TCP, cần cho pub/sub). Game đọc `REDIS_URL` trước, rồi `KV_URL`. Nếu integration của bạn chỉ cho biến REST (`KV_REST_API_URL`) thì thêm tay `REDIS_URL` bằng chuỗi kết nối TCP/TLS của database.
3. Kiểm tra project đang bật **Fluid Compute** (mặc định bật với project tạo từ 23/04/2025; project cũ bật ở Settings > Functions rồi deploy lại).
4. Deploy. Mở `https://<domain>/api/health`: trả `{"ok":true,"store":"redis"}` là đã có Redis. Rồi mở trang chính, vào phòng bằng hai trình duyệt.

### Biến môi trường

| Biến | Ý nghĩa |
| --- | --- |
| `REDIS_URL` hoặc `KV_URL` | Chuỗi kết nối Redis (TCP). Bắt buộc trên Vercel. Local có thể bỏ trống |
| `WS_MAX_DURATION_S` | Thời gian tối đa của một kết nối WebSocket. Mặc định 300 trên Vercel, 0 (không giới hạn) khi chạy local. Đặt bằng `maxDuration` nếu bạn nâng lên (gói Pro) |
| `RESPAWN_MS` | Thời gian đồ vật tự thay mới, mặc định 25000 |
| `ROOM_TTL_S` | Phòng không có ai thì state bị xóa sau từng này giây, mặc định 1800 |
| `PORT` | Cổng khi chạy local, mặc định 3000 |
| `TRUST_PROXY=1` | Chỉ cần khi chạy `server.js` sau reverse proxy ngoài Vercel (Render, Railway, Nginx...) để đếm kết nối theo IP thật. Trên Vercel luôn bật sẵn |

### Kết nối bị cắt sau 5 phút thì sao

Mỗi kết nối WebSocket bị đóng khi hàm hết `maxDuration` (Hobby: 300 giây, Pro: tối đa 800 giây, beta mở rộng tới 1800 giây). Game xử lý việc này theo hai lớp:

- **Chuyển kết nối êm**: khoảng 25 giây trước hạn, server báo `renew`. Client mở socket mới, vào lại bằng cùng token, rồi mới đóng socket cũ. Không ai thấy "rời phòng/vào phòng", không rớt khung hình.
- **Reconnect khi rớt bất ngờ** (mạng, deploy mới, instance bị thu hồi): client thử lại với exponential backoff 1s, 2s, 4s... tối đa 10s, có jitter. Mỗi tab giữ một token trong `sessionStorage`, nên vào lại vẫn giữ nguyên id, điểm, vị trí và đồ đã đập. Người chơi chỉ rời khỏi danh sách online nếu thật sự mất kết nối.

Nếu một instance chết mà không kịp dọn, các instance còn lại tự loại người chơi đó sau 20 giây không có nhịp tim.

### Giới hạn của bản beta

- WebSocket trên Vercel đang **public beta** (từ 22/06/2026), docs ghi rõ hành vi và API có thể đổi. Theo dõi changelog trước khi dùng cho thứ quan trọng.
- Tài liệu không nêu con số giới hạn kết nối đồng thời mỗi instance. Chưa có số liệu tải thực tế cho game này.
- Mọi tin nhắn đi qua Redis, nên độ trễ phụ thuộc khoảng cách giữa region của hàm và của database. Hãy đặt hai cái cùng region.
- Chi phí: tính theo Active CPU, Provisioned Memory, Invocations của Fluid Compute, cộng số lệnh Redis. Mỗi phòng có người chơi tốn khoảng 1 lệnh Redis mỗi giây cho việc dọn dẹp và nhịp tim (mỗi instance giữ phòng đó), cộng pub/sub cho các tin vị trí khi có người đang di chuyển và vài lệnh cho mỗi lần đập. Kiểm tra hạn mức của gói Redis bạn chọn.
- Pub/sub của Redis không đảm bảo giao tin. Nếu đứt kết nối Redis giữa chừng, một tin có thể rơi mất. Client được đồng bộ lại đầy đủ ở lần vào phòng kế tiếp.
- Firewall và rate limit của Vercel áp dụng cho mỗi request upgrade, đừng đặt rule quá chặt.

### Phương án dự phòng

`server.js` chạy được trên mọi host Node thường trực (Render, Railway, Fly.io, VPS): `npm install && npm start`. Một tiến trình duy nhất thì không cần Redis (state nằm trong RAM, mất khi khởi động lại). Muốn chạy nhiều instance thì đặt `REDIS_URL` như trên. Repo hiện không có Dockerfile.

Health check: `GET /healthz` khi chạy `server.js`, `GET /api/health` trên Vercel.

## Cấu trúc

```
api/ws.js            hàm Vercel nhận WebSocket (export http server có gắn WebSocketServer)
api/health.js        báo đã cấu hình Redis chưa
lib/realtime.js      logic game và nối WebSocket, không biết đang chạy ở đâu
lib/world.js         bố cục văn phòng và loại đồ vật (cố định)
lib/store-redis.js   state dùng chung + pub/sub trong Redis (script Lua nguyên tử)
lib/store-memory.js  cùng giao diện nhưng trong RAM, cho local và test
lib/config.js        chọn store theo biến môi trường
server.js            chạy local: file tĩnh + WebSocket ở /api/ws
public/              index.html, style.css, game.js (canvas, hiệu ứng, âm thanh WebAudio, không cần file ảnh/âm thanh)
test/                smoke.js (end-to-end, RAM), shared.js (Redis thật, hai instance)
vercel.json          thư mục tĩnh và maxDuration
```

## Test

```bash
npm test
```

`test/smoke.js` chạy server thật bằng WebSocket thật với store trong RAM. `test/shared.js` chạy cùng một bộ kiểm tra hợp đồng cho store RAM và Redis, rồi bật hai server dùng chung một Redis để chơi xuyên instance (đập chung một món từ hai instance, reconnect sang instance khác, giới hạn IP xuyên instance, instance chết đột ngột). Nó tự bật `redis-server` tạm trên cổng trống; nếu máy không có `redis-server` thì phần Redis được bỏ qua và in dòng `SKIP`. Có thể trỏ tới Redis có sẵn bằng `TEST_REDIS_URL`.

## Ghi chú thiết kế

Server là nơi quyết định mọi thứ quan trọng: client chỉ gửi vị trí và yêu cầu đập, server kiểm tra khoảng cách, chống dịch chuyển tức thời, giới hạn tốc độ đập và số tin nhắn mỗi giây. Tên người chơi được làm sạch ở server và chỉ hiển thị bằng `textContent` hoặc canvas ở client. Token của người chơi chỉ để nhận lại chỗ cũ sau khi reconnect, nó không phải thông tin xác thực: không có tài khoản, và id công khai của người chơi là số nguyên không liên quan tới token.
