# Vault Organizer

Tool web nhỏ để sắp xếp lại file export JSON của Vaultwarden/Bitwarden bằng kéo thả, rồi xuất ra file JSON import lại được.

Toàn bộ xử lý chạy trong trình duyệt. nginx chỉ phục vụ file tĩnh, CSP chặn mọi kết nối ra ngoài (`connect-src 'none'`), không có gì được lưu lên server hay vào ổ đĩa.

## Chạy

```bash
docker compose up -d --build     # mở http://127.0.0.1:8088
docker compose down              # tắt
```

Đang bind `0.0.0.0:8088` (truy cập được từ máy khác). Chỉ muốn dùng trên máy này thì đổi `ports` thành `127.0.0.1:8088:80`. Qua HTTP không phải localhost thì nút copy vẫn chạy (có fallback), nhưng nên đặt sau HTTPS.

## Dùng

1. Vaultwarden → Tools → **Export vault** → định dạng `.json` (không mã hóa). Hỗ trợ cả export Organization (collections) và cá nhân (folders).
2. Mở file trong tool (nút **Mở file** hoặc kéo file vào trang).
3. Sắp xếp:
   - Kéo item thả vào collection (hoặc thả lên một item khác trong collection đó) để **chuyển**.
   - Giữ `Ctrl` (hoặc `Alt`) khi thả để **thêm** item vào collection đó mà vẫn giữ chỗ cũ. Badge `×2`, `×3` cho biết item đang nằm ở mấy nơi. Bỏ bớt ở phần "Collection" trong màn sửa item.
   - Kéo collection vào collection khác để lồng vào; thả lên dòng `⤒` trên cùng để đưa lên cấp cao nhất. Nếu trùng tên, tool sẽ hỏi có gộp không.
   - `Ctrl` + click để chọn nhiều item, rồi kéo hoặc dùng "Chuyển tới…" ở khung bên phải.
   - Khi kéo, đường ngang chỉ vị trí item/collection sẽ nằm sau khi thả (đã tính theo thứ tự tên A→Z), nhãn bên phải cho biết thả vào đâu.
   - Click phải vào item / collection để mở menu: nhân bản, copy username/mật khẩu, bỏ khỏi collection, tạo mới, đổi tên, giải thể, **xóa ngay** (không hỏi lại — dùng "Hoàn tác" trên thông báo hoặc `Ctrl+Z` nếu lỡ tay).
   - **⊞ Mở hết / ⊟ Thu hết** trên thanh công cụ cho cả cây; với một nhánh: click phải vào collection → "Mở hết bên trong" / "Thu gọn bên trong", hoặc `Alt` + click vào mũi tên.
   - Click vào item hoặc collection để sửa (tên, username, password, TOTP, URL, ghi chú, custom field, JSON thô…).
   - `Ctrl+Z` / `Ctrl+Y` để hoàn tác / làm lại, `/` để tìm, `Ctrl+S` để xuất, `Delete` để xóa item/collection đang chọn (có hỏi lại), `F2` để đổi tên collection.
4. **Xuất JSON**, rồi import file đó vào Vaultwarden (Tools → Import data → định dạng "Bitwarden (json)").

Vaultwarden luôn hiển thị theo tên A→Z, nên tool cũng sắp xếp như vậy. Thứ tự kéo thả trong cùng một cấp không có ý nghĩa. Muốn ép thứ tự thì đặt tiền tố, ví dụ `01 - Production`.

## Lưu ý khi import lại

Import của Vaultwarden luôn **tạo mới** item, không ghi đè. Vì vậy:

- Nên import vào **Organization trống** (tạo org mới, hoặc xóa hết item và collection cũ trước). Nếu không, mỗi item sẽ bị nhân đôi.
- Nên để bật tùy chọn **"Tạo ID mới cho collection"** (mặc định). Nếu ID collection đã tồn tại trong org, Vaultwarden sẽ dùng lại collection cũ với **tên cũ**, nên việc đổi tên hoặc di chuyển collection sẽ không có tác dụng.
- Item không thuộc collection nào sẽ nằm trong mục "Unassigned" của org.
- File export chứa mật khẩu không mã hóa. Xóa file sau khi import xong.

## Cấu trúc

```
public/core.js     logic dữ liệu (parse / cây / di chuyển / export), không phụ thuộc DOM
public/app.js      giao diện: cây, kéo thả, màn sửa, undo
public/index.html, style.css
test/core.test.js  node test/core.test.js [file.json]  — kiểm tra round-trip và các thao tác
test/sample.json   dữ liệu giả để test
```

Sửa code trong `public/` xong thì chạy `docker compose up -d --build` để cập nhật.
