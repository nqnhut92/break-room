# Hướng dẫn chơi

[English](GAMEPLAY.md) · Tiếng Việt · [Tài liệu](README.md)

## Chơi chung với đồng nghiệp

Game có **hai server cố định**: **BR-1** và **BR-2**, mỗi server tối đa 20 người. Phần chọn server ở màn vào hiện đang ẩn (`SHOW_SERVER_PICKER = false` trong `public/game.js`; code vẫn giữ), nên mọi người vào BR-1 trừ khi link chỉ định server khác. Nút "Copy link server" tạo link `/?server=br-1` hoặc `/?server=br-2`; link cũ dạng `?room=` vẫn dùng được. Khi bật lại, phần chọn server hiển thị "x online" của từng server, màu xanh lá (dưới 50% sức chứa), cam (từ 50%), đỏ (từ 80%), và tự chọn sẵn server đang đông nhất còn chỗ. Không có server riêng: tên lạ trong link rơi về server đầu tiên. Chữ hiện cho người chơi gọi một instance game là "server". Đổi tên hoặc thêm server ở danh sách `ROOMS` trong `lib/world.js` (`id` viết thường không dấu, `name` là tên hiển thị).

Rời phòng bằng cửa thoát thì lần vào sau xuất hiện ở sảnh; tải lại trang hoặc mất kết nối thì quay lại đúng chỗ đang đứng.

