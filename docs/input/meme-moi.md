# Meme bổ sung vào lõi classic - 2026-10-22

> Nguồn: `50_meme_lau_meme.md` (danh sách thô 50 meme). Dữ liệu thật nằm ở `docs/input/noi_dung.py` (mục "meme bổ sung 2026-10-22"); `noi-dung-loi.json` và `noi-dung-loi.md` sinh lại bằng `python3 docs/input/noi_dung.py docs/input`. File này chỉ để duyệt, không phải nguồn dữ liệu.
> Quyết định đã chốt: vào lõi classic (không qua mẻ nhúng); chấp nhận tỉ lệ Việt/quốc tế giảm dưới 70/30; giữ "Hồi chiều trời mưa" như tiếng lóng chung.

## 1. Kết quả

| Chỉ số | Trước | Sau |
|---|---|---|
| Phần tử | 139 | 174 (+35) |
| Công thức | 363 | 518 (+155) |
| Độ sâu tối đa | 7 | 7 |
| Việt / quốc tế | 100 / 39 (71%) | 107 / 67 (61%) |
| Ghép trượt 20 lượt đầu (ngưỡng ≤ 45%) | ≈ 41% | ≈ 41% |
| Ghép trượt 100 lượt (ngưỡng ≤ 70%) | ≈ 67% | ≈ 66% |

- Script tự kiểm đạt: mọi phần tử tới được, không trùng cặp, không trùng tên sau bỏ dấu, không trùng emoji, tên ≤ 4 từ, mọi ứng viên Món đặc biệt (depth 4..8) có gợi ý.
- Mỗi meme mới có ít nhất 1 công thức tạo ra và ít nhất 3 công thức làm đầu vào; mỗi meme mới đều ra được ít nhất 1 phần tử đã có trong lõi.
- Không sửa công thức cũ nào. Công thức mới làm 4 phần tử cũ có đường ngắn hơn: Chia Tay 5 → 4, Bom Hàng 7 → 6, Phông Bạt 6 → 5, Chờ Về Bờ 6 → 4 (cả bốn vẫn trong [4, 8]).
- Link Google Images chỉ giữ ở bảng dưới để tham khảo, không vào dữ liệu: ảnh do bước ART vẽ từ `image_hint` (ADR 0012).

## 2. Đối chiếu 50 mục

Phân loại: MOI = thêm mới giữ tên; DOI_TEN = thêm mới nhưng đặt tên theo hiện tượng vì gắn người thật hoặc nhân vật có bản quyền (mục 7.1); TRUNG_LOI = đã có trong lõi; TRUNG_DS = trùng một mục khác trong danh sách; LOAI = không đưa vào.

