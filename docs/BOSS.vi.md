# VKL, boss của phòng server

[English](BOSS.md) · Tiếng Việt · [Kiến trúc](ARCHITECTURE.vi.md)

Mỗi server (BR-1, BR-2) có một boss duy nhất, **VKL**, đi tuần trong phòng server. Trang này nói cách chơi và quan trọng hơn là **vì sao làm thế này**, để sau này sửa không vô tình phá một quyết định đã có lý do.

## Cách chơi

- Sếp đi một vòng trong phòng server. Khi có người **ở trong phòng** (hoặc đứng ở khoảng sân ngay trước cửa) sếp chạy lại người gần nhất, giơ nắm đấm lên (0,7 giây, **vòng đỏ** dưới sàn báo chỗ nắm đấm sẽ rơi) rồi đấm. Ai đang trong vòng lúc nắm đấm rơi thì mất 30 máu. Chạy ra khỏi vòng kịp lúc là né được.
- Người chơi có 100 máu (thanh máu trên đầu khi bị thương, và một ô ở thanh trên cùng). Bốn cú đấm là gục. Nằm **15 giây**, vẫn chat được, rồi hồi sinh ở **sảnh**, không bao giờ hồi sinh ngay chỗ ngã.
- Máu hồi chậm: 4 giây đầu sau cú đấm không hồi gì, sau đó 5 máu mỗi giây (đầy lại khoảng 24 giây sau cú cuối). Ra khỏi phòng chờ một chút là lựa chọn thật sự.
- Sếp khởi đầu có 6.000 máu với 1–4 người thật online trong room. Mỗi nhóm bốn người tiếp theo cộng 3.000 vào cả máu hiện tại và tối đa sau 15 giây giữ ngưỡng. Sát thương đã gây được giữ lại; không tự hồi máu. Búa/điện luôn gây 10, trà sữa gây 5; ulti gây 20% máu tối đa hiện tại.
- Sếp ngã thì **500 triệu tiền thưởng** được cộng vào bảng thiệt hại, chia theo sát thương mỗi người gây ra. 1 phút sau sếp quay lại chỗ cũ với đầy máu.
- Ngoài sự kiện đi tuần toàn văn phòng, sếp ở phòng server; ra khỏi khu vực sẽ thoát truy đuổi, nhưng sếp không hồi máu. Trong phòng có sáu tủ server, mỗi tủ 120 triệu, nên đáng để liều.

## Các con số

Chỉ số giao tranh nằm trong `BOSS` và `PLAYER` ở [`lib/boss.js`](../lib/boss.js); ngưỡng dân số nằm trong [`lib/boss-population.js`](../lib/boss-population.js). Client nhận máu hiện tại/tối đa, không nhận bộ đếm người thật.

| Thiết lập | Giá trị | Lý do |
| --- | --- | --- |
| Máu người chơi | 100 | Bốn cú đấm. Đủ ít để thấy nguy hiểm, đủ nhiều để sống sót qua một lỗi. |
| Cú đấm của sếp | 30 sát thương, báo trước 0,7 giây, hồi 0,6 giây | "Phải đau" nhưng né được. Người chạy hết tốc độ thoát khỏi vòng trong khoảng 0,29 giây. |
| Tốc độ sếp | 220 khi tuần tra, 480 khi đuổi (người chơi đi 420) | Trên đường thoáng, sếp bắt kịp người đang chạy; né lúc báo đòn và đánh trả lúc sếp hồi đòn. Ngoài sự kiện đi tuần toàn văn phòng, ra khỏi khu boss vẫn thoát được cuộc đuổi. |
| Máu sếp | 6.000 cho 1–4 người thật; +3.000 mỗi nhóm bốn tiếp theo | Giữ sát thương đã gây khi room đông thêm. |
| Ulti | 20% máu tối đa hiện tại | Áp dụng VKL, TML và DMM; tốc độ tích giữ nguyên. |
| Hồi máu sếp | không | Người chơi thấy sếp hồi máu quá khó. Xem "Vì sao sếp không hồi máu". |
| Hồi máu người chơi | 5/giây sau 4 giây | Vừa phải: không "không bao giờ", không "ngay lập tức". |
| Người chơi hồi sinh | 15 giây, ở sảnh | Trước là 60 giây; người chơi thấy một phút là quá lâu. |
| Sếp hồi sinh | 1 phút | Trước là ngẫu nhiên 3 đến 5 phút; người chơi thấy quá lâu. |
| Tiền thưởng | 500 triệu, chia theo sát thương | Xem "Vì sao chia theo sát thương". |
| Tầm búa | 150 tính từ giữa người sếp, và không bị vật cản | Sếp to; tường và tủ chắn được cú đập. |

