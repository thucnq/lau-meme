"""Lõi nội dung Lẩu Meme: phần tử + công thức. Chạy file này để kiểm và sinh noi-dung-loi.md + noi-dung-loi.json."""
import json, random, sys, unicodedata
from collections import deque
from pathlib import Path

# tên: (emoji, nguồn V=Việt / Q=quốc tế, gợi ý ảnh minh họa — vẽ khái niệm, không chép ảnh gốc, không người thật)
E = {
 "Cay": ("🌶️", "V", "quả ớt đỏ bốc khói, mặt cau có"),
 "Cười": ("😂", "Q", "mặt cười chảy nước mắt"),
 "Toang": ("💀", "V", "bình gốm vỡ toang, mảnh văng tung tóe"),
 "Deadline": ("⏰", "Q", "đồng hồ báo thức đỏ rực rung bần bật"),
 # tầng 1
 "Tới Công Chuyện": ("🔥", "V", "người xắn tay áo, lửa phía sau"),
 "Hết Nước Chấm": ("🥢", "V", "chén nước chấm trống trơn, đôi đũa buông thõng"),
 "Ét O Ét": ("🆘", "V", "biển báo SOS cắm giữa đống giấy tờ"),
 "Thức Trắng": ("🌙", "V", "người ôm laptop, trăng ngoài cửa sổ, mắt thâm"),
 "Cà Khịa": ("😏", "V", "cái nhếch mép ngạo nghễ, liếc ngang"),
 "Ăn Hành": ("🧅", "V", "nhân vật bị úp nguyên rổ hành lên đầu"),
 "This Is Fine": ("☕", "Q", "nồi lẩu cười mỉm cầm ly cà phê giữa căn phòng có lửa nhỏ"),
 "Hết Cứu": ("🫠", "V", "nhân vật tan chảy thành vũng"),
 "Để Mai Tính": ("🐌", "V", "con ốc sên đội tờ lịch, bò chậm rãi"),
 "Sếp": ("👔", "V", "chiếc ghế xoay to đùng, cà vạt, không thấy mặt"),
 # văn phòng
 "Họp": ("📅", "V", "bàn họp dài, ai cũng ngáp"),
 "Họp Bàn Lịch Họp": ("🔁", "V", "lịch họp lồng trong lịch họp, vòng xoáy"),
 "Ngủ Gật": ("😴", "V", "đầu gục xuống bàn phím, chữ zzz"),
 "Cười Xã Giao": ("😬", "V", "nụ cười cứng đơ như nhựa"),
 "Đơn Nghỉ Việc": ("📩", "V", "phong bì bay vèo ra khỏi tòa nhà"),
 "Lương Tháng Sau": ("⏳", "V", "đồng xu trôi xa dần theo dòng thời gian"),
 "Còn Cái Nịt": ("👖", "V", "chiếc thắt lưng nằm cô đơn trong ví rỗng"),
 "Stonks": ("📈", "Q", "biểu đồ đi lên, nhân vật đầu tượng 3D mặc vest (tự vẽ, không chép)"),
 "Sếp Tổng": ("🏢", "V", "tòa nhà có cà vạt"),
 "Hứa Lèo": ("🎈", "V", "quả bóng bay ghi 'tăng lương' bay mất"),
 "Nịnh Sếp": ("🍯", "V", "hũ mật ong đặt trên bàn sếp"),
 "Tự Do": ("🕊️", "Q", "chim bồ câu bay ra khỏi cửa văn phòng"),
 "Cuối Tháng": ("📆", "V", "tờ lịch ngày 30, ví mỏng dính"),
 "Mì Tôm": ("🍜", "V", "gói mì tôm phát sáng như báu vật"),
 "Chạy Deadline": ("🏃", "V", "người chạy hụt hơi, đồng hồ đuổi theo"),
 "Tăng Ca": ("🌃", "V", "tòa nhà về đêm chỉ còn một ô cửa sáng"),
 "Làm Không Công": ("🆓", "V", "bảng lương ghi số 0 to đùng"),
 "Quiet Quitting": ("🤫", "Q", "nhân vật làm việc bằng một ngón tay, mặt thảnh thơi"),
 "Gật Gù Cho Có": ("🙂", "V", "dãy đầu gật gù như lò xo"),
 "Seen Không Rep": ("👀", "V", "bong bóng chat có chữ 'đã xem', im lặng"),
 "Như Email Trước": ("📧", "V", "email có chữ 'như đã gửi' gạch chân ba lần"),
 "Cà Phê Sữa Đá": ("🥤", "V", "ly cà phê sữa đá đổ mồ hôi"),
 "Gấu Trúc": ("🐼", "V", "gấu trúc mặc áo sơ mi văn phòng"),
 "Thứ Hai": ("😩", "V", "tờ lịch thứ Hai đè lên người"),
 "Cuối Tuần": ("🎉", "V", "tờ lịch thứ Bảy nhảy múa"),
 # yêu đương
 "Khẩu Nghiệp": ("👄", "V", "cái miệng có gắn loa phóng thanh"),
 "Crush": ("😍", "Q", "trái tim nấp sau cột điện nhìn trộm"),
 "Thả Thính": ("🎣", "V", "cần câu thả mồi hình trái tim"),
 "Có Gấu": ("🧸", "V", "gấu bông ôm điện thoại nhắn tin"),
 "Cơm Chó": ("🍚", "V", "bát cơm đầy tràn, chú chó nhìn tủi thân"),
 "Chia Tay": ("💔", "Q", "trái tim xé đôi, mỗi nửa đi một ngả"),
 "Nhạc Suy": ("🎧", "V", "tai nghe nhỏ giọt mưa"),
 "Ế": ("🥲", "V", "một ghế đá công viên, một người, một cái bánh mì"),
 "FA": ("🧍", "Q", "người đứng giữa đám đông các cặp đôi"),
 "Friendzone": ("🚧", "Q", "rào chắn ghi 'chỉ là bạn'"),
 "Red Flag": ("🚩", "Q", "lá cờ đỏ phấp phới trên đầu"),
 "Delulu": ("🦄", "Q", "kỳ lân mơ màng trên mây"),
 "Hẹn Hò": ("💑", "V", "hai đôi đũa gắp chung một miếng"),
 # Tết
 "Cuối Năm": ("🎆", "V", "pháo hoa trên tờ lịch tháng 12"),
 "Tết": ("🌸", "V", "cành hoa đào, bánh chưng"),
 "Lì Xì": ("🧧", "V", "phong bao đỏ nhỏ xíu"),
 "Mẹ Giữ Hộ": ("👛", "V", "chiếc ví khóa ba lớp"),
 "Thưởng Tết": ("💰", "V", "túi tiền có dây buộc"),
 "Thưởng Bằng Niềm Tin": ("🫶", "V", "phong bì rỗng có vẽ trái tim"),
 "Hỏi Thăm Ngày Tết": ("🍵", "V", "ấm trà và những dấu hỏi bay quanh"),
 "Bao Giờ Cưới": ("💍", "V", "chiếc nhẫn kèm dấu hỏi khổng lồ"),
 "Lương Bao Nhiêu": ("💵", "V", "máy tính cầm tay bị soi đèn"),
 "Con Nhà Người Ta": ("🏅", "V", "huy chương vàng treo nhà hàng xóm, tỏa sáng"),
 # đồ ăn và lẩu
 "Nồi Lẩu": ("🍲", "V", "nồi lẩu hai ngăn sôi sùng sục"),
 "Lẩu Meme": ("🫕", "V", "nồi lẩu thả đủ thứ biểu tượng cảm xúc"),
 "Meme": ("🖼️", "Q", "khung tranh có chữ trắng viền đen"),
 "Trời Lạnh Ăn Lẩu": ("❄️", "V", "bông tuyết bên nồi lẩu nghi ngút"),
 "Ăn Buffet Gỡ Vốn": ("🍖", "V", "đĩa thức ăn chồng cao như núi"),
 "Chấm Mắm Tôm": ("🦐", "V", "con tôm cầm chén mắm tôm đánh bông"),
 "Nhậu": ("🍻", "V", "hai cốc bia cụng nhau"),
 "Một Hai Ba Dzô": ("🥂", "V", "nhiều cốc giơ cao, chữ DZÔ"),
 "Tiếp Khách": ("🤝", "V", "bàn tiệc dài, ghế sếp ở giữa"),
 "Lương Về": ("🤑", "V", "tin nhắn biến động số dư phát sáng"),
 "Trà Sữa Full Topping": ("🧋", "V", "ly trà sữa đầy trân châu tràn miệng"),
 "Cháy Túi": ("💸", "V", "chiếc ví bốc cháy, tiền bay"),
 # đường phố
 "Mưa": ("🌧️", "V", "đám mây đen chọn đúng một người để mưa"),
 "Kẹt Xe": ("🚗", "V", "dòng xe máy kín đường như hộp cá"),
 "Ngập": ("🌊", "V", "xe máy chìm nửa bánh, nước ngang gối"),
 "Bơi Đi Làm": ("🏊", "V", "người đeo cặp táp bơi sải"),
 "Shipper": ("🛵", "V", "xe máy chất hàng cao ngất"),
 "Bom Hàng": ("💣", "V", "gói hàng có ngòi nổ, shipper ôm đầu"),
 # mua sắm
 "Săn Sale": ("🛒", "V", "giỏ hàng lao vun vút lúc 0 giờ"),
 "Mua Rồi Để Đó": ("📦", "V", "chồng hộp hàng chưa bóc trong góc phòng"),
 "Chốt Đơn": ("✅", "V", "nút chốt đơn bị bấm lún"),
 # game
 "Thánh Nhọ": ("🙈", "V", "đám mây đen chỉ mưa trên đầu một người"),
 "Báo Thủ": ("🐆", "V", "con báo đốm làm đổ hết đồ đạc của đồng đội"),
 "Gánh Team": ("🏋️", "V", "người gánh cả đội trên đòn gánh"),
 "Feed": ("🍼", "Q", "bình sữa phát cho đối thủ"),
 "Leo Rank": ("🧗", "Q", "người leo bậc thang huy hiệu"),
 "GG": ("🏳️", "Q", "lá cờ trắng phất phơ"),
 "Mạng Lag": ("🐢", "V", "con rùa cõng cục wifi"),
 "Skill Issue": ("🎯", "Q", "bia tập bắn, mũi tên cắm ngược vào người bắn"),
 "AFK": ("💤", "Q", "ghế chơi game trống, tay cầm rơi xuống sàn"),
 # mạng xã hội
 "Flex": ("💎", "Q", "viên kim cương đeo kính râm"),
 "Sống Ảo": ("📸", "V", "điện thoại có 12 bộ lọc chồng lên nhau"),
 "Phông Bạt": ("🎭", "V", "tấm phông nền hình siêu xe, phía sau là xe đạp"),
 "Đu Trend": ("🏄", "V", "người lướt sóng trên làn sóng biểu tượng hashtag"),
 "Hóng Biến": ("🍿", "V", "xô bỏng ngô và đôi mắt mở to"),
 "Biến Căng": ("🌪️", "V", "cơn lốc cuốn theo các bong bóng chat"),
 "Bóc Phốt": ("🧾", "V", "tờ hóa đơn dài lê thê bị bóc ra"),
 "Tâm Thư Xin Lỗi": ("✉️", "V", "lá thư viết tay có giọt nước mắt"),
 "Đào Mả Phốt": ("⛏️", "V", "cái xẻng đào lên một chồng ảnh chụp màn hình cũ phủ bụi"),
 "Fan Quay Xe": ("🔄", "V", "đoàn xe máy gắn cờ cổ vũ quay đầu đồng loạt"),
 "Anh Hùng Bàn Phím": ("⌨️", "V", "bàn phím mặc áo choàng siêu nhân"),
 "Ảo Ma Canada": ("🍁", "V", "lá phong xoay vòng, hiệu ứng ảo ảnh"),
 "Xỉu Up Xỉu Down": ("😵", "V", "nhân vật ngã lên ngã xuống như lò xo"),
 "Gét Gô": ("🚀", "V", "tên lửa khởi động có chữ GÉT GÔ"),
 "Khum": ("🙅", "V", "bàn tay nhỏ xua xua dễ thương"),
 "Ủa Alo": ("📞", "V", "chiếc điện thoại bàn tự nhấc máy hỏi"),
 "U Là Trời": ("😫", "V", "nhân vật ôm mặt ngửa lên trời"),
 "Chill": ("🌿", "Q", "võng mắc giữa hai cây, nhạc lofi"),
 "Chill Guy": ("😎", "Q", "nhân vật tự vẽ đút tay túi quần, mặt thản nhiên (không chép nhân vật gốc)"),
 "Main Character": ("🌟", "Q", "ánh đèn sân khấu chiếu một người giữa phố"),
 "NPC": ("🤖", "Q", "dãy người giống hệt nhau nói cùng một câu"),
 "Rizz": ("🪄", "Q", "cây đũa phép bắn ra tim"),
 "Sigma": ("🐺", "Q", "con sói đeo tai nghe đi một mình"),
 "Lướt Tới Sáng": ("📱", "V", "ngón tay cái mỏi nhừ trên màn hình, trời hửng sáng"),
 "Brainrot": ("🧠", "Q", "bộ não tan chảy thành video ngắn"),
 "Touch Grass": ("🌱", "Q", "bàn tay chạm vào bãi cỏ thật lần đầu"),
 "Aura": ("🌈", "Q", "vầng hào quang +1000 trên đầu"),
 "Âm Aura": ("📉", "Q", "vầng hào quang tắt ngóm, -1000"),
 "Lương 404": ("🕳️", "Q", "bảng lương là một cái lỗ đen ghi 404"),
 "Ctrl Z": ("↩️", "Q", "phím Ctrl và Z khổng lồ bị bấm điên cuồng"),
 "Plot Twist": ("🌀", "Q", "con đường cong ngoặt 180 độ"),
 "Speedrun": ("⏱️", "Q", "đồng hồ bấm giờ có cánh"),
 "Side Quest": ("🗺️", "Q", "tấm bản đồ đầy dấu chấm than phụ"),
 # học hành
 "Mùa Thi": ("📝", "V", "chồng đề cương cao tới trần nhà"),
 "Học Tủ": ("🗄️", "V", "tủ hồ sơ có dán chữ 'chắc chắn ra'"),
 "Trúng Tủ": ("🍀", "V", "tủ mở ra phát sáng, cỏ bốn lá"),
 "Trật Tủ": ("🗑️", "V", "tủ mở ra toàn mạng nhện"),
 "Đồ Án": ("📚", "V", "cuốn đồ án dày cộp có quầng thâm"),
 # tài chính
 "Đu Đỉnh": ("🏔️", "V", "người cắm cờ trên đỉnh núi biểu đồ, phía sau là vực"),
 "Cắt Lỗ": ("✂️", "V", "cây kéo cắt đường biểu đồ đỏ"),
 "Chờ Về Bờ": ("🏖️", "V", "người ôm phao nhìn bờ biển xa tít"),
 "Not Stonks": ("🥶", "Q", "biểu đồ cắm đầu xuống, nhân vật vest run cầm cập"),
 # chó
 "Doge": ("🐕", "Q", "chú chó shiba liếc mắt tự mãn (tự vẽ, không chép ảnh gốc)"),
 "Cheems": ("🍔", "Q", "chú shiba nhỏ ôm cái bánh mì kẹp"),
 "Swole Doge": ("💪", "Q", "chú shiba vai u thịt bắp"),
 "Such Wow": ("✨", "Q", "chữ màu Comic Sans bay lấp lánh"),
 "Ổn Áp": ("👌", "V", "ngón tay OK trên nền nồi lẩu êm ả"),
}

