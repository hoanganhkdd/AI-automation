# 🚀 Hướng dẫn Deploy

App này **cần một host chạy được Node.js** (có server). **KHÔNG** dùng được Netlify hay GitHub Pages vì chúng chỉ phục vụ file tĩnh, không chạy backend Express/API.

Gợi ý: **Render** (có gói free), Railway, Fly.io, hoặc VPS.

## Cách 1 — Render (Blueprint, dễ nhất)
1. Đẩy code lên GitHub (xem cuối file).
2. Vào https://render.com → **New +** → **Blueprint** → chọn repo. Render đọc `render.yaml` tự tạo web service.
3. Sau khi tạo, vào **Environment** đặt biến `OPENAI_API_KEY` = key của bạn (không commit key vào Git).
4. Deploy. Health check tại `/healthz`.

### Lưu ý gói Free của Render
- Service **ngủ sau ~15 phút** không dùng, lần gọi kế tiếp mất **~50s** để thức dậy (cold start). App đã tự động thử lại + reload để chịu được điều này.
- Ổ đĩa gói free là **tạm** → dữ liệu **thêm sau khi deploy** (tài liệu upload, tiến độ) sẽ **mất khi service restart/redeploy**. Giáo án seed vẫn còn vì nằm trong code.

### Giữ dữ liệu lâu dài (gói trả phí)
Trong `render.yaml`, bỏ chú thích phần **disk** và biến **DATA_DIR** (vd `/var/data`). Server sẽ tự copy seed sang đĩa và lưu dữ liệu bền vững ở đó.

## Cách 2 — Railway / Fly / VPS
- Railway: New Project → Deploy from GitHub → đặt env `OPENAI_API_KEY`. Start command `npm start`.
- VPS: `git clone` → `npm install` → đặt `OPENAI_API_KEY` → `npm start` (nên chạy qua `pm2`/systemd, đặt Nginx reverse proxy).

## Biến môi trường
| Biến | Ý nghĩa |
|---|---|
| `OPENAI_API_KEY` | Key OpenAI cho tính năng AI (bắt buộc để dùng AI) |
| `OPENAI_MODEL` | Model mặc định (vd `gpt-4o-mini`) |
| `PORT` | Cổng (host tự đặt) |
| `DATA_DIR` | Thư mục lưu dữ liệu bền vững (khi gắn Disk) |

## Đẩy code lên GitHub
```bash
git init
git add .
git commit -m "AI Automation Academy"
git branch -M main
git remote add origin https://github.com/hoanganhkdd/AI-automation.git
git push -u origin main
```
