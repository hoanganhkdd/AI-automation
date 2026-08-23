import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Parser from "rss-parser";
import { execFile } from "child_process";
import { promisify } from "util";
const execFileP = promisify(execFile);

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

// Dịch nội dung bài học sang tiếng Anh (song ngữ). Trả về map { "câu VI": "EN" }
app.post("/api/curriculum/translate", async (req, res) => {
  const texts = Array.isArray(req.body?.texts) ? req.body.texts.slice(0, 200) : [];
  try {
    await translateLessonBatch(texts);
    const out = {};
    for (const t of texts) if (t && lessonTrans[t]) out[t] = lessonTrans[t];
    res.json({ ok: true, translations: out });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

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

// =========================================================
//  TIN TỨC AI AUTOMATION (RSS, cập nhật mỗi ngày)
// =========================================================
const NEWS_FEEDS = [
  { name: "TechCrunch – AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { name: "VentureBeat – AI", url: "https://venturebeat.com/category/ai/feed/" },
  { name: "The Verge – AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml" },
  { name: "MIT Tech Review – AI", url: "https://www.technologyreview.com/topic/artificial-intelligence/feed" },
  { name: "Ars Technica – AI", url: "https://arstechnica.com/ai/feed/" },
  { name: "OpenAI Blog", url: "https://openai.com/blog/rss.xml" },
  { name: "Google AI Blog", url: "https://blog.google/technology/ai/rss/" },
  { name: "Zapier Blog", url: "https://zapier.com/blog/feeds/latest/" },
  { name: "Hugging Face Blog", url: "https://huggingface.co/blog/feed.xml" },
];
// Từ khoá lọc để ưu tiên tin về AI/automation
const NEWS_KEYWORDS = /\b(ai|a\.i|automat|agent|llm|gpt|claude|gemini|copilot|workflow|no-code|nocode|rpa|zapier|n8n|make\.com|chatbot|machine learning|ml\b|neural|openai|anthropic)/i;

const rssParser = new Parser({ timeout: 15000, headers: { "User-Agent": "AI-Automation-Academy/1.0" } });
let newsCache = { items: [], updatedAt: null, refreshing: false, sources: [] };

// ---- Dịch song ngữ 2 chiều (Google free -> MyMemory dự phòng, cache ra file) ----
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// Cache tin tức (EN -> VI) và cache bài học (VI -> EN)
const NEWS_TRANS_FILE = path.join(DATA_DIR, "news_trans.json");
const LESSON_TRANS_FILE = path.join(DATA_DIR, "lesson_trans.json");
let newsTrans = readJSON(NEWS_TRANS_FILE, {});
let lessonTrans = readJSON(LESSON_TRANS_FILE, {});
let newsTransDirty = false, lessonTransDirty = false;
setInterval(() => {
  if (newsTransDirty) { writeJSON(NEWS_TRANS_FILE, newsTrans); newsTransDirty = false; }
  if (lessonTransDirty) { writeJSON(LESSON_TRANS_FILE, lessonTrans); lessonTransDirty = false; }
}, 20000);

async function gTranslate(text, sl = "en", tl = "vi") {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=` + encodeURIComponent(text.slice(0, 1800));
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
  if (!res.ok) throw new Error("google " + res.status);
  const data = await res.json();
  return (data[0] || []).map((seg) => seg[0]).join("");
}
async function mmTranslate(text, sl = "en", tl = "vi") {
  const url = `https://api.mymemory.translated.net/get?langpair=${sl}|${tl}&q=` + encodeURIComponent(text.slice(0, 480));
  const res = await fetch(url);
  if (!res.ok) throw new Error("mymemory " + res.status);
  const data = await res.json();
  return data?.responseData?.translatedText || "";
}
// translate 1 đoạn theo chiều sl->tl, dùng cache tương ứng
async function translateOneWay(text, sl, tl, cache, markDirty) {
  if (!text) return "";
  if (cache[text]) return cache[text];
  let out = "";
  for (let i = 0; i < 2 && !out; i++) { try { out = await gTranslate(text, sl, tl); } catch (e) { if (String(e).includes("429")) await sleepMs(600); } }
  if (!out) { try { out = await mmTranslate(text, sl, tl); } catch {} }
  if (out) { cache[text] = out; markDirty(); }
  return out || text;
}
const translateVi = (t) => translateOneWay(t, "en", "vi", newsTrans, () => (newsTransDirty = true));
const translateEn = (t) => translateOneWay(t, "vi", "en", lessonTrans, () => (lessonTransDirty = true));
// Dịch theo LÔ bằng OpenAI (ổn định, không cạn quota như dịch vụ free)
async function openaiTranslateMany(texts, target = "Vietnamese") {
  const system = `Bạn là người dịch. Dịch từng chuỗi sang ${target} tự nhiên, giữ nguyên số phần tử và đúng thứ tự. Giữ dấu ** (đậm) nếu có. CHỈ trả về JSON đúng dạng {"t":["...","..."]}.`;
  const raw = await openaiChat({ system, user: JSON.stringify(texts), json: true });
  const parsed = parseJSONLoose(raw);
  return Array.isArray(parsed?.t) ? parsed.t : [];
}

// Dịch nội dung bài học sang tiếng Anh (VI -> EN), theo lô, có cache
async function translateLessonBatch(texts) {
  const need = [...new Set(texts.filter((t) => t && !lessonTrans[t]))];
  if (!need.length) return;
  const { key } = getKeyModel();
  if (key) {
    for (let i = 0; i < need.length; i += 20) {
      const batch = need.slice(i, i + 20);
      try { const en = await openaiTranslateMany(batch, "English"); batch.forEach((t, j) => { if (en[j]) { lessonTrans[t] = en[j]; lessonTransDirty = true; } }); }
      catch (e) { console.warn("lesson translate batch fail", e.message); break; }
    }
  } else {
    for (const t of need) { try { await translateEn(t); await sleepMs(120); } catch {} }
  }
}

let preTransRunning = false;
async function preTranslateNews(limit = 120) {
  if (preTransRunning) return;
  preTransRunning = true;
  try {
    const { key } = getKeyModel();
    // Gom các đoạn cần dịch (title + summary) chưa có trong cache
    const need = [];
    for (const it of newsCache.items.slice(0, limit)) {
      if (it.title && !newsTrans[it.title]) need.push(it.title);
      if (it.summary && !newsTrans[it.summary]) need.push(it.summary);
    }
    if (!need.length) { preTransRunning = false; return; }

    if (key) {
      // OpenAI: dịch theo lô 20 đoạn/lần
      for (let i = 0; i < need.length; i += 20) {
        const batch = need.slice(i, i + 20);
        try {
          const vi = await openaiTranslateMany(batch);
          batch.forEach((t, j) => { if (vi[j]) { newsTrans[t] = vi[j]; newsTransDirty = true; } });
        } catch (e) { console.warn("openai translate batch fail", e.message); break; }
      }
    } else {
      // Không có key: dùng Google/MyMemory (có thể bị giới hạn tốc độ)
      for (const t of need) {
        try { await translateVi(t); await sleepMs(120); } catch {}
      }
    }
  } finally { preTransRunning = false; }
}

function cleanText(s = "") {
  return s.replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
}
async function fetchNews() {
  if (newsCache.refreshing) return;
  newsCache.refreshing = true;
  const results = await Promise.allSettled(NEWS_FEEDS.map(async (f) => {
    const feed = await rssParser.parseURL(f.url);
    return (feed.items || []).map((it) => ({
      id: it.guid || it.link || (f.name + it.title),
      title: cleanText(it.title || ""),
      link: it.link || "",
      source: f.name,
      summary: cleanText(it.contentSnippet || it.content || it.summary || "").slice(0, 260),
      ts: it.isoDate || it.pubDate ? new Date(it.isoDate || it.pubDate).getTime() : 0,
    }));
  }));
  const items = [];
  const sources = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") { items.push(...r.value); sources.push({ name: NEWS_FEEDS[i].name, ok: true, count: r.value.length }); }
    else sources.push({ name: NEWS_FEEDS[i].name, ok: false, count: 0 });
  });
  // Lọc theo từ khoá AI/automation + khử trùng lặp + sắp xếp mới nhất
  const seen = new Set();
  const filtered = items.filter((it) => {
    if (!NEWS_KEYWORDS.test(it.title + " " + it.summary)) return false;
    const key = it.link || it.id;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((a, b) => b.ts - a.ts).slice(0, 120);
  newsCache = { items: filtered, updatedAt: new Date().toISOString(), refreshing: false, sources };
  console.log(`  📰 Tin AI: ${filtered.length} tin từ ${sources.filter((s) => s.ok).length}/${NEWS_FEEDS.length} nguồn.`);
  preTranslateNews().catch(() => {}); // dịch sẵn song ngữ ở nền
}
// Phân loại chủ đề tin theo từ khoá
const TOPICS = {
  automation: "🤖 Agent & Automation",
  model: "🧠 Mô hình & Nghiên cứu",
  business: "💼 Sản phẩm & Công ty",
  policy: "⚖️ Chính sách & An toàn",
  other: "📌 Khác",
};
function classifyTopic(text = "") {
  const t = text.toLowerCase();
  if (/\bagent|automat|workflow|n8n|zapier|make\.com|\brpa\b|copilot|no-?code|orchestrat|assistant/.test(t)) return "automation";
  if (/safety|regulat|policy|\blaw\b|\bbill\b|privacy|govern|ethic|lawsuit|court|copyright|ban\b/.test(t)) return "policy";
  if (/launch|release|funding|raises?\b|partner|acqui|valuation|startup|\bipo\b|billion|million|invest|revenue|deal\b/.test(t)) return "business";
  if (/\bmodel|\bllm\b|gpt|research|paper|benchmark|neural|training|dataset|open-?source|weights|reasoning|multimodal/.test(t)) return "model";
  return "other";
}
app.get("/api/news", (req, res) => {
  const items = newsCache.items.map((i) => {
    const topic = classifyTopic(i.title + " " + i.summary);
    return {
      ...i, topic, topicLabel: TOPICS[topic],
      titleVi: newsTrans[i.title] || null,
      summaryVi: i.summary ? newsTrans[i.summary] || null : null,
    };
  });
  res.json({ updatedAt: newsCache.updatedAt, total: items.length, sources: newsCache.sources, items });
});
// Dịch theo yêu cầu (các tin chưa có sẵn bản dịch)
app.post("/api/news/translate", async (req, res) => {
  const texts = Array.isArray(req.body?.texts) ? req.body.texts.slice(0, 40) : [];
  try {
    const out = {};
    for (const t of texts) { if (!t || out[t] !== undefined) continue; const cached = !!newsTrans[t]; out[t] = await translateVi(t); if (!cached) await sleepMs(120); }
    res.json({ ok: true, translations: out });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});
app.post("/api/news/refresh", async (req, res) => { await fetchNews(); res.json({ ok: true, updatedAt: newsCache.updatedAt, total: newsCache.items.length }); });

// Tóm tắt tin tức dạng infographic (AI) — tổng quan + điểm nhấn theo chủ đề
app.post("/api/news/summarize", async (req, res) => {
  try {
    const source = req.body?.source || "";
    const topic = req.body?.topic || "";
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    let items = newsCache.items.slice();
    if (ids.length) {
      // Ưu tiên: chỉ tóm tắt các tin người dùng đã chọn
      items = items.filter((i) => ids.includes(i.id));
    } else {
      if (source) items = items.filter((i) => i.source === source);
      if (topic) items = items.filter((i) => classifyTopic(i.title + " " + i.summary) === topic);
    }
    items = items.slice(0, 45);
    if (!items.length) return res.status(400).json({ ok: false, error: "Chưa có tin phù hợp để tóm tắt" });

    // Thống kê (không cần AI)
    const byTopic = {}, bySource = {};
    for (const i of items) {
      const tp = classifyTopic(i.title + " " + i.summary);
      byTopic[tp] = (byTopic[tp] || 0) + 1;
      bySource[i.source] = (bySource[i.source] || 0) + 1;
    }

    // AI viết tổng quan + điểm chính theo chủ đề + tin nổi bật (JSON, tiếng Việt)
    const list = items.map((i, n) => `${n + 1}. [${classifyTopic(i.title + " " + i.summary)}] ${i.title}`).join("\n");
    const system = 'Bạn là biên tập viên bản tin công nghệ. Từ danh sách tiêu đề tin AI/automation, tạo bản TÓM TẮT tiếng Việt súc tích để đọc nhanh. CHỈ trả JSON: {"overview":"2-3 câu tổng quan xu hướng nổi bật","topics":[{"key":"automation|model|business|policy|other","points":["gạch đầu dòng ngắn",...]}],"highlights":[{"title":"tiêu đề tin (tiếng Việt, ngắn)","why":"vì sao đáng chú ý"}]}. Mỗi topic 2-3 điểm; 4-5 highlights.';
    let ai = { overview: "", topics: [], highlights: [] };
    try {
      const raw = await openaiChat({ system, user: "Các tin mới nhất:\n" + list, json: true });
      ai = parseJSONLoose(raw) || ai;
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
    res.json({
      ok: true,
      updatedAt: newsCache.updatedAt,
      focus: ids.length ? `${items.length} tin bạn chọn` : (topic ? TOPICS[topic] : (source || "")),
      stats: { total: items.length, sources: Object.keys(bySource).length, byTopic, topicLabels: TOPICS },
      overview: ai.overview || "",
      topics: ai.topics || [],
      highlights: ai.highlights || [],
    });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// =========================================================
//  TÍCH HỢP NOTEBOOKLM (gọi CLI notebooklm-py)
// =========================================================
// Dò đường dẫn CLI notebooklm một lần (lười + nhớ) — tránh đua tiến trình & lỗi .exe trên Windows
let _binPromise = null;
async function resolveBin() {
  if (process.env.NBLM_BIN) return process.env.NBLM_BIN;
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const { stdout } = await execFileP(cmd, ["notebooklm"], { timeout: 8000 });
    const p = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (p) return p;
  } catch {}
  // Dự phòng: quét thư mục Scripts của các bản Python trên Windows
  if (process.platform === "win32") {
    const roots = [
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Python"),
      path.join(process.env.APPDATA || "", "Python"),
    ];
    for (const root of roots) {
      try {
        for (const d of fs.readdirSync(root)) {
          const cand = path.join(root, d, "Scripts", "notebooklm.exe");
          if (fs.existsSync(cand)) return cand;
        }
      } catch {}
    }
  }
  return "notebooklm";
}
function binOnce() { return (_binPromise ||= resolveBin()); }
async function nblm(args, timeout = 60000) {
  const bin = await binOnce();
  const { stdout } = await execFileP(bin, args, { timeout, maxBuffer: 12 * 1024 * 1024, windowsHide: true });
  return stdout;
}
async function waitSourcesReady(nid, timeoutMs = 240000) {
  const start = Date.now();
  let last = { ready: 0, total: 0 };
  while (Date.now() - start < timeoutMs) {
    try {
      const j = parseJSONLoose(await nblm(["source", "list", "-n", nid, "--json"], 30000)) || { sources: [] };
      const s = j.sources || [];
      last = { ready: s.filter((x) => x.status === "ready").length, total: s.length };
      if (s.length && s.every((x) => x.status === "ready" || x.status === "error")) return last;
    } catch {}
    await sleepMs(8000);
  }
  return { ...last, timedOut: true };
}

// Trạng thái: CLI có sẵn & đã đăng nhập?
let nblmStatusCache = null, nblmStatusAt = 0;
app.get("/api/notebooklm/status", async (req, res) => {
  const ttl = nblmStatusCache?.authed ? 60000 : 8000; // OK: nhớ 60s; lỗi: chỉ 8s để tự phục hồi
  if (nblmStatusCache && Date.now() - nblmStatusAt < ttl) return res.json(nblmStatusCache);
  try {
    const j = parseJSONLoose(await nblm(["auth", "check", "--test", "--json"], 30000)) || {};
    const authed = j.status === "ok" && j?.checks?.token_fetch === true;
    nblmStatusCache = { available: true, authed, email: j?.account?.email || null };
  } catch (e) {
    nblmStatusCache = { available: false, authed: false, error: String(e.message || e).slice(0, 160) };
  }
  nblmStatusAt = Date.now();
  res.json(nblmStatusCache);
});

// Tóm tắt các tin đã chọn bằng NotebookLM (tạo notebook -> nạp URL -> hỏi tóm tắt)
app.post("/api/notebooklm/summarize", async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    let items = newsCache.items.filter((i) => ids.includes(i.id) && i.link).slice(0, 10);
    if (!items.length) return res.status(400).json({ ok: false, error: "Chưa chọn tin (có link) để tóm tắt" });

    // 1) Tạo notebook
    const title = "Tin AI " + new Date().toLocaleDateString("vi-VN") + " (" + items.length + " nguồn)";
    const created = parseJSONLoose(await nblm(["create", title, "--json"], 40000));
    const nid = created?.notebook?.id;
    if (!nid) throw new Error("Không tạo được notebook");

    // 2) Nạp từng URL làm source (bỏ qua lỗi lẻ)
    let added = 0;
    for (const it of items) {
      try { await nblm(["source", "add", it.link, "-n", nid, "--json"], 60000); added++; }
      catch (e) { console.warn("nblm add fail", it.link, e.message); }
    }
    if (!added) throw new Error("Không nạp được nguồn nào vào notebook");

    // 3) Chờ source xử lý xong
    const ready = await waitSourcesReady(nid, 240000);

    // 4) Hỏi NotebookLM tóm tắt (dựa trên nội dung nguồn thật)
    const prompt = "Hãy đọc TẤT CẢ các nguồn trong notebook và viết bản tóm tắt tin tức bằng tiếng Việt, gồm: " +
      "1) 4-6 gạch đầu dòng điểm chính nổi bật nhất; 2) Các xu hướng/chủ đề chung nổi lên; 3) Vì sao đáng chú ý. " +
      "Trình bày ngắn gọn, rõ ràng, dựa hoàn toàn vào nội dung nguồn.";
    const ans = parseJSONLoose(await nblm(["ask", prompt, "-n", nid, "--json"], 180000)) || {};

    res.json({
      ok: true,
      notebookId: nid,
      notebookUrl: "https://notebooklm.google.com/notebook/" + nid,
      title,
      added,
      ready: ready.ready, total: ready.total, timedOut: !!ready.timedOut,
      answer: ans.answer || "(NotebookLM không trả về nội dung)",
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});

// Tạo MIND MAP từ notebook (note-backed = nhanh, đồng bộ)
app.post("/api/notebooklm/mindmap", async (req, res) => {
  try {
    const nid = req.body?.notebookId;
    if (!nid) return res.status(400).json({ ok: false, error: "Thiếu notebookId" });
    const out = parseJSONLoose(await nblm(["generate", "mind-map", "--kind", "note-backed", "-n", nid, "--json"], 150000)) || {};
    const mindMap = out.mind_map || out.mindMap || null;
    if (!mindMap) throw new Error("NotebookLM không trả về mind map");
    res.json({ ok: true, mindMap });
  } catch (e) { res.status(502).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});

// Bắt đầu tạo PODCAST (audio) — chạy nền, trả task_id
app.post("/api/notebooklm/podcast/start", async (req, res) => {
  try {
    const nid = req.body?.notebookId;
    if (!nid) return res.status(400).json({ ok: false, error: "Thiếu notebookId" });
    const instr = "Tạo podcast tiếng Việt tóm tắt các nguồn tin: nêu các điểm chính nổi bật, xu hướng chung và vì sao đáng chú ý. Giọng tự nhiên, mạch lạc.";
    let out;
    try { out = parseJSONLoose(await nblm(["generate", "audio", instr, "--language", "vi", "-n", nid, "--json"], 60000)); }
    catch (e) { out = parseJSONLoose(await nblm(["generate", "audio", instr, "-n", nid, "--json"], 60000)); }
    const taskId = out?.task_id || out?.taskId;
    if (!taskId) throw new Error("Không bắt đầu được việc tạo podcast");
    res.json({ ok: true, taskId, status: out.status || "pending" });
  } catch (e) { res.status(502).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});

// Kiểm tra podcast; xong thì tải về và trả link phát
app.post("/api/notebooklm/podcast/status", async (req, res) => {
  try {
    const nid = req.body?.notebookId, taskId = req.body?.taskId;
    if (!nid || !taskId) return res.status(400).json({ ok: false, error: "Thiếu tham số" });
    const j = parseJSONLoose(await nblm(["artifact", "list", "-n", nid, "--json"], 30000)) || { artifacts: [] };
    const art = (j.artifacts || []).find((a) => a.id === taskId || a.id?.startsWith(taskId) || taskId.startsWith(a.id));
    const status = art?.status || "unknown";
    if (status === "completed") {
      const file = path.join(UPLOAD_DIR, "podcast-" + String(taskId).slice(0, 8) + ".m4a");
      if (!fs.existsSync(file)) await nblm(["download", "audio", file, "-a", taskId, "-n", nid], 180000);
      return res.json({ ok: true, ready: true, url: "/uploads/" + path.basename(file) });
    }
    res.json({ ok: true, ready: false, status });
  } catch (e) { res.status(502).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});

// ---------- Middleware bắt lỗi ----------
app.use((err, req, res, next) => {
  console.error("[express error]", err);
  res.status(500).json({ ok: false, error: err.message || "Lỗi máy chủ" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🎓 AI Automation Academy chạy tại http://localhost:${PORT}`);
  console.log(`   DATA_DIR = ${DATA_DIR}\n`);
  fetchNews().catch((e) => console.warn("news init fail", e.message));
  setInterval(() => fetchNews().catch(() => {}), 60 * 60 * 1000); // cập nhật tin mỗi giờ
});
