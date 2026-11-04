# Break Room

[English](README.md) · Tiếng Việt · [Kiến trúc](docs/ARCHITECTURE.vi.md)

Văn phòng đập phá nhiều người chơi, vẽ 3D bằng three.js. Vào phòng, đi quanh văn phòng cùng đồng nghiệp và đập laptop, màn hình, máy in, tủ server. Mỗi món vỡ sẽ cộng vào "tổng thiệt hại" của cả phòng, ai đập nhiều nhất lên bảng xếp hạng. IT sẽ thay đồ mới sau 25 giây, hoặc bấm nút "Gọi IT" để thay hết ngay.

## Chạy thử trên máy

```bash
npm install
npm start
```

Mở http://localhost:3000. Muốn chơi chung thì mở thêm tab khác (hoặc gửi link cho người khác nếu máy bạn truy cập được từ ngoài).

Chạy local không cần Redis: toàn bộ state nằm trong RAM của tiến trình `npm start`. Muốn thử đúng như bản Vercel (nhiều server dùng chung state) thì đặt `REDIS_URL=redis://localhost:6379` rồi chạy `npm start` ở hai terminal với `PORT` khác nhau, mở mỗi cổng một tab, hai tab vẫn thấy cùng một văn phòng. `vercel dev` cũng dùng được nếu bạn cần chạy chính xác hàm `api/ws.js`, nhưng không bắt buộc.

## Chơi chung với đồng nghiệp

Game có **hai server cố định**: **BR-1** và **BR-2**, mỗi server tối đa 20 người. Màn hình vào hiển thị "x online" của từng server, màu xanh lá (dưới 50% sức chứa), cam (từ 50%), đỏ (từ 80%), và tự chọn sẵn server đang đông nhất còn chỗ. Muốn chơi cùng đồng nghiệp thì cùng chọn một server; nút "Copy link server" tạo link `/?room=br-1` hoặc `/?room=br-2` để chọn sẵn. Không có tạo phòng riêng: tên phòng lạ trong link cũ rơi về phòng đầu tiên. Đổi tên hoặc thêm phòng ở danh sách `ROOMS` trong `lib/world.js` (`id` viết thường không dấu, `name` là tên hiển thị).

Màn vào còn hỏi vai trò trong công ty (kế toán, nhân sự, IT, dev, sale, marketing, designer, thực tập sinh, bảo vệ, tạp vụ hoặc nhân viên quèn; hiện dưới tên, một số vai có mũ hoặc tai nghe, và có câu hô riêng khi đập) và diện mạo nhân vật (nam hoặc nữ). Danh sách vai trò nằm ở `public/roles.js` và phải khớp `ROLE_IDS` trong `lib/world.js` (có test kiểm tra). Có thể nhập thêm tên công ty (không bắt buộc, tối đa 20 ký tự, trình duyệt nhớ lại), hiện cạnh vai trò dưới tên người chơi. Tên là bắt buộc, và tên đã có người đang online dùng ở cùng server (trùng y hệt, phân biệt hoa thường) sẽ bị từ chối.

## Điều khiển

| Hành động | Cách làm |
| --- | --- |
| Di chuyển | WASD / phím mũi tên, hoặc chạm vào nền |
| Đập | Space (giữ để đập liên tục; không có gì trong tầm vẫn vung búa, miễn phí), nút ĐẬP!, hoặc chạm vào đồ vật (màn hình cảm ứng) |
| Thả emoji | Phím 1 đến 8 hoặc bấm các nút emoji |
| Chat | Enter hoặc bấm vào ô chat cạnh thanh emoji (nút 💬 trên màn hình cảm ứng); Enter để gửi và quay lại game |
| Zoom camera | Lăn chuột, chụm hai ngón tay, hoặc nút + / − trên màn hình cảm ứng |
| Bản đồ nhỏ | Phím M để ẩn hoặc hiện (bấm vào nó cũng được) |

