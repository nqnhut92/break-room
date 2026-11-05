# Phát triển

[English](DEVELOPMENT.md) · Tiếng Việt · [Tài liệu](README.md)

## Chạy local và nhiều instance

Chạy local không cần Redis: toàn bộ state nằm trong RAM của tiến trình `npm start`. Muốn thử đúng như bản Vercel (nhiều server dùng chung state) thì đặt `REDIS_URL=redis://localhost:6379` rồi chạy `npm start` ở hai terminal với `PORT` khác nhau, mở mỗi cổng một tab, hai tab vẫn thấy cùng một văn phòng. `vercel dev` cũng dùng được nếu bạn cần chạy chính xác hàm `api/ws.js`, nhưng không bắt buộc.

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
docs/                hướng dẫn chơi, deploy, kiến trúc, phát triển và adr/
```

## Test

```bash
npm test
```

`test/world.js` kiểm tra bố cục và đường đi. `test/smoke.js` chạy server thật bằng WebSocket thật với store trong RAM (gồm AFK, giới hạn kết nối/phòng và công tắc tắt khẩn cấp). `test/shared.js` chạy cùng một bộ kiểm tra hợp đồng cho store RAM và Redis, rồi bật hai server dùng chung một Redis để chơi xuyên instance (đập chung một món từ hai instance, reconnect sang instance khác, giới hạn IP xuyên instance, instance chết đột ngột). Nó tự bật `redis-server` tạm trên cổng trống; nếu máy không có `redis-server` thì phần Redis được bỏ qua và in dòng `SKIP`. Có thể trỏ tới Redis có sẵn bằng `TEST_REDIS_URL`. Máy không có `redis-server`? Chạy `npm run test:redis`: lệnh này bật một container Redis tạm bằng podman hoặc docker (`scripts/test-with-redis.sh`), chạy đủ bộ test rồi xóa container; lần đầu sẽ kéo image `redis:7-alpine`.

## Dựng hình và nâng cấp thư viện

Hình 3D dùng texture có giấy phép và hình học dựng bằng code:

- **Texture** (ambientCG, CC0, `public/assets/textures/`, ghi chú giấy phép trong `License.txt`): sàn gỗ, thảm, gạch và tấm kim loại, bản đồ màu và pháp tuyến 512 px (khoảng 0,7 MB), nhuộm màu trong `FLOOR_FILES` ở `scene3d.js`. Thiếu file thì dùng lại sàn vẽ bằng canvas như cũ.
- **Nhân vật dựng bằng code** (`makePlayer` trong `scene3d.js`): thân "chibi" tròn làm từ hình cầu và viên nang, bốn kiểu tóc, mũ theo vai trò, sếp mặc vest xanh navy tóc bạc. Chuyển động cũng do code (thở, nhún, nghiêng, giãn co, vung búa), không dùng file model.
- **Mọi thứ còn lại dựng bằng code** (`public/scene3d.js`) từ khối hộp bo góc, hình elip, viên nang và trụ: đồ đạc, nhân vật, tường kính, mảnh vỡ và hiệu ứng. Không có file model nên không cần giấy phép hay tải gì. `box()` bo góc, `sbox()` giữ góc vuông (tường).

Three.js được chép sẵn vào `public/vendor/` (MIT, kèm giấy phép), không tải từ CDN. Muốn nâng cấp: `npm install three@<phiên bản> --save-dev` rồi chép `three.module.min.js` (thư mục `build`) cùng `BufferGeometryUtils.js` (từ `examples/jsm/utils`) vào `public/vendor/`, và `RoundedBoxGeometry.js`, `RoomEnvironment.js` (từ `examples/jsm/geometries` và `examples/jsm/environments`) vào `public/vendor/jsm/` với cùng tên thư mục.

Cần trình duyệt có WebGL. Điện thoại yếu có thể giật, màn hình cảm ứng mặc định dùng chế độ an toàn với độ phân giải gốc và bóng tròn dưới chân, không render bóng thời gian thực. Lựa chọn chế độ cao đã lưu vẫn được áp dụng.

## Chỉnh map và đồ họa

Bố cục, cửa và tường dùng chung nằm trong `FLOOR_ROOMS` ở `lib/world.js`; đổi tên phòng chơi trong `ROOMS`. `rot`: 0 hướng nam, PI/2 đông, PI bắc, -PI/2 tây. Các zone sàn cùng độ cao chỉ được chạm cạnh, không chồng diện tích: sàn trùng nhau có thể chớp khi camera di chuyển ở cả hai mức đồ họa. Kiểm tra này nằm trong `test/world.js`. Biển tên phòng lơ lửng đã được bỏ khỏi props/renderer; tên phòng vẫn là metadata cho bố cục. Giữ ID và loại đồ vật ổn định vì state Redis được lưu theo ID. Khi đổi map, kiểm tra đường tới đồ vật, cửa đi được và vách kín; xem [ADR 0004](adr/0004-static-world.md).

Vai trò ở `public/roles.js` phải khớp `ROLE_IDS` trong `lib/world.js`. Mana nằm ở `MANA` trong `lib/realtime.js`.

Hai mức đồ họa vẽ thẳng ra màn hình, không dùng EffectComposer. Lý do và điều kiện xem xét lại: [ADR 0003](adr/0003-direct-rendering.md). Quy tắc viewport và kiểm tra điện thoại: [MOBILE.md](MOBILE.md).

## Kiểm tra renderer và hiệu năng mobile

Kiểm tra WebGL tách khỏi bộ test server, dùng Playwright ghim phiên bản trong dev dependency và Chromium. Dùng Node.js 20+ theo yêu cầu của dự án:

```bash
npx playwright install chromium
npm run test:renderer
```

Có thể dùng Chromium đã cài bằng `CHROMIUM_PATH=/path/to/chromium npm run test:renderer`. Fixture mặc định là màn hình cảm ứng; chạy thêm `RENDERER_TOUCH=0 npm run test:renderer` để kiểm tra cấu hình desktop. Test intercept module để đọc tài nguyên nội bộ, không đổi hành vi production. Nó kiểm tra safe/high, giải phóng shadow target, vật liệu dùng chung, geometry nhân vật/mini-boss, hiệu ứng điện, picking và nhiều lượt vào/rời. Phép đo tính cả shadow pass; SwiftShader không đại diện cho FPS iPhone.

Geometry rig người chơi được cấp riêng; `ownedMaterials` chỉ chứa material riêng của bóng tròn/vòng chọn. Cleanup dispose mỗi geometry riêng một lần, thêm material điện nếu có; không dispose body material hoặc pick material dùng chung. Nếu chuyển rig sang geometry cache chung sau này thì phải cập nhật ownership và test.

Xem [kết quả điều tra và kiểm tra máy thật](PERFORMANCE.vi.md), [ADR 0005](adr/0005-safe-mode-shadows.md). Capture/probe chẩn đoán ban đầu vẫn giữ local; regression test WebGL ở `test/renderer.cjs` đã nằm trong repo.

Kiểm tra nhắc xoay màn hình bằng `npm run test:orientation` sau khi cài Chromium như trên (hỗ trợ `CHROMIUM_PATH`). Test giữ HTML/CSS, logic game/viewport và WebSocket thật, chỉ stub WebGL; kiểm tra reload trước khi vào phòng, auto-rejoin, ngắt kết nối và API xoay/toàn màn hình bị từ chối. Xem [Mobile](MOBILE.md#orientation-regression-checks).

Kiểm tra vòng đời joystick bằng `npm run test:joystick` (Chromium/`CHROMIUM_PATH`). Test kết hợp touch thật trong Chromium và sự kiện bị mất được mô phỏng để kiểm tra hướng, giữ ngón, vừa đi vừa đánh, mất capture và focus chat. Đây không phải tái hiện chắc chắn lỗi Safari trên iPhone; xem [Mobile](MOBILE.md#joystick-recovery) và kiểm tra tiếp trên máy thật.

Kiểm tra lưới cài đặt bằng `npm run test:settings` (Chromium/`CHROMIUM_PATH`): bố cục các cặp nút, Gọi IT toàn hàng, listener/trạng thái được giữ và toolbar desktop. `SETTINGS_REAL_RENDERER=1` chạy smoke test có WebGL thật; xem [Mobile](MOBILE.md#settings-layout). Renderer test cũng đi camera qua ranh giới sàn cũ ở cả safe/high; kiểm tra máy thật khi di chuyển vẫn cần thiết.

Chỉnh chính sách IT trong `lib/object-respawn.js`: hệ số dùng chung cho RAM và Lua. `test/object-respawn.js` kiểm tra ví dụ/biên/tính đơn điệu; `test/shared.js` chạy cùng contract trên RAM/Redis, gồm bot, presence hết hạn, batch, thay đổi số người và tranh chấp hai client Redis. Chạy `npm run test:redis`; `RESPAWN_MS` dương vẫn giữ chế độ cố định để test nhanh.

## Kiểm thử điểm và chat

`npm run test:scores` (`scripts/test-scores.sh`, podman hoặc docker) dựng Postgres 16 và Redis 7 dùng-một-lần rồi chạy `test/scores.js` trên cả store RAM lẫn Redis: mọi nguồn thưởng theo phần mười, mất ack và hai worker đồng thời, nửa đêm với đồng hồ giả và sync trễ, chuyển điểm khách khi còn sự kiện chờ và sự kiện đến muộn, đồng hạng/đổi tên, hàng đợi đầy, Redis mất dữ liệu và phòng hết TTL, Postgres lỗi/phục hồi và thời gian giữ, chat idempotent/phân trang/lọc 24 giờ, cùng một lượt WebSocket thật (dòng BXH, chat ack/lỗi/lịch sử, không lộ id nội bộ). Test không bao giờ đọc `DATABASE_URL`/`REDIS_URL`. `npm test` và `npm run test:redis` phủ các script Lua qua contract của store và bộ test gameplay.

## Kiểm thử identity

Dùng Node 20+ (đã kiểm tra Node 24). Chạy `npm run test:identity` với Postgres/Redis bỏ đi, migration và Google OIDC mock qua Auth.js. Runner không đọc URL database production. Xem [kiểm thử identity](IDENTITY.vi.md#kiểm-thử-và-phần-cần-xác-minh-live); mock không xác minh Google/Neon thật. Dùng `CHROMIUM_PATH` với browser đã cài như hướng dẫn trên.

Trên máy cloud hạn chế tài nguyên, `TEST_WAIT_FACTOR=3 npm test` (hoặc `TEST_WAIT_FACTOR=3 npm run test:redis`) chỉ tăng thời gian chờ kết quả mạng/join trong helper. Không đổi cooldown game, assertion phủ định hay timing mặc định của test.

Schema tự khởi tạo khi dùng DB hồ sơ lần đầu. `test:identity` kiểm tra các instance chạy đồng thời, khởi động lại giữ nguyên dữ liệu và rollback/retry transaction. Lệnh tùy chọn `npm run db:migrate` dùng `MIGRATION_DATABASE_URL` hoặc `DATABASE_URL`; test chỉ dùng DB bỏ đi.

Bộ browser test account kiểm tra cột ngang laptop/cảm ứng, gửi Google login, màu số online và một nút chính tạo/sửa/vào phòng. `test/actor-collision.js` kiểm tra thân actor chia bước, trượt, tránh xuyên tường, NPC trung lập tránh người và đi qua trước/sau boss chết bằng WebSocket thật; được chạy trong `npm test`.

Nhân vật đã lưu hiển thị dạng thông tin chỉ đọc; chế độ sửa mới hiện form. Browser test account kiểm tra viền focus nằm trọn trong ô, chọn giới tính bằng bàn phím/con trỏ, trả focus khi hủy và radio native được ẩn trong lúc chờ lưu.


`test/office-patrol.js` nằm trong `npm test`/`npm run test:redis`: kiểm tra giới hạn hỗ trợ tủ/reset/hồi sinh/bounty, điện phân số, đường boss đi/về, chọn mục tiêu mini, bot ngụy trang, fence version/lease, trừ máu qua WebSocket thật và sự kiện/reconnect/chuyển runner giữa instance Redis. `CHROMIUM_PATH=/path/to/chromium npm run test:office-ui` kiểm tra tia điện WebGL thật và banner không tương tác dưới header trên desktop/mobile.


`CHROMIUM_PATH=/path/to/chromium npm run test:minimap` kiểm tra kích thước khi HUD ẩn, auto-rejoin, resize và map/chat/joystick không đè nhau. `npm run test:mobile-safe-area` mô phỏng inset camera/thanh điều hướng và lỗi chiều cao cũ; preview safe area với WebGL thật nằm trong `npm run test:office-ui`. Xem [Mobile](MOBILE.md#safe-areas-and-rotation-previews) để tra nguồn và kiểm tra trên máy thật.


`npm run test:mobile-chat` (Chromium/`CHROMIUM_PATH`) kiểm tra chat mobile cố định, tin dài xuống dòng và thao tác chạm không đổi kích thước; `CHAT_REAL_RENDERER=1` chụp bố cục ở cỡ Pro Max bằng WebGL thật. Xem [bố cục chat mobile](MOBILE.md#mobile-chat-layout) để tra thao tác và giới hạn kiểm tra máy thật.

## Kiểm tra dân số, tìm đường và bản đồ

`test/shared.js` kiểm tra ngưỡng người thật riêng trên memory/Redis, thời gian giữ/ngắt ngưỡng, tăng máu đồng thời với đánh, đổi runner, damage ulti/tủ theo phần trăm, giữ mốc rắn, reconnect, hồi sinh và truyền HP giữa hai server đang chạy. `test/miniboss.js` kiểm tra đi chéo đúng tốc độ và đủ khoảng trống cho thân qua tường/nội thất. Bố cục khôi phục có một cửa mỗi phòng. Test kiểm tra vách kín ngoài cửa, cửa đi được, tới được đồ vật và zone sàn không chồng nhau; giữ ID/loại đồ vật đã lưu khi sửa.

`npm run test:minimap` kiểm tra chạm mở/đóng, desktop giữ Tab khi chạy, thả phím/mất focus thì đóng, không bắt phím lúc nhập, radar tròn, người chơi ở tâm, mép mờ dần, cắt boss xa khỏi mini map, giữ chức năng M và cập nhật HP sai thứ tự. `RENDERER_TOUCH=0 npm run test:renderer` cùng lượt touch mặc định kiểm tra đề từ mini boss chỉ ở desktop và thu hồi tài nguyên. Đây là kiểm tra trình duyệt/WebGL phần mềm, không phải đo hiệu năng thiết bị thật.

Tạo lại toàn cảnh README và sơ đồ bằng `CHROMIUM_PATH=/path/to/chromium node scripts/capture-office.cjs`. Script phục vụ world/renderer hiện tại với góc camera chỉ dùng khi chụp; không đổi giới hạn camera hay spawn trong game. Xem cả `artifacts/map-ingame.png` và `artifacts/map-overview.png` trước khi commit. Toàn cảnh là hình dựng từ game; tên phòng trên sơ đồ là chú thích chỉnh sửa.
