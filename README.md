# 🎓 AI Automation Academy

App học tập **song ngữ Việt–Anh** với giáo án **AI Automation** (4 module) + **tin tức AI cập nhật mỗi ngày**, tích hợp **trợ lý AI (OpenAI)**, **đọc to (TTS)**, **kiểm tra/thi**, và **thư viện tài liệu**. Backend Node/Express, frontend vanilla JS, lưu file JSON — không cần database, không build step.

## ✨ Tính năng chính
- **Giáo án 4 module × 4 bài** (Nền tảng AI & Agent · Automation với Claude Code & Antigravity · Tự động hoá công việc văn phòng · Workflow automation nâng cao), mỗi bài nhiều slide: khái niệm, quy trình, kỹ thuật, ví dụ, thực hành, lỗi thường gặp, thuật ngữ.
- **📰 Tin tức AI Automation mỗi ngày**: tổng hợp RSS (TechCrunch, VentureBeat, The Verge, OpenAI, Google, Zapier, Hugging Face…), lọc theo AI/automation, tự cập nhật mỗi giờ, đánh dấu **tin MỚI** kể từ lần xem trước (nút 📰 Tin AI trên thanh trên).
- **🌐 Song ngữ đồng thời** (có nút **Bật/Tắt** trên thanh trên): tin tức hiển thị bản dịch **Việt** dưới bản gốc Anh; nội dung **bài học** hiển thị bản **Anh** dưới mỗi dòng Việt. Tắt song ngữ → chỉ hiện ngôn ngữ gốc (tin=Anh, bài học=Việt) cho gọn. Dịch nền bằng **OpenAI** khi có key (ổn định, dịch theo lô), dự phòng Google/MyMemory khi chưa có key; bản dịch được **cache ra file** để dùng lại.
- **🎧 Đọc to (TTS)**: nghe từng bài (chế độ ngồi xe, tự chuyển bài) hoặc **nghe toàn bộ phần Đào sâu** (bài học + ví dụ + công cụ + video + thực hành + hỏi AI). Mini-player chỉnh tốc độ, chọn giọng vi-VN.
- **🧠 Đào sâu (AI)**: gợi ý ví dụ thực tế, công cụ/website, **video liên quan**, bài tập — kèm URL nguồn thật (web_search). Mỗi kết quả **💾 Lưu** vào Kho kiến thức **và** Thư viện.
- **📚 Thư viện**: thêm text/PDF/ảnh/YouTube/Reel FB/link, gắn tag, **✨ Rút insight** (Tóm tắt / Bài học chính / Áp dụng ngay), xuất .md.
- **📝 Kiểm tra**: nhanh theo bài, theo module, **tổng kết toàn khoá** (trắc nghiệm + tự luận, AI chấm tự luận). Kết quả **lưu vào thư viện**.
- **🔁 Nhắc ôn lại**: bài đã học quá 3 ngày / chưa kiểm tra / điểm < 7 sẽ hiện ở trang chủ.
- **🎯 Mục tiêu học + ⏱️ timer + 🔥 streak**, đồng bộ đa thiết bị qua server.
- **➕ CRUD giáo án** ngay trong app: thêm/xoá module, bài học, slide.

