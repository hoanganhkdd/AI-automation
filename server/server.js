import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SEED_DIR = path.join(__dirname, "data");
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : SEED_DIR;
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const PUBLIC_DIR = path.join(ROOT, "public");

const PORT = process.env.PORT || 3000;

// ---------- Chống crash-loop: chỉ log, không thoát ----------
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));

// ---------- Chuẩn bị thư mục dữ liệu (tự copy seed nếu DATA_DIR trống) ----------
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  // Copy các file seed (curriculum.json, library.json) nếu DATA_DIR khác seed và còn trống
  if (DATA_DIR !== SEED_DIR) {
    for (const f of ["curriculum.json", "library.json"]) {
      const dst = path.join(DATA_DIR, f);
      const src = path.join(SEED_DIR, f);
      if (!fs.existsSync(dst) && fs.existsSync(src)) fs.copyFileSync(src, dst);
    }
  }
}
ensureDataDir();

const FILES = {
  curriculum: path.join(DATA_DIR, "curriculum.json"),
  library: path.join(DATA_DIR, "library.json"),
  knowledge: path.join(DATA_DIR, "knowledge.json"),
  settings: path.join(DATA_DIR, "settings.json"),
  state: path.join(DATA_DIR, "state.json"),
};

function readJSON(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.warn("read fail", file, e.message); }
  return fallback;
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

// Khởi tạo file mặc định nếu thiếu
if (!fs.existsSync(FILES.curriculum)) writeJSON(FILES.curriculum, { meta: { title: "AI AUTOMATION", subtitle: "", source: "", modules: 0, sessions: 0, updated: Date.now() }, sessions: [] });
if (!fs.existsSync(FILES.library)) writeJSON(FILES.library, { resources: [] });
if (!fs.existsSync(FILES.knowledge)) writeJSON(FILES.knowledge, { items: [] });
if (!fs.existsSync(FILES.state)) writeJSON(FILES.state, { progress: {}, plan: { perWeek: 3, minPerDay: 30 }, studylog: {}, reviewlog: {}, updatedAt: Date.now() });
if (!fs.existsSync(FILES.settings)) writeJSON(FILES.settings, { openaiKey: "", model: process.env.OPENAI_MODEL || "gpt-4o-mini" });

const uid = (p = "") => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// =========================================================
//  OPENAI PROXY
// =========================================================
function getKeyModel() {
  const s = readJSON(FILES.settings, {});
  const key = process.env.OPENAI_API_KEY || s.openaiKey || "";
  const model = s.model || process.env.OPENAI_MODEL || "gpt-4o-mini";
  return { key, model };
}

async function openaiChat({ system, user, json = false, model, images = [] }) {
  const { key, model: defModel } = getKeyModel();
  if (!key) throw new Error("Chưa cấu hình OPENAI_API_KEY (vào ⚙️ Cài đặt để nhập key).");
  const content = [{ type: "text", text: user }];
  for (const img of images) content.push({ type: "image_url", image_url: { url: img } });
  const body = {
    model: model || defModel,
    messages: [
      { role: "system", content: system },
      { role: "user", content: images.length ? content : user },
    ],
    temperature: 0.5,
  };
  if (json) body.response_format = { type: "json_object" };
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const t = await res.text(); throw new Error("OpenAI " + res.status + ": " + t.slice(0, 300)); }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// Responses API có web_search (kèm citations)
async function openaiWebSearch({ system, user, model }) {
  const { key, model: defModel } = getKeyModel();
  if (!key) throw new Error("Chưa cấu hình OPENAI_API_KEY (vào ⚙️ Cài đặt để nhập key).");
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: model || defModel,
      tools: [{ type: "web_search_preview" }],
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error("OpenAI web_search " + res.status + ": " + t.slice(0, 300)); }
  const data = await res.json();
  let text = data.output_text || "";
  const citations = [];
  if (!text && Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c.type === "output_text") {
            text += c.text || "";
            for (const ann of c.annotations || []) {
              if (ann.type === "url_citation" && ann.url) citations.push({ url: ann.url, title: ann.title || ann.url });
            }
          }
        }
      }
    }
  }
  return { text, citations };
}