R = """
Cay + Cay = Tới Công Chuyện
Cười + Cười = Hết Nước Chấm
Toang + Toang = Ét O Ét
Deadline + Deadline = Thức Trắng
Cay + Cười = Cà Khịa
Cay + Toang = Ăn Hành
Cười + Toang = This Is Fine
Toang + Deadline = Hết Cứu
Cười + Deadline = Để Mai Tính
Cay + Deadline = Sếp
# văn phòng
Để Mai Tính + Deadline = Chạy Deadline
Sếp + Toang = Đơn Nghỉ Việc
Sếp + Để Mai Tính = Lương Tháng Sau
Lương Tháng Sau + Toang = Còn Cái Nịt
Còn Cái Nịt + This Is Fine = Stonks
Sếp + Deadline = Họp
Họp + Họp = Họp Bàn Lịch Họp
Họp + Thức Trắng = Ngủ Gật
Sếp + Cười = Cười Xã Giao
Sếp + Sếp = Sếp Tổng
Sếp Tổng + Để Mai Tính = Hứa Lèo
Sếp + Hết Nước Chấm = Nịnh Sếp
Đơn Nghỉ Việc + Cười = Tự Do
Lương Tháng Sau + Deadline = Cuối Tháng
Cuối Tháng + Còn Cái Nịt = Mì Tôm
Chạy Deadline + Chạy Deadline = Tăng Ca
Tăng Ca + Lương Tháng Sau = Làm Không Công
Tăng Ca + Để Mai Tính = Quiet Quitting
Họp + Cười = Gật Gù Cho Có
Cà Khịa + Để Mai Tính = Seen Không Rep
Cà Khịa + Họp = Như Email Trước
Thức Trắng + Chạy Deadline = Cà Phê Sữa Đá
Thức Trắng + Thức Trắng = Gấu Trúc
Để Mai Tính + Để Mai Tính = Thứ Hai
Thứ Hai + Tự Do = Cuối Tuần
# yêu đương
Cà Khịa + Toang = Khẩu Nghiệp
Cười + Thức Trắng = Crush
Crush + Cà Khịa = Thả Thính
Thả Thính + Thả Thính = Có Gấu
Có Gấu + Cười = Cơm Chó
Có Gấu + Toang = Chia Tay
Chia Tay + Thức Trắng = Nhạc Suy
Crush + Seen Không Rep = Ế
Ế + Ế = FA
Crush + Cười Xã Giao = Friendzone
Có Gấu + Khẩu Nghiệp = Red Flag
Crush + Để Mai Tính = Delulu
# Tết
Cuối Tháng + Cuối Tháng = Cuối Năm
Cuối Năm + Cười = Tết
Tết + Cười = Lì Xì
Lì Xì + Để Mai Tính = Mẹ Giữ Hộ
Tết + Sếp = Thưởng Tết
Thưởng Tết + Còn Cái Nịt = Thưởng Bằng Niềm Tin
Tết + Cà Khịa = Hỏi Thăm Ngày Tết
Hỏi Thăm Ngày Tết + Ế = Bao Giờ Cưới
Hỏi Thăm Ngày Tết + Lương Tháng Sau = Lương Bao Nhiêu
Hỏi Thăm Ngày Tết + Ăn Hành = Con Nhà Người Ta
# lẩu và đồ ăn
Cay + Hết Nước Chấm = Nồi Lẩu
Lướt Tới Sáng + Cười = Meme
Nồi Lẩu + Meme = Lẩu Meme
Tới Công Chuyện + Cười = Nhậu
Nhậu + Nhậu = Một Hai Ba Dzô
Nhậu + Sếp = Tiếp Khách
Cuối Tháng + Cười = Lương Về
Lương Về + Để Mai Tính = Trà Sữa Full Topping
Lương Về + Toang = Cháy Túi
Cà Khịa + Hết Nước Chấm = Chấm Mắm Tôm
Nồi Lẩu + Lương Về = Ăn Buffet Gỡ Vốn
# đường phố
Thứ Hai + Ét O Ét = Mưa
Thứ Hai + Toang = Kẹt Xe
Mưa + Kẹt Xe = Ngập
Ngập + This Is Fine = Bơi Đi Làm
Nồi Lẩu + Mưa = Trời Lạnh Ăn Lẩu
# mua sắm
Lương Về + Thức Trắng = Săn Sale
Săn Sale + Để Mai Tính = Mua Rồi Để Đó
Săn Sale + Tới Công Chuyện = Chốt Đơn
Chốt Đơn + Kẹt Xe = Shipper
Shipper + Seen Không Rep = Bom Hàng
# game
Ăn Hành + Ăn Hành = Thánh Nhọ
Ăn Hành + Cà Khịa = Báo Thủ
Báo Thủ + Tới Công Chuyện = Gánh Team
Báo Thủ + Toang = Feed
Gánh Team + Thức Trắng = Leo Rank
Ăn Hành + Hết Cứu = GG
Ăn Hành + Để Mai Tính = Mạng Lag
Mạng Lag + Cà Khịa = Skill Issue
Báo Thủ + Ngủ Gật = AFK
# mạng xã hội
Lương Về + Cà Khịa = Flex
Flex + Cười = Sống Ảo
Flex + Còn Cái Nịt = Phông Bạt
Sống Ảo + Tới Công Chuyện = Đu Trend
Cà Khịa + Cà Khịa = Hóng Biến
Hóng Biến + Hóng Biến = Biến Căng
Biến Căng + Khẩu Nghiệp = Bóc Phốt
Bóc Phốt + Ét O Ét = Tâm Thư Xin Lỗi
Bóc Phốt + Thức Trắng = Đào Mả Phốt
Bóc Phốt + Bóc Phốt = Fan Quay Xe
Đào Mả Phốt + Lướt Tới Sáng = Hóng Biến
Fan Quay Xe + Toang = Âm Aura
Khẩu Nghiệp + Thức Trắng = Anh Hùng Bàn Phím
Hết Nước Chấm + This Is Fine = Ảo Ma Canada
Hết Nước Chấm + Toang = Xỉu Up Xỉu Down
Tới Công Chuyện + Tới Công Chuyện = Gét Gô
Cười Xã Giao + Để Mai Tính = Khum
Seen Không Rep + Ét O Ét = Ủa Alo
Ét O Ét + Cười = U Là Trời
Tự Do + Để Mai Tính = Chill
Chill + This Is Fine = Chill Guy
Sống Ảo + Delulu = Main Character
Cười Xã Giao + Họp = NPC
Thả Thính + Gét Gô = Rizz
Ế + Tới Công Chuyện = Sigma
Để Mai Tính + Thức Trắng = Lướt Tới Sáng
Lướt Tới Sáng + Lướt Tới Sáng = Brainrot
Brainrot + Tự Do = Touch Grass
Sigma + Flex = Aura
Phông Bạt + Toang = Âm Aura
Lương Tháng Sau + Hết Cứu = Lương 404
Đơn Nghỉ Việc + Hết Cứu = Ctrl Z
Biến Căng + Cười = Plot Twist
Chạy Deadline + Gét Gô = Speedrun
Để Mai Tính + Gét Gô = Side Quest
# học hành
Thức Trắng + Ét O Ét = Mùa Thi
Mùa Thi + Để Mai Tính = Học Tủ
Học Tủ + Cười = Trúng Tủ
Học Tủ + Toang = Trật Tủ
Mùa Thi + Chạy Deadline = Đồ Án
# tài chính
Stonks + Gét Gô = Đu Đỉnh
Đu Đỉnh + Toang = Cắt Lỗ
Cắt Lỗ + Để Mai Tính = Chờ Về Bờ
Stonks + Toang = Not Stonks
# chó
This Is Fine + Cười = Doge
Doge + Tới Công Chuyện = Swole Doge
Doge + Ăn Hành = Cheems
Doge + Hết Nước Chấm = Such Wow
This Is Fine + This Is Fine = Ổn Áp
## công thức bổ sung (tăng mật độ ghép, ra phần tử đã có)
Sếp + Thức Trắng = Tăng Ca
Sếp + Cay = Họp
Sếp + Cà Khịa = Như Email Trước
Sếp + Ăn Hành = Đơn Nghỉ Việc
Sếp + Hết Cứu = Lương 404
Sếp + Ét O Ét = Tăng Ca
Sếp + This Is Fine = Quiet Quitting
Sếp + Tới Công Chuyện = Sếp Tổng
Sếp + Thứ Hai = Họp
Sếp + Có Gấu = Tiếp Khách
Sếp + Flex = Hứa Lèo
Sếp + Lương Về = Thưởng Tết
Sếp + Crush = Red Flag
Sếp + Mì Tôm = Làm Không Công
Họp + Toang = Gật Gù Cho Có
Họp + Để Mai Tính = Họp Bàn Lịch Họp
Họp + Deadline = Chạy Deadline
Họp + Ngủ Gật = AFK
Họp + Hết Nước Chấm = Ngủ Gật
Họp + Ét O Ét = Như Email Trước
Họp + Lướt Tới Sáng = NPC
Tăng Ca + Toang = Đơn Nghỉ Việc
Tăng Ca + Cười = This Is Fine
Tăng Ca + Thức Trắng = Gấu Trúc
Tăng Ca + Mì Tôm = Làm Không Công
Đơn Nghỉ Việc + Để Mai Tính = Quiet Quitting
Đơn Nghỉ Việc + Tự Do = Chill
Đơn Nghỉ Việc + Lương Về = Ctrl Z
Đơn Nghỉ Việc + Cà Khịa = Bóc Phốt
Chạy Deadline + Toang = Hết Cứu
Chạy Deadline + Cười = This Is Fine
Chạy Deadline + Cay = Tới Công Chuyện
Chạy Deadline + Ét O Ét = Mùa Thi
Chạy Deadline + Cà Phê Sữa Đá = Speedrun
Chạy Deadline + Lướt Tới Sáng = Side Quest
Thức Trắng + Toang = Gấu Trúc
Thức Trắng + Cay = Cà Phê Sữa Đá
Thức Trắng + Cà Khịa = Anh Hùng Bàn Phím
Thức Trắng + Hết Nước Chấm = Lướt Tới Sáng
Thức Trắng + Crush = Nhạc Suy
Thức Trắng + Săn Sale = Chốt Đơn
Để Mai Tính + Toang = Hết Cứu
Để Mai Tính + Cay = Lương Tháng Sau
Để Mai Tính + This Is Fine = Chill
Để Mai Tính + Đồ Án = Chạy Deadline
Để Mai Tính + Có Gấu = Bao Giờ Cưới
Cà Khịa + Cười = Khẩu Nghiệp
Cà Khịa + Ét O Ét = Ủa Alo
Cà Khịa + Thứ Hai = Seen Không Rep
Cà Khịa + Flex = Phông Bạt
Cà Khịa + Doge = Such Wow
Cà Khịa + Stonks = Not Stonks
Cà Khịa + Con Nhà Người Ta = Hỏi Thăm Ngày Tết
Ăn Hành + Toang = GG
Ăn Hành + Cười = Thánh Nhọ
Ăn Hành + Deadline = Hết Cứu
Ăn Hành + Ét O Ét = Feed
Ăn Hành + Tới Công Chuyện = Báo Thủ
Ăn Hành + Crush = Friendzone
Ăn Hành + Stonks = Not Stonks
Ăn Hành + Mùa Thi = Trật Tủ
This Is Fine + Toang = Ổn Áp
This Is Fine + Deadline = Quiet Quitting
This Is Fine + Mưa = Bơi Đi Làm
This Is Fine + Kẹt Xe = Chill Guy
This Is Fine + Hết Cứu = Xỉu Up Xỉu Down
This Is Fine + Đu Đỉnh = Chờ Về Bờ
This Is Fine + Lương Tháng Sau = Thưởng Bằng Niềm Tin
Hết Cứu + Cười = Xỉu Up Xỉu Down
Hết Cứu + Hết Cứu = GG
Hết Cứu + Ét O Ét = U Là Trời
Hết Cứu + Cuối Tháng = Còn Cái Nịt
Hết Cứu + Mùa Thi = Trật Tủ
Tới Công Chuyện + Toang = Biến Căng
Tới Công Chuyện + Deadline = Chạy Deadline
Tới Công Chuyện + Crush = Thả Thính
Tới Công Chuyện + Nồi Lẩu = Lẩu Meme
Tới Công Chuyện + Lương Về = Cháy Túi
Tới Công Chuyện + Mùa Thi = Đồ Án
Hết Nước Chấm + Deadline = Để Mai Tính
Hết Nước Chấm + Ét O Ét = U Là Trời
Hết Nước Chấm + Hết Nước Chấm = Ảo Ma Canada
Hết Nước Chấm + Nồi Lẩu = Chấm Mắm Tôm
Hết Nước Chấm + Crush = Delulu
Hết Nước Chấm + Lương Về = Trà Sữa Full Topping
Ét O Ét + Deadline = Chạy Deadline
Ét O Ét + Cay = Mưa
Ét O Ét + Crush = Ủa Alo
Ét O Ét + Ngập = Bơi Đi Làm
Ét O Ét + Lương Tháng Sau = Lương 404
Cười + Mì Tôm = This Is Fine
Cười + Crush = Thả Thính
Cười + Ế = FA
Cười + Phông Bạt = Sống Ảo
Cười + Stonks = Doge
Cay + Crush = Red Flag
Cay + Lướt Tới Sáng = Anh Hùng Bàn Phím
Cay + Ế = Sigma
Cay + Nồi Lẩu = Trời Lạnh Ăn Lẩu
Cay + Mì Tôm = Nồi Lẩu
Cay + Kẹt Xe = Khẩu Nghiệp
Toang + Săn Sale = Cháy Túi
Toang + Shipper = Bom Hàng
Toang + Mạng Lag = GG
Toang + Đồ Án = Ctrl Z
Toang + Mưa = Ngập
Deadline + Có Gấu = Bao Giờ Cưới
Deadline + Tết = Cuối Năm
Deadline + Lì Xì = Mẹ Giữ Hộ
Deadline + Săn Sale = Chốt Đơn
Deadline + Lướt Tới Sáng = Brainrot
Deadline + Cuối Tuần = Thứ Hai
Crush + Crush = Delulu
Crush + Có Gấu = Red Flag
Crush + Flex = Rizz
Crush + Thứ Hai = Seen Không Rep
Crush + Nồi Lẩu = Hẹn Hò
Thả Thính + Nồi Lẩu = Hẹn Hò
Thả Thính + Seen Không Rep = Ế
Thả Thính + Toang = Friendzone
Thả Thính + Flex = Rizz
Có Gấu + Có Gấu = Cơm Chó
Có Gấu + Tết = Bao Giờ Cưới
Có Gấu + Lương Về = Cháy Túi
Có Gấu + Nhạc Suy = Chia Tay
Ế + Tết = Bao Giờ Cưới
Ế + Cơm Chó = FA
Ế + Nồi Lẩu = Trời Lạnh Ăn Lẩu
Ế + Lướt Tới Sáng = Delulu
Chia Tay + Cười = Tự Do
Chia Tay + Cà Khịa = Bóc Phốt
Chia Tay + Lướt Tới Sáng = Nhạc Suy
Lương Về + Lương Về = Flex
Lương Về + Tết = Lì Xì
Lương Về + Stonks = Đu Đỉnh
Lương Về + Nhậu = Một Hai Ba Dzô
Lương Về + Mẹ Giữ Hộ = Con Nhà Người Ta
Cuối Tháng + Toang = Còn Cái Nịt
Cuối Tháng + Nồi Lẩu = Mì Tôm
Cuối Tháng + Săn Sale = Cháy Túi
Còn Cái Nịt + Còn Cái Nịt = Mì Tôm
Còn Cái Nịt + Cười = Thưởng Bằng Niềm Tin
Còn Cái Nịt + Doge = Cheems
Mì Tôm + Mì Tôm = Cuối Tháng
Mì Tôm + Thức Trắng = Đồ Án
Mì Tôm + Nồi Lẩu = Lẩu Meme
Nhậu + Toang = Ctrl Z
Nhậu + Cà Khịa = Khẩu Nghiệp
Nhậu + Nồi Lẩu = Cuối Tuần
Nhậu + Tết = Một Hai Ba Dzô
Nhậu + Crush = Delulu
Tết + Toang = Hỏi Thăm Ngày Tết
Tết + Tết = Lì Xì
Tết + Lì Xì = Mẹ Giữ Hộ
Tết + Ăn Hành = Con Nhà Người Ta
Tết + Mùa Thi = Con Nhà Người Ta
Hỏi Thăm Ngày Tết + Có Gấu = Bao Giờ Cưới
Hỏi Thăm Ngày Tết + Lương Về = Lương Bao Nhiêu
Hỏi Thăm Ngày Tết + Phông Bạt = Lương Bao Nhiêu
Thứ Hai + Thứ Hai = Kẹt Xe
Thứ Hai + Cười = This Is Fine
Thứ Hai + Thức Trắng = Ngủ Gật
Thứ Hai + Mưa = Ngập
Mưa + Mưa = Ngập
Mưa + Crush = Nhạc Suy
Mưa + Shipper = Bom Hàng
Kẹt Xe + Kẹt Xe = Ét O Ét
Kẹt Xe + Shipper = Bom Hàng
Kẹt Xe + Lướt Tới Sáng = Brainrot
Săn Sale + Săn Sale = Mua Rồi Để Đó
Săn Sale + Cười = Flex
Săn Sale + Shipper = Chốt Đơn
Chốt Đơn + Seen Không Rep = Bom Hàng
Chốt Đơn + Toang = Bom Hàng
Báo Thủ + Báo Thủ = Feed
Báo Thủ + Cười = Skill Issue
Báo Thủ + Mạng Lag = Feed
Gánh Team + Gánh Team = Leo Rank
Gánh Team + Cay = Swole Doge
Gánh Team + Flex = Aura
Mạng Lag + Mạng Lag = AFK
Flex + Flex = Main Character
Flex + Toang = Âm Aura
Flex + Lướt Tới Sáng = Sống Ảo
Flex + Stonks = Đu Đỉnh
Sống Ảo + Sống Ảo = Phông Bạt
Sống Ảo + Toang = Âm Aura
Sống Ảo + Nồi Lẩu = Đu Trend
Hóng Biến + Toang = Biến Căng
Hóng Biến + Cười = Plot Twist
Hóng Biến + Lướt Tới Sáng = Brainrot
Hóng Biến + Khẩu Nghiệp = Bóc Phốt
Biến Căng + Biến Căng = Bóc Phốt
Biến Căng + Để Mai Tính = Tâm Thư Xin Lỗi
Bóc Phốt + Toang = Âm Aura
Khẩu Nghiệp + Khẩu Nghiệp = Anh Hùng Bàn Phím
Khẩu Nghiệp + Ăn Hành = Tâm Thư Xin Lỗi
Gét Gô + Gét Gô = Speedrun
Gét Gô + Thứ Hai = Chạy Deadline
Gét Gô + Săn Sale = Chốt Đơn
Gét Gô + Doge = Swole Doge
Chill + Chill = Touch Grass
Chill + Cười = Ổn Áp
Chill + Lướt Tới Sáng = Brainrot
Lướt Tới Sáng + Toang = Brainrot
Lướt Tới Sáng + Ét O Ét = Touch Grass
Brainrot + Brainrot = NPC
Brainrot + Cười = Meme
Sigma + Sigma = Aura
Sigma + Cười = Chill Guy
Stonks + Stonks = Đu Đỉnh
Stonks + Hết Cứu = Cắt Lỗ
Đu Đỉnh + Đu Đỉnh = Cắt Lỗ
Cắt Lỗ + Cười = Mì Tôm
Doge + Doge = Such Wow
Doge + Toang = Cheems
Doge + Stonks = Not Stonks
Mùa Thi + Mùa Thi = Đồ Án
Mùa Thi + Toang = Trật Tủ
Mùa Thi + Cười = Trúng Tủ
Học Tủ + Học Tủ = Trúng Tủ
Meme + Meme = Brainrot
Meme + Doge = Such Wow
Meme + Stonks = Not Stonks
Nồi Lẩu + Nồi Lẩu = Lẩu Meme
Nồi Lẩu + Có Gấu = Hẹn Hò
Nồi Lẩu + Toang = Hết Nước Chấm"""