## 📓 Tích hợp NotebookLM (tóm tắt toàn văn nguồn)
Ở trang **📰 Tin AI**: tích chọn vài tin → **📓 Tóm tắt bằng NotebookLM**. App gọi CLI [notebooklm-py](https://github.com/teng-lin/notebooklm-py) để **tạo notebook → nạp URL các tin làm nguồn → NotebookLM đọc TOÀN VĂN bài báo → tóm tắt tiếng Việt kèm trích dẫn nguồn**, rồi trả về ngay trong app (kèm link mở notebook để tạo podcast/mind map/quiz).

Yêu cầu (chỉ nơi chạy được CLI — thường là máy cá nhân, **không** phải Render free vốn là Node):
```bash
pip install "notebooklm-py[browser]"
notebooklm login          # đăng nhập Google 1 lần (mở trình duyệt)
notebooklm auth check --test   # kiểm tra
```
Từ kết quả tóm tắt, có thể bấm **🧠 Tạo mind map** (nhanh, hiện cây kiến thức ngay) và **🎙️ Tạo podcast** (NotebookLM dựng audio ~10–20 phút, app tự kiểm tra và cho nghe/tải .m4a khi xong).

**Bài học cũng có NotebookLM:** trong tab **🧠 Đào sâu** của mỗi bài có panel **📓 NotebookLM** với nút **🧠 Mind map** và **🎙️ Podcast** — NotebookLM đọc toàn văn nội dung bài học rồi tạo sơ đồ tư duy / podcast tiếng Việt.

Nếu chưa cài/đăng nhập, nút sẽ tự **mờ đi** kèm hướng dẫn — các tính năng khác không ảnh hưởng.

## 📚 Thư viện tài liệu + Google Sheet/Drive
Mỗi bài có tab **📚 Thư viện**: thêm **Text · Ảnh (chọn/dán nhiều) · PDF · YouTube · FB Reel · Link**, ghi chú **dán/kéo-thả ảnh** (tự upload, hiện inline, bấm xem lớn), tìm kiếm + lọc loại, **🗂️ Thư viện chung** (xem toàn bộ + lọc theo bài học), ⬇️ Xuất .md.

**Đồng bộ Google Sheet + Drive (miễn phí, không cần service account):**
1. Mở [google-apps-script.gs](google-apps-script.gs) → làm theo hướng dẫn đầu file (Tạo Sheet → Apps Script → Deploy Web app → cấp quyền Drive).
2. Copy URL `.../exec` → đặt env **`GSHEET_WEBHOOK_URL`** (và **`PUBLIC_URL`** = domain app để link ảnh/PDF đầy đủ). Xem [.env.example](.env.example).
3. Thêm tài liệu → tự ghi 1 dòng vào Sheet; ảnh được đẩy lên Drive (folder theo `module - bài học`) và hiện thumbnail trong Sheet. Nút **🔄 Đồng bộ tất cả** ghi lại toàn bộ (không trùng, ảnh không nhân bản).

## ▶️ Chạy trên máy
```bash
npm install
npm start
```
Mở: http://localhost:3000 (nếu cổng bận, đặt `PORT=3100 npm start`).

## 🤖 Bật AI
Các tính năng AI cần **OpenAI API key**. Mở **⚙️ Cài đặt** trong app → dán key → chọn model (mặc định `gpt-4o-mini`).
Hoặc đặt biến môi trường `OPENAI_API_KEY` (khuyên dùng khi deploy). **Không** hard-code, **không** commit key.

## 🗂️ Cấu trúc
```
server/server.js            # toàn bộ API + proxy OpenAI + trích xuất nội dung
server/data/                # curriculum.json, library.json (seed) + knowledge/settings/state (tự sinh) + uploads/
public/index.html
public/css/style.css
public/js/slides.js         # render slide + TTS text
public/js/app.js            # SPA: routing, tabs, TTS, quiz, thư viện, AI, đồng bộ
render.yaml, Procfile, .nvmrc, DEPLOY.md
```

## 🔌 API
| Method | Endpoint | Chức năng |
|---|---|---|
| GET | /api/curriculum | Lấy giáo án |
| POST/DELETE | /api/curriculum/sessions[/:id] | Thêm/xoá bài học |
| POST/DELETE | /api/curriculum/sessions/:id/slides[/:n] | Thêm/xoá slide |
| GET/POST/DELETE | /api/resources[/:id] | Thư viện tài liệu (lọc `?session=&type=&q=`, sắp mới nhất) |
| POST | /api/resources/upload | Upload PDF/ảnh (≤50MB) |
| POST | /api/upload-image | Lưu 1 ảnh, trả `{url}` (dán ảnh vào ghi chú) |
| GET · POST | /api/gsheet/status · /api/gsheet/sync-all | Đồng bộ Thư viện lên Google Sheet + Drive |
| GET/POST/DELETE | /api/knowledge[/:id] | Kho kiến thức |
| POST | /api/knowledge/generate | AI sinh ví dụ/công cụ/video/thực hành |
| GET/POST | /api/state | Đồng bộ tiến độ/kế hoạch/timer/ôn tập |
| POST | /api/quiz/generate · /api/quiz/grade | Sinh đề · chấm tự luận |
| POST | /api/chat · /api/insight | Coach AI · rút insight tài liệu |
| GET/POST | /api/settings | Key + model |
| GET | /api/news · POST /api/news/refresh | Tin tức AI (RSS, tự lọc & cập nhật) |
| GET | /healthz | Kiểm tra sống |

## 🚀 Deploy
Xem [DEPLOY.md](DEPLOY.md). Cần host **chạy Node** (Render/Railway/Fly/VPS). **Không** dùng Netlify/GitHub Pages (chỉ tĩnh).