// Cắt JSON ra khỏi chuỗi (phòng model kèm text thừa)
function parseJSONLoose(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// =========================================================
//  TRÍCH XUẤT NỘI DUNG (cho insight)
// =========================================================
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function ytId(url = "") {
  const m = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/);
  return m ? m[1] : null;
}
async function extractResourceText(r) {
  try {
    if (r.type === "text") return r.note || r.title || "";
    if (r.type === "youtube") {
      const id = ytId(r.url);
      if (!id) return r.title || "";
      const { YoutubeTranscript } = await import("youtube-transcript");
      const tr = await YoutubeTranscript.fetchTranscript(id);
      return tr.map((x) => x.text).join(" ").slice(0, 8000);
    }
    if (r.type === "pdf" && r.file) {
      const buf = fs.readFileSync(path.join(UPLOAD_DIR, r.file));
      const mod = await import("pdf-parse");
      const PDFParse = mod.PDFParse || mod.default?.PDFParse || mod.default;
      const parsed = await new PDFParse({ data: buf }).getText();
      return (parsed.text || "").slice(0, 8000);
    }
    if (r.type === "image" && r.file) {
      const buf = fs.readFileSync(path.join(UPLOAD_DIR, r.file));
      const b64 = "data:image/*;base64," + buf.toString("base64");
      return "[IMAGE]" + b64; // xử lý riêng ở insight
    }
    if ((r.type === "link" || r.type === "facebook") && r.url) {
      const res = await fetch(r.url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const html = await res.text();
      return stripHtml(html).slice(0, 8000);
    }
  } catch (e) {
    console.warn("extract fail", r.type, e.message);
  }
  return "";
}

// =========================================================
//  APP
// =========================================================
const app = express();
app.use(express.json({ limit: "10mb" }));

// Static không cache
app.use(express.static(PUBLIC_DIR, {
  etag: false, lastModified: false,
  setHeaders: (res) => res.set("Cache-Control", "no-store, max-age=0"),
}));

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 50 * 1024 * 1024 } });

app.get("/healthz", (req, res) => res.json({ ok: true, ts: Date.now() }));

// ---------- CURRICULUM ----------
app.get("/api/curriculum", (req, res) => res.json(readJSON(FILES.curriculum, { meta: {}, sessions: [] })));

app.post("/api/curriculum/sessions", (req, res) => {
  const cur = readJSON(FILES.curriculum, { meta: {}, sessions: [] });
  const { module, title_vi, title_en, subtitle } = req.body || {};
  if (!module || !title_vi) return res.status(400).json({ ok: false, error: "Thiếu module hoặc tiêu đề" });
  const id = uid("s-");
  const session = {
    id, module, title_vi, title_en: title_en || "", subtitle: subtitle || "", custom: true,
    slides: [{ n: 1, kind: "title", label: "", lines: [title_vi, title_en || "", subtitle || ""], custom: true }],
  };
  cur.sessions.push(session);
  cur.meta.sessions = cur.sessions.length;
  cur.meta.modules = new Set(cur.sessions.map((s) => s.module)).size;
  cur.meta.updated = Date.now();
  writeJSON(FILES.curriculum, cur);
  res.json({ ok: true, session });
});

app.delete("/api/curriculum/sessions/:id", (req, res) => {
  const cur = readJSON(FILES.curriculum, { meta: {}, sessions: [] });
  const s = cur.sessions.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: "Không tìm thấy" });
  if (!s.custom) return res.status(403).json({ ok: false, error: "Chỉ xoá được bài tự thêm" });
  cur.sessions = cur.sessions.filter((x) => x.id !== req.params.id);
  cur.meta.sessions = cur.sessions.length;
  cur.meta.modules = new Set(cur.sessions.map((x) => x.module)).size;
  writeJSON(FILES.curriculum, cur);
  res.json({ ok: true });
});

app.post("/api/curriculum/sessions/:id/slides", (req, res) => {
  const cur = readJSON(FILES.curriculum, { meta: {}, sessions: [] });
  const s = cur.sessions.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: "Không tìm thấy bài" });
  const { kind, label, lines } = req.body || {};
  const n = (s.slides.reduce((m, x) => Math.max(m, x.n), 0) || 0) + 1;
  const slide = { n, kind: kind || "concept", label: label || "", lines: Array.isArray(lines) ? lines : [], custom: true };
  s.slides.push(slide);
  writeJSON(FILES.curriculum, cur);
  res.json({ ok: true, slide });
});

