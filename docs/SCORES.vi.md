# BXH ngày, lưu điểm và lịch sử chat

[English](SCORES.md) · [Tài liệu](README.md) · [Quyết định](adr/0008-daily-scores-and-chat.md)

## Người chơi nhận được gì

- **BXH hôm nay** — mỗi phòng (BR-1, BR-2) một bảng, về 0 lúc 00:00 giờ Asia/Ho_Chi_Minh. Bảng gồm mọi người đã chơi phòng đó hôm nay: online, offline, khách và bot, xếp theo điểm hôm nay. Điểm bằng nhau cùng hạng, thứ tự phụ ổn định. Tiêu đề ghi "BXH hôm nay · phòng", tổng ở đầu bảng là thiệt hại hôm nay của phòng. Hộp thoại có tab thứ hai **bị PIP**: số lần bị PIP hôm nay của từng người (kể cả offline), cùng cách reset và lưu như điểm, top 50 cộng hạng của bạn. Mọi người nhận top 50; ai ngoài top được gửi hạng của riêng mình khi hỏi.
- Ai ở lại qua nửa đêm tự sang ngày mới với 0 điểm, không cần vào lại. Đổi ngày không xóa nhân vật. Không có BXH all-time và không lưu lịch sử người thắng.
- **Khách** có tên trên bảng. Điểm khách chỉ nhận lại được khi token định danh của tab còn hợp lệ (lưu trong `sessionStorage`); tên không phải bằng chứng sở hữu. Sau khi đăng nhập Google ở cùng tab, điểm hôm nay của khách trong phòng đó được chuyển **một lần** sang nhân vật và cộng vào điểm đã có. Chỉ điểm và số đồ phá được chuyển: khách giữ dòng của mình (về 0) cùng số lần bị PIP, số lần ngỏm không bao giờ chuyển. Khách chưa có điểm hôm nay thì không chuyển gì. Đăng xuất hoặc đăng nhập tài khoản khác không chuyển lại được.
- **Chat** thuộc phòng, giữ 24 giờ kể từ lúc server nhận tin. Vào phòng tải 50 dòng mới nhất; kéo lên tải trang cũ hơn bằng cursor; reconnect tự lấp khoảng thiếu. Dòng lịch sử không tạo bong bóng trên đầu. Tin chỉ hiện là đã gửi sau khi lưu xong; nếu lưu lỗi người gửi thấy "Chưa gửi được tin nhắn" và không ai thấy tin. Khi đổi tên nhân vật (chỉ làm được lúc offline), các tin nó đã gửi trong 24 giờ gần nhất hiện tên mới từ lần tải lịch sử kế tiếp; dòng đang nằm trên màn hình ai đó giữ tên cũ tới khi họ vào lại.

## Dữ liệu nằm ở đâu

| Dữ liệu | Redis | Postgres |
| --- | --- | --- |
| BXH ngày đang chạy (`ds:<day>` zset, `di:<day>` hash) | có, TTL 4 ngày | dựng lại từ đó |
| Hàng đợi sự kiện bền (`evq`, `qs`) | có, **không TTL**, có giới hạn | — |
| Sự kiện đã áp (`score_events`), điểm ngày (`daily_scores`), chuyển điểm | — | có |
| Chat (`chat_messages`) | — (pub/sub chỉ để giao tin trực tiếp) | có |

Điểm lưu bằng **phần mười điểm** (mọi giá đồ và phần thưởng boss đều là bội của 0,1). Ngày = số ngày nguyên từ epoch theo UTC+7, tính từ đồng hồ instance chốt khoản thưởng.

ID người tham gia là nội bộ: `c:<uuid nhân vật>`, `g:<HMAC của phòng và token tab>`, `b:<uuid ngẫu nhiên>` (bot). Chúng khác player id số trong Redis (id này bị dùng lại khi phòng hết hạn). Không thứ gì gửi cho client chứa ID này hay cho biết một dòng là bot. Bot có dòng ngay từ lúc xuất hiện như người khác và giữ dòng offline sau khi rời.

## Luồng điểm

1. Mỗi khoản thưởng (phá đồ, giết nội gián, chia thưởng VKL, TML/DMM) chạy một script Lua Redis: cập nhật gameplay **và** BXH ngày **và** thêm sự kiện (`{id, actor, tenths, breaks, deaths, name, day}`) vào hàng đợi. Điểm không bao giờ được cộng mà thiếu sự kiện.
2. Worker sync (`lib/scoreboard.js`, `sync`) lấy khóa hàng đợi của phòng, đọc tới 500 sự kiện, áp trong một transaction SQL (khóa chính `score_events` = chống trùng; advisory lock theo phòng = giữ thứ tự), rồi xóa bằng **ack có điều kiện** (id đầu và cuối phải còn khớp). Chỉ ack sau khi commit, nên mất ack chỉ khiến lô chạy lại và ledger bỏ qua. Hai worker, hoặc worker hết khóa, không thể áp đôi hay cắt sự kiện của người khác.
3. Ngày của sự kiện = ngày khoản thưởng được chốt, không phải ngày worker chạy. Sync trễ sự kiện hôm qua vẫn vào dòng hôm qua.
4. Instance tự xả hàng đợi mỗi ~5 giây khi phòng có người, nhưng **không có gì dựa vào đó**: hãy chạy job maintenance theo lịch (bên dưới).

