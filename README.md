# Break Room

Văn phòng đập phá nhiều người chơi. Vào phòng, đi quanh văn phòng cùng đồng nghiệp và đập laptop, màn hình, máy in, tủ server. Mỗi món vỡ sẽ cộng vào "tổng thiệt hại" của cả phòng, ai đập nhiều nhất lên bảng xếp hạng. IT sẽ thay đồ mới sau 25 giây, hoặc bấm nút "Gọi IT" để thay hết ngay.

## Chạy thử trên máy

```bash
npm install
npm start
```

Mở http://localhost:3000. Muốn chơi chung thì mở thêm tab khác (hoặc gửi link cho người khác nếu máy bạn truy cập được từ ngoài).

## Chơi chung với đồng nghiệp

Mỗi phòng có một tên, nằm trong link: `/?room=ten-phong`. Bấm "Copy link phòng" rồi gửi cho mọi người. Ai vào cùng link là vào cùng phòng, mỗi phòng tối đa 40 người.

## Điều khiển

| Hành động | Cách làm |
| --- | --- |
| Di chuyển | WASD / phím mũi tên, hoặc chạm vào nền |
| Đập | Space (giữ để đập liên tục), hoặc bấm thẳng vào đồ vật, hoặc nút ĐẬP! |
| Thả emoji | Phím 1 đến 8 hoặc bấm các nút emoji |

Bấm vào một món ở xa thì nhân vật tự chạy tới và đập cho tới khi vỡ.

## Deploy

Game cần một tiến trình Node chạy liên tục để giữ kết nối WebSocket, nên **không deploy được lên Vercel/Netlify dạng serverless**. Dùng host chạy Node thường trực như Render, Railway, Fly.io hoặc một VPS.

| Biến môi trường | Ý nghĩa |
| --- | --- |
| `PORT` | Cổng lắng nghe, mặc định 3000 |
| `TRUST_PROXY=1` | Bật khi chạy sau reverse proxy (Render, Railway, Nginx...) để giới hạn kết nối theo IP thật của người chơi. Nếu thiếu, mọi người cùng chung IP của proxy và sẽ bị chặn sau 10 kết nối |
| `RESPAWN_MS` | Thời gian đồ vật tự thay mới, mặc định 25000 |

Health check: `GET /healthz`.

## Cấu trúc

```
server.js        HTTP tĩnh + WebSocket, server giữ trạng thái phòng (máu đồ vật, điểm, kiểm tra tầm với và tốc độ)
public/          index.html, style.css, game.js (canvas, hiệu ứng, âm thanh tạo bằng WebAudio, không cần file ảnh/âm thanh)
test/smoke.js    test end-to-end bằng WebSocket thật
```

## Test

```bash
npm test
```

## Ghi chú thiết kế

Server là nơi quyết định mọi thứ quan trọng: client chỉ gửi vị trí và yêu cầu đập, server kiểm tra khoảng cách, chống dịch chuyển tức thời, giới hạn tốc độ đập và số tin nhắn mỗi giây. Tên người chơi được làm sạch ở server và chỉ hiển thị bằng `textContent` hoặc canvas ở client.