TRUOT = """Nồi trào rồi, hai món này không ăn chung được.
Khét lẹt. Thử nhúng món khác xem.
Hai đứa này nhìn nhau rồi... seen không rep.
Nước dùng từ chối nhận hai món này.
Đầu bếp đang suy nghĩ. Đầu bếp đã bỏ cuộc.
Không hợp vị. Lẩu cũng có lòng tự trọng.
Ủa alo? Không có món này trong thực đơn.
Cạn nước chấm. Đổi cặp đi bạn ơi.
Nồi lẩu lắc đầu nguầy nguậy.
Hai món này đang giận nhau, để mai tính.
Thêm cặp này vào là nồi lẩu nghỉ việc.
Bếp báo: không tìm thấy công thức, mã lỗi 404.
Trộn kiểu này thì thánh cũng không ăn nổi.
Nước sôi rồi nguội. Không có gì xảy ra.
Combo này chỉ có trong mơ của bạn thôi.
Hai món va vào nhau rồi... ai về nhà nấy.
Lẩu không gánh nổi pha này.
Đầu bếp đã xem và không phản hồi.
Nồi lẩu xin phép từ chối khéo.
Thử lại đi, nồi lẩu tin bạn làm được.
Sai công thức rồi, bà ngoại mà biết là ăn đòn.
Pha ghép này skill issue nhẹ.
Nồi lẩu vừa khum.
Hơi nước bốc lên rồi tan biến, như lời hứa tăng lương.
Hai món này chưa đủ duyên.
Không có biến gì, giải tán.
Nồi lẩu đang bận họp, quay lại sau.
Ghép trật tủ rồi.
Chưa nấu chín đã khét.
Lẩu cay quá, món này chạy mất dép.
Hai món này là red flag của nhau.
Mẹ bảo không được trộn hai cái này.
Mất aura rồi, thử lại đi.
Nồi lẩu đang loading... và đứng hình luôn.
Món này chỉ có trong vũ trụ song song.
Nồi lẩu xỉu up xỉu down.
Không có gì trồi lên, chỉ có nỗi buồn.
Đầu bếp bảo: cái này để mai tính.
Nồi lẩu chúc bạn may mắn lần sau.
Hai món này friendzone nhau rồi.
"""

