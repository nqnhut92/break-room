# VKL, boss của phòng server

[English](BOSS.md) · Tiếng Việt · [Kiến trúc](ARCHITECTURE.vi.md)

Mỗi server (BR-1, BR-2) có một boss duy nhất, **VKL**, đi tuần trong phòng server. Đây là thứ duy nhất trong game làm người chơi bị thương. Trang này nói cách chơi và quan trọng hơn là **vì sao làm thế này**, để sau này sửa không vô tình phá một quyết định đã có lý do.

## Cách chơi

- Sếp đi một vòng trong phòng server. Khi có người **ở trong phòng** (hoặc đứng ở khoảng sân ngay trước cửa) sếp chạy lại người gần nhất, giơ nắm đấm lên (0,7 giây, **vòng đỏ** dưới sàn báo chỗ nắm đấm sẽ rơi) rồi đấm. Ai đang trong vòng lúc nắm đấm rơi thì mất 30 máu. Chạy ra khỏi vòng kịp lúc là né được.
- Người chơi có 100 máu (thanh máu trên đầu khi bị thương, và một ô ở thanh trên cùng). Bốn cú đấm là gục. Nằm **15 giây**, vẫn chat được, rồi hồi sinh ở **sảnh**, không bao giờ hồi sinh ngay chỗ ngã.
- Máu hồi chậm: 4 giây đầu sau cú đấm không hồi gì, sau đó 5 máu mỗi giây (đầy lại khoảng 24 giây sau cú cuối). Ra khỏi phòng chờ một chút là lựa chọn thật sự.
- Sếp có 3.600 máu, một cú búa gây 10 (tức 360 cú) và sếp tự hồi máu (xem bảng). **Một hay hai người không hạ nổi, khoảng năm người hạ trong hai phút, đông người cũng không dễ.**
- Sếp ngã thì **500 triệu tiền thưởng** được cộng vào bảng thiệt hại, chia theo sát thương mỗi người gây ra. 3 đến 5 phút sau (ngẫu nhiên) sếp quay lại chỗ cũ với đầy máu.
- Sếp không bao giờ rời phòng server: bạn đi ra thì sếp quay lại tuần tra và hồi máu. Trong phòng có sáu tủ server, mỗi tủ 120 triệu, nên đáng để liều.

## Các con số

Tất cả nằm trong `BOSS` và `PLAYER` ở [`lib/boss.js`](../lib/boss.js), không chỗ nào khác ghi cứng (client nhận qua tin `welcome`).

| Thiết lập | Giá trị | Lý do |
| --- | --- | --- |
| Máu người chơi | 100 | Bốn cú đấm. Đủ ít để thấy nguy hiểm, đủ nhiều để sống sót qua một lỗi. |
| Cú đấm của sếp | 30 sát thương, báo trước 0,7 giây, hồi 0,6 giây | "Phải đau" nhưng né được. Người chạy hết tốc độ thoát khỏi vòng trong khoảng 0,29 giây. |
| Tốc độ sếp | 110 khi tuần tra, 280 khi đuổi (người chơi đi 420) | Luôn chạy trốn được, chỉ là không được đứng yên. |
| Máu sếp | 3.600, mỗi cú búa 10 | Chỉnh theo mô phỏng bên dưới. |
| Hồi máu sếp | luôn 5/giây, thêm 20/giây sau 5 giây không bị đánh | Xem "Vì sao sếp tự hồi máu". |
| Hồi máu người chơi | 5/giây sau 4 giây | Vừa phải: không "không bao giờ", không "ngay lập tức". |
| Người chơi hồi sinh | 15 giây, ở sảnh | Trước là 60 giây; người chơi thấy một phút là quá lâu. |
| Sếp hồi sinh | ngẫu nhiên 3 đến 5 phút | Theo yêu cầu. |
| Tiền thưởng | 500 triệu, chia theo sát thương | Xem "Vì sao chia theo sát thương". |
| Tầm búa | 150 tính từ giữa người sếp, và không bị vật cản | Sếp to; tường và tủ chắn được cú đập. |

### Mô phỏng nói gì

`node test/boss.js` chạy một mô hình cố ý rộng rãi (không ai chết hay đánh trượt, mọi người đập nhanh nhất mana cho phép, lấy kiểu đập tốt hơn trong hai kiểu) rồi in thời gian sếp sống được:

| Số người trong phòng | 1 | 2 | 3 | 4 | 5 | 8 | 20 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Giây để hạ sếp | không bao giờ | không bao giờ (> 15 phút) | ~310 | ~170 | ~115 | ~115 | ~115 |

Trận thật khó hơn mô hình vì người chơi bị đấm, nên 3 đến 4 người đánh rất vất vả, từ 5 người trở lên thắng được dù có người ngã, 1 đến 2 người không thể. Test sẽ fail nếu các lời hứa này bị phá, nên chỉnh lại số là an toàn: sửa `BOSS`, chạy `npm test`.