app.delete("/api/curriculum/sessions/:id/slides/:n", (req, res) => {
  const cur = readJSON(FILES.curriculum, { meta: {}, sessions: [] });
  const s = cur.sessions.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: "Không tìm thấy bài" });
  const n = Number(req.params.n);
  const slide = s.slides.find((x) => x.n === n);
  if (!slide) return res.status(404).json({ ok: false, error: "Không tìm thấy slide" });
  if (!slide.custom) return res.status(403).json({ ok: false, error: "Chỉ xoá slide tự thêm" });
  s.slides = s.slides.filter((x) => x.n !== n);
  writeJSON(FILES.curriculum, cur);
  res.json({ ok: true });
});

// ---------- RESOURCES (thư viện) ----------
app.get("/api/resources", (req, res) => {
  const lib = readJSON(FILES.library, { resources: [] });
  const { sessionId } = req.query;
  let list = lib.resources;
  if (sessionId) list = list.filter((r) => r.sessionId === sessionId);
  res.json({ resources: list });
});

app.post("/api/resources", (req, res) => {
  const lib = readJSON(FILES.library, { resources: [] });
  const { sessionId, type, title, url, note, tags } = req.body || {};
  if (!sessionId || !type) return res.status(400).json({ ok: false, error: "Thiếu sessionId/type" });
  const r = { id: uid("r-"), sessionId, type, title: title || "", url: url || "", note: note || "", tags: tags || [], file: null, createdAt: Date.now() };
  lib.resources.push(r);
  writeJSON(FILES.library, lib);
  res.json({ ok: true, resource: r });
});

app.post("/api/resources/upload", upload.single("file"), (req, res) => {
  const lib = readJSON(FILES.library, { resources: [] });
  const { sessionId, type, title, tags } = req.body || {};
  if (!sessionId || !req.file) return res.status(400).json({ ok: false, error: "Thiếu file/sessionId" });
  const r = {
    id: uid("r-"), sessionId, type: type || "pdf", title: title || req.file.originalname,
    url: "/uploads/" + req.file.filename, note: "", tags: tags ? JSON.parse(tags) : [],
    file: req.file.filename, createdAt: Date.now(),
  };
  lib.resources.push(r);
  writeJSON(FILES.library, lib);
  res.json({ ok: true, resource: r });
});

app.delete("/api/resources/:id", (req, res) => {
  const lib = readJSON(FILES.library, { resources: [] });
  const r = lib.resources.find((x) => x.id === req.params.id);
  if (r?.file) { try { fs.unlinkSync(path.join(UPLOAD_DIR, r.file)); } catch {} }
  lib.resources = lib.resources.filter((x) => x.id !== req.params.id);
  writeJSON(FILES.library, lib);
  res.json({ ok: true });
});

// Phục vụ file upload
app.use("/uploads", express.static(UPLOAD_DIR));

// ---------- KNOWLEDGE (kho kiến thức đào sâu) ----------
app.get("/api/knowledge", (req, res) => {
  const kb = readJSON(FILES.knowledge, { items: [] });
  const { sessionId } = req.query;
  let list = kb.items;
  if (sessionId) list = list.filter((k) => k.sessionId === sessionId);
  res.json({ items: list });
});

app.post("/api/knowledge", (req, res) => {
  const kb = readJSON(FILES.knowledge, { items: [] });
  const { sessionId, kind, title, detail, url } = req.body || {};
  if (!sessionId) return res.status(400).json({ ok: false, error: "Thiếu sessionId" });
  const item = { id: uid("k-"), sessionId, kind: kind || "note", title: title || "", detail: detail || "", url: url || "", createdAt: Date.now() };
  kb.items.push(item);
  writeJSON(FILES.knowledge, kb);
  res.json({ ok: true, item });
});