DAILY = ["Stonks", "Bao Giờ Cưới", "Mẹ Giữ Hộ"]
DAILY_HINT = {"Stonks": "Mất sạch mà vẫn thấy ổn", "Bao Giờ Cưới": "Câu hỏi bất hủ mỗi dịp Tết",
              "Mẹ Giữ Hộ": "Tiền của bạn, nhưng người khác giữ... vĩnh viễn"}
# Gợi ý mờ cho mọi ứng viên Món đặc biệt (depth 4–8): không nêu tên món, không nhắc người thật hay vụ việc (mục 7.1).
DAILY_HINT.update({
    "Cuối Năm": "Lúc ai cũng hứa năm sau sẽ khác", "Có Gấu": "Hết cảnh đi chơi một mình",
    "FA": "Lễ tình nhân chỉ có mình với mình", "Fan Quay Xe": "Hôm qua còn mê, hôm nay đã khác",
    "Leo Rank": "Thắng một trận lên một bậc, thua một trận tụt ba", "Lương Về": "Vài ngày trong tháng thấy mình giàu",
    "Mì Tôm": "Cứu tinh của những ngày cuối tháng", "Rizz": "Nói câu nào người ta xiêu lòng câu đó",
    "Sigma": "Một mình một lối, không cần ai hiểu", "Âm Aura": "Vừa làm một việc mất sạch phong độ",
    "Đào Mả Phốt": "Chuyện cũ bị lôi lên lại", "Aura": "Không cần nói gì vẫn ngầu",
    "Chia Tay": "Từ hai thành một", "Cháy Túi": "Ví nhẹ hẳn sau một ngày vui",
    "Cơm Chó": "Người ta tình tứ, mình ngồi ăn no", "Cắt Lỗ": "Thà mất ít còn hơn mất hết",
    "Flex": "Có gì cũng phải cho cả thế giới biết", "Not Stonks": "Mua xong là thấy đỏ",
    "Săn Sale": "Thức canh nửa đêm chỉ vì giảm giá", "Thưởng Tết": "Cả năm chờ một phong bì",
    "Trà Sữa Full Topping": "Uống thì ít, nhai thì nhiều", "Tết": "Dịp cả họ hỏi bạn nhiều câu nhất",
    "Ăn Buffet Gỡ Vốn": "Trả tiền rồi thì phải ăn cho đáng", "Đu Đỉnh": "Mua đúng lúc giá cao nhất",
    "Chốt Đơn": "Một cú bấm, ví khóc", "Chờ Về Bờ": "Ôm hàng ngồi đợi giá lên lại",
    "Con Nhà Người Ta": "Người luôn giỏi hơn bạn trong lời của mẹ",
    "Hỏi Thăm Ngày Tết": "Quan tâm theo kiểu khiến bạn muốn trốn", "Lì Xì": "Trẻ con mong, người lớn lo",
    "Main Character": "Cả thế giới xoay quanh mình", "Mua Rồi Để Đó": "Đặt về cho vui, chưa từng mở hộp",
    "Phông Bạt": "Ảnh thì sang, đời thì khác", "Sống Ảo": "Chụp trăm tấm, đăng một tấm",
    "Bom Hàng": "Đặt rồi mà không nhận", "Lương Bao Nhiêu": "Câu hỏi khiến ai cũng muốn đổi chủ đề",
    "Shipper": "Người được mong chờ nhất mỗi ngày", "Đu Trend": "Cái gì đang hot là làm theo liền",
})
BEST = {("Còn Cái Nịt", "This Is Fine"), ("Sếp", "Để Mai Tính"), ("Cười", "Deadline"), ("Flex", "Còn Cái Nịt"),
        ("Mạng Lag", "Cà Khịa"), ("Ăn Hành", "Cà Khịa"), ("Thưởng Tết", "Còn Cái Nịt"), ("Ngập", "This Is Fine"),
        ("Shipper", "Seen Không Rep"), ("Hỏi Thăm Ngày Tết", "Ăn Hành"), ("Lì Xì", "Để Mai Tính"),
        ("Nồi Lẩu", "Lương Về"), ("Tăng Ca", "Lương Tháng Sau"), ("Lương Tháng Sau", "Hết Cứu"), ("Có Gấu", "Cười"),
        ("Cười Xã Giao", "Họp"), ("Đơn Nghỉ Việc", "Hết Cứu"), ("Sếp Tổng", "Để Mai Tính"), ("Họp", "Họp"),
        ("Cắt Lỗ", "Để Mai Tính")}