Màn vào còn hỏi vai trò trong công ty (kế toán, nhân sự, IT, dev, sale, marketing, designer, thực tập sinh, bảo vệ, tạp vụ hoặc nhân viên quèn; hiện dưới tên, một số vai có mũ hoặc tai nghe, và có câu hô riêng khi đập) và diện mạo nhân vật (nam hoặc nữ). Danh sách vai trò nằm ở `public/roles.js` và phải khớp `ROLE_IDS` trong `lib/world.js` (có test kiểm tra). Có thể nhập thêm tên công ty (không bắt buộc, tối đa 20 ký tự, trình duyệt nhớ lại), hiện cạnh vai trò dưới tên người chơi. Tên là bắt buộc. Khi không có Postgres, tên trùng online được kiểm tra theo chuỗi chính xác, có phân biệt hoa thường. Khi bật identity qua Postgres, tên được chuẩn hóa và kiểm tra không phân biệt hoa thường với người/bot online và tên đăng ký được giữ cả lúc offline; xem [Identity](IDENTITY.vi.md#tên-và-xử-lý-lỗi).

## Điều khiển

| Hành động | Cách làm |
| --- | --- |
| Di chuyển | WASD / phím mũi tên, hoặc joystick bên trái trên màn hình cảm ứng |
| Đập | Space (giữ để đập liên tục; không có gì trong tầm vẫn vung búa, miễn phí), hoặc giữ nút ĐẬP! trên màn hình cảm ứng |
| Skill | Phím 1, 2, 3 chọn búa, trà sữa hoặc điện (hoặc nút Skill); skill đang chọn nằm trên tay (cây búa, ly trà sữa, đồ chích điện) và người khác cũng thấy. Ném ly trà sữa tầm xa gấp đôi nhưng **chỉ bằng một nửa sát thương** của một cú búa, cả với đồ vật lẫn sếp |
| Gọi IT | Phím I, hoặc nút Gọi IT: thay hết đồ mới (chung thời gian chờ) |
| Xin lỗi khi đấu 1:1 | Phím E, hoặc nút "Em xin lỗi" khi nút hiện ra |
| Nhận nước | Phím Q, hoặc nút "Đồng nghiệp mời nước" khi đang mời |
| Thả emoji | Shift + phím 1 đến 8 hoặc bấm các nút emoji |
| Chat | Enter hoặc `/`, hoặc bấm vào ô chat cạnh thanh emoji (nút 💬 trên màn hình cảm ứng); Enter để gửi và quay lại game, Esc để huỷ. Khung chat luôn hiện trên máy tính; trên màn hình cảm ứng nằm ngang, lịch sử ở giữa cạnh dưới thu về một hàng sau tám giây không hoạt động; chạm bản thu gọn để mở lại |
| Zoom camera | Lăn chuột, chụm hai ngón tay, hoặc nút + / − trên màn hình cảm ứng |
| Bản đồ nhỏ | Phím M hoặc tiện ích bản đồ để ẩn/hiện bản đồ quanh bạn; chạm/click mini map để mở/đóng bản đồ toàn room |
| Bản đồ toàn room | Desktop: giữ Tab để xem, thả để đóng; Esc hoặc × đóng bản mở bằng click. Chạm/click bất kỳ đâu ngoài joystick và các nút đánh/skill (kể cả chính bản đồ), chạm lại mini map hoặc × để đóng. Vẫn di chuyển được; lúc nhập chat giữ thao tác bàn phím bình thường |

Trên thiết bị không cảm ứng, nút xin lỗi và nút nhận nước ghi kèm phím "(E)" / "(Q)"; dòng gợi ý và danh sách hướng dẫn đều nhắc hai phím này.

**Bảo vệ khi xuất hiện.** Sau khi hồi sinh, hoặc khi mới vào ở sảnh, bạn được bảo vệ 10 giây: không nguồn nào gây sát thương (VKL, TML/DMM, rắn, New Process). Boss vẫn nhắm và vung đòn vào bạn; đòn bị chặn hiện "🛡️ CHẶN!". Đi lại hoặc đánh bất cứ thứ gì (đồ vật, người chơi, boss, rắn, ulti) sẽ mất bảo vệ sớm. Mọi người thấy 🛡️ trước tên người đang được bảo vệ. Reconnect ở xa sảnh không được bảo vệ. Thời lượng là tùy chọn server `spawnProtectionMs`.

Trên màn hình cảm ứng nằm ngang, nút icon skill có kích thước bằng nút ra đòn và nằm bên trái, cách 24px. Đường kính radar tự đổi theo diện tích màn hình còn trống. Tagline boss hiện trên desktop và khung cảm ứng ngang lớn; khung cảm ứng nhỏ ẩn chúng.

**Mana.** Mỗi cú đập tốn 5 trên 100 mana (thanh xanh dương dưới tên bạn). Mana hồi 3/giây lúc đầu và 12/giây khi đã quá 2 giây không đập (nên đi bộ giữa hai món xa nhau chỉ hồi được chút ít), nên bạn đập dồn được khoảng 20 cú rồi cần khoảng 10 giây mới đầy lại. Hết mana thì cú đập bị từ chối và thanh nháy đỏ. Đồ đã bị đập hiện thanh máu: xanh lá khi còn khoẻ, cam từ nửa trở xuống, đỏ ở cú cuối. Các con số nằm ở `MANA` trong `lib/realtime.js`; server áp dụng (giữ theo từng kết nối, nên reconnect sẽ đầy lại) còn client dùng cùng công thức để hiển thị.

Trên màn hình cảm ứng, dùng joystick bên trái để di chuyển và giữ nút ĐẬP! bên phải để đánh. Chạm vào nền hoặc đồ vật không di chuyển hay tấn công. Chụm hai ngón trên canvas để zoom camera. Trên điện thoại, thông báo xoay ngang hiện ngay ở màn vào phòng, kể cả khi reload hoặc mất kết nối. Tắt khóa xoay rồi xoay ngang để vào; giao diện dùng hướng xoay gốc của trình duyệt. Safari có thể thêm game vào Home Screen để chơi không có thanh công cụ. Icon Home Screen cũ có thể cần xoá rồi thêm lại để nhận cấu hình app mới. Chi tiết giao diện và kiểm tra thiết bị: [MOBILE.md](MOBILE.md).

Nút ✨ chuyển giữa đồ họa cao và chế độ an toàn. Chế độ an toàn giữ bóng tròn dưới chân, tắt bóng thời gian thực và halo để giảm tải. Điện thoại mặc định dùng chế độ an toàn, nhưng lựa chọn đã lưu vẫn được giữ; nếu đã bật high trước đó, chuyển lại safe để thử giảm giật.

## IT tự thay đồ

Mặc định mỗi món vỡ được tự thay trong **25–60 giây**, tính từ lúc vỡ. Phòng ít người, ít đồ vỡ thì IT đến chậm; đông người hoặc nhiều đồ vỡ thì nhanh hơn:

`thời gian (ms) = max(25000, 60000 − 2500 × max(0, người thật − 1) − 500 × max(0, món vỡ − 3))`

| Người thật online | Đồ đang vỡ | Tuổi vỡ tối thiểu để được thay |
| --- | --- | --- |
| 1 | 1–3 | 60 giây |
| 1 | 20 | 51,5 giây |
| 5 | 20 | 41,5 giây |
| 10 | 20 | 29 giây |
| 20 | 1 | 25 giây |

Mỗi lượt housekeeping dùng số người online sau khi dọn presence hết hạn và số đồ vỡ **trước lượt thay**. Nội gián không tính là người thật; đồ chỉ mất máu chưa vỡ không tăng tải. Mỗi món vẫn giữ thời điểm vỡ gốc. Người vào/rời và đồ mới vỡ làm ngưỡng thay đổi; không khởi động lại đồng hồ của món cũ, và đủ 60 giây thì luôn đủ tuổi. Housekeeping chạy khoảng mỗi giây khi đang có đồ chờ, nên thời điểm hiển thị có thể muộn hơn ngưỡng một nhịp.

Nút Gọi IT vẫn thay ngay khi hết cooldown như cũ. Đặt `RESPAWN_MS` dương là override thời gian cố định cho quản trị/test, kể cả ngoài khoảng mặc định; xem [Deploy](DEPLOYMENT.vi.md).

## Boss và nội gián

VKL canh phòng server và chủ động đánh người bước vào. Ngoài đợt đi tuần toàn văn phòng, TML/DMM đi quanh map và chỉ trả đũa người đánh mình; trong đợt đi tuần đã báo trước, chúng chủ động săn mục tiêu ở gần. New Process đánh dấu vòng tròn cố định bán kính 350, báo trước 1,2 giây rồi gây 20 sát thương. Tốc độ tuần tra/đi thường của VKL/TML/DMM là 220/200/180; tốc độ đuổi là 480/460/440, đều cao hơn người chơi (420). Trên đường thoáng, chỉ chạy không thể giữ khoảng cách mãi: hãy né vòng báo đòn và tranh thủ đánh trả lúc boss hồi đòn. Nội gián giả làm người chơi. Luật và cân bằng chi tiết:

- [VKL, rắn, đấu 1:1 và chiêu New Process](BOSS.vi.md)
- [TML và DMM](MINIBOSSES.md) (tiếng Anh)
- [Nội gián](MOLES.vi.md)

Max HP VKL tăng theo nhóm bốn người thật online: 6.000 cho 1–4 người, sau đó +3.000 mỗi nhóm khi giữ ngưỡng 15 giây. Tăng máu giữ sát thương đã gây, không hạ mức trong cùng mạng boss; hồi sinh thì tính lại. Nội gián/rắn không tính, đòn thường không còn giảm damage theo đám đông. Ulti gây 20% max HP lên cả ba boss; máu mini boss vẫn cố định.

## Văn phòng

Hàng phía bắc, từ tây sang đông: **West Workspace** mở, phòng **Server** (phòng của VKL; cửa ở tường nam, mở ra hành lang bắc gần trục sảnh), **Town Hall** (màn hình lớn trên tường bắc, ghế quay về màn hình, cửa ở giữa tường nam), **Meeting C**, rồi **WC NAM / WC NU** ở góc đông bắc. Dải giữa là sảnh mở (chỗ spawn) cùng **East Workspace** mở, trải thảm, với hai phòng họp nhỏ **Meeting D** và **Meeting E** sát tường đông. Hàng phía nam: **Meeting A**, **Meeting B**, **Director**, **Pantry** và **Lounge** ở góc đông nam. Mọi chỗ ngồi ở workspace là bàn đảo sáu chỗ với hai màn hình gắn tay đỡ; chỉ bàn giám đốc giữ một màn hình. Đồ đã lưu giữ ID và loại; đồ mới được nối vào cuối.

Có hàng trăm món đập được; tường, kính, thảm và sàn giữ nguyên. Đồ cứng đã vỡ vẫn để lại vật cản. Mini map hình tròn giữ bạn ở tâm, phóng gần vùng sàn trong bán kính cố định 1.500 đơn vị. Giữa bản đồ rõ, vùng ngoài mờ dần về mép; zoom camera không đổi tỉ lệ radar. Trong vùng này, bạn màu vàng, người khác màu trắng, đồ vỡ màu đỏ, VKL đỏ, TML cam và DMM tím; boss ở ngoài vùng không hiện. Bản đồ lớn hiển thị toàn room. Cả hai không dừng game.

[Xem map hiện tại](../artifacts/map-overview.png).

Bản đồ toàn văn phòng ghi tên từng phòng, cùng nhãn LOBBY, để người chơi hẹn chỗ gặp. Cảnh 3D không có biển tên phòng lơ lửng.

## Khách và nhân vật đã lưu

Khách vẫn vào chơi ngay. [Google login](IDENTITY.vi.md#hành-vi-người-chơi) lưu một nhân vật độc lập ở mỗi phòng. Tạo/khôi phục/sửa ở ngoài phòng; chỉnh sửa áp dụng lần vào tiếp theo và bị chặn khi nhân vật đang chơi ở nơi khác. Tên đăng ký được giữ cả offline, không phân biệt hoa/thường. Đăng nhập không tự vào phòng. Lần vào đầu tiên bằng tài khoản chuyển điểm khách hôm nay của tab đó sang nhân vật, một lần. Bảng là **BXH hôm nay** theo phòng (về 0 lúc 00:00 giờ Việt Nam; gồm mọi người đã chơi hôm nay, cả offline, khách và bot); không có BXH all-time. Chat phòng được lưu 24 giờ và tải khi bạn vào. Chi tiết: [BXH ngày](SCORES.vi.md).

## Va chạm nhân vật

VKL và TML/DMM còn sống có thân rắn: phải đi vòng, không đi xuyên. Boss đã chết không chặn đường. Boss và mini-boss tránh nhân vật còn sống khi di chuyển. Người chơi và bot ngụy trang đi xuyên nhau để không chặn cửa và giữ cùng quy tắc thể hiện cho cả hai. Chỉ chạm thân không làm mini-boss trung lập nổi giận. Không đổi sát thương, tầm đánh, báo đòn hay bố cục map.


Tủ server phản điện lên người đánh và hỗ trợ rút tối đa 12% máu VKL mỗi mạng sếp. Sự kiện đi tuần cho VKL/TML/DMM săn người 30 giây, báo chung dưới header và không thêm nút. Xem [cân bằng tủ và luật đi tuần](BOSS.vi.md#tủ-server-phản-điện).