## Vì sao làm thế này

**Thang sát thương riêng, không phải "gấp 100 đến 1000 lần máu".** Ý đầu tiên là sếp có máu gấp 100 đến 1000 lần người chơi. Hiểu đúng nghĩa thì là 10.000 đến 100.000 máu, mà mỗi cú đập chỉ 1 sát thương và cả nhóm chỉ đập được khoảng bốn cú mỗi giây, nên sếp như vậy không bao giờ chết. Điều quan trọng là *thời gian hạ sếp*, không phải tỉ lệ. Nên cú búa vào sếp tính 10 và sếp có 3.600 (gấp 36 lần máu người, 360 cú), số được chọn theo thời gian hạ ở bảng trên.

**Vì sao sếp tự hồi máu (hai tầng).** Không hồi máu thì một người kiên nhẫn có thể thắng: đánh, trốn, quay lại. Chỉ hồi sau khi nghỉ cũng chưa đủ, vì ai đánh mỗi 4,9 giây thì khoảng nghỉ không bao giờ bắt đầu. Nên có một mức hồi nhỏ luôn chạy (5/giây), lớn hơn lượng một người đánh được khi bị mana giới hạn (khoảng 3,7/giây), cộng thêm hồi nhanh sau khi nghỉ để chặn đánh rồi chạy. Gộp lại: một hay hai người không bao giờ thắng, cả nhóm phải bám sát. Hồi máu được *tính* từ giá trị đã lưu và thời điểm lưu (`bossHpAt`), không phải chạy đồng hồ, nên không tốn gì khi phòng vắng và giống hệt nhau ở mọi instance.

**Vì sao sát thương theo số đông.** Nếu hai mươi người bạn vào, sếp chỉnh cho năm người sẽ chết trong 30 giây. Mỗi cú búa được chia cho `max(1, số người trong phòng sếp / 5)`, nên thời gian hạ sếp vẫn quanh hai phút dù đông hay vắng. Số này đếm người *còn sống và đang trong khu vực của sếp*, không phải số người online, nếu không thì mười lăm người đứng trong nhà vệ sinh làm sếp khoẻ hơn với năm người đang đánh, còn một đám đông đứng ngoài thì chẳng ảnh hưởng gì.

**Vì sao sếp chỉ ở trong phòng server.** Bạn yêu cầu thế, và nó cũng giữ phần còn lại của game an toàn: người mới vào spawn ở sảnh, văn phòng mở không bao giờ nguy hiểm. Giống "phòng boss" trong RPG cũ: bạn chọn bước vào. Vì sếp chỉ để ý người trong phòng (hoặc trên khoảng sân trước cửa) nên đứng ở cửa chọc sếp cũng không thành đánh miễn phí: khoảng sân được tính, sếp sẽ bước ra gặp bạn.

**Vì sao có vòng đỏ.** "Làm cho đau" và "làm cho công bằng" kéo ngược nhau. Sát thương lớn (bốn cú là gục) để nó có ý nghĩa; 0,7 giây báo trước làm mỗi cú đều né được, nhờ vậy sát thương chấp nhận được thay vì ngẫu nhiên. Trên điện thoại, chạm để đi chậm hơn bàn phím nên khoảng báo trước được cho rộng rãi.

**Vì sao máu người chơi hồi vừa phải.** Máu không bao giờ hồi thì một lỗi làm hỏng cả lượt và người ta bỏ cuộc. Hồi tức thì thì máu chẳng có nghĩa gì. Bốn giây yên rồi năm máu mỗi giây nghĩa là "ra khỏi phòng 25 giây rồi quay lại khoẻ", một lựa chọn chiến thuật chứ không phải nút reset miễn phí.

**Vì sao trạng thái ngất nằm trong store.** Nếu đồng hồ ngất chỉ nằm trong kết nối thì F5 là sống lại ngay. Thời điểm được hồi sinh được lưu cùng người chơi (`h<id>` trong hash tên của phòng), nên tải lại trang, nối lại hay đổi kết nối sau vài phút đều không hồi sinh hay hồi máu sớm được. (Danh tính hoàn toàn mới, ví dụ hồ sơ trình duyệt khác, vẫn bắt đầu lại; chấp nhận cho game giải trí.)

**Vì sao chia thưởng theo sát thương.** Nếu không, người tình cờ tung cú cuối (có khi chỉ là người đi ngang bấm một lần) ôm hết, còn cả nhóm chịu đòn hai phút không được gì. Sát thương mỗi người được ghi (`bdmg`, tính lượng thật sự có hiệu lực, đánh dư không được cộng thêm).

**Vì sao cú búa cần đường thẳng không bị chắn.** Server trước đây chỉ kiểm tra khoảng cách. Sếp ở sau kính thì ai đứng ngoài tường cũng đánh được trong khi sếp không đụng được họ. Giờ mỗi cú cần `clearLine` giữa hai bên (tường và đồ đạc chắn được).

