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
- Có hai store cùng giao diện: `lib/store-redis.js` (dùng chung, chạy trên Vercel) và `lib/store-memory.js` (RAM, cho `npm start` và test). `lib/config.js` chọn store; trên Vercel mà thiếu `REDIS_URL` thì game từ chối chạy chứ không lùi về RAM.
- Mỗi WebSocket bị ghim vào instance nhận nó, còn reconnect có thể rơi vào instance khác. Vì thế state dùng chung không thể nằm trong RAM.

## Redis làm gì

**1. Giữ state dùng chung của mỗi server (BR-1, BR-2).** Một "phòng" là một server. Các key của phòng cùng hash tag `{room}` (cùng một slot cluster) và mọi script nhận cùng chín key:

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

Sếp VKL dùng thêm ba key của cùng phòng (cùng hạn sống): `boss` (hash: `hp`, `at`, `dead`, `respawnAt`), `bdmg` (hash: id người chơi → sát thương đã gây cho sếp hiện tại) và `blk` (hợp đồng của instance đang điều khiển sếp). Chúng không nằm trong bộ chín key ở trên; script của chúng chỉ nhận key cần dùng. Xem [BOSS.vi.md](BOSS.vi.md).

Lease kết nối theo IP (mỗi IP một zset) và key `br:keepalive` của health check nằm ngoài phòng.

**2. Thao tác nguyên tử.** Vào, rời, đập, dọn dẹp, snapshot và reset đều là một script Lua. Hai người ở hai instance đập cùng một món thì món chỉ vỡ đúng một lần và điểm cộng một lần. Việc kiểm tra tên nằm trong script vào phòng, nên hai người không thể giành cùng một tên trong cùng một khoảnh khắc.

**3. Pub/sub.** Instance nhận một hành động (đập, emoji, vị trí, vào/ra) sẽ publish lên kênh của phòng; mọi instance đang giữ người chơi của phòng đó chuyển tiếp cho client của mình. Pub/sub chỉ là tin tạm thời, không tốn dung lượng. Không đảm bảo giao tin; client được đồng bộ lại ở lần vào kế tiếp. Khi mọi người của một phòng cùng ở một instance thì vị trí đi nội bộ và không publish.

## Vòng đời và dọn dẹp

Redis không bị ghi vô hạn. Mọi thứ đều có hạn dùng hoặc kích thước bị chặn:

| Dữ liệu | Cách dọn |
| --- | --- |
| Cả phòng (9 key) | `touch` đặt `EXPIRE` bằng `ROOM_TTL_S` (mặc định 1800 giây) ở mỗi lần vào, rời và dọn dẹp. Phòng 30 phút không ai chạm vào thì biến mất hoàn toàn, gồm cả điểm, tên và token |
| Online (`on`, `own`) | Nhịp tim được làm mới khi dọn dẹp, khoảng mỗi giây (mỗi 2 giây khi chưa có gì vỡ). Người không có nhịp tim quá `PRESENCE_TTL_MS` (20 giây) bị loại, ví dụ khi instance chết |
| Đồ vật vỡ (`o`) | Dọn dẹp xoá mục sau khi vỡ đủ `RESPAWN_MS` (25 giây); "Gọi IT" xoá cả hash. Món chưa bị đụng không được lưu, nên `o` tối đa chỉ có khoảng 285 món (chỉ lưu món đã bị đập hoặc vỡ, mỗi món khoảng 20 byte; đo thực tế: đập hết cả 274 món trong một phòng chỉ tốn khoảng 6 KB) của văn phòng |
| Lease theo IP | Mỗi lease hết hạn sau 60 giây và được làm mới khi kết nối còn sống |
| `br:keepalive` | Hạn 3 ngày, ghi lại ở mỗi lần health check sâu |

Dọn nén (compaction): khi dọn dẹp, mỗi phòng còn chạy một lượt dọn nén nhỏ tối đa mỗi 2 phút (`lastCompact` trong `meta`). Nó quên token, tên, giới tính, vai trò, vị trí cuối và chỗ của mọi người chơi đã offline mà chưa từng ghi điểm. Người có điểm ở lại đến khi phòng hết hạn để bảng xếp hạng vẫn giữ họ. Nhờ vậy số mục theo token bị chặn bởi số người thật sự đã chơi chứ không phải mọi người từng ghé qua.

Kích thước ước lượng (ước tính, chưa đo): state của một phòng vài chục KB. Redis Cloud còn tính cả phần overhead nền của nó, nên một database gần như trống vẫn hiện khoảng 2 MB.

## Sức chứa và giới hạn

- **Dung lượng.** Dữ liệu bị chặn bởi 2 server × (khoảng 140 món + tối đa 20 người online + các mục token ở trên). Nó sẽ ở rất xa mức 30 MB của Redis Cloud Free. Nếu bộ nhớ vẫn đầy thì chính sách eviction quyết định: với `volatile-lru` (mặc định của Redis Cloud, đã thấy trên dashboard), Redis xoá các key có hạn dùng, tức là key của phòng cũ, thay vì từ chối ghi. Tệ nhất là một phòng mất state giữa chừng (đồ hồi lại, điểm về 0), chứ không sập.
- **Throughput mới là giới hạn chặt hơn.** Redis Cloud Free cho 100 ops/giây và 30 kết nối. Mỗi phòng có người tốn khoảng 1 lệnh mỗi giây cho mỗi instance đang giữ phòng đó (dọn dẹp, nhịp tim), cộng pub/sub khi có người di chuyển, cộng vài lệnh cho mỗi lần đập. Theo dõi **Metrics → Throughput** lúc đông người. Mỗi instance Vercel giữ tối đa hai kết nối Redis (lệnh và subscriber nạp trễ); nhiều instance thì 30 kết nối có thể thành trần thật sự.
- **Độ trễ.** Mọi hành động đi qua Redis, nên đặt region của hàm và của database cùng chỗ (ở đây cùng Singapore). `check:store` chạy từ nơi khác không đại diện cho độ trễ này; dùng `/api/health?deep=<HEALTH_KEY>` (`pingMs`) từ hàm đã deploy.
- **Database ngủ đông.** Redis Cloud Free xoá database không có lệnh nào khoảng 14 ngày. Một monitor gọi health check sâu ít nhất mỗi ngày một lần sẽ tránh được.
- **Bảo mật.** Redis Cloud Free không có TLS (`redis://`), mật khẩu đi không mã hoá. Dùng mật khẩu riêng cho database này và đổi nếu bị lộ. Không bao giờ commit hay ghi log `REDIS_URL`.

## Mỗi thứ nằm ở đâu

| Việc | File |
| --- | --- |
| Luật chơi, xử lý WebSocket, luật tên | `lib/realtime.js` |
| Script Redis và cách đặt key | `lib/store-redis.js` |
| Store RAM (cùng hợp đồng) | `lib/store-memory.js` |
| Chọn store, giới hạn, TTL từ biến môi trường | `lib/config.js` |
| Danh sách server (`BR-1`, `BR-2`) | `lib/world.js` (`ROOMS`), `lib/room-list.js` |
| Test hợp đồng cho cả hai store | `test/shared.js` |
| Bố cục đồ đạc và hướng quay (`rot`: 0 nam, PI/2 đông, PI bắc, -PI/2 tây) | `lib/world.js` |
| Cảnh 3D, ánh sáng và nút ✨ đổi đồ họa (cao / an toàn, vẽ thẳng, không có hậu kỳ) | `public/scene3d.js` |