**Mana.** Mỗi cú đập tốn 8 trên 100 mana (thanh xanh dương dưới tên bạn). Mana hồi 2,5/giây lúc đầu và 9/giây khi đã quá 2,5 giây không đập (nên đi bộ giữa hai món xa nhau chỉ hồi được chút ít), nên bạn đập dồn được khoảng 12 cú rồi cần khoảng 12 giây mới đầy lại. Hết mana thì cú đập bị từ chối và thanh nháy đỏ. Đồ đã bị đập hiện thanh máu: xanh lá khi còn khoẻ, cam từ nửa trở xuống, đỏ ở cú cuối. Các con số nằm ở `MANA` trong `lib/realtime.js`; server áp dụng (giữ theo từng kết nối, nên reconnect sẽ đầy lại) còn client dùng cùng công thức để hiển thị.

Trên màn hình cảm ứng (và bút), chạm vào nền thì đi tới đó, chạm vào một món thì đi tới và đập đúng một cú cho mỗi lần chạm (nếu bị bàn hay tường chặn thì dừng lại); giữ nút ĐẬP! để đập liên tục. Với chuột thì canvas bỏ qua cú click: chơi bằng bàn phím.

## VKL, boss của server

Mỗi server có một boss trong phòng server. Bước vào là sếp chạy lại đấm; vòng đỏ dưới sàn báo chỗ nắm đấm sẽ rơi nên né được. Bốn cú đấm (30 mỗi cú) là gục 15 giây, rồi hồi sinh ở sảnh; máu tự hồi chậm khi bạn yên ổn. Một hay hai người không hạ nổi (sếp tự hồi máu), khoảng năm người hạ trong hai phút, sếp ngã thì 500 triệu tiền thưởng vào bảng thiệt hại, chia theo sát thương. 3 đến 5 phút sau sếp quay lại. Luật, các con số và lý do chọn chúng nằm ở [docs/BOSS.vi.md](docs/BOSS.vi.md).

## Văn phòng

Phòng rộng 4800×3000, camera bám theo người chơi (bản đồ nhỏ ở góc cho thấy cả văn phòng: bạn màu vàng, người khác màu trắng, đồ đã vỡ màu đỏ). Nửa phía bắc là khu bàn làm việc (32 bàn), pantry với máy in, bình nước, máy pha cà phê, phòng server có tường kính và cửa ở phía tây, và sảnh với bàn họp, sofa. Cánh đông có toilet (mỗi bên ba ngăn và hai bồn rửa, tường đặc) và một hội trường xếp ghế hướng về màn hình. Cánh nam có hai phòng họp kính (bàn, ghế, tivi), phòng giám đốc (bàn lớn, két sắt trị giá 200 triệu, tivi, sofa) và phòng nghỉ có sofa, tivi và máy pha cà phê. Khoảng 285 món đập được: bàn, sofa, tivi, bồn cầu, bồn rửa, tủ sách, tủ lạnh, loa, đèn, thùng rác và két sắt đều đập được. Chỉ tường, kính, thảm và sàn là không đập được. Đồ cứng (bàn, tường, máy in, tủ server, bồn cầu, bồn rửa, két sắt...) là vật cản: **cả client lẫn server** đều chặn, nên không ai đi xuyên qua được bằng cách sửa client (`slideMove` trong `lib/world.js`). Đồ cứng bị đập vỡ để lại đống đổ nát vẫn chặn đường (va chạm không đổi trong lúc chơi).

Hình 3D gồm hai nguồn:

- **Texture** (ambientCG, CC0, `public/assets/textures/`, ghi chú giấy phép trong `License.txt`): sàn gỗ, thảm, gạch và tấm kim loại, bản đồ màu và pháp tuyến 512 px (khoảng 0,7 MB), nhuộm màu trong `FLOOR_FILES` ở `scene3d.js`. Thiếu file thì dùng lại sàn vẽ bằng canvas như cũ.
- **Nhân vật dựng bằng code** (`makePlayer` trong `scene3d.js`): thân "chibi" tròn làm từ hình cầu và viên nang, bốn kiểu tóc, mũ theo vai trò, sếp mặc vest xanh navy tóc bạc đội vương miện. Chuyển động cũng do code (thở, nhún, nghiêng, giãn co, vung búa), không dùng file model.
- **Mọi thứ còn lại dựng bằng code** (`public/scene3d.js`) từ khối hộp bo góc, hình elip, viên nang và trụ: đồ đạc, nhân vật, tường kính, mảnh vỡ và hiệu ứng. Không có file model nên không cần giấy phép hay tải gì. `box()` bo góc, `sbox()` giữ góc vuông (tường).