app.delete("/api/knowledge/:id", (req, res) => {
  const kb = readJSON(FILES.knowledge, { items: [] });
  kb.items = kb.items.filter((x) => x.id !== req.params.id);
  writeJSON(FILES.knowledge, kb);
  res.json({ ok: true });
});

// ---------- STATE (đồng bộ) ----------
app.get("/api/state", (req, res) => res.json(readJSON(FILES.state, {})));
app.post("/api/state", (req, res) => {
  const cur = readJSON(FILES.state, { progress: {}, plan: {}, studylog: {}, reviewlog: {} });
  const inc = req.body || {};
  // Gộp thông minh: studylog theo max/ngày, reviewlog giữ mới nhất
  const merged = {
    progress: { ...cur.progress, ...(inc.progress || {}) },
    plan: { ...cur.plan, ...(inc.plan || {}) },
    studylog: { ...cur.studylog },
    reviewlog: { ...cur.reviewlog, ...(inc.reviewlog || {}) },
    updatedAt: Date.now(),
  };
  for (const [d, m] of Object.entries(inc.studylog || {})) merged.studylog[d] = Math.max(merged.studylog[d] || 0, m);
  writeJSON(FILES.state, merged);
  res.json({ ok: true, state: merged });
});

// ---------- SETTINGS ----------
app.get("/api/settings", (req, res) => {
  const s = readJSON(FILES.settings, {});
  res.json({ hasKey: !!(process.env.OPENAI_API_KEY || s.openaiKey), model: s.model || "gpt-4o-mini", envKey: !!process.env.OPENAI_API_KEY });
});
app.post("/api/settings", (req, res) => {
  const s = readJSON(FILES.settings, {});
  const { openaiKey, model } = req.body || {};
  if (typeof openaiKey === "string" && openaiKey.trim()) s.openaiKey = openaiKey.trim();
  if (model) s.model = model;
  writeJSON(FILES.settings, s);
  res.json({ ok: true, hasKey: !!(process.env.OPENAI_API_KEY || s.openaiKey), model: s.model });
});

