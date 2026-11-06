# Điều tra giật trên mobile

[English](PERFORMANCE.md) · Tiếng Việt · [Tài liệu](README.md)

Điều tra ban đầu ngày 2026-11-04 trên runtime revision `dcbcb33`. Các phát hiện/bảng baseline bên dưới mô tả phiên bản đó. Bản sửa hiện tại nằm ở phần tiếp theo; vấn đề iPhone 17 Pro Max vẫn cần kiểm tra trên máy thật.

## Bản sửa để thử trên thiết bị

Người dùng đã xác nhận giật ngay từ phiên mới. Thiếu cleanup sau nhiều lượt vào/rời **không giải thích được riêng trường hợp đó**; đây là lỗi tài nguyên độc lập. Bản sửa xử lý cả cleanup và tải bóng có ngay từ frame đầu:

- Safe mode tắt shadow pass thời gian thực, giữ bóng tròn dưới chân. High mode giữ bóng thời gian thực (1024 trên cảm ứng, 2048 desktop), có thể bật lại bằng nút ✨. Lựa chọn đã lưu không bị reset.
- Chuyển sang safe mode giải phóng shadow target; chuyển lại high tạo lại đúng cách.
- Khi gỡ nhân vật/mini-boss, dispose geometry riêng và material bóng tròn/vòng chọn/điện, giữ material dùng chung.

[Regression test WebGL](../test/renderer.cjs) kiểm tra cleanup thực tế, không chèn patch sửa hành vi. Ở fixture cảm ứng có một người đội phụ kiện dev, safe là **52 draw calls / 27.140 tam giác**, high là **304 / 813.964**, tính cả bóng. Qua tám lượt vào/rời, geometry giữ **92 → 92**. Fixture khác baseline cũ một phụ kiện, vì vậy so safe/high trong cùng lượt này thay vì trừ số giữa hai fixture.

Lượt kiểm tra cleanup/bóng ban đầu hoàn tất **17 checks** trên mỗi cấu hình cảm ứng và desktop, không có page error hay WebGL error; việc chuyển high/safe cũng không giữ lại shadow texture.