Three.js được chép sẵn vào `public/vendor/` (MIT, kèm giấy phép), không tải từ CDN. Muốn nâng cấp: `npm install three@<phiên bản> --save-dev` rồi chép `three.module.min.js` (thư mục `build`) cùng `BufferGeometryUtils.js` (từ `examples/jsm/utils`) vào `public/vendor/`, và `RoundedBoxGeometry.js`, `RoomEnvironment.js` (từ `examples/jsm/geometries` và `examples/jsm/environments`) vào `public/vendor/jsm/` với cùng tên thư mục.

Cần trình duyệt có WebGL. Điện thoại yếu có thể giật, game tự giảm độ phân giải và bóng đổ trên màn hình cảm ứng.

## Deploy lên Vercel

Game chạy trên Vercel Functions với WebSocket native (public beta, Fluid Compute). Trang tĩnh trong `public/` do Vercel phục vụ, còn kết nối WebSocket vào hàm `api/ws.js` tại `wss://<domain>/api/ws`.

### Vì sao cần Redis

Vercel có thể chạy nhiều instance của hàm cùng lúc. Mỗi kết nối WebSocket bị ghim vào instance nhận nó, nhưng kết nối mới (kể cả reconnect) có thể rơi vào instance khác, và RAM không dùng chung. Nếu giữ state trong RAM thì hai người cùng phòng có thể thấy hai văn phòng khác nhau. Vì vậy mọi state dùng chung nằm trong Redis, và mọi broadcast đi qua Redis pub/sub (chi tiết mô hình dữ liệu, cách dọn dẹp và giới hạn: [docs/ARCHITECTURE.vi.md](docs/ARCHITECTURE.vi.md)). **Không có `REDIS_URL` thì trên Vercel game không cho vào phòng** (hiện thông báo lỗi) thay vì âm thầm chia đôi thế giới.

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
| `AFK_MS` | Người chơi đứng yên (không đi, đập, emoji) quá từng này mili giây thì bị ngắt với mã 4002, mặc định 180000 (3 phút). Client không tự kết nối lại, hiện nút vào lại, điểm vẫn còn. Chặn tab bỏ quên giữ instance Vercel sống (bộ nhớ tính theo thời gian instance còn sống) |
| `MAX_CONNECTIONS` | Số kết nối tối đa mỗi instance. Mặc định 200 trên Vercel, không giới hạn khi chạy local |
| `MAX_ROOMS` | Số phòng tối đa mỗi instance. Mặc định 40 trên Vercel, không giới hạn khi chạy local. Với danh sách phòng cố định thì gần như không còn tác dụng |
| `FIXED_ROOMS=0` | Cho phép vào phòng có tên bất kỳ thay vì chỉ các phòng trong `ROOMS` (dùng khi thử nghiệm hoặc chạy test) |
| `GAME_DISABLED=1` | Công tắc tắt khẩn cấp: mọi người vào đều nhận "Game đang tạm đóng" và server không mở kết nối Redis nào. Đặt biến rồi redeploy |
| `REDIS_TLS_CA` | Chứng chỉ CA (nội dung PEM) cho nhà cung cấp Redis dùng chứng chỉ tự ký, ví dụ gói trả phí của Redis Cloud. Có thể viết `\n` thay cho xuống dòng |
| `HEALTH_KEY` | Nếu đặt, `/api/health?deep=<HEALTH_KEY>` mới được kiểm tra sâu (xem dưới) |
| `ROOM_TTL_S` | Phòng không có ai thì state bị xóa sau từng này giây, mặc định 1800 |
| `PORT` | Cổng khi chạy local, mặc định 3000 |
| `TRUST_PROXY=1` | Chỉ cần khi chạy `server.js` sau reverse proxy ngoài Vercel (Render, Railway, Nginx...) để đếm kết nối theo IP thật. Trên Vercel luôn bật sẵn |

### Kết nối bị cắt sau 5 phút thì sao

Mỗi kết nối WebSocket bị đóng khi hàm hết `maxDuration` (Hobby: 300 giây, Pro: tối đa 800 giây, beta mở rộng tới 1800 giây). Game xử lý việc này theo hai lớp:

