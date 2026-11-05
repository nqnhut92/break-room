# Bạn sếp nằm vùng

[English](MOLES.md) · Tiếng Việt

Bạn sếp là người chơi giả do server điều khiển. Nó vào phòng qua đúng cửa mà người thật dùng (có chỗ, tên ngẫu nhiên viết như người ta hay gõ (biệt danh, `tuan97`, `hoa_qa`, thêm chữ cái đầu), vai trò, tính vào số online và bảng xếp hạng) nên nhìn giống một đồng nghiệp bình thường. Không có gì trên đường truyền cho biết nó là ai.

- **Xuất hiện.** Instance đang điều khiển phòng (giữ lease của sếp) thêm một con mỗi 1–3 phút, không bao giờ quá nửa số người thật (6 người thì tối đa 3 con) và luôn chừa một chỗ trống. Người thật vào phòng đầy thì chiếm chỗ của một con.
- **Hòa nhập.** 20–90 giây đầu nó đi dạo và đập đồ như người chơi (cùng lưới đường đi với rắn). Nó không chat, không thả emoji.
- **Đâm lén.** Rồi nó đi tới một người (ưu tiên người đang đánh sếp, không thì ai cũng được) và đâm không báo trước: `-30` máu. Đòn đó làm nó lộ: hiện nhãn `🐍 BẠN SẾP` và thanh máu, tiếp tục đuổi bằng búa mặc định (`-20` mỗi đòn) rồi đi sau 40 giây (hoặc 4 phút kể từ lúc vào, dù chuyện gì xảy ra).
- **Nhận ra bằng cách đánh.** Đánh người thật miễn phí và chỉ để vui. Đánh bạn sếp tốn mana như đập đồ và làm nó lộ. Máu và tiền thưởng bằng tủ server (8 máu, 120). Tiền thưởng thuộc về người ra đòn kết liễu.
- **Nằm ở đâu.** `lib/moles.js` là hành vi thuần (test không cần socket). `lib/realtime.js` chạy nó (`moleTick`, `spawnMole`, `hitMole`). Bí mật (máu, đã lộ hay chưa) nằm trong hash `moles` của store (`moleAdd/moleList/moleReveal/moleHit/moleDel`), nên đòn đánh từ instance nào cũng nguyên tử. Instance lên điều khiển mới sẽ cho các con của người trước về.
- **Chỉnh.** `MOLE_DISABLED=1` tắt hẳn; `MOLE_SPAWN_MS=5000` cho một con mỗi 5 giây (để thử). Test thu nhỏ thời gian bằng option `moleSpawnMs` và `moleOpts`.
- **BXH ngày.** Bạn sếp có dòng trên BXH ngày của phòng ngay từ lúc xuất hiện, y như người chơi, và giữ dòng đó dạng offline sau khi rời. ID của nó ngẫu nhiên và chỉ có ở server; không tin nhắn BXH, join hay chat nào cho biết nó là gì. Xem [BXH ngày](SCORES.vi.md).


Trong [đợt đi tuần](BOSS.vi.md#sếp-đi-tuần), boss cũng đánh bot nhưng không làm lộ. Bot chưa lộ bỏ chạy và ngừng đâm lén; người chơi đánh vẫn làm lộ. Damage boss được quy đổi về thang 8 HP của bot, không phải trừ thẳng 30 rồi chết một hit. Boss hạ bot không phát bounty cho người chơi, chỉ hiện gục thông thường. Bot đập tủ server cũng bị phản điện.
