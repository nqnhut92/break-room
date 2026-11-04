# Điều tra giật trên mobile

[English](PERFORMANCE.md) · Tiếng Việt · [Tài liệu](README.md)

Ghi nhận ngày 2026-11-04, runtime revision `dcbcb33`. Báo cáo iPhone 17 Pro Max còn giật vẫn đang mở. Phần này là điều tra và đề xuất; chưa sửa hay deploy renderer của game.

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
| P0 | Dispose geometry riêng của người chơi và material riêng của bóng tròn/vòng chọn khi gỡ rig. Quản lý ownership và tránh dispose lặp; không dispose body material, model cache hay geometry rắn đang dùng chung. | Bản sửa thật phải giữ tài nguyên ổn định sau teardown đám đông và nhiều lượt vào/rời. Kiểm tra người vào lại, phụ kiện vai trò, điện và người mới không mất hình. Patch đối chứng mới chỉ xác nhận geometry, chưa phải cleanup production đầy đủ. |
| P1 | Làm bóng ở chế độ an toàn nhẹ hơn: so sánh tắt bóng thời gian thực, giữ bóng tròn dưới chân; sau đó thử chỉ nhân vật đổ bóng hoặc thu vùng shadow nếu cần giữ chất hình. Chế độ cao vẫn có sẵn. | Đo cùng góc/cùng cảnh trên iPhone; kiểm tra chiều sâu, bóng khi di chuyển và mép phòng. Không thêm composer, theo ADR 0003. |
| P1 | Thêm overlay/cờ chẩn đoán tuỳ chọn: chất lượng/DPR thực tế, phân vị khoảng cách frame, long task nếu hỗ trợ, draw/triangle gồm bóng và bộ đếm resource. | Xác định high đã lưu hay không, giật gắn với render, GC, warmup hay snapshot mạng. UI bình thường không mang chi tiết chẩn đoán. Safari thiếu một số API bộ nhớ/long task của Chromium nên phải kiểm tra hỗ trợ. |
| P2 | Thử DPR 0,85/0,75 ở chế độ an toàn; chỉ thêm điều chỉnh tự động chậm, có giới hạn sau khi đo. | Giảm pixel nhưng không giảm hình học. So độ nét, nhịp frame dài hạn; giữ nguyên layout viewport và ánh xạ cử chỉ. |
| P2 | Giảm độ chi tiết nhân vật xa, dùng chung geometry bất biến và giảm cập nhật ngoài màn hình. Cân nhắc instancing nội thất lặp nếu vẫn giữ được hình khi bị đánh. | Profile cảnh đông trước. Giữ nhắm đánh, phụ kiện, picking, điện và ownership tài nguyên đúng; không ẩn nhầm đối tượng còn cần cho bóng/hiệu ứng. |
| P3 | Cache cập nhật HUD/đồ vật không đổi và chia vùng truy vấn di chuyển/chọn mục tiêu nếu trace CPU chỉ ra chúng. Chỉ điều tra MSAA khi chi phí pixel/buffer vẫn trội. | Chưa phải nguyên nhân đo được trong lượt này. Đổi MSAA có thể phải tạo lại renderer và kiểm tra rộng hơn. |

Nên làm P0 và đối chứng P1 trước khi viết lại renderer. Cleanup nhắm tới phiên chơi dài; bóng nặng có thể ảnh hưởng ngay phiên mới. Không tự xoá lựa chọn đồ họa đã lưu của người dùng.

## Kiểm tra trên iPhone

Dùng cùng iPhone 17 Pro Max với Safari và app Home Screen; ghi viewport, OS/browser, chất lượng, DPR và nhịp frame thực tế. Đổi từng yếu tố, bắt đầu khi máy mát, giữ nguyên Low Power Mode/độ sáng; lặp sau 10–15 phút để phân biệt ảnh hưởng nhiệt. Đây là kế hoạch kiểm tra, chưa phải các lượt đã chạy.

- So safe/high, bật/tắt bóng và DPR 1/0,75 ở cùng góc. Thử sảnh yên tĩnh, đi liên tục, cú đập đầu, đập liên tục, VKL/rắn và đám đông thực tế. Phân biệt kéo giật vị trí do mạng với frame bị nghẽn tại máy.
- Ghi khoảng cách frame p50/p95/p99, stall >50 ms, JS/GC timeline, thời gian GPU nếu hỗ trợ và resource. Dùng Safari Web Inspector để xem allocation và dấu hiệu áp lực bộ nhớ nếu có. Màn hình 120 Hz không có nghĩa đã đo được 120 FPS.
- Mục tiêu ban đầu đề xuất: 60 FPS ổn định khi được hỗ trợ; khoảng cách frame p95 không quá 20 ms, p99 không quá 33,3 ms ở cảnh đại diện có kiểm soát sau warmup. Báo rõ nếu chưa đạt.
- Lặp vào/rời và hiệu ứng: tài nguyên phải ổn định, không tăng tuyến tính. Không mất mesh, context hay bị reload. Lặp kiểm tra xoay gốc, joystick double tap, bàn phím/chat và pinch trong [Mobile](MOBILE.md).

Thiếu RAM vẫn là giả thuyết cho đến khi có dấu hiệu memory pressure/context loss/reload hoặc allocation thật. Thông số tổng RAM của điện thoại không tự cho biết ngân sách của browser hay giải thích được một frame giật.
