# Tài khoản và nhân vật theo phòng (đợt 1)

[English](IDENTITY.md) · [Tài liệu](README.md) · [Quyết định](adr/0006-account-identity.md)

## Hành vi người chơi

Khách vẫn chơi ngay, không cần đăng nhập và không tạo bản ghi DB. Google login lưu tối đa một nhân vật/account/phòng. BR-1 và BR-2 có ID và hồ sơ độc lập, kể cả khi tên hiển thị giống nhau. Tên/email Google không ghi đè hồ sơ và không chứng minh quyền sở hữu nhân vật.

Đăng nhập quay về màn hình chọn phòng, không tự vào game. Ngoài phòng, chọn phòng để tự tải nhân vật đã lưu. Nếu chưa có, điền hồ sơ đang hiện và bấm “Tạo nhân vật & vào phòng” để xác nhận tạo rồi vào chơi trong một thao tác. Chỉ sao chép tên, giới tính, nghề và công ty; không nhận người chơi bằng tên. Lần vào đầu tiên bằng nhân vật sẽ chuyển điểm khách hôm nay của tab đó sang nhân vật, một lần ([BXH ngày](SCORES.vi.md#chuyển-điểm-khách)). Phải rời phòng khách trước khi tạo; nếu tên còn online ở nơi khác, thao tác bị từ chối. Nếu đã có nhân vật, khôi phục hồ sơ đó thay vì ghi đè bằng dữ liệu khách. Hồ sơ đã lưu hiển thị dạng thông tin chỉ đọc; “Sửa nhân vật” mới hiện form nhập. Thiết bị đăng nhập mới khi vào phòng sẽ thay kết nối điều khiển cũ. Reconnect/handover giữ slot Redis khi slot đó còn tồn tại.

Sửa tên, giới tính, nghề và công ty ở ngoài phòng bằng “Sửa nhân vật”. Nút chính “Lưu & vào phòng” lưu trước khi vào chơi; hủy chỉnh sửa sẽ khôi phục hồ sơ đã lưu. Backend từ chối sửa khi nhân vật đang online ở bất kỳ thiết bị nào, kể cả trình duyệt đang sửa. Đổi tên giữ nguyên UUID. Socket cũ đóng không xóa kết nối thay thế hoặc ghi đè máu/nộ cũ. Logout, thu hồi và hết hạn chấm dứt phiên chơi account, không biến nhân vật đang chơi thành khách. Mỗi thao tác kiểm tra phiên và quyền điều khiển; socket không gửi thao tác vẫn bị kiểm tra mỗi giây, chỉ qua Redis.

Điểm là dữ liệu gameplay Redis được đồng bộ sang Postgres thành BXH **ngày** theo phòng (nửa đêm Asia/Ho_Chi_Minh), và điểm hôm nay của khách được chuyển một lần sang nhân vật khi đăng nhập. Dòng BXH khóa theo participant id nội bộ của server (`c:<id nhân vật>`), không theo tên hay player id Redis; đổi tên sẽ đổi tên trên BXH và trên các tin chat trong 24 giờ gần nhất. Chat giữ 24 giờ. Xem [BXH ngày](SCORES.vi.md). Không có BXH all-time hay lịch sử người thắng. Bot không có account/character lâu dài và không có field công khai làm lộ danh tính; dòng BXH của bot dùng id ngẫu nhiên không bao giờ tới client.

## Tên và xử lý lỗi

Tên hiển thị chuẩn hóa Unicode NFC, bỏ ký tự điều khiển và dấu ngoặc nhọn, gộp khoảng trắng, trim, giới hạn 14 đơn vị UTF-16 theo giới hạn hiện tại. Công ty dùng giới hạn 20 đơn vị hiện tại. Backend kiểm tra các lựa chọn giới tính/nghề có sẵn. Khóa tên là tên đã chuẩn hóa chuyển về chữ thường; khác hoa/thường vẫn là cùng tên. Giữ cách viết hoa để hiển thị, không bỏ dấu và không đối chiếu email. Lowercase ở ứng dụng và DB phải đồng nhất; kiểm tra locale DB khi mở rộng bảng chữ cái hỗ trợ.

Tên đã đăng ký được giữ theo phòng cả khi offline. Khách và bot không được dùng tên đó. Tên cũng không được trùng, kể cả khác hoa/thường, với bất kỳ actor online nào. Tạo/sửa hồ sơ và join của người/bot dùng cùng transaction advisory lock Postgres theo phòng và kiểm tra presence Redis khi đang giữ lock. Unique constraint SQL bảo vệ thêm account/phòng và phòng/tên. Đây là phối hợp SQL–Redis, không phải SQL có thể rollback Redis. Join/commit lỗi có thể để lại presence ngắn hạn đến khi lease hết; không cấp quyền bằng tên.

Nếu không đọc được tên đã giữ, account nhận lỗi rõ ràng và tạm hoãn sinh bot mới. Khách nhận tên tạm `~…` do server sinh trong namespace mà hồ sơ đăng ký và tên khách tự nhập không được dùng. Nhờ vậy vẫn chơi khách khi Redis hoạt động mà không chiếm tên offline. Người đang chơi không query Postgres theo movement, frame hoặc heartbeat nên có thể tiếp tục khi DB lỗi. Local thiếu auth/DB vẫn chơi khách; ẩn nút Google. App tự chạy migration còn thiếu trước lần truy cập DB hồ sơ đầu tiên của mỗi instance. Nếu khởi tạo lỗi, không được coi như bảng giữ tên rỗng.

## Cấu hình

Dùng Node 20+ có Web Crypto (đã kiểm tra trên Node 24). Cài bằng `npm ci`. Có thể chép [.env.example](../.env.example) thành `.env` được ignore; server không tự đọc file này. Export biến hoặc chạy `node --env-file=.env server.js` trên Node 20.6+.

- `DATABASE_URL`: URL Postgres **pooled** của Neon cho runtime. Pool tối đa 3 connection, timeout lấy/kết nối 3 giây, statement 5 giây, query 6 giây và idle 10 giây. Giữ xác minh chứng chỉ TLS; nên dùng `sslmode=verify-full` với CA tin cậy. Tính giới hạn connection cho tổng các instance Vercel.
- `MIGRATION_DATABASE_URL`: kết nối migration **tùy chọn đến cùng database**, ưu tiên direct/unpooled nếu tách role quản lý schema. Không có biến này thì dùng `DATABASE_URL`, không cần khai báo thêm. Role dùng để migration cần quyền tạo/sửa schema.
- `AUTH_URL`: origin chuẩn, local `http://localhost:3111`, production `https://break-room.congtynhu.cc`. Không tin origin suy từ forwarded header tùy ý. Preview cần origin/app/callback riêng.
- `AUTH_SECRET`: secret ngẫu nhiên riêng, ít nhất 32 ký tự; không đưa ra frontend.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: credentials OAuth web client, chỉ ở backend.
- `REDIS_URL` (hoặc `KV_URL` có sẵn): Redis chung cho gameplay và thu hồi phiên giữa các instance production. Local một process có thể dùng RAM; phiên RAM mất khi restart. Mất Redis làm phiên account hết hiệu lực; đăng nhập lại tạo phiên mới.

Trong Google Cloud Console → Google Auth Platform, cấu hình Branding và External Audience. Khi Testing, thêm test users. Tạo client **Web application**, chỉ dùng scope `openid email profile`. Thêm authorized domain `congtynhu.cc` khi được yêu cầu. JavaScript origins: `http://localhost:3111` và `https://break-room.congtynhu.cc`. Redirect URI phải đúng:

```text
http://localhost:3111/api/auth/callback/google
https://break-room.congtynhu.cc/api/auth/callback/google
```

Nhập biến an toàn trong Vercel cho đúng environment. Cấu hình Vercel không tự cấp credentials cho máy Codex. Khi mở cho người ngoài test users, publish app đồng ý của Google sau khi có các thông tin công khai bắt buộc. Không lưu secret trong source, browser storage, URL hoặc log.

## Migration và rollout

App tự khởi tạo schema: trước thao tác DB account/hồ sơ/giữ tên đầu tiên của mỗi instance, app áp dụng SQL version còn thiếu. Khởi tạo thành công được cache trong process đó. Gameplay/movement Redis không chạy migration hay query Postgres. Local thiếu DB vẫn chơi khách được.

Transaction advisory lock ngăn các instance cold start chạy migration cùng lúc, kể cả qua Neon transaction pooling. SQL và bản ghi `schema_migrations` commit cùng nhau; lỗi thì rollback cả hai và request sau có thể thử lại. Version đã áp dụng được bỏ qua nên restart/deploy lại không tạo lại schema, reset nhân vật hay seed đè dữ liệu người dùng. Khi đổi schema, thêm migration mới; không sửa file đã áp dụng. Pool migration tạm có tối đa một connection, timeout kết nối/lock/statement hữu hạn và đóng sau khi xong. Bundle function Vercel được khai báo mang theo `migrations/*.sql`.

Nếu đã có `DATABASE_URL` và role có quyền quản lý schema, deploy không cần chạy migration tay. Nếu tách role runtime/migration thì cấp thêm `MIGRATION_DATABASE_URL` đến cùng DB. Lệnh thủ công vẫn có để dùng khi cần; ưu tiên biến migration, nếu thiếu thì dùng `DATABASE_URL`:

```bash
npm run db:migrate
```

Build/install không kết nối DB. Migration tự chạy trong app đang hoạt động, trước khi truy cập bảng hồ sơ. Kiểm thử migration trên DB bỏ đi trước khi phát hành. Task này không kết nối hay migration production. Tránh bản game cũ chạy đồng thời và bỏ qua protocol giữ tên mới: rollout có kiểm soát, ngắt instance game cũ trước khi bật tạo account. Không nhập dữ liệu khách cũ bằng cách trùng tên.

Auth.js Core xử lý state/nonce/PKCE của OIDC, CSRF đăng nhập/đăng xuất và cookie phiên mã hóa HttpOnly (Secure khi HTTPS, SameSite=Lax). Token chỉ có account ID nội bộ, session ID ngẫu nhiên có thể thu hồi và hạn dùng; không chứa Google access/refresh token. Phiên có hạn tuyệt đối bảy ngày. Trạng thái hiệu lực ở Redis, không ở Postgres; chiến lược JWT này không cần bảng SQL `auth_sessions`. Mutation hồ sơ còn yêu cầu Origin khớp chính xác, JSON body, phiên hợp lệ và quyền backend. Origin WebSocket đối chiếu `AUTH_URL`; reconnect token không xác thực account.

## Kiểm thử và phần cần xác minh live

```bash
npm test
npm run test:redis
npm run test:identity
CHROMIUM_PATH=/usr/bin/chromium npm run test:account-ui
CHROMIUM_PATH=/usr/bin/chromium npm run test:orientation
CHROMIUM_PATH=/usr/bin/chromium npm run test:settings
```

`test:identity` tạo Postgres 16 và Redis 7 Docker/podman mới với URL chỉ dành cho test. Không dùng `DATABASE_URL`, `MIGRATION_DATABASE_URL` hay Redis production. Test migration tự động/cold start đồng thời, khởi tạo lại không mất dữ liệu, rollback/retry khi DDL lỗi, callback account đồng thời, uniqueness, khôi phục/quyền edit, race tên SQL–Redis, fallback khách, fence ownership, WebSocket thật, logout/hết hạn và Google OIDC mock qua Auth.js. Mock không chứng minh Google live hoạt động. `npm test` có thể SKIP Redis khi thiếu `redis-server`; chỉ full run Redis mới xác minh phần đó.

Trước rollout production cần xác minh riêng Google consent/callback thật, cookie trên domain chuẩn, Neon pooled TLS/locale, Redis và khôi phục cùng account trên hai thiết bị thật. Browser dùng software rendering không chứng minh hành vi/hiệu năng iPhone. Đọc release notes Auth.js và chạy lại security/callback tests khi nâng core được pin.
