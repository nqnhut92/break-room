# Kiến trúc

[English](ARCHITECTURE.md) · Tiếng Việt · [README](../README.vi.md)

## Tổng quan

```
trình duyệt (client three.js)
   │  WebSocket  wss://<domain>/api/ws
   ▼
instance hàm Vercel (api/ws.js → lib/realtime.js)     ← có thể chạy nhiều instance cùng lúc
   │  lệnh Redis (script Lua nguyên tử) + pub/sub
   ▼
Redis  (nguồn sự thật duy nhất cho state của mỗi server)
```

- `lib/realtime.js` giữ luật chơi và xử lý WebSocket. Nó chỉ nói chuyện với một giao diện *store* và không biết mình đang chạy ở đâu.
- Có hai store cùng giao diện: `lib/store-redis.js` (dùng chung, chạy trên Vercel) và `lib/store-memory.js` (RAM, cho `npm start` và test). `lib/config.js` chọn store; trên Vercel mà thiếu cả `REDIS_URL` lẫn `KV_URL` thì game từ chối vào phòng chứ không lùi về RAM.
- Mỗi WebSocket bị ghim vào instance nhận nó, còn reconnect có thể rơi vào instance khác. Vì thế state dùng chung không thể nằm trong RAM.

## Redis làm gì

**1. Giữ state dùng chung của mỗi server (BR-1, BR-2).** Một "phòng" là một server. Các key của phòng cùng hash tag `{room}` (cùng một slot cluster) và các script cho state cơ bản nhận bộ chín key sau (script tính năng dùng key riêng; housekeeping còn nhận `moles` để không tính bot vào tải thay đồ):

| Key | Kiểu | Nội dung |
| --- | --- | --- |
| `o` | hash | id đồ vật → `hp:brokenAt` (không có = còn nguyên) |
| `sc` | hash | id người chơi → điểm |
| `bk` | hash | id người chơi → số món đã đập vỡ |
| `nm` | hash | id người chơi → tên hiển thị; field `g<id>` → giới tính (`m` hoặc `f`), `r<id>` → vai trò, `c<id>` → tên công ty, `h<id>` → `máu|lúc lưu|ngất đến khi` |
| `tok` | hash | token client → id người chơi (để reconnect giữ id và điểm) |
| `meta` | hash | `nextid`, `total` thiệt hại, `lastReset` |
| `on` | zset | id người chơi → nhịp tim cuối (ms); đây chính là "ai đang online" |
| `own` | hash | id người chơi → id kết nối đang giữ chỗ |
| `pos` | hash | id người chơi → vị trí đã lưu `x,y,d` |