### Khôi phục và nhất quán

BXH đang chạy là dữ liệu *suy ra*: `dòng SQL + sự kiện trong hàng đợi mà SQL chưa có`. Nó được dựng lại (`ensure`) khi bảng của một ngày thiếu: lần đầu dùng ngày mới, Redis restart/bị evict, hoặc sau chế độ degraded. Việc dựng giữ khóa hàng đợi, đọc hàng đợi, hỏi SQL id nào đã commit, rồi chạy đúng một script Lua, nên không cộng SQL và hàng đợi hai lần. Nếu Postgres không với tới, bảng degraded được dựng chỉ từ hàng đợi và dựng lại từ SQL ở lần thử sau. Sau khi dựng thất bại, cổng Redis dùng chung chỉ cho thử lại tối đa một lần mỗi 30 giây theo phòng và ngày, cho mọi instance và đường gọi (`board`, deaths, touch, transfer và housekeeping); trong lúc chờ vẫn đọc bảng degraded. Việc dựng kiểm tra lại trạng thái ngày sau khi lấy khóa hàng đợi; lượt đọc degraded không chờ khóa đang bận. Sync hàng đợi có lịch riêng và không bị cổng dựng bảng này trì hoãn. Gameplay chạy tiếp trong mọi trường hợp này.

ID sự kiện là `<run id>:<số thứ tự>`; run id mới mỗi khi Redis bắt đầu hàng đợi mới, nên không bao giờ trùng id Postgres đã giữ từ lần trước.

Chấp nhận mất: điểm chưa sync khi Redis mất dữ liệu. Không chấp nhận: cộng đôi do retry, mất ack, worker đồng thời hay dựng lại.

### Giới hạn hàng đợi và theo dõi

`SCORE_QUEUE_MAX` (mặc định 20000) giới hạn sự kiện chưa sync. Vượt mức, sự kiện mới **không được xếp hàng**: BXH live vẫn hiện điểm nhưng điểm sẽ không tới Postgres; mỗi lần từ chối tăng `dropped`. Không cắt âm thầm. Xem `GET /api/health?deep=<HEALTH_KEY>` (`queue.<room>.len`, `dropped`, `syncAt`, `err`) hoặc `npm run maintenance -- --status` (thêm kết quả job gần nhất, số dòng bảng, dung lượng DB). `len` tăng mà `syncAt` cũ nghĩa là chưa có job nào xả hàng đợi.

### Chuyển điểm khách

Khi vào phòng đã đăng nhập, server suy ra participant khách từ token tab trong tin join và, trong một script Lua, chuyển điểm và số đồ phá của khách sang dòng nhân vật (dòng khách ở lại với 0 điểm cùng số lần ngỏm; không làm gì nếu cả hai bằng 0), ghi `x:<khách> = nhân vật` cho ngày và thêm sự kiện chuyển. Quy tắc: chỉ hôm nay và cùng phòng; một lần cho mỗi participant khách (sau đó trả `exists`); khách chưa có điểm lẫn đồ phá thì không làm gì; không áp dụng cho bot (ID bot không suy ra được từ thứ client có). Không có chuyển hướng nào: những gì khách kiếm hoặc chịu sau đó (ví dụ chơi lại bằng khách sau khi đăng xuất ở cùng tab) ở lại trên dòng khách, và lần chuyển thứ hai cho tab khách đó bị từ chối trong ngày. Sự kiện đã nằm trong hàng đợi lúc chuyển được áp trước vì SQL áp chuyển điểm theo thứ tự hàng đợi, sau các sự kiện trước đó của khách. Dấu `x:<khách>` được lưu ở `score_transfers` và khôi phục khi dựng lại bảng.

### Nửa đêm

Khóa của bảng và sự kiện được tính lúc chốt khoản thưởng, nên người online lúc 00:00 tự cộng vào ngày mới. Housekeeping dựng bảng ngày mới và tạo dòng 0 cho từng người trên instance. Trận VKL kéo qua nửa đêm trả thưởng vào ngày chốt hạ boss. Không có job reset.

## Thời gian giữ và dọn dẹp