### Mô phỏng nói gì

`node test/boss.js` chạy một mô hình cố ý rộng rãi (không ai chết hay đánh trượt, mọi người đập nhanh nhất mana cho phép, lấy kiểu đập tốt hơn trong hai kiểu) rồi in thời gian sếp sống được:

| Người thật online, tất cả cùng đánh | 1 | 2 | 3 | 4 | 5 | 8 | 20 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Giây để hạ sếp | ~373 | ~186 | ~121 | ~93 | ~108 | ~68 | ~54 |

Mô hình bắt đầu ở mức máu tương ứng số người, không tính ulti, tủ server, đòn địch hay thời gian di chuyển. Trận thật phụ thuộc né đòn và số người tham chiến; người online ở khu khác vẫn làm tăng mức máu. Qua ranh giới nhóm có thể khiến năm người đánh lâu hơn bốn. Đây là kết quả mô phỏng, không phải thời gian đo trận thật. Chạy `npm run test:redis` sau khi sửa luật server.

## Vì sao làm thế này

**Thang sát thương riêng, không phải "gấp 100 đến 1000 lần máu".** Ý đầu tiên là sếp có máu gấp 100 đến 1000 lần người chơi. Hiểu đúng nghĩa thì là 10.000 đến 100.000 máu, mà mỗi cú đập chỉ 1 sát thương và cả nhóm chỉ đập được khoảng bốn cú mỗi giây, nên sếp như vậy không bao giờ chết. Điều quan trọng là *thời gian hạ sếp*, không phải tỉ lệ. Cú đánh vào sếp có thang sát thương riêng (búa gây 10); máu tối đa hiện theo nhóm người như bảng trên.

**Vì sao sếp không hồi máu (nữa).** Trước đây sếp hồi 5 mỗi giây, thêm 20 mỗi giây sau một lúc yên, nên một hay hai người không bao giờ thắng và cả nhóm phải bám sát. Chơi thật thì quá khó và mất vui: không ai đánh bớt rồi rút lui được. Giờ sát thương được giữ lại, đánh rồi chạy là chiến thuật thật. Trận vẫn khó vì sếp đấm, và máu sếp tăng lên 6.000 để vẫn là việc của cả nhóm. Code hồi máu (`bossHpAt`) vẫn còn và hai con số nằm trong `BOSS` (`baseRegenPerSec`, `regenPerSec`): đặt lớn hơn 0 là hồi máu trở lại, client dùng cùng công thức.

### Máu theo số người

Máu tối đa là 6.000 / 9.000 / 12.000 / 15.000 / 18.000 tương ứng 1–4 / 5–8 / 9–12 / 13–16 / 17–20 người thật online trong room. Đếm presence còn hạn trong store chung của mọi instance, kể cả người đang chờ hồi sinh hoặc ngoài khu boss. Mỗi ID tính một lần; nội gián ẩn/đã lộ và rắn triệu hồi không tính. Các danh tính khách/tài khoản riêng vẫn là người chơi riêng; cơ chế này không xác minh số người ngoài đời.

Mỗi ngưỡng mới phải giữ 15 giây, runner quan sát mỗi giây. Mỗi ngưỡng có bộ đếm riêng: từ chín xuống năm người không xóa tiến độ ngưỡng năm người. Nếu quá ba giây không quan sát, các bộ đếm chờ bắt đầu lại. Khi tăng mức, cộng chênh lệch max HP vào HP hiện tại: 300/6.000 thành 3.300/9.000. Không xóa ledger sát thương, dấu tủ đã dùng hoặc đợt rắn đã gọi. Trong một mạng boss, max HP không giảm; ra vào lại cùng mức không cộng thêm. Hồi sinh thì đầy máu theo số người thật đang có. Room mới bắt đầu ở máu gốc và xác nhận tăng mức như bình thường.

Bỏ giảm sát thương theo số mục tiêu cũ. Ulti tính 20% max HP trong store nguyên tử cùng cú đánh, tránh instance khác dùng max HP cũ. Tủ hỗ trợ 2% max HP tại lúc vỡ; tủ đã dùng không được tính lại khi tăng mức. Mỗi đợt rắn 70/40/10% vẫn chỉ xảy ra một lần mỗi mạng boss.