- **Chuyển kết nối êm**: khoảng 25 giây trước hạn, server báo `renew`. Client mở socket mới, vào lại bằng cùng token, rồi mới đóng socket cũ. Không ai thấy "rời phòng/vào phòng", không rớt khung hình.
- **Reconnect khi rớt bất ngờ** (mạng, deploy mới, instance bị thu hồi): client thử lại với exponential backoff 1s, 2s, 4s... tối đa 10s, có jitter. Mỗi tab giữ một token trong `sessionStorage`, nên vào lại vẫn giữ nguyên id, điểm, vị trí và đồ đã đập. Người chơi chỉ rời khỏi danh sách online nếu thật sự mất kết nối.

Nếu một instance chết mà không kịp dọn, các instance còn lại tự loại người chơi đó sau 20 giây không có nhịp tim.

Web Analytics: `public/index.html` nạp `/_vercel/insights/script.js` của Vercel (không dùng cookie, bỏ qua trên localhost). Chỉ cần bật một lần ở tab **Analytics** của project trên Vercel, không cần làm gì thêm.

### Giới hạn của bản beta

- WebSocket trên Vercel đang **public beta** (từ 22/06/2026), docs ghi rõ hành vi và API có thể đổi. Theo dõi changelog trước khi dùng cho thứ quan trọng.
- Tài liệu không nêu con số giới hạn kết nối đồng thời mỗi instance. Chưa có số liệu tải thực tế cho game này.
- Mọi tin nhắn đi qua Redis, nên độ trễ phụ thuộc khoảng cách giữa region của hàm và của database. Hãy đặt hai cái cùng region.
- Chi phí: tính theo Active CPU, Provisioned Memory, Invocations của Fluid Compute, cộng số lệnh Redis. Mỗi phòng có người chơi tốn khoảng 1 lệnh Redis mỗi giây cho việc dọn dẹp và nhịp tim (mỗi instance giữ phòng đó), cộng pub/sub cho các tin vị trí khi có người đang di chuyển và vài lệnh cho mỗi lần đập. Kiểm tra hạn mức của gói Redis bạn chọn.
- Pub/sub của Redis không đảm bảo giao tin. Nếu đứt kết nối Redis giữa chừng, một tin có thể rơi mất. Client được đồng bộ lại đầy đủ ở lần vào phòng kế tiếp.
- Firewall và rate limit của Vercel áp dụng cho mỗi request upgrade, đừng đặt rule quá chặt.

### Phương án dự phòng

`server.js` chạy được trên mọi host Node thường trực (Render, Railway, Fly.io, VPS): `npm install && npm start`. Một tiến trình duy nhất thì không cần Redis (state nằm trong RAM, mất khi khởi động lại). Muốn chạy nhiều instance thì đặt `REDIS_URL` như trên. Repo hiện không có Dockerfile.

Health check: `GET /healthz` khi chạy `server.js`, `GET /api/health` trên Vercel (chỉ kiểm tra đã có biến Redis). `GET /api/health?deep=<HEALTH_KEY>` kết nối thật tới Redis, ghi một khoá `br:keepalive` có hạn 3 ngày và trả `pingMs`. Các gói Redis miễn phí xoá database khi khoảng 2 tuần không có lệnh nào, nên trỏ một dịch vụ uptime miễn phí (ví dụ UptimeRobot) tới địa chỉ này mỗi ngày một lần vừa giữ database sống vừa báo khi game hỏng.

### Chọn và kiểm tra nhà cung cấp Redis

Trước khi dán `REDIS_URL` vào Vercel, chạy thử trên máy:

```bash
REDIS_URL='rediss://user:password@host:port' npm run check:store
```

Script kiểm tra: kết nối, độ trễ, `SET`/`GET`, Lua (`EVAL`), pub/sub, 20 kết nối cùng lúc, và chạy thử chính store của game (vào phòng, đập, snapshot, dọn dẹp, gọi IT). Nó chỉ tạo khoá trong một phòng tạm rồi xoá, và không in chuỗi kết nối. Ghi chú về các gói (số liệu tính đến 2026-11, hãy xem lại trang giá của họ):