| Dữ liệu | Giữ |
| --- | --- |
| `daily_scores` (điểm, số đồ phá, số lần bị PIP), `score_events`, `score_transfers` | hôm nay và hôm qua (dòng có `day` < hôm qua bị job xóa) → 24–48 giờ sau khi hết ngày |
| Sự kiện trong hàng đợi của ngày cũ hơn | **không ghi**; đếm vào `expired` trong kết quả job (để dòng đã dọn không hiện lại) |
| Chat | 24 giờ từ lúc nhận; truy vấn tự lọc theo tuổi dù job chưa chạy; job xóa theo lô 2000 |
| Khóa Redis của bảng ngày | TTL 4 ngày |

## Vận hành

Không có gì tự cấu hình scheduler cho bạn. Gọi job ít nhất vài phút một lần (mỗi phút cũng được, rất rẻ khi rảnh):

```bash
npm run maintenance                  # chạy một lần: xả hàng đợi, xóa dữ liệu hết hạn, ghi kết quả
npm run maintenance -- --status      # backlog, số bị bỏ, kết quả gần nhất, dung lượng
curl -H "Authorization: Bearer $MAINTENANCE_SECRET" https://<domain>/api/maintenance           # tương tự qua HTTP (GET, HEAD hoặc POST)
curl -H "Authorization: Bearer $MAINTENANCE_SECRET" "https://<domain>/api/maintenance?status=1"
```

Monitor không gắn được header (ví dụ UptimeRobot) dùng `https://<domain>/api/maintenance?key=<secret>` bằng GET hoặc HEAD mỗi 5 phút (HEAD cũng chạy job); secret khi đó nằm trong URL và log, và chỉ cho người ta chạy job idempotent này. Lần chạy khi hàng đợi rỗng chỉ chạm Redis, nên lịch gọi dày không giữ Postgres serverless thức mãi: phần dọn SQL chạy tối đa 6 giờ một lần (các instance dùng chung cổng này) và dòng status chỉ ghi khi có việc; `npm run maintenance` luôn ép chạy dọn. Endpoint tắt trừ khi có secret dài từ 8 ký tự: `MAINTENANCE_SECRET`, nếu không thì `CRON_SECRET` (Vercel Cron gửi sẵn), nếu không nữa thì dùng luôn `HEALTH_KEY` đang có. Job idempotent, chạy đồng thời vẫn an toàn. Trên Vercel hãy tự thêm cron, ví dụ `{ "crons": [{ "path": "/api/maintenance", "schedule": "*/5 * * * *" }] }`; repo này không thêm sẵn.

## Cấu hình

| Biến | Ý nghĩa |
| --- | --- |
| `DATABASE_URL` | Bật lưu điểm và lịch sử chat (và tài khoản). Không có thì BXH chỉ live và chat chỉ broadcast |
| `SCORE_PERSIST=0` | BXH ngày chỉ ở Redis (không hàng đợi, không SQL) |
| `CHAT_HISTORY=0` | Chat chỉ broadcast dù có database |
| `SCORE_QUEUE_MAX` | Giới hạn sự kiện chưa sync, mặc định 20000 |
| `MAINTENANCE_SECRET` / `CRON_SECRET` / `HEALTH_KEY` | Secret cho `/api/maintenance`, cái nào có trước dùng cái đó |
| `DB_POOL_MAX` | Cỡ pool Postgres mỗi instance, mặc định 4 |

## Triển khai

1. Request đầu tiên của bản mới tự áp migration `002-daily-scores-chat.sql` (cùng cơ chế với tài khoản); hoặc chạy `npm run db:migrate` trên bản sao dùng-một-lần trước.
2. **BXH ngày bắt đầu trống** khi bật; điểm Redis cũ không được nhập (và không bao giờ ghép theo tên).
3. Ngắt instance bản cũ (thông báo build đã làm việc này): instance cũ không ghi bảng ngày hay sự kiện nên điểm của nó sẽ thiếu trên bảng.
4. Cấu hình scheduler, rồi theo dõi `queue.len` / `syncAt` ở health check.
5. Rollback bằng cách deploy lại bản cũ; bảng và key thừa không ảnh hưởng. Đặt `SCORE_PERSIST=0` / `CHAT_HISTORY=0` để tắt từng phần mà không đổi code.

## Chưa kiểm chứng live

Hành vi TLS pooled và độ trễ SQL theo lô trên Neon, script/TIME/bộ nhớ/chính sách evict của nhà cung cấp Redis, Vercel cron có chạy đúng không, và đăng nhập Google thật chưa được test container dùng-một-lần bao phủ. Xem [Phát triển](DEVELOPMENT.vi.md#kiểm-thử-điểm-và-chat).