Client chỉ nhận HP hiện tại/tối đa và phiên bản máu. Không gửi số người thật, bộ đếm ngưỡng hay phân loại bot. Chia nhóm và trì hoãn giảm dấu hiệu đổi HP ngay khi có người vào, nhưng số máu và số online công khai vẫn có thể giúp suy luận; không bảo đảm giấu tuyệt đối. Xem [ADR 0010](adr/0010-population-boss-health.md).

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
- **Chi phí.** Bản chụp vị trí gửi 5 lần mỗi giây khi sếp đi và 10 lần khi đánh, và chỉ khi nó di chuyển; nếu mọi người trong phòng ở cùng instance với người điều khiển thì không đụng Redis. Redis thấy khoảng một lệnh hợp đồng mỗi giây mỗi instance mỗi phòng, một lệnh nguyên tử kiểm tra presence/tăng máu mỗi giây cho người điều khiển, và một lệnh cho mỗi cú đánh vào sếp hoặc mỗi cú đấm trúng. Phòng trống thì sếp không có đồng hồ nào chạy.

### Các tin nhắn (server gửi client)

| Tin | Khi nào |
| --- | --- |
| `boss` | vị trí, hướng, trạng thái và số người trong tầm (thanh HUD dùng) |
| `bwind` | một cú đấm bắt đầu: tâm, bán kính, thời lượng (vòng đỏ) |
| `bstrike` | nắm đấm rơi |
| `bhp` | đổi máu do đánh, tủ hoặc tăng dân số: HP hiện tại/tối đa và phiên bản máu tăng dần; bỏ qua bản cũ |
| `bdead` | sếp gục: ai gây bao nhiêu, mỗi người nhận bao nhiêu thưởng, bao lâu nữa quay lại |
| `bup` | sếp quay lại, kèm max HP của mạng mới và phiên bản máu |
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

## New Process (Quy trình mới)

Sau mỗi 12 giây giao tranh, boss đánh dấu vị trí một người chơi bằng vòng tím bán kính 350. Sau 1,2 giây, giấy quy trình rơi xuống, gây 20 sát thương cho người còn trong vòng và trong khu boss. Vị trí đánh dấu không di chuyển; chạy khỏi vòng để né.

Người chơi đánh nhau chỉ tạo hiệu ứng, không mất máu hoặc mana.

## Rắn và đồng nghiệp mời nước

Boss triệu hồi rắn tại 70%, 40%, 10% máu, mỗi mốc một lần mỗi lượt. Số rắn mỗi đợt là số nguyên ngẫu nhiên từ `ceil(1,3 × số người online)` đến `2 × số người online` trong server ở mốc 70% và 40%. Riêng đợt cuối tại 10% máu thả rắn đỏ với số nguyên ngẫu nhiên từ `2 × số người online` đến `3 × số người online`. Mỗi đợt tối thiểu 1 con. Rắn xanh lá đuổi người sống gần nhất khắp bản đồ qua các cửa, có 4 máu, mỗi cú búa trừ 1, tốc độ 200 và cắn mỗi 1,2 giây: rắn xanh gây 5 sát thương, rắn đỏ gây 7 sát thương. Rắn còn lại được dọn khi boss hồi sinh. Redis đồng bộ mốc triệu hồi và máu rắn; một instance điều khiển di chuyển, lưu vị trí mỗi giây; trình duyệt dựng hiệu ứng.

Mỗi 5 phút, nút “Đồng nghiệp mời nước” hiện trong 5 giây. Một người bấm sẽ hồi đầy máu và mana cho người đang kết nối trong server; người bị hạ hồi sinh ở sảnh. Lịch và lượt nhận dùng chung giữa các instance.

## Bắt đấu 1:1

Cứ 40–60 giây (ngẫu nhiên), VKL chọn một người sống trong phòng hoặc cách mép phòng tối đa 320 đơn vị. Nếu không có ai đủ gần thì bỏ lượt và hẹn lại sau 40–60 giây. Boss tung dây kéo người đó vào phòng, thổi những người sống còn lại ra hành lang phía tây.

Trong 20 giây, người bị bắt được di chuyển và chiến đấu trong phòng nhưng không ra được; người khác không vào phòng, gây sát thương lên boss hoặc nhận đòn boss. Sau 10 giây đầu, chỉ người bị bắt thấy nút “Em xin lỗi”; bấm để mở phòng sớm. Server kiểm tra người bấm, phiên bản lượt đấu và thời gian, kể cả giữa các instance. Hết giờ, hoặc một bên bị hạ, phòng mở lại. Ngắt kết nối không xóa thời gian bị bắt; tải lại trang khôi phục thời gian còn lại. Người giữ lease boss ghi lịch, mục tiêu và vị trí kéo/thổi nguyên tử trong store, có kiểm tra phiên bản.

Rắn có thân liền uốn chữ S, đuôi thuôn và lưỡi chẻ. Khi triệu hồi, boss giơ tay cùng vòng phép xanh. Hiệu ứng dùng hình học tái sử dụng, không thêm post-processing.

Test: `test/duel.js` (luật, lịch, cửa khóa), `test/duel-realtime.js` (hai instance, tải lại trang, đổi leader), `test/shared.js` (hợp đồng store trên memory và Redis).