- **Redis Cloud Free (30 MB)**: 30 kết nối, 100 ops/giây, 5 GB băng thông/tháng, không có hạn mức số lệnh theo tháng. **Không có TLS** (docs ghi rõ) nên dùng mật khẩu riêng của database này, và database tự bị xoá nếu khoảng 14 ngày không có lệnh nào (dùng `deep` health ở trên). Chưa có tài liệu xác nhận Lua và pub/sub có chạy trên gói Free hay không, vì vậy hãy chạy script trước.
- **Redis Cloud Essentials (trả phí, khoảng $5/tháng)**: có TLS (phải bật trong Security, có thể cần `REDIS_TLS_CA`), 256 kết nối, 1000 ops/giây, 100 GB băng thông.
- **Upstash Free**: 500K lệnh/tháng, chỉ 1 database. Nếu gắn thẻ thanh toán, theo tài liệu của họ mọi tài nguyên free của cả tài khoản chuyển sang trả phí.
- Game giảm số lệnh khi mọi người ở cùng một instance (vị trí gửi nội bộ, chỉ dùng Redis khi có người ở instance khác), nhưng vẫn tốn lệnh cho dọn dẹp mỗi vài giây và cho mỗi lần đập.

## Cấu trúc

```
api/ws.js            hàm Vercel nhận WebSocket (export http server có gắn WebSocketServer)
api/health.js        báo đã cấu hình Redis chưa; ?deep=KEY ping Redis thật
api/rooms.js         danh sách phòng + số người online cho màn hình vào (CDN cache 10 giây)
lib/room-list.js     đếm người mỗi phòng bằng 1 lệnh store, cache ngắn trong tiến trình
scripts/check-store.js  kiểm tra một Redis có chạy được game không
lib/realtime.js      logic game và nối WebSocket, không biết đang chạy ở đâu
lib/world.js         bố cục văn phòng, loại đồ vật, vật cản và hàm va chạm (cố định)
lib/store-redis.js   state dùng chung + pub/sub trong Redis (script Lua nguyên tử)
lib/store-memory.js  cùng giao diện nhưng trong RAM, cho local và test
lib/config.js        chọn store theo biến môi trường
server.js            chạy local: file tĩnh + WebSocket ở /api/ws
public/              index.html, style.css, game.js (mạng, input, HUD, âm thanh WebAudio),
                     scene3d.js (toàn bộ phần three.js), vendor/ (three.js chép sẵn),
                     assets/textures/ (texture sàn, CC0)
test/                world.js (bố cục, đường đi), smoke.js (end-to-end, RAM), shared.js (Redis thật, hai instance)
vercel.json          thư mục tĩnh và maxDuration
docs/                ARCHITECTURE.md (tiếng Anh) và ARCHITECTURE.vi.md: Redis làm gì, dọn dẹp, giới hạn
```

## Test

```bash
npm test
```

`test/world.js` kiểm tra bố cục và đường đi. `test/smoke.js` chạy server thật bằng WebSocket thật với store trong RAM (gồm AFK, giới hạn kết nối/phòng và công tắc tắt khẩn cấp). `test/shared.js` chạy cùng một bộ kiểm tra hợp đồng cho store RAM và Redis, rồi bật hai server dùng chung một Redis để chơi xuyên instance (đập chung một món từ hai instance, reconnect sang instance khác, giới hạn IP xuyên instance, instance chết đột ngột). Nó tự bật `redis-server` tạm trên cổng trống; nếu máy không có `redis-server` thì phần Redis được bỏ qua và in dòng `SKIP`. Có thể trỏ tới Redis có sẵn bằng `TEST_REDIS_URL`. Máy không có `redis-server`? Chạy `npm run test:redis`: lệnh này bật một container Redis tạm bằng podman hoặc docker (`scripts/test-with-redis.sh`), chạy đủ bộ test rồi xóa container; lần đầu sẽ kéo image `redis:7-alpine`.

## Ghi chú thiết kế

Server là nơi quyết định mọi thứ quan trọng: client chỉ gửi vị trí và yêu cầu đập, server kiểm tra khoảng cách, chống dịch chuyển tức thời, giới hạn tốc độ đập và số tin nhắn mỗi giây. Tên người chơi được làm sạch ở server và chỉ hiển thị bằng `textContent` hoặc canvas ở client. Token của người chơi chỉ để nhận lại chỗ cũ sau khi reconnect, nó không phải thông tin xác thực: không có tài khoản, và id công khai của người chơi là số nguyên không liên quan tới token.