VKL dùng thêm ba key trong room: `boss` (hash: HP hiện tại/tối đa, phiên bản máu, mốc thời gian và state tính năng), `bdmg` (hash: sát thương đã gây cho boss hiện tại) và `blk` (lease runner). Dữ liệu boss dùng hạn sống room khi ghi; riêng `blk` là lease ba giây, được chủ lease gia hạn. Chúng nằm ngoài bộ chín key cơ bản; script tính năng nhận các key cần dùng. Xem [Boss](BOSS.vi.md) và [máu theo dân số](#máu-boss-theo-dân-số).

Bạn sếp dùng thêm key `moles` (hash: id người chơi → `{hp, rev, conn}`), cũng nằm ngoài bộ chín key. Xem [MOLES.vi.md](MOLES.vi.md).

State mở rộng gồm `mini`, `snakes`, `rage` và `moles`; đấu 1:1 nằm trong field `duel` của `boss`. Chúng không đổi bộ chín key cơ bản. Mỗi thanh nộ/ulti cá nhân dùng key chuỗi `rage:<participant id>` (nhân vật hoặc tab khách), không theo player id bị dùng lại, với TTL riêng bảy ngày từ lần lưu cuối. Người chơi khác và thao tác đọc không gia hạn TTL đó. Thanh nộ đi theo nhân vật qua thiết bị và renew; nó không được chép từ khách sang nhân vật khi đăng nhập. Field trong hash `rage` cũ được chuyển khi đọc hoặc lưu tiếp theo rồi xóa khỏi hash; field chưa đọc hết hạn cùng hash cũ. Xem [TML/DMM](MINIBOSSES.md), [VKL](BOSS.vi.md) và `lib/store-redis.js` để tra thao tác cụ thể.

Hash tên còn lưu `a<id>`, actor BXH nội bộ của từng người chơi. Bảng ngày (`ds:<day>`, `di:<day>`) và hàng đợi điểm (`evq`, `qs`, không TTL) cùng slot hash-tag nhưng nằm ngoài bộ chín key và ngoài TTL của phòng. Xem [BXH ngày](SCORES.vi.md).

Lease kết nối theo IP (mỗi IP một zset) và key `br:keepalive` của health check nằm ngoài phòng.

**2. Thao tác nguyên tử.** Vào, rời, đập, dọn dẹp, snapshot và reset đều là một script Lua. Hai người ở hai instance đập cùng một món thì món chỉ vỡ đúng một lần và điểm cộng một lần. Việc kiểm tra tên nằm trong script vào phòng, nên hai người không thể giành cùng một tên trong cùng một khoảnh khắc.

**3. Pub/sub.** Instance nhận một hành động (đập, emoji, vị trí, vào/ra) sẽ publish lên kênh của phòng; mọi instance đang giữ người chơi của phòng đó chuyển tiếp cho client của mình. Pub/sub chỉ là tin tạm thời, không tốn dung lượng. Không đảm bảo giao tin; client được đồng bộ lại ở lần vào kế tiếp. Khi mọi người của một phòng cùng ở một instance thì vị trí đi nội bộ và không publish.

## Vòng đời và dọn dẹp

Redis không bị ghi vô hạn. Mọi thứ đều có hạn dùng hoặc kích thước bị chặn:

| Dữ liệu | Cách dọn |
| --- | --- |
| Cả phòng (9 key) | `touch` đặt `EXPIRE` bằng `ROOM_TTL_S` (mặc định 1800 giây) ở mỗi lần vào, rời và dọn dẹp. Phòng 30 phút không ai chạm vào thì biến mất hoàn toàn, gồm cả điểm, tên và token |
| Online (`on`, `own`) | Nhịp tim được làm mới khi dọn dẹp, khoảng mỗi giây (mỗi 2 giây khi chưa có gì vỡ). Người không có nhịp tim quá `PRESENCE_TTL_MS` (20 giây) bị loại, ví dụ khi instance chết |
| Đồ vật vỡ (`o`) | Housekeeping tính nguyên tử ngưỡng 25–60 giây theo số người thật và đồ vỡ trước lượt thay, rồi xoá mục đủ tuổi; `RESPAWN_MS` dương giữ override cố định; Gọi IT xoá cả hash. Món nguyên vẹn không được lưu; số mục tối đa bằng số đồ vật trong `lib/world.js` (hiện 359) |
| Lease theo IP | Mỗi lease hết hạn sau 60 giây và được làm mới khi kết nối còn sống |
| `br:keepalive` | Hạn 3 ngày, ghi lại ở mỗi lần health check sâu |

Dọn nén (compaction): khi dọn dẹp, mỗi phòng còn chạy một lượt dọn nén nhỏ tối đa mỗi 2 phút (`lastCompact` trong `meta`). Nó quên token, tên, giới tính, vai trò, vị trí cuối và chỗ của mọi người chơi đã offline mà chưa từng ghi điểm. Người có điểm ở lại đến khi phòng hết hạn để bảng xếp hạng vẫn giữ họ. Nhờ vậy số mục theo token bị chặn bởi số người thật sự đã chơi chứ không phải mọi người từng ghé qua.

Đo dung lượng state bằng công cụ chẩn đoán Redis và dashboard nhà cung cấp. Overhead nền của database khác với dữ liệu game; không suy ra giới hạn người chơi từ dung lượng hiển thị của database gần như trống.

## Sức chứa và giới hạn

- **Dung lượng.** State đồ vật bị chặn bởi số phòng và số đồ vật trong map (hiện 2 phòng × 359 món), cộng state người chơi và NPC. Chỉ lưu đồ đã bị đập hoặc vỡ. Khi thiếu bộ nhớ, chính sách eviction của Redis có thể xoá key có TTL và làm mất state; kiểm tra cấu hình thực tế của provider.
- **Throughput và kết nối.** Mỗi instance game dùng kết nối lệnh và subscriber nạp trễ; phần login dùng chung kết nối lệnh đó. Các route ngắn (`/api/profile`, `/api/auth/*`, `/api/rooms`, `/api/maintenance`) chỉ mở Redis khi cần và đóng trước khi kết thúc, nên instance serverless bị thu hồi không để lại kết nối rò so với giới hạn kết nối của gói. Theo dõi housekeeping, pub/sub và số lệnh khi đánh đồ; đo tải thực tế thay vì suy ra sức chứa từ dung lượng Redis.
- **Độ trễ.** Đặt function và Redis cùng region. Tin vị trí ở cùng instance đi nội bộ; thao tác state dùng chung vẫn cần Redis. Dùng health check sâu từ bản deploy để đo `pingMs`.
- **Vận hành.** Hạn mức, TLS, eviction và chính sách xoá database phụ thuộc gói đang dùng. Xem [Deploy](DEPLOYMENT.vi.md).

## Mỗi thứ nằm ở đâu

| Việc | File |
| --- | --- |
| Luật chơi, xử lý WebSocket, luật tên | `lib/realtime.js` |
| Script Redis và cách đặt key | `lib/store-redis.js`, `lib/daily-lua.js` |
| BXH ngày, worker sync, chuyển điểm khách | `lib/scoreboard.js` (bản RAM: `lib/daily-memory.js`) |
| Lịch sử chat, job maintenance | `lib/chat-store.js`, `lib/persistence.js`, `lib/maintenance-http.js` |
| Store RAM (cùng hợp đồng) | `lib/store-memory.js` |
| Chọn store, giới hạn, TTL từ biến môi trường | `lib/config.js` |
| Danh sách server (`BR-1`, `BR-2`) | `lib/world.js` (`ROOMS`), `lib/room-list.js` |
| Test hợp đồng cho cả hai store | `test/shared.js` |
| Bố cục đồ đạc và hướng quay (`rot`: 0 nam, PI/2 đông, PI bắc, -PI/2 tây) | `lib/world.js` |
| Cảnh 3D, ánh sáng và nút ✨ đổi đồ họa (cao / an toàn, vẽ thẳng, không có hậu kỳ) | `public/scene3d.js` |

## Ranh giới kiểm tra và token

Server là nơi quyết định mọi thứ quan trọng: client chỉ gửi vị trí và yêu cầu đập, server kiểm tra khoảng cách, chống dịch chuyển tức thời, giới hạn tốc độ đập và số tin nhắn mỗi giây. Tên người chơi được làm sạch ở server và chỉ hiển thị bằng `textContent` hoặc canvas ở client. Token của người chơi chỉ để nhận lại chỗ cũ sau khi reconnect, nó không phải thông tin xác thực account. Quyền account lấy từ phiên đã xác minh; id realtime công khai của người chơi vẫn là số nguyên không liên quan tới phiên đó.

## Quyết định kiến trúc

Xem [ADR](adr/README.md) để biết vì sao chọn store dùng chung, runner có lease, render trực tiếp và map va chạm tĩnh. [Phát triển](DEVELOPMENT.vi.md) hướng dẫn sửa và kiểm tra code.

Quy tắc thay đồ nằm ở `lib/object-respawn.js`; script Lua lấy hệ số từ cùng constants và tính trên state Redis ngay trong lượt housekeeping, không dùng số đếm riêng của từng instance. Tuổi đồ vỡ giữ nguyên. [Công thức và ví dụ](GAMEPLAY.vi.md#it-tự-thay-đồ).

## Tài khoản và hồ sơ lâu dài

[Identity đợt 1](IDENTITY.vi.md) tách account Google đã xác thực và nhân vật Postgres theo phòng khỏi gameplay, hiệu lực phiên và quyền kết nối Redis. Tên đăng ký được giữ cả khi offline. Join/mutation hồ sơ phối hợp SQL với khách và bot online; Redis write có fence connection/session. Không query Postgres theo frame hay heartbeat. BXH ngày (bảng ngày trên Redis + hàng đợi bền xả vào Postgres) và chat giữ 24 giờ được mô tả ở [BXH ngày](SCORES.vi.md); Redis vẫn là nguồn chân lý cho gameplay trực tiếp, Postgres chỉ bị chạm theo lô thưởng, không theo frame hay heartbeat.

Khi cấu hình hồ sơ lâu dài có giữ tên, heartbeat phải gia hạn trước khi lease hết. Heartbeat đến muộn không tạo lại owner đã hết hạn hoặc bị prune; client phải join lại và kiểm tra tên đã giữ.

## Thân va chạm động

`public/actor-collision.js` cung cấp cùng phép di chuyển chia bước theo hình tròn cho dự đoán ở browser và xác minh ở server. Đồ đạc vẫn dùng hình học tĩnh có thẩm quyền. Tâm boss/mini-boss còn sống lấy từ snapshot runner/pubsub hiện có; không thêm database, heartbeat hay field identity. Server sửa vị trí bị chặn và tách phần chồng lấn còn lại sau cập nhật snapshot. Người/người và người/bot không chặn nhau. Animation kéo/thổi trong duel hoàn tất trước khi tách thân thông thường tiếp tục. Xem [ADR 0007](adr/0007-dynamic-actor-collision.md).


Hash boss còn giữ lịch đi tuần có version và vị trí lưu mỗi giây; cập nhật phải có lease boss hiện tại cùng version mong đợi. Dấu tủ đã hỗ trợ (`rack:<object id>`) nằm trong cùng hash tới lúc boss hồi sinh; script đánh đồ commit nguyên tử tủ vỡ, tiền thưởng và damage sếp có giới hạn. Xem [sếp đi tuần](BOSS.vi.md#sếp-đi-tuần).


Canvas và HUD fixed dùng chung mặt phẳng layout động `#app`, được `viewport.js` theo dõi; `innerHeight` của layout đặt chiều cao tối thiểu khi xoay còn để lại giá trị root/đơn vị động cũ. Safe-area inset do trình duyệt cung cấp bảo vệ nội dung mà không thu nhỏ nền game. Số đo visual viewport vẫn chỉ dùng cho bàn phím. Xem [layout mobile và giới hạn kiểm tra](MOBILE.md#safe-areas-and-rotation-previews).

## Máu boss theo dân số

Hash boss lưu HP hiện tại/tối đa, `rev` tăng dần, bộ đếm ngưỡng riêng `population` và `popAt`. Chủ lease hiện tại gọi `bossScale` mỗi giây; một thao tác store kiểm tra lease, đếm presence còn hạn toàn room trừ ID nội gián và cộng chênh lệch mức máu. Người đang chờ hồi sinh vẫn tính; presence hết hạn không tính. Quá ba giây không quan sát thì xác nhận ngưỡng bắt đầu lại. Hồi sinh tính lại HP hiện tại/tối đa theo số người thật đang có. Đòn thường không còn chia damage theo số mục tiêu gần boss.

`bossHit` nhận `share` cho ulti và tính damage theo max HP trong store nguyên tử cùng cú đánh; tủ hỗ trợ và ngưỡng rắn cũng đọc max HP này. Tăng mức giữ ledger đóng góp, dấu tủ và đợt rắn. Mọi thay đổi máu tăng `rev`; `bhp`, `bup` và welcome mang max HP/phiên bản để bản pub/sub đến muộn không ghi đè trạng thái mới. Các trường dân số và phân loại người/bot không nằm trong tin này; HP công khai vẫn có thể cho phép suy luận một phần. Xem [ADR 0010](adr/0010-population-boss-health.md) và [luật](BOSS.vi.md#máu-theo-số-người).