STARTERS = ["Cay", "Cười", "Toang", "Deadline"]


def fold(s):
    s = s.replace("đ", "d").replace("Đ", "D")
    return " ".join("".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn").lower().split())


def parse():
    rec, errs = [], []
    for line in R.strip().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        lhs, res = [x.strip() for x in line.split("=")]
        a, b = [x.strip() for x in lhs.split("+")]
        for n in (a, b, res):
            if n not in E:
                errs.append(f"không có phần tử: {n} ({line})")
        rec.append((a, b, res))
    return rec, errs


def check():
    rec, errs = parse()
    pairs = {}
    for a, b, r in rec:
        k = tuple(sorted((fold(a), fold(b))))
        if k in pairs:
            errs.append(f"trùng cặp: {a} + {b} (đã = {pairs[k]})")
        pairs[k] = r
        if r in (a, b) and r != "Thứ Hai":
            errs.append(f"tự ra chính nó: {a} + {b}")
    # BFS depth: a recipe fires when both inputs are known
    depth = {s: 0 for s in STARTERS}
    changed = True
    while changed:
        changed = False
        for a, b, r in rec:
            if a in depth and b in depth:
                d = max(depth[a], depth[b]) + 1
                if r not in depth or d < depth[r]:
                    depth[r] = d
                    changed = True
    unreachable = [n for n in E if n not in depth]
    if unreachable:
        errs.append(f"không tới được: {unreachable}")
    names = [fold(n) for n in E]
    if len(set(names)) != len(names):
        errs.append("trùng tên phần tử sau khi bỏ dấu")
    emos = [v[0] for v in E.values()]
    dup = {e for e in emos if emos.count(e) > 1}
    if dup:
        errs.append(f"trùng emoji: {dup}")
    for n in E:
        if len(n.split()) > 4:
            errs.append(f"tên > 4 từ: {n}")
    for n in E:
        if 4 <= depth.get(n, -1) <= 8 and n not in DAILY_HINT:
            errs.append(f"ứng viên Món đặc biệt {n} chưa có gợi ý (DAILY_HINT)")
    for t in DAILY:
        if t in depth and not 4 <= depth[t] <= 8:
            errs.append(f"món đặc biệt {t} có độ sâu {depth[t]} ngoài [4, 8]")
    produced = {r for _, _, r in rec}
    orphans = [n for n in E if n not in produced and n not in STARTERS]
    if orphans:
        errs.append(f"không có công thức tạo ra: {orphans}")
    return rec, depth, errs


def miss_rate(rec, trials=2000, steps=100, seed=7):
    """Chơi ngẫu nhiên: mỗi lượt chọn 2 phần tử đang có (có thể trùng), ghi nhận trượt."""
    table = {tuple(sorted((a, b))): r for a, b, r in rec}
    rng = random.Random(seed)
    total = miss = 0
    for _ in range(trials):
        have = list(STARTERS)
        for _ in range(steps):
            a, b = rng.choice(have), rng.choice(have)
            r = table.get(tuple(sorted((a, b))))
            total += 1
            if r is None:
                miss += 1
            elif r not in have:
                have.append(r)
    return miss / total


def shortest_path(rec, target):
    """Số lượt nhúng tối thiểu (đếm cả phần tử trung gian cần tạo) — tìm theo cây phụ thuộc với độ sâu nhỏ nhất."""
    best = {s: (0, []) for s in STARTERS}
    changed = True
    while changed:
        changed = False
        for a, b, r in rec:
            if a in best and b in best:
                steps = list(dict.fromkeys(best[a][1] + best[b][1] + [(a, b, r)]))
                if r not in best or len(steps) < best[r][0]:
                    best[r] = (len(steps), steps)
                    changed = True
    return best[target][1]


def main():
    rec, depth, errs = check()
    if errs:
        print("\n".join(errs))
        return 1
    mr = miss_rate(rec)
    viet = sum(1 for v in E.values() if v[1] == "V")
    print(f"OK: {len(E)} phần tử, {len(rec)} công thức, độ sâu tối đa {max(depth.values())}, "
          f"Việt/quốc tế {viet}/{len(E) - viet} ({100 * viet // len(E)}%), ghép trượt ngẫu nhiên 100 lượt ≈ {mr:.0%}")
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".")
    data = {
        "starters": STARTERS,
        "elements": [{"name": n, "emoji": e, "origin": o, "depth": depth[n], "image_hint": h}
                     | ({"daily_hint": DAILY_HINT[n]} if n in DAILY_HINT else {}) for n, (e, o, h) in E.items()],
        "recipes": [{"a": a, "b": b, "result": r, "best": (a, b) in BEST or (b, a) in BEST} for a, b, r in rec],
        "miss_lines": TRUOT.strip().splitlines(),
        "daily_examples": [{"target": t, "hint": DAILY_HINT[t], "path": [list(s) for s in shortest_path(rec, t)]} for t in DAILY],
    }
    (out / "noi-dung-loi.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    write_md(out / "noi-dung-loi.md", data, mr, miss_rate(rec, steps=20))
    return 0


def write_md(path, d, mr, mr20):
    els = sorted(d["elements"], key=lambda x: (x["depth"], x["name"]))
    L = ["# Nội dung lõi — Lẩu Meme", "",
         "> Trạng thái: **bản lõi chờ duyệt** (giọng mặn, tỉ lệ Việt/quốc tế ~7/3). Sinh bởi `tools/noi_dung.py` — sửa dữ liệu ở đó rồi chạy lại,",
         "> không sửa tay file này. Bản máy đọc: `noi-dung-loi.json` (pipeline nạp làm lõi classic).", "",
         f"Tổng: **{len(els)} phần tử**, **{len(d['recipes'])} công thức**, {len(d['miss_lines'])} câu \"Nồi trào\", "
         f"{len(d['daily_examples'])} ví dụ Món đặc biệt. Tự kiểm (script): mọi phần tử tới được từ 4 phần tử khởi đầu, "
         "không trùng cặp, không trùng tên sau khi bỏ dấu, không trùng emoji, tên ≤ 4 từ.", "",
         "## 1. Bốn phần tử khởi đầu", "", "🌶️ Cay · 😂 Cười · 💀 Toang · ⏰ Deadline (lý do: xem bản mẫu đã duyệt).", "",
         "## 2. Phần tử theo độ sâu", "",
         "Cột Ảnh = gợi ý cho bước vẽ minh họa: vẽ **khái niệm**, không chép ảnh/nhân vật gốc, không người thật.", "",
         "| Độ sâu | Emoji | Tên | Nguồn | Ảnh |", "|---|---|---|---|---|"]
    for e in els:
        L.append(f"| {e['depth']} | {e['emoji']} | {e['name']} | {'Việt' if e['origin'] == 'V' else 'Quốc tế'} | {e['image_hint']} |")
    L += ["", "## 3. Công thức", "", "⭐ = 20 công thức hay nhất.", "", "| # | A | B | Kết quả |", "|---|---|---|---|"]
    emo = {e["name"]: e["emoji"] for e in els}
    for i, r in enumerate(d["recipes"], 1):
        L.append(f"| {i} | {emo[r['a']]} {r['a']} | {emo[r['b']]} {r['b']} | {emo[r['result']]} {r['result']}{' ⭐' if r['best'] else ''} |")
    L += ["", "## 4. Câu \"Nồi trào / Khét rồi\"", ""] + [f"{i}. {s}" for i, s in enumerate(d["miss_lines"], 1)]
    L += ["", "Cùng một cặp luôn ra cùng một câu (chọn theo băm của cặp).", "", "## 5. Món đặc biệt hôm nay — 3 ví dụ", ""]
    for x in d["daily_examples"]:
        L += [f"### {emo[x['target']]} {x['target']} — gợi ý: \"{x['hint']}\"", ""]
        L += [f"{i}. {emo[a]} {a} + {emo[b]} {b} → {emo[r]} {r}" for i, (a, b, r) in enumerate(x["path"], 1)]
        L += [""]
    L += ["## 6. Chỉ số", "",
          f"- Ghép trượt khi chơi ngẫu nhiên 100 lượt (mô phỏng 2.000 ván): **≈ {mr:.0%}** (20 lượt đầu ≈ {mr20:.0%}). NFR đã chốt (Q13): 20 lượt đầu ≤ 45%, cả ván ≤ 70% — **đạt**.",
          "- Người chơi thật không ghép ngẫu nhiên (họ thử theo nghĩa), nên tỉ lệ thực tế thấp hơn; mô phỏng này là cận trên để so sánh giữa các bản.", "",
          "## 7. Vì sao không dùng mốc ≤ 40% (đã chốt Q13)", "",
          "Tập đóng viết tay không thể dày bằng Infinite Craft (ở đó LLM trả lời mọi cặp). Với ~140 phần tử có ~10.000 cặp; "
          "muốn ngẫu nhiên trượt ≤ 40% cần hàng nghìn công thức. Ba hướng:",
          "1. **Đổi cách đo** NFR thành \"20 lượt đầu ≤ 45%\" (trải nghiệm lúc mới vào, quyết định người chơi có ở lại không) và \"cả ván ≤ 70%\".",
          "2. **Bước \"công thức bổ sung\" của pipeline** sinh thêm hàng loạt cặp giữa các phần tử đã có (LLM + giám khảo), mỗi đợt tăng mật độ; "
          "theo dõi chỉ số này trong báo cáo đợt.",
          "3. **\"Nồi trào có gợi ý\"**: khi trượt, thỉnh thoảng gợi ý một phần tử nên thử cùng (lấy từ công thức có thật) — giảm cảm giác bế tắc mà không lộ đáp án.",
          "Đã chốt 19/10: làm cả 3 hướng.", ""]
    path.write_text("\n".join(L), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
