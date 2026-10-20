# Gantt - ƯỚC LƯỢNG - LẨU MEME

Tiến độ 0% · nghiệm thu KH 2027-11-23 · dự báo 2027-12-07. Bản tương tác: `gantt.html`.

```mermaid
gantt
    title ƯỚC LƯỢNG - LẨU MEME
    dateFormat YYYY-MM-DD
    excludes weekends, 2027-01-01, 2027-02-04, 2027-02-05, 2027-02-06, 2027-02-07, 2027-02-08, 2027-02-09, 2027-02-10, 2027-04-30, 2027-05-01, 2027-09-02, 2028-01-01
    todayMarker stroke-width:2px,stroke:#d33
    section Nền tảng
    NEN Khởi tạo dự án & hạ tầng (0%) :NEN, 2026-10-20, 7d
    section Nội dung
    SEED Nạp lõi nội dung classic (0%) :SEED, 2026-10-29, 7d
    GRAPH Graph mã hóa + manifest + rollback (0%) :GRAPH, 2026-11-09, 14d
    section Trò chơi
    GAME Chơi ghép (Nhúng lẩu) (0%) :GAME, 2026-11-27, 27d
    section Nội dung
    PIPE Pipeline Mẻ nhúng - chế độ lõi (giai đoạn 1) (0%) :PIPE, 2027-01-06, 11d
    section Vận hành
    PRIV Chính sách quyền riêng tư (0%) :PRIV, 2027-01-21, 14d
    section Cộng đồng
    DISC Công thức gia truyền (0%) :DISC, 2027-02-17, 15d
    section Trò chơi
    DAILY Món đặc biệt hôm nay (0%) :DAILY, 2027-03-10, 20d
    section Cộng đồng
    SHARE Thẻ chia sẻ (0%) :SHARE, 2027-04-07, 9d
    section An toàn
    REPORT Báo cáo + chặn nóng (0%) :REPORT, 2027-04-20, 13d
    ADMIN Trang quản trị tối giản (0%) :ADMIN, 2027-05-10, 14d
    section Vận hành
    METRIC Đo chỉ số thành công (0%) :METRIC, 2027-05-28, 10d
    section Kiểm thử
    INV Bất biến nội dung và trò chơi (0%) :INV, 2027-06-11, 14d
    section Nền tảng
    SUBPATH Chạy dưới đường dẫn con dinoduct.fun/lau-meme (0%) :SUBPATH, 2027-07-01, 9d
    section Kiểm thử
    UAT Kiểm thử nghiệm thu & sửa lỗi (giai đoạn 1) (0%) :crit, UAT, 2027-07-14, 26d
    section Nội dung
    MOD Kiểm duyệt nội dung tự động (giai đoạn 2) (0%) :crit, MOD, 2027-08-19, 20d
    PIPE2 Pipeline Mẻ nhúng - crawl và tự động đăng (giai đoạn 2) (0%) :crit, PIPE2, 2027-09-17, 31d
    ART Ảnh minh họa tự tạo (giai đoạn 2) (0%) :crit, ART, 2027-11-01, 16d
    section Kiểm thử
    UAT2 Kiểm thử nghiệm thu & sửa lỗi (giai đoạn 2) (0%) :crit, UAT2, 2027-11-23, 10d
    section Bàn giao
    UAT 0 tuần :uat, 2027-12-07, 0d
    Nghiệm thu :milestone, 2027-12-07, 0d
```