| # | Tên thô | Phân loại | Tên chuẩn | Emoji | Nguồn | Lý do | Ảnh gốc |
|---|---|---|---|---|---|---|---|
| 1 | HDPE thì ngon luôn | LOAI | - | - | - | Chưa xác minh được nguồn gốc và nghĩa; xem câu hỏi mở 39 | [tìm](https://www.google.com/search?tbm=isch&q=HDPE+th%C3%AC+ngon+lu%C3%B4n+meme) |
| 2 | Nhiệm vụ hệ thống | MOI | Nhiệm Vụ Hệ Thống | 🎮 | Việt | - | [tìm](https://www.google.com/search?tbm=isch&q=nhi%E1%BB%87m+v%E1%BB%A5+h%E1%BB%87+th%E1%BB%91ng+meme) |
| 3 | Hồi chiều trời mưa | MOI | Hồi Chiều Trời Mưa | ☔ | Việt | Giữ như tiếng lóng chung (mục 7.1); không vẽ người, không nhắc người gốc, không làm Món đặc biệt (depth 3, không có gợi ý Daily) | [tìm](https://www.google.com/search?tbm=isch&q=H%E1%BB%93i+chi%E1%BB%81u+tr%E1%BB%9Di+m%C6%B0a+meme) |
| 4 | Công chúa phòng trọ | MOI | Công Chúa Phòng Trọ | 👑 | Việt | - | [tìm](https://www.google.com/search?tbm=isch&q=c%C3%B4ng+ch%C3%BAa+ph%C3%B2ng+tr%E1%BB%8D+meme) |
| 5 | Bá khí | MOI | Bá Khí | 🐉 | Việt | - | [tìm](https://www.google.com/search?tbm=isch&q=b%C3%A1+kh%C3%AD+meme+Vi%E1%BB%87t+Nam) |
| 6 | Farm aura | MOI | Farm Aura | 🗿 | Việt | Khác Aura/Âm Aura đã có: đây là hành động cố tạo aura | [tìm](https://www.google.com/search?tbm=isch&q=farm+aura+meme+Vi%E1%BB%87t+Nam) |
| 7 | Dự án ma | MOI | Dự Án Ma | 👻 | Việt | - | [tìm](https://www.google.com/search?tbm=isch&q=d%E1%BB%B1+%C3%A1n+ma+meme) |
| 8 | Rắn độc văn phòng | MOI | Rắn Độc Văn Phòng | 🐍 | Việt | - | [tìm](https://www.google.com/search?tbm=isch&q=r%E1%BA%AFn+%C4%91%E1%BB%99c+v%C4%83n+ph%C3%B2ng+meme) |
| 9 | Laura cà phê | LOAI | - | - | - | Chưa xác minh; tên riêng có thể trỏ tới một người cụ thể (mục 7.1); xem câu hỏi mở 39 | [tìm](https://www.google.com/search?tbm=isch&q=Laura+c%C3%A0+ph%C3%AA+meme) |
| 10 | Mèo Cucurella | LOAI | - | - | - | So sánh ngoại hình với một cầu thủ thật: nhận ra người cụ thể (7.1) và gần body shaming (mục 7) | [tìm](https://www.google.com/search?tbm=isch&q=m%C3%A8o+Cucurella+meme) |
| 11 | Meme nhân vật Việt Nam | LOAI | - | - | - | Là cả một bộ sưu tập biểu cảm người thật, không phải một meme | [tìm](https://www.bom.edu.vn/meme-nhan-vat-viet-nam) |
| 12 | Mèo khóc | MOI | Mèo Khóc | 😿 | Quốc tế | Vẽ mèo hoạt hình, không chép ảnh gốc | [tìm](https://www.google.com/search?tbm=isch&q=crying+cat+meme) |
| 13 | Mèo nhìn khinh bỉ | MOI | Mèo Khinh Bỉ | 😼 | Quốc tế | - | [tìm](https://www.google.com/search?tbm=isch&q=judging+cat+meme) |
| 14 | Woman Yelling at Cat | DOI_TEN | Gào Thét Với Mèo | 🙀 | Quốc tế | Ảnh gốc có người thật; giữ tình huống, không vẽ người | [tìm](https://www.google.com/search?tbm=isch&q=woman+yelling+at+cat+meme) |
| 15 | Surprised Pikachu | DOI_TEN | Ngạc Nhiên Giả Trân | 😲 | Quốc tế | Nhân vật có bản quyền | [tìm](https://www.google.com/search?tbm=isch&q=surprised+pikachu+meme) |
| 16 | This Is Fine | TRUNG_LOI | This Is Fine | ☕ | Quốc tế | Đã có (depth 1); thêm công thức ra This Is Fine từ meme mới | [tìm](https://www.google.com/search?tbm=isch&q=this+is+fine+dog+meme) |
| 17 | Side Eye Chloe | DOI_TEN | Liếc Xéo | 🤨 | Quốc tế | Người thật | [tìm](https://www.google.com/search?tbm=isch&q=side+eye+Chloe+meme) |
| 18 | Monkey Puppet | DOI_TEN | Lảng Đi Chỗ Khác | 🐒 | Quốc tế | Nhân vật rối có bản quyền; vẽ rối khỉ chung chung | [tìm](https://www.google.com/search?tbm=isch&q=awkward+monkey+puppet+meme) |
| 19 | Hide the Pain Harold | DOI_TEN | Cười Mà Đau | 🫠 | Quốc tế | Người thật | [tìm](https://www.google.com/search?tbm=isch&q=Hide+the+Pain+Harold+meme) |
| 20 | Roll Safe | DOI_TEN | Logic Lỏ | 🤓 | Quốc tế | Người thật | [tìm](https://www.google.com/search?tbm=isch&q=Roll+Safe+meme) |
| 21 | Drake Hotline Bling | DOI_TEN | Chê Kèo Thơm | 🫷 | Quốc tế | Người thật; gộp #36, #49 | [tìm](https://www.google.com/search?tbm=isch&q=Drake+Hotline+Bling+meme) |
| 22 | Distracted Boyfriend | DOI_TEN | Trông Núi Nọ | ⛰️ | Quốc tế | Người thật (ảnh stock); dùng thành ngữ Việt | [tìm](https://www.google.com/search?tbm=isch&q=distracted+boyfriend+meme) |
| 23 | Stonks | TRUNG_LOI | Stonks | 📈 | Quốc tế | Đã có (depth 4) | [tìm](https://www.google.com/search?tbm=isch&q=stonks+meme) |
| 24 | Người đàn ông nhìn xa xăm | MOI | Nhìn Xa Xăm | 🫥 | Quốc tế | Tình huống chung, không vẽ người | [tìm](https://www.google.com/search?tbm=isch&q=man+staring+into+distance+meme) |
| 25 | Pablo Escobar Waiting | DOI_TEN | Ngồi Chờ Mòn Mỏi | 🪑 | Quốc tế | Người thật + ảnh phim có bản quyền | [tìm](https://www.google.com/search?tbm=isch&q=Pablo+Escobar+waiting+meme) |
| 26 | Gru's Plan | DOI_TEN | Kế Hoạch Hoàn Hảo | 📋 | Quốc tế | Nhân vật có bản quyền | [tìm](https://www.google.com/search?tbm=isch&q=Gru%27s+plan+meme) |
| 27 | Two Buttons | MOI | Hai Nút Bấm | 🔘 | Quốc tế | Tranh gốc có bản quyền; vẽ khái niệm | [tìm](https://www.google.com/search?tbm=isch&q=two+buttons+sweating+meme) |
| 28 | Expanding Brain | MOI | Galaxy Brain | 🌌 | Quốc tế | Gộp #42 (cùng danh tính) | [tìm](https://www.google.com/search?tbm=isch&q=expanding+brain+meme) |
| 29 | Bernie Sanders ngồi rét | DOI_TEN | Ngồi Co Ro | 🧤 | Quốc tế | Người thật, chính trị gia (mục 7 cấm chính trị) | [tìm](https://www.google.com/search?tbm=isch&q=Bernie+Sanders+mittens+meme) |
| 30 | Coffin Dance | MOI | Coffin Dance | ⚰️ | Quốc tế | Tên hiện tượng; không vẽ người (nhóm thật ngoài đời) | [tìm](https://www.google.com/search?tbm=isch&q=coffin+dance+meme) |
| 31 | Success Kid | DOI_TEN | Chiến Thắng Nhỏ | ✊ | Quốc tế | Ảnh gốc là trẻ em thật | [tìm](https://www.google.com/search?tbm=isch&q=Success+Kid+meme) |
| 32 | Crying Jordan | DOI_TEN | Khóc Ròng | 😭 | Quốc tế | Người thật | [tìm](https://www.google.com/search?tbm=isch&q=Crying+Jordan+meme) |
| 33 | Disaster Girl | DOI_TEN | Cháy Nhà Cười Tươi | 😈 | Quốc tế | Ảnh gốc là trẻ em thật | [tìm](https://www.google.com/search?tbm=isch&q=Disaster+Girl+meme) |
| 34 | Doge | TRUNG_LOI | Doge | 🐕 | Quốc tế | Đã có (depth 2); thêm Mèo Chui Hộp + Doge = Cheems | [tìm](https://www.google.com/search?tbm=isch&q=Doge+meme) |
| 35 | Spongebob chế giễu | DOI_TEN | Nhại Lại | 🦜 | Quốc tế | Nhân vật có bản quyền | [tìm](https://www.google.com/search?tbm=isch&q=mocking+Spongebob+meme) |
| 36 | Drake phản đối và đồng ý | TRUNG_DS | Chê Kèo Thơm | 🫷 | Quốc tế | Cùng danh tính #21 | [tìm](https://www.google.com/search?tbm=isch&q=Drake+Hotline+Bling+meme) |
| 37 | Người nhện chỉ tay nhau | DOI_TEN | Đổ Lỗi Cho Nhau | 👉 | Quốc tế | Nhân vật có bản quyền; gộp #41 | [tìm](https://www.google.com/search?tbm=isch&q=Spider-Man+pointing+at+Spider-Man+meme) |
| 38 | Leonardo DiCaprio nâng ly | DOI_TEN | Cạn Ly Mỉa Mai | 🍸 | Quốc tế | Người thật; khác Một Hai Ba Dzô đã có (cụng ly thật lòng) | [tìm](https://www.google.com/search?tbm=isch&q=Leonardo+DiCaprio+cheers+meme) |
| 39 | Programmer Humor | MOI | Máy Em Chạy Mà | 💻 | Quốc tế | Câu cửa miệng dân lập trình | [tìm](https://www.google.com/search?tbm=isch&q=programmer+humor+production+works+on+my+machine+meme) |
| 40 | Bugs Bunny nói “No” | TRUNG_LOI | Khum | 🙅 | Việt | Nhân vật có bản quyền; ý "từ chối" trùng Khum đã có; thêm Khum + Deadline, Máy Em Chạy Mà + Khum | [tìm](https://www.google.com/search?tbm=isch&q=Bugs+Bunny+no+meme) |
| 41 | Người nhện lỗi hệ thống | TRUNG_DS | Đổ Lỗi Cho Nhau | 👉 | Quốc tế | Cùng danh tính #37 | [tìm](https://www.google.com/search?tbm=isch&q=Spider-Man+pointing+meme) |
| 42 | Galaxy Brain | TRUNG_DS | Galaxy Brain | 🌌 | Quốc tế | Cùng danh tính #28 | [tìm](https://www.google.com/search?tbm=isch&q=galaxy+brain+meme) |
| 43 | Is This a Pigeon? | DOI_TEN | Gọi Nhầm Tên | 🦋 | Quốc tế | Ảnh gốc từ anime có bản quyền | [tìm](https://www.google.com/search?tbm=isch&q=is+this+a+pigeon+meme) |
| 44 | Người ngồi trước máy tính lúc 3 giờ sáng | MOI | Debug Ba Giờ Sáng | 🪲 | Quốc tế | - | [tìm](https://www.google.com/search?tbm=isch&q=debugging+at+3am+programmer+meme) |
| 45 | Leonardo DiCaprio cười đểu | DOI_TEN | Cười Đểu | 🤭 | Quốc tế | Người thật | [tìm](https://www.google.com/search?tbm=isch&q=Leonardo+DiCaprio+smirk+meme) |
| 46 | Pikachu bất ngờ | TRUNG_DS | Ngạc Nhiên Giả Trân | 😲 | Quốc tế | Cùng danh tính #15 | [tìm](https://www.google.com/search?tbm=isch&q=surprised+Pikachu+meme) |
| 47 | Woman Yelling at Cat phiên bản gia đình | TRUNG_DS | Gào Thét Với Mèo | 🙀 | Quốc tế | Cùng danh tính #14 | [tìm](https://www.google.com/search?tbm=isch&q=woman+yelling+at+cat+meme) |
| 48 | Mèo ngồi trong hộp | MOI | Mèo Chui Hộp | 🐈 | Quốc tế | - | [tìm](https://www.google.com/search?tbm=isch&q=cat+sitting+in+box+meme) |
| 49 | Drake chọn thứ vô lý | TRUNG_DS | Chê Kèo Thơm | 🫷 | Quốc tế | Cùng danh tính #21 | [tìm](https://www.google.com/search?tbm=isch&q=Drake+Hotline+Bling+meme) |
| 50 | Awkward Look Monkey Puppet | TRUNG_DS | Lảng Đi Chỗ Khác | 🐒 | Quốc tế | Cùng danh tính #18 | [tìm](https://www.google.com/search?tbm=isch&q=awkward+monkey+puppet+meme) |

Tổng: 16 MOI, 19 DOI_TEN, 4 TRUNG_LOI, 7 TRUNG_DS, 4 LOAI ⇒ 35 phần tử mới.

## 3. Phần tử thêm mới

Ứng viên Daily = depth trong [4, 8] (đã có gợi ý mờ trong `DAILY_HINT`).

| Emoji | Tên | Nguồn | Depth | Gợi ý ảnh | Ứng viên Daily |
|---|---|---|---|---|---|
| 🎮 | Nhiệm Vụ Hệ Thống | Việt | 4 | khung thông báo nhiệm vụ kiểu game lơ lửng trên chiếc bàn chải đánh răng | có |
| ☔ | Hồi Chiều Trời Mưa | Việt | 3 | khung cửa sổ chiều mưa, chiếc ô nhỏ rưng rưng, không vẽ người | không |
| 👑 | Công Chúa Phòng Trọ | Việt | 4 | vương miện lấp lánh đặt trên gói mì tôm trong căn phòng trọ chật | có |
| 🐉 | Bá Khí | Việt | 3 | con rồng nhỏ khoanh tay ưỡn ngực, gió thổi tung bờm | không |
| 🗿 | Farm Aura | Việt | 4 | tượng đá cố nghiêng mặt góc 45 độ dưới đèn chiếu | có |
| 👻 | Dự Án Ma | Việt | 4 | bóng ma ôm bản kế hoạch trắng trơn, bay lơ lửng | có |
| 🐍 | Rắn Độc Văn Phòng | Việt | 3 | con rắn đeo thẻ nhân viên, cười mỉm sau tập hồ sơ | không |
| 😿 | Mèo Khóc | Quốc tế | 3 | chú mèo hoạt hình mắt rưng rưng hai giọt lệ to mà vẫn cố gượng | không |
| 😼 | Mèo Khinh Bỉ | Quốc tế | 4 | chú mèo nheo mắt khinh khỉnh nhìn xuống từ nóc tủ | có |
| 🐈 | Mèo Chui Hộp | Quốc tế | 4 | chú mèo nhét mình vào hộp giấy quá nhỏ, cạnh giường êm bỏ trống | có |
| 🙀 | Gào Thét Với Mèo | Quốc tế | 5 | bong bóng thoại đỏ rực gào vào chú mèo đang ngồi thản nhiên liếm chân | có |
| 😲 | Ngạc Nhiên Giả Trân | Quốc tế | 4 | quả trứng hoạt hình há hốc mồm trước tờ hóa đơn ai cũng đoán được | có |
| 🤨 | Liếc Xéo | Quốc tế | 3 | đôi mắt hoạt hình liếc ngang, một bên chân mày nhướn cao | không |
| 🐒 | Lảng Đi Chỗ Khác | Quốc tế | 3 | con rối khỉ nhồi bông liếc mắt sang bên, mồ hôi nhỏ giọt | không |
| 🫠 | Cười Mà Đau | Quốc tế | 3 | cốc trà nóng mỉm cười trong khi nứt dần | không |
| 🤓 | Logic Lỏ | Quốc tế | 4 | ngón tay chỉ vào thái dương bằng giấy, sau lưng là phép tính sai | có |
| 🫷 | Chê Kèo Thơm | Quốc tế | 6 | bàn tay xua đi đĩa cơm ngon, quay sang ôm hộp quà giảm giá | có |
| ⛰️ | Trông Núi Nọ | Quốc tế | 5 | hai ngọn núi, cái gần ngoái cổ nhìn ngọn núi xa lấp lánh | có |
| 🫥 | Nhìn Xa Xăm | Quốc tế | 3 | chiếc ghế văn phòng quay về phía cửa sổ, đám mây trôi vô định | không |
| 🪑 | Ngồi Chờ Mòn Mỏi | Quốc tế | 3 | chiếc ghế phủ mạng nhện cạnh đồng hồ quay vòng | không |
| 📋 | Kế Hoạch Hoàn Hảo | Quốc tế | 4 | bảng kế hoạch bốn ô, ô cuối có cái bẫy tự sập | có |
| 🔘 | Hai Nút Bấm | Quốc tế | 3 | hai nút đỏ to, giọt mồ hôi khổng lồ lơ lửng phía trên | không |
| 🌌 | Galaxy Brain | Quốc tế | 5 | bộ não phát sáng thành dải ngân hà, nổ pháo hoa | có |
| 🧤 | Ngồi Co Ro | Quốc tế | 4 | đôi găng len to sụ ôm lấy chiếc ghế xếp giữa gió lạnh | có |
| ⚰️ | Coffin Dance | Quốc tế | 3 | cỗ hòm bằng hộp giấy tự nhún nhảy theo nốt nhạc, không vẽ người | không |
| ✊ | Chiến Thắng Nhỏ | Quốc tế | 4 | nắm tay nhỏ xíu giơ lên trước bãi cát, cờ chiến thắng tí hon | có |
| 😭 | Khóc Ròng | Quốc tế | 3 | quả bóng xì hơi khóc thành vòi nước | không |
| 😈 | Cháy Nhà Cười Tươi | Quốc tế | 3 | con quỷ nhỏ cười tủm tỉm trước căn nhà đồ chơi bốc khói | không |
| 🦜 | Nhại Lại | Quốc tế | 3 | con vẹt chống nạnh nhại giọng, bong bóng thoại méo mó, không có chữ | không |
| 👉 | Đổ Lỗi Cho Nhau | Quốc tế | 3 | hai ngón tay giống hệt nhau chỉ thẳng vào nhau | không |
| 🍸 | Cạn Ly Mỉa Mai | Quốc tế | 4 | ly cocktail giơ cao, nháy mắt đầy ẩn ý | có |
| 💻 | Máy Em Chạy Mà | Quốc tế | 4 | chiếc laptop cười tươi, phía sau màn hình server cháy đỏ | có |
| 🦋 | Gọi Nhầm Tên | Quốc tế | 4 | con bướm bị chỉ vào bởi tấm biển có dấu hỏi to | có |
| 🪲 | Debug Ba Giờ Sáng | Quốc tế | 4 | con bọ ngồi trên bàn phím dưới ánh trăng, đồng hồ chỉ 3 giờ | có |
| 🤭 | Cười Đểu | Quốc tế | 3 | cái miệng che tay khúc khích, ánh mắt biết tuốt | không |

## 4. Công thức mới

Cùng định dạng chuỗi `R` trong `noi_dung.py`.

```text
# đời thường và mạng xã hội
Side Quest + Deadline = Nhiệm Vụ Hệ Thống
Nhiệm Vụ Hệ Thống + Thứ Hai = Bơi Đi Làm
Nhiệm Vụ Hệ Thống + Deadline = Speedrun
Nhiệm Vụ Hệ Thống + Để Mai Tính = Dự Án Ma
Nhiệm Vụ Hệ Thống + Gánh Team = Bá Khí
Mưa + U Là Trời = Hồi Chiều Trời Mưa
Hồi Chiều Trời Mưa + Crush = Chia Tay
Hồi Chiều Trời Mưa + Cười = Cười Mà Đau
Hồi Chiều Trời Mưa + Ế = Nhạc Suy
Hồi Chiều Trời Mưa + Hóng Biến = Biến Căng
Còn Cái Nịt + Delulu = Công Chúa Phòng Trọ
Công Chúa Phòng Trọ + Săn Sale = Bom Hàng
Công Chúa Phòng Trọ + Mì Tôm = Phông Bạt
Công Chúa Phòng Trọ + Trà Sữa Full Topping = Cháy Túi
Công Chúa Phòng Trọ + Cuối Tháng = Còn Cái Nịt
Tới Công Chuyện + Gét Gô = Bá Khí
Bá Khí + Leo Rank = Gánh Team
Bá Khí + Toang = Ăn Hành
Bá Khí + Farm Aura = Aura
Bá Khí + Sếp = Sếp Tổng
Chill Guy + Gét Gô = Farm Aura
Farm Aura + Sống Ảo = Main Character
Farm Aura + Toang = Âm Aura
Farm Aura + Chill = Chill Guy
Farm Aura + Cười = Cười Đểu
Cà Khịa + Hóng Biến = Cười Đểu
Cười Đểu + Bóc Phốt = Hóng Biến
Cười Đểu + Crush = Thả Thính
Cười Đểu + Sếp = Nịnh Sếp
Cà Khịa + Như Email Trước = Nhại Lại
Nhại Lại + Sếp = Gật Gù Cho Có
Nhại Lại + Khẩu Nghiệp = Anh Hùng Bàn Phím
Nhại Lại + Crush = Cà Khịa
Cà Khịa + Seen Không Rep = Liếc Xéo
Liếc Xéo + Phông Bạt = Bóc Phốt
Liếc Xéo + Crush = Thả Thính
Liếc Xéo + Red Flag = Chia Tay
Liếc Xéo + Như Email Trước = Cười Đểu
# văn phòng
Hứa Lèo + Đồ Án = Dự Án Ma
Dự Án Ma + Sếp = Hứa Lèo
Dự Án Ma + Deadline = Hết Cứu
Dự Án Ma + Họp = Họp Bàn Lịch Họp
Dự Án Ma + Stonks = Not Stonks
Nịnh Sếp + Khẩu Nghiệp = Rắn Độc Văn Phòng
Rắn Độc Văn Phòng + Họp = Đổ Lỗi Cho Nhau
Rắn Độc Văn Phòng + Sếp = Nịnh Sếp
Rắn Độc Văn Phòng + Quiet Quitting = Đơn Nghỉ Việc
Rắn Độc Văn Phòng + Bóc Phốt = Biến Căng
Thứ Hai + Tăng Ca = Nhìn Xa Xăm
Nhìn Xa Xăm + Lương Tháng Sau = Hết Nước Chấm
Nhìn Xa Xăm + Cuối Tuần = Touch Grass
Nhìn Xa Xăm + Ngồi Chờ Mòn Mỏi = Chờ Về Bờ
Nhìn Xa Xăm + Đơn Nghỉ Việc = Tự Do
Seen Không Rep + Lương Tháng Sau = Ngồi Chờ Mòn Mỏi
Ngồi Chờ Mòn Mỏi + Cuối Tháng = Lương Về
Ngồi Chờ Mòn Mỏi + Thả Thính = Friendzone
Ngồi Chờ Mòn Mỏi + Mạng Lag = AFK
Để Mai Tính + Hứa Lèo = Kế Hoạch Hoàn Hảo
Kế Hoạch Hoàn Hảo + Săn Sale = Cháy Túi
Kế Hoạch Hoàn Hảo + Toang = Plot Twist
Kế Hoạch Hoàn Hảo + Đồ Án = Dự Án Ma
Kế Hoạch Hoàn Hảo + Thứ Hai = Để Mai Tính
Đơn Nghỉ Việc + Lương Tháng Sau = Hai Nút Bấm
Hai Nút Bấm + Nhậu = Một Hai Ba Dzô
Hai Nút Bấm + Crush = Thả Thính
Hai Nút Bấm + Deadline = Ét O Ét
Ngập + Họp = Ngồi Co Ro
Ngồi Co Ro + Nồi Lẩu = Trời Lạnh Ăn Lẩu
Ngồi Co Ro + Cuối Tuần = Chill
Ngồi Co Ro + Kẹt Xe = Bơi Đi Làm
Ủa Alo + Cười Xã Giao = Lảng Đi Chỗ Khác
Lảng Đi Chỗ Khác + Bao Giờ Cưới = Ế
Lảng Đi Chỗ Khác + Lương Bao Nhiêu = Cười Xã Giao
Lảng Đi Chỗ Khác + Sếp = Quiet Quitting
Lảng Đi Chỗ Khác + Họp = Ngủ Gật
Cười Xã Giao + Hết Cứu = Cười Mà Đau
Cười Mà Đau + Thứ Hai = Thánh Nhọ
Cười Mà Đau + Lương Tháng Sau = This Is Fine
Cười Mà Đau + Deadline = Chạy Deadline
Cười Mà Đau + Cà Khịa = Khẩu Nghiệp
This Is Fine + Báo Thủ = Cháy Nhà Cười Tươi
Cháy Nhà Cười Tươi + Biến Căng = Hóng Biến
Cháy Nhà Cười Tươi + Đổ Lỗi Cho Nhau = Báo Thủ
Cháy Nhà Cười Tươi + Sếp = Đơn Nghỉ Việc
Báo Thủ + Họp = Đổ Lỗi Cho Nhau
Đổ Lỗi Cho Nhau + Báo Thủ = GG
Đổ Lỗi Cho Nhau + Sếp = Tâm Thư Xin Lỗi
Đổ Lỗi Cho Nhau + Bóc Phốt = Biến Căng
# mèo
Cười Xã Giao + U Là Trời = Mèo Khóc
Mèo Khóc + Chill = Mèo Chui Hộp
Mèo Khóc + Cà Khịa = Mèo Khinh Bỉ
Mèo Khóc + Nhạc Suy = Hồi Chiều Trời Mưa
Mèo Khóc + Chia Tay = Ế
Mèo Khinh Bỉ + Biến Căng = Gào Thét Với Mèo
Mèo Khinh Bỉ + Khẩu Nghiệp = Anh Hùng Bàn Phím
Mèo Khinh Bỉ + Delulu = Touch Grass
Mèo Khinh Bỉ + Flex = Phông Bạt
Mèo Chui Hộp + Shipper = Mua Rồi Để Đó
Mèo Chui Hộp + Để Mai Tính = AFK
Mèo Chui Hộp + Mạng Lag = Ngủ Gật
Mèo Chui Hộp + Doge = Cheems
Gào Thét Với Mèo + Seen Không Rep = Khum
Gào Thét Với Mèo + Ổn Áp = This Is Fine
Gào Thét Với Mèo + Họp = Biến Căng
# phản ứng kinh điển
Plot Twist + Ổn Áp = Ngạc Nhiên Giả Trân
Ngạc Nhiên Giả Trân + Đu Đỉnh = Cắt Lỗ
Ngạc Nhiên Giả Trân + Bom Hàng = U Là Trời
Ngạc Nhiên Giả Trân + Cười = Cười Xã Giao
Brainrot + Để Mai Tính = Logic Lỏ
Logic Lỏ + Logic Lỏ = Galaxy Brain
Logic Lỏ + Stonks = Đu Đỉnh
Logic Lỏ + Cuối Tháng = Mì Tôm
Logic Lỏ + Học Tủ = Trật Tủ
Galaxy Brain + Ctrl Z = Debug Ba Giờ Sáng
Galaxy Brain + Stonks = Not Stonks
Galaxy Brain + Họp = Họp Bàn Lịch Họp
Săn Sale + Khum = Chê Kèo Thơm
Chê Kèo Thơm + Crush = Friendzone
Chê Kèo Thơm + Lương Về = Cháy Túi
Chê Kèo Thơm + Đơn Nghỉ Việc = Hai Nút Bấm
Chê Kèo Thơm + Cười = Cà Khịa
Có Gấu + Thả Thính = Trông Núi Nọ
Trông Núi Nọ + Bóc Phốt = Chia Tay
Trông Núi Nọ + Crush = Red Flag
Trông Núi Nọ + Săn Sale = Mua Rồi Để Đó
Toang + Gét Gô = Coffin Dance
Coffin Dance + Đu Đỉnh = Cắt Lỗ
Coffin Dance + Stonks = Not Stonks
Coffin Dance + Leo Rank = GG
Trúng Tủ + Cười = Chiến Thắng Nhỏ
Chiến Thắng Nhỏ + Lương Về = Flex
Chiến Thắng Nhỏ + Leo Rank = Gánh Team
Chiến Thắng Nhỏ + Săn Sale = Chốt Đơn
GG + U Là Trời = Khóc Ròng
Khóc Ròng + Đu Đỉnh = Chờ Về Bờ
Khóc Ròng + Mùa Thi = Trật Tủ
Khóc Ròng + Cười = Cười Mà Đau
Một Hai Ba Dzô + Cà Khịa = Cạn Ly Mỉa Mai
Cạn Ly Mỉa Mai + Thưởng Bằng Niềm Tin = Lương Tháng Sau
Cạn Ly Mỉa Mai + Báo Thủ = GG
Cạn Ly Mỉa Mai + Nhậu = Tiếp Khách
# công nghệ
Ctrl Z + Toang = Máy Em Chạy Mà
Máy Em Chạy Mà + Thức Trắng = Debug Ba Giờ Sáng
Máy Em Chạy Mà + Sếp = Ét O Ét
Máy Em Chạy Mà + Khum = Skill Issue
Máy Em Chạy Mà + Đổ Lỗi Cho Nhau = Báo Thủ
NPC + Ủa Alo = Gọi Nhầm Tên
Gọi Nhầm Tên + Crush = Chia Tay
Gọi Nhầm Tên + Họp = Cười Xã Giao
Gọi Nhầm Tên + Sếp = Ăn Hành
Thức Trắng + Ctrl Z = Debug Ba Giờ Sáng
Debug Ba Giờ Sáng + Cà Phê Sữa Đá = Tăng Ca
Debug Ba Giờ Sáng + Deadline = Chạy Deadline
Debug Ba Giờ Sáng + Ổn Áp = This Is Fine
Khum + Deadline = Quiet Quitting
```

## 5. Việc còn lại

- Test pipeline đóng cứng 139 phần tử / 363 công thức và bộ dữ liệu vàng `pipeline/tests/golden/expected.json` chưa sinh lại ⇒ 9 test đỏ. Chưa sửa test, chờ quyết định (câu hỏi mở 40).
- #1 và #9 chưa xác minh nguồn gốc (câu hỏi mở 39).