VKL còn sống chặn đường người chơi và tránh mục tiêu còn sống khi bước đi; thân đã chết không chặn đường. Va chạm thân không đổi timing hay sát thương đòn đánh.


## Tủ server phản điện

Sáu tủ server giữ 8 HP đồ vật và thưởng 120 triệu khi vỡ. Mỗi hit hợp lệ phản 5 HP người chơi cho mỗi đơn vị damage thực sự gây lên tủ, không vượt HP còn lại; trà sữa phản 2,5 HP qua 16 hit nửa damage. Phá trọn một tủ tốn 40 HP và 40 mana bằng búa/điện, hoặc 40 HP và 80 mana bằng trà sữa. Đánh tủ đã vỡ không mất máu hay mana. Tủ tóe điện và có tia điện ngắn nối tới người đánh, kèm phản hồi trừ máu thông thường. Không thêm thao tác.

Tủ vỡ rút 2% máu tối đa VKL (120/6.000), mỗi tủ vật lý chỉ một lần trong mỗi mạng sếp. Sáu tủ hỗ trợ tối đa 12% (720 HP). IT thay đồ, reset thủ công, reconnect hay đổi runner không khôi phục lượt hỗ trợ; sếp hồi sinh thì có. Damage dừng ở 1 HP sếp, không nạp ulti, không tính phần chia bounty sếp và không tích sẵn khi VKL đã chết. Tiền phá tủ vẫn nhận như cũ. Tủ vỡ, tiền, dấu đã hỗ trợ và damage sếp commit cùng một script Lua gameplay (hoặc thao tác RAM). Người đánh bị điện giật gục ở hit cuối vẫn nhận kết quả phá tủ đã commit. Các ngưỡng gọi rắn vẫn phản ứng với damage hỗ trợ.

## Sếp đi tuần

Sau 3–5 phút có người chơi trong phòng, banner ngay dưới header báo trước 5 giây: “Ban lãnh đạo xuống lắng nghe. Bằng nắm đấm.” VKL ra khỏi phòng server, cùng TML/DMM chủ động săn người còn sống ở gần trong 30 giây. Damage, tốc độ và dấu báo đòn giữ nguyên; không biết vị trí mục tiêu trên toàn map. Mini-boss ưu tiên mục tiêu chưa bị boss khác chọn khi có lựa chọn gần đó. VKL chỉ đấm thường, không dùng New Process hay bắt đấu 1:1 trong sự kiện. Đấu đang diễn ra làm hoãn thông báo. Boss đã chết không được hồi sinh để tham gia; VKL chết giữa đợt không hủy phần đi tuần còn lại của hai mini-boss.

Hết đợt, VKL tự đi về theo sàn đi được và không đánh trên đường về; mini-boss hủy windup đi tuần và trở lại luật bị khiêu khích cũ. Khoảng nghỉ 3–5 phút tiếp theo tính từ lúc VKL về tới nơi (hoặc đã chết). Nếu phòng ngừng hoạt động qua cả thời gian báo và sự kiện thì không phát lại đợt cũ. Người mới vào sảnh và người hồi sinh được bảo vệ khỏi đòn đi tuần 3 giây; ra đòn sẽ mất bảo vệ. Reconnect ở xa sảnh không cấp bảo vệ.

Bot giả người cũng là mục tiêu đi tuần và bỏ chạy thay vì đâm lén trong sự kiện. Đòn boss trừ theo cùng tỷ lệ máu người thật (30/100 tương đương 2,4 trên 8 HP nội bộ), không làm lộ bot và không phát bounty hạ bot. Bot chưa lộ hồi sau 4 giây với tốc độ tương đương 5 HP người/giây. Bot bị hạ hiện animation gục thông thường, ghi số lần ngỏm rồi rời phòng sau thời gian nằm 15 giây. Người chơi đánh vẫn làm lộ; bot đã lộ giữ nguyên danh tính.

Lịch/version và vị trí đi tuần nằm trong hash boss hiện có, dùng lease boss hiện có. Chỉ broadcast chuyển trạng thái; lúc đi tuần/đi về lưu vị trí mỗi giây để chuyển runner. Join/reconnect nhận sự kiện hiện tại cùng deadline gốc. Lịch rảnh không ghi mỗi tick; phòng trống không chạy vòng lặp đi tuần hay mở thêm connection Redis. `lib/office-patrol.js` giữ thời gian; test có thể override `patrolOpts`, không thêm biến môi trường production.

Trên desktop, VKL hiện “Mọi người nghĩ dì dẫy?” ngay dưới tên. Nhãn trên cảm ứng/mobile không có đề từ.