Đây là giảm tải gửi hình học đo trên SwiftShader, chưa phải cải thiện FPS đã đo trên iPhone. Xem [ADR 0005](adr/0005-safe-mode-shadows.md) và [cách chạy test](DEVELOPMENT.vi.md#kiểm-tra-renderer-và-hiệu-năng-mobile). Các đề xuất còn lại phía dưới vẫn chưa triển khai.

## Vạch chớp khi di chuyển

Báo cáo tiếp theo từ iPhone cho biết cả safe/high đã hết lag nhưng xuất hiện vạch ngang chớp khi di chuyển. Kiểm tra map phát hiện hai zone hành lang chồng sàn sảnh tại `y=1420..1460`, phủ tổng `x=0..2880`; chúng đều được vẽ ở cùng độ cao. Đây là lỗi coplanar/z-fighting cụ thể trong layout, dùng chung ở cả hai chế độ; chưa phải tái hiện trực tiếp dấu vạch trên GPU iPhone.

Bản sửa bắt đầu sàn sảnh ở `y=1460`, chỉ tiếp giáp cạnh hành lang, giữ tối ưu bóng hiện tại. `test/world.js` kiểm tra mọi cặp zone không chồng diện tích; renderer test đi camera qua khu này ở safe/high. Đồng thời bỏ biển tên phòng lơ lửng theo yêu cầu người dùng. Cần xác nhận lại vạch chớp trên máy thật trong lúc di chuyển, không suy ra từ ảnh tĩnh. Lượt regression renderer cảm ứng mới nhất qua 18 checks, có 50 draw calls ở safe và 302 ở high, geometry giữ ổn định ở 90; bỏ biển tên làm số mesh nhìn thấy khác lượt trước.

## Kết luận hiện tại

Chưa có bằng chứng iPhone thiếu RAM. Có bằng chứng local cho hai vấn đề: tải render bóng và tài nguyên WebGL chưa được giải phóng khi người chơi rời phòng. Chúng có thể xuất hiện cùng việc máy nóng, lịch chạy frame của Safari hoặc chế độ đồ họa cao được lưu từ lần trước.

1. **Chế độ an toàn vẫn render bóng thời gian thực khá nặng.** Cùng một góc ở sảnh, tắt bóng giảm từ 302 xuống 51 draw calls, từ 813.404 xuống 26.860 tam giác. `setQuality('low')` chỉ giảm độ phân giải shadow map, vẫn giữ đối tượng đổ bóng và vùng shadow rộng bám camera. Giảm độ phân giải không tự giảm chi phí gửi hình học.
2. **Geometry của nhân vật rời phòng chưa được giải phóng.** `disposePlayer()` gỡ group/label nhưng chỉ dispose pick proxy và tài nguyên điện. Sau khi đám đông rời đi, bộ đếm geometry vẫn cao; tám lượt vào/rời tiếp theo tăng mười geometry mỗi lượt, kể cả sau khi ép JS GC. Bản cleanup chỉ chèn trong response chẩn đoán giữ bộ đếm ổn định.
3. **Chế độ cao đã lưu có thể nhân tải pixel trên điện thoại.** `public/game.js` đọc `br-gfx2` thay vì luôn dùng mặc định cảm ứng. Với DPR 3 của probe, high render ở DPR 2, low ở DPR 1: canvas high gấp bốn số pixel. Cả hai vẫn dùng antialiasing của context. Chưa biết máy người dùng đang lưu chế độ nào.
4. **Đông nhân vật làm tăng tải rõ rệt.** Cảnh mô phỏng 20 người/40 rắn gửi 823 draw calls và 1.396.808 tam giác, tính cả bóng. Mỗi người dựng geometry riêng. Frustum culling không loại bỏ hết việc duyệt scene, cập nhật từng món và render bóng ngoài khung nhìn.

## Bằng chứng và phạm vi đo

Probe local dùng `createScene3D` và map thật, state mô phỏng, camera cố định tại sảnh, viewport cảm ứng 956×440 CSS pixel và DPR 3. Nó chạy Chromium headless với SwiftShader bằng phần mềm, không phải Safari/iPhone. Không chạy mạng, input, HUD hay âm thanh của game. Các số dưới đây không phải FPS, thời gian GPU hay dung lượng RAM của iPhone.

Bộ đếm reset một lần trước mỗi frame, đặt `renderer.info.autoReset = false` để tính cả shadow pass. Cơ chế tự reset của bản three.js trong repo xảy ra sau render bóng nên sẽ che mất phần tải này. Bảng là số đếm ổn định sau bốn frame chẩn đoán mỗi trường hợp, không phải trung bình thời gian.

| Cảnh mô phỏng | Pixel canvas | Draw calls, gồm bóng | Tam giác, gồm bóng |
| --- | ---: | ---: | ---: |
| Low, một người | 420.640 | 302 | 813.404 |
| Low, cùng góc, tắt bóng | 420.640 | 51 | 26.860 |
| Low, DPR 0,75 | 236.610 | 302 | 813.404 |
| High, một người | 1.682.560 | 302 | 813.404 |
| Low, 20 người + 40 rắn | 420.640 | 823 | 1.396.808 |
| Cùng đám đông + mảnh vỡ/bụi/tia lửa | 420.640 | 833 | 1.398.266 |

Tắt bóng giảm khoảng 83% draw calls và 97% số tam giác gửi đi ở góc này; không suy ra cùng tỷ lệ giảm thời gian GPU hay tăng FPS. DPR 0,75 giảm khoảng 44% pixel nhưng không giảm hình học. Số pixel canvas không tính texture shadow map hay bộ đệm multisample.

| Mốc kiểm tra vòng đời | Renderer hiện tại: geometry đã upload | Bản đối chứng dispose geometry |
| --- | ---: | ---: |
| Ban đầu, một người | 91 | 91 |
| Sau khi đám đông rời và hiệu ứng hết | 284 | 94 |
| Sau tám lượt vào/rời nữa | 364 | 94 |
| Sau ép JS GC và render lại | 364 | 94 |

Ba geometry tăng thêm trong bản đối chứng là cache dùng chung cho hình rắn/proxy/thanh máu được tạo khi chạy cảnh đám đông. Sau khi đám đông rời, cả hai bản đều quay về khoảng 18,1 MiB **mảng thuộc tính/index geometry còn được scene tham chiếu**; con số này không tính texture, buffer driver, framebuffer hay bộ nhớ khác của tiến trình. `renderer.info.memory` đếm tài nguyên, không đo byte. JS heap ổn định vì vậy chưa đủ để loại trừ thiếu dispose tài nguyên WebGL.

Dữ liệu gốc và script chẩn đoán hiện giữ local, chưa phát hành trong repo. Capture gồm `mobile-probe.json` và `mobile-probe.cpuprofile` cho bản hiện tại và bản đối chứng cleanup.

Cả hai lượt đo hoàn tất, không có page error. CPU profile chứa cả đổi chất lượng, dựng rig và render thủ công; không dùng các hotspot gộp làm tỷ lệ CPU khi chơi ổn định. Bảng trên ghi lại các bộ đếm; kế hoạch bên dưới mô tả cách xác nhận độc lập trên máy thật.

## Thứ tự xử lý đề xuất

| Ưu tiên | Thay đổi | Kiểm tra / đánh đổi |
| --- | --- | --- |
| P0 (đã sửa, chờ kiểm tra thiết bị) | Dispose geometry riêng của người chơi và material riêng của bóng tròn/vòng chọn khi gỡ rig. Quản lý ownership và tránh dispose lặp; không dispose body material, model cache hay geometry rắn đang dùng chung. | Bản sửa thật phải giữ tài nguyên ổn định sau teardown đám đông và nhiều lượt vào/rời. Kiểm tra người vào lại, phụ kiện vai trò, điện và người mới không mất hình. Patch đối chứng mới chỉ xác nhận geometry, chưa phải cleanup production đầy đủ. |
| P1 (đã tắt bóng thời gian thực ở safe mode) | Làm bóng ở chế độ an toàn nhẹ hơn: so sánh tắt bóng thời gian thực, giữ bóng tròn dưới chân; sau đó thử chỉ nhân vật đổ bóng hoặc thu vùng shadow nếu cần giữ chất hình. Chế độ cao vẫn có sẵn. | Đo cùng góc/cùng cảnh trên iPhone; kiểm tra chiều sâu, bóng khi di chuyển và mép phòng. Không thêm composer, theo ADR 0003. |
| P1 | Thêm overlay/cờ chẩn đoán tuỳ chọn: chất lượng/DPR thực tế, phân vị khoảng cách frame, long task nếu hỗ trợ, draw/triangle gồm bóng và bộ đếm resource. | Xác định high đã lưu hay không, giật gắn với render, GC, warmup hay snapshot mạng. UI bình thường không mang chi tiết chẩn đoán. Safari thiếu một số API bộ nhớ/long task của Chromium nên phải kiểm tra hỗ trợ. |
| P2 | Thử DPR 0,85/0,75 ở chế độ an toàn; chỉ thêm điều chỉnh tự động chậm, có giới hạn sau khi đo. | Giảm pixel nhưng không giảm hình học. So độ nét, nhịp frame dài hạn; giữ nguyên layout viewport và ánh xạ cử chỉ. |
| P2 | Giảm độ chi tiết nhân vật xa, dùng chung geometry bất biến và giảm cập nhật ngoài màn hình. Cân nhắc instancing nội thất lặp nếu vẫn giữ được hình khi bị đánh. | Profile cảnh đông trước. Giữ nhắm đánh, phụ kiện, picking, điện và ownership tài nguyên đúng; không ẩn nhầm đối tượng còn cần cho bóng/hiệu ứng. |
| P3 | Cache cập nhật HUD/đồ vật không đổi và chia vùng truy vấn di chuyển/chọn mục tiêu nếu trace CPU chỉ ra chúng. Chỉ điều tra MSAA khi chi phí pixel/buffer vẫn trội. | Chưa phải nguyên nhân đo được trong lượt này. Đổi MSAA có thể phải tạo lại renderer và kiểm tra rộng hơn. |

Nên làm P0 và đối chứng P1 trước khi viết lại renderer. Cleanup nhắm tới phiên chơi dài; bóng nặng có thể ảnh hưởng ngay phiên mới. Không tự xoá lựa chọn đồ họa đã lưu của người dùng.

## Chế độ đẹp trên iPad và iPhone (tháng 11/2026)

Đo bằng overlay trên iPad Pro M4 11 inch (bộ đệm vẽ 2420×1572) và iPhone chip A19 Pro, Safari, chế độ đẹp, đứng ở sảnh. Logic game, cập nhật cảnh và nhãn cộng lại khoảng 2 ms; gần như cả khung hình là `renderer.render`, mà trên Safari hàm này chờ GPU.

| iPad, chế độ đẹp | render | FPS |
|---|---|---|
| Trước khi sửa | 17,1 ms | 35 |
| Pixel ratio 1,5 thay vì 2 | 17,0 ms | 36 |
| Bóng PCF thay vì PCFSoft | 18,1 ms | 34 |
| Không có environment map | 16,5 ms | 37 |
| Không có bóng thời gian thực | 10,8 ms | 53 |
| Vùng bóng ôm theo khung nhìn, màn hình/laptop/thùng rác không đổ bóng trên cảm ứng | 12,5 ms | 42 |
| …và đồ còn nguyên dùng chung một material | 11,6 ms | 48 |

Vậy chỗ tốn không phải số điểm ảnh mà là lượt vẽ bóng: vùng bóng là hình vuông tính theo khoảng cách camera, rộng 5400 đơn vị khi zoom xa, và vẽ 726 draw call, 2,2 triệu tam giác (đếm trong renderer headless; số draw của overlay không gồm lượt vẽ bóng vì three.js đặt lại bộ đếm sau lượt đó) so với 327 cho hình chính. Giờ vùng bóng ôm theo phần sàn camera thấy, tính trong không gian của nguồn sáng, cộng biên 220 đơn vị, còn 488 draw ở góc nhìn đó; trên màn hình cảm ứng, 393 màn hình, laptop và thùng rác không đổ bóng thời gian thực (thùng rác vẫn có vệt bóng tiếp xúc), còn 215. Trước đây mỗi món đồ còn mang một bản sao material riêng nên mỗi draw call phải gửi lại uniform; giờ chúng dùng chung `bodyMat` và chỉ có bản riêng khi đang hư hại, chớp sáng hoặc bị điện giật. Khu làm việc (khoảng 600 draw) vẫn chỉ khoảng 37 FPS trên iPad lúc đang đập; bước tiếp theo sẽ là gộp hoặc instancing đồ đạc.

## Overlay đo frame time

Mở game với `?perf=1` (trên điện thoại, máy tính bảng thì link này còn bỏ qua màn hình bắt thêm vào Màn hình chính, nên mở được trong tab trình duyệt; tham số được giữ khi vào phòng và khi tải lại). Cố ý không có lệnh chat để bật, để không ai bật nhầm, nên app Home Screen không hiện được overlay. Overlay hiện số liệu của 5 giây gần nhất: FPS, khoảng cách khung hình p50/p95/p99, số khung trên 50 ms kể từ lúc tải trang, và thời gian JS + gửi lệnh vẽ mỗi khung của trang (không phải thời gian GPU). Dòng thứ ba chia trung bình phần việc đó trong cùng 5 giây thành logic game và HUD, cập nhật cảnh, `renderer.render` và nhãn trong thế giới (dùng trung bình vì Safari làm tròn `performance.now()` tới mili giây). Dòng cuối ghi chế độ đồ họa, kích thước bộ đệm vẽ và pixel ratio, device pixel ratio, số draw call và tam giác của khung vừa vẽ (không gồm lượt vẽ bóng: three.js đặt lại bộ đếm sau lượt đó), và kích thước shadow map / bề rộng vùng bóng. So sánh các máy ở cùng vị trí và mức zoom, sau vài giây khởi động.

## Kiểm tra trên iPhone

Dùng cùng iPhone 17 Pro Max với Safari và app Home Screen; ghi viewport, OS/browser, chất lượng, DPR và nhịp frame thực tế. Đổi từng yếu tố, bắt đầu khi máy mát, giữ nguyên Low Power Mode/độ sáng; lặp sau 10–15 phút để phân biệt ảnh hưởng nhiệt. Đây là kế hoạch kiểm tra, chưa phải các lượt đã chạy.

- So safe/high, bật/tắt bóng và DPR 1/0,75 ở cùng góc. Thử sảnh yên tĩnh, đi liên tục, cú đập đầu, đập liên tục, VKL/rắn và đám đông thực tế. Phân biệt kéo giật vị trí do mạng với frame bị nghẽn tại máy.
- Ghi khoảng cách frame p50/p95/p99, stall >50 ms, JS/GC timeline, thời gian GPU nếu hỗ trợ và resource. Dùng Safari Web Inspector để xem allocation và dấu hiệu áp lực bộ nhớ nếu có. Màn hình 120 Hz không có nghĩa đã đo được 120 FPS.
- Mục tiêu ban đầu đề xuất: 60 FPS ổn định khi được hỗ trợ; khoảng cách frame p95 không quá 20 ms, p99 không quá 33,3 ms ở cảnh đại diện có kiểm soát sau warmup. Báo rõ nếu chưa đạt.
- Lặp vào/rời và hiệu ứng: tài nguyên phải ổn định, không tăng tuyến tính. Không mất mesh, context hay bị reload. Lặp kiểm tra xoay gốc, joystick double tap, bàn phím/chat và pinch trong [Mobile](MOBILE.md).

Thiếu RAM vẫn là giả thuyết cho đến khi có dấu hiệu memory pressure/context loss/reload hoặc allocation thật. Thông số tổng RAM của điện thoại không tự cho biết ngân sách của browser hay giải thích được một frame giật.