**Vì sao bỏ vai "Sếp".** Giờ chỉ có đúng một sếp. Danh sách vai trò không còn "Sếp"; lựa chọn đã lưu cũ tự về nhân viên thường.

**Diện mạo của sếp.** Sếp dùng cùng thân dựng bằng code như người chơi (`makePlayer` trong `scene3d.js`, `gender: 'boss'`): vest xanh navy, cà vạt đỏ, tóc bạc dựng và vương miện vàng, phóng to bằng `BOSS_SCALE`. Người chơi chỉ chọn `m` hoặc `f`; màn hình vào phòng và server chỉ nhận hai giá trị đó.

## Chạy trên nhiều instance thế nào

Game chạy trên nhiều instance Vercel cùng lúc, nên phải có **đúng một sếp mỗi phòng** và không instance nào được tin vào suy đoán của instance khác về vị trí người chơi.

- **Một người điều khiển.** Instance giữ một hợp đồng ngắn trong store (`blk`, 3 giây, gia hạn mỗi giây, instance nào có người trong phòng cũng thử giành) sẽ điều khiển sếp: đi tuần, để ý người, tung đấm, và phát bản chụp vị trí. Nó chết thì instance khác giành hợp đồng trong khoảng 3 giây và đi tiếp từ bản chụp cuối. Phòng trống thì không instance nào giữ hợp đồng, nên tốn 0.
- **Ai cũng làm đau người của mình.** Người điều khiển phát `bstrike` (tâm và bán kính). Mỗi instance tự kiểm tra *người của nó* với vòng tròn bằng vị trí thật phía server rồi trừ máu. Không ai phải đoán vị trí người ở instance khác, và mỗi người chỉ bị đau một lần.
- **Nguyên tử ở chỗ cần.** Một cú đánh vào sếp là một script Lua (`bossHit`): cộng phần hồi máu, trừ cú đánh, ghi sát thương, và với cú kết liễu thì trả tiền thưởng và đánh dấu sếp gục, tất cả một lúc, nên hai instance cùng tung cú cuối không thể cùng trả thưởng. Máu sếp lưu kèm mốc thời gian (hash `boss`); máu người chơi nằm trong hash tên.
- **Chi phí.** Bản chụp vị trí gửi 5 lần mỗi giây khi sếp đi và 10 lần khi đánh, và chỉ khi nó di chuyển; nếu mọi người trong phòng ở cùng instance với người điều khiển thì không đụng Redis. Redis thấy khoảng một lệnh hợp đồng mỗi giây mỗi instance mỗi phòng, một `HMGET` mỗi giây cho người điều khiển, và một lệnh cho mỗi cú đánh vào sếp hoặc mỗi cú đấm trúng. Phòng trống thì sếp không có đồng hồ nào chạy.

### Các tin nhắn (server gửi client)

| Tin | Khi nào |
| --- | --- |
| `boss` | vị trí, hướng, trạng thái và số người trong tầm (thanh HUD dùng) |
| `bwind` | một cú đấm bắt đầu: tâm, bán kính, thời lượng (vòng đỏ) |
| `bstrike` | nắm đấm rơi |
| `bhp` | một cú đánh vào sếp, kèm máu mới (client tự cộng phần hồi) |
| `bdead` | sếp gục: ai gây bao nhiêu, mỗi người nhận bao nhiêu thưởng, bao lâu nữa quay lại |
| `bup` | sếp quay lại |
| `hp` | người chơi bị thương: máu mới và sát thương |
| `down` | người chơi bị hạ gục: bao nhiêu mili giây nữa hồi sinh |
| `up` | người chơi hồi sinh: ở đâu, máu mới |

Từ client: `bhit` (một cú búa vào sếp; server kiểm tra tầm, đường thẳng, mana và cooldown như với mọi đồ vật).

## Thử và chỉnh

Biến môi trường (đều không bắt buộc): `BOSS_DISABLED=1`, `BOSS_MAX_HP=300` (sếp gục sau 30 cú), `BOSS_RESPAWN_MS=5000`, `PLAYER_RESPAWN_MS=5000`.

Test: `test/boss.js` (luật, cân bằng), `test/boss-net.js` (cả một trận qua WebSocket), `test/shared.js` (cùng hợp đồng store trên memory và Redis thật, cộng một trận giữa hai instance).

## Giới hạn đã biết và ý tưởng

- Người bỏ danh tính cũ sẽ có đầy máu. Chấp nhận được với game này; bước sau là thời gian chờ theo IP.
- Ai đứng yên trong phòng server là mục tiêu dễ: bị gục và chờ 15 giây.
- Chưa có đẩy lùi: cú đấm chỉ gây sát thương và rung màn hình. Thêm thì server phải dời người chơi và báo client.
- Chưa có bảng riêng cho số lần hạ sếp; tiền thưởng vào bảng thiệt hại chung.