// ---------- CHAT ----------
app.post("/api/chat", async (req, res) => {
  try {
    const { message, context, web } = req.body || {};
    const system = `Bạn là huấn luyện viên (coach) môn "AI AUTOMATION / Kỹ năng Sale". Trả lời bằng tiếng Việt, thực chiến, ngắn gọn, có ví dụ và các bước hành động cụ thể. Bối cảnh bài học: ${context || "(chung)"}`;
    if (web) {
      const r = await openaiWebSearch({ system, user: message });
      return res.json({ ok: true, answer: r.text, citations: r.citations });
    }
    const answer = await openaiChat({ system, user: message });
    res.json({ ok: true, answer, citations: [] });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// ---------- INSIGHT ----------
app.post("/api/insight", async (req, res) => {
  try {
    const { resourceId } = req.body || {};
    const lib = readJSON(FILES.library, { resources: [] });
    const r = lib.resources.find((x) => x.id === resourceId);
    if (!r) return res.status(404).json({ ok: false, error: "Không tìm thấy tài liệu" });
    if (r.insight) return res.json({ ok: true, insight: r.insight, citations: r.insightCitations || [], via: r.insightVia, cached: true });

    let content = await extractResourceText(r);
    const system = "Bạn là trợ lý học tập. Đọc nội dung và rút INSIGHT theo đúng khung markdown:\n**Tóm tắt**\n...\n**Bài học chính**\n- ...\n**Áp dụng ngay**\n- ...\nTiếng Việt, súc tích, thực chiến.";
    let insight = "", citations = [], via = "text";

    if (content.startsWith("[IMAGE]")) {
      const b64 = content.slice(7);
      insight = await openaiChat({ system, user: "Rút insight từ hình ảnh tài liệu này.", images: [b64] });
      via = "image";
    } else if (content && content.length > 40) {
      insight = await openaiChat({ system, user: "Nội dung tài liệu:\n" + content.slice(0, 7000) });
      via = r.type;
    } else {
      // fallback web_search theo tiêu đề/URL
      const q = r.title || r.url || "";
      const out = await openaiWebSearch({ system, user: "Tìm và rút insight về: " + q });
      insight = out.text; citations = out.citations; via = "web_search";
    }

    r.insight = insight; r.insightCitations = citations; r.insightVia = via; r.insightAt = Date.now();
    writeJSON(FILES.library, lib);
    res.json({ ok: true, insight, citations, via });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// ---------- KNOWLEDGE GENERATE (examples | tools | practice | videos) ----------
app.post("/api/knowledge/generate", async (req, res) => {
  try {
    const { kind, context } = req.body || {};
    const ctx = context || "";
    let system, user, useWeb = false;
    if (kind === "examples") {
      useWeb = true;
      system = 'Trả về JSON {"items":[{"title","detail","url"}]}. Liệt kê 4-6 VÍ DỤ THỰC TẾ có thật về chủ đề, mỗi ví dụ kèm URL nguồn thật. Tiếng Việt.';
      user = "Chủ đề bài học: " + ctx;
    } else if (kind === "tools") {
      useWeb = true;
      system = 'Trả về JSON {"items":[{"title","detail","url"}]}. Liệt kê 4-6 CÔNG CỤ/WEBSITE hữu ích có thật cho chủ đề, kèm URL thật. Tiếng Việt.';
      user = "Chủ đề bài học: " + ctx;
    } else if (kind === "videos") {
      useWeb = true;
      system = 'Trả về JSON {"items":[{"title","detail","url"}]}. Tìm 4-6 VIDEO (ưu tiên YouTube) có thật, cùng chủ đề bài học để đào sâu; url là link video thật, detail nêu vì sao nên xem. Tiếng Việt.';
      user = "Chủ đề bài học: " + ctx;
    } else { // practice
      system = 'Trả về JSON {"items":[{"title","detail","url"}]}. Soạn 4-6 BÀI TẬP/HÀNH ĐỘNG cụ thể làm được ngay trong tuần cho chủ đề (url có thể để rỗng). Tiếng Việt, thực chiến.';
      user = "Chủ đề bài học: " + ctx;
    }
    let raw, citations = [];
    if (useWeb) { const o = await openaiWebSearch({ system: system + " CHỈ trả JSON.", user }); raw = o.text; citations = o.citations; }
    else raw = await openaiChat({ system, user, json: true });
    const parsed = parseJSONLoose(raw) || { items: [] };
    res.json({ ok: true, items: parsed.items || [], citations });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// ---------- QUIZ GENERATE ----------
app.post("/api/quiz/generate", async (req, res) => {
  try {
    const { context, count, scope } = req.body || {};
    const n = count || 4;
    const system = `Bạn là giáo viên ra đề. Trả về JSON {"questions":[ {"type":"mcq","q","options":["A","B","C","D"],"answer":0,"explain"} hoặc {"type":"essay","q","guide"} ]}. Ra ${n} câu (trộn trắc nghiệm và tự luận), bằng tiếng Việt, bám sát nội dung. Phạm vi: ${scope || "bài học"}.`;
    const raw = await openaiChat({ system, user: "Nội dung/chủ đề:\n" + (context || ""), json: true });
    const parsed = parseJSONLoose(raw) || { questions: [] };
    res.json({ ok: true, questions: parsed.questions || [] });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// ---------- QUIZ GRADE (tự luận) ----------
app.post("/api/quiz/grade", async (req, res) => {
  try {
    const { items } = req.body || {}; // [{q, guide, answer}]
    const system = 'Bạn là giám khảo. Chấm mỗi câu tự luận theo thang 0-10. Trả về JSON {"results":[{"score":0-10,"feedback":"..."}]} đúng thứ tự. Tiếng Việt, nhận xét ngắn gọn, mang tính xây dựng.';
    const raw = await openaiChat({ system, user: JSON.stringify(items || []), json: true });
    const parsed = parseJSONLoose(raw) || { results: [] };
    res.json({ ok: true, results: parsed.results || [] });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// ---------- Middleware bắt lỗi ----------
app.use((err, req, res, next) => {
  console.error("[express error]", err);
  res.status(500).json({ ok: false, error: err.message || "Lỗi máy chủ" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🎓 AI Automation Academy chạy tại http://localhost:${PORT}`);
  console.log(`   DATA_DIR = ${DATA_DIR}\n`);
});
