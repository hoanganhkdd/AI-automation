/* ================= AI Automation Academy — app.js ================= */
const { renderSlides, slideToText, sessionToSentences, mdLite, escapeHtml } = window.SLIDES;

let CUR = { meta: {}, sessions: [] };
let STATE = { progress: {}, plan: { perWeek: 3, minPerDay: 30 }, studylog: {}, reviewlog: {} };
let SETTINGS = { hasKey: false, model: "gpt-4o-mini" };
const $ = (id) => document.getElementById(id);
const todayKey = () => new Date().toISOString().slice(0, 10);

/* ---------- API helper ---------- */
async function api(method, path, body) {
  const opt = { method, headers: {} };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  const res = await fetch(path, opt);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

/* ---------- Toast ---------- */
let toastT;
function toast(msg, ms = 2600) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms);
}

/* ---------- Modal ---------- */
function openModal(title, html) {
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = html;
  $("modal").hidden = false;
}
function closeModal() { $("modal").hidden = true; }

/* ---------- State sync (debounce) ---------- */
let stateT;
function saveState() {
  STATE.updatedAt = Date.now();
  clearTimeout(stateT);
  stateT = setTimeout(() => { api("POST", "/api/state", STATE).catch(() => {}); }, 600);
}
function isDone(id) { return !!STATE.progress[id]; }

/* ================= TTS ENGINE ================= */
const TTS = {
  queue: [], idx: 0, playing: false, rate: 1, voice: null, title: "",
  onLesson: null, // session để tự chuyển bài (chế độ nghe bài)
  voices: [],
  loadVoices() {
    this.voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    const sel = $("mpVoice");
    if (!sel) return;
    const vi = this.voices.filter((v) => /vi|VN/i.test(v.lang));
    const list = vi.length ? vi.concat(this.voices.filter((v) => !/vi|VN/i.test(v.lang))) : this.voices;
    sel.innerHTML = list.map((v, i) => `<option value="${v.name}">${v.name} (${v.lang})</option>`).join("");
    if (vi.length) { this.voice = vi[0]; sel.value = vi[0].name; }
    else if (this.voices[0]) this.voice = this.voices[0];
  },
  start(sentences, title, session) {
    if (!window.speechSynthesis) { toast("Trình duyệt không hỗ trợ đọc to."); return; }
    this.queue = sentences.filter(Boolean); this.idx = 0; this.title = title || "Đang đọc";
    this.onLesson = session || null;
    $("miniPlayer").hidden = false; $("mpTitle").textContent = this.title;
    this.playing = true; this.speakCurrent();
    $("mpToggle").textContent = "⏸";
  },
  speakCurrent() {
    speechSynthesis.cancel();
    if (this.idx >= this.queue.length) { this.onEnd(); return; }
    const u = new SpeechSynthesisUtterance(this.queue[this.idx]);
    u.rate = this.rate; u.lang = "vi-VN";
    if (this.voice) u.voice = this.voice;
    u.onend = () => { if (this.playing) { this.idx++; this.speakCurrent(); } };
    $("mpProgress").textContent = `${Math.min(this.idx + 1, this.queue.length)}/${this.queue.length}`;
    speechSynthesis.speak(u);
  },
  onEnd() {
    // Tự chuyển bài kế tiếp (chế độ nghe bài)
    if (this.onLesson) {
      const list = CUR.sessions;
      const i = list.findIndex((s) => s.id === this.onLesson.id);
      const next = list[i + 1];
      if (next) { const sents = sessionToSentences(next); this.start(sents, "🎧 " + next.title_vi, next); return; }
    }
    this.stop();
  },
  toggle() {
    if (!this.queue.length) return;
    if (this.playing) { this.playing = false; speechSynthesis.pause(); $("mpToggle").textContent = "▶️"; }
    else { this.playing = true; speechSynthesis.resume(); $("mpToggle").textContent = "⏸"; if (speechSynthesis.speaking === false) this.speakCurrent(); }
  },
  next() { this.idx = Math.min(this.idx + 1, this.queue.length); this.playing = true; $("mpToggle").textContent = "⏸"; this.speakCurrent(); },
  prev() { this.idx = Math.max(this.idx - 1, 0); this.playing = true; $("mpToggle").textContent = "⏸"; this.speakCurrent(); },
  stop() { this.playing = false; if (window.speechSynthesis) speechSynthesis.cancel(); $("miniPlayer").hidden = true; },
};

/* ================= ROUTER ================= */
function route() {
  const hash = location.hash.replace(/^#/, "") || "home";
  if (hash === "home" || !hash) { showHome(); return; }
  const s = CUR.sessions.find((x) => x.id === hash);
  if (s) showSession(s); else showHome();
}
function goHome() { location.hash = "#home"; }

function showHome() {
  $("session-view").hidden = true;
  $("home-view").hidden = false;
  renderHome();
}
function showSession(s) {
  $("home-view").hidden = true;
  $("session-view").hidden = false;
  renderSession(s);
  window.scrollTo(0, 0);
}

/* ================= HOME ================= */
function computeStats() {
  const total = CUR.sessions.length;
  const done = CUR.sessions.filter((s) => isDone(s.id)).length;
  const modules = [...new Set(CUR.sessions.map((s) => s.module))];
  return { total, done, modules, pct: total ? Math.round((done / total) * 100) : 0 };
}
function streakDays() {
  let n = 0; const d = new Date();
  for (;;) { const k = d.toISOString().slice(0, 10); if ((STATE.studylog[k] || 0) > 0) { n++; d.setDate(d.getDate() - 1); } else break; }
  return n;
}
function reviewNeeded() {
  const now = Date.now(), DAY = 86400000;
  return CUR.sessions.filter((s) => {
    if (!isDone(s.id)) return false;
    const r = STATE.reviewlog[s.id];
    if (!r) return true;
    if (now - r.ts > 3 * DAY) return true;
    if ((r.score ?? 10) < 7) return true;
    return false;
  });
}

async function renderHome() {
  const st = computeStats();
  let libCount = 0;
  try { libCount = (await api("GET", "/api/resources")).resources.length; } catch {}
  $("courseTitle").textContent = CUR.meta.title || "AI AUTOMATION";
  $("courseSub").textContent = CUR.meta.subtitle || "";

  const plan = STATE.plan || { perWeek: 3, minPerDay: 30 };
  const left = st.total - st.done;
  const weeks = plan.perWeek ? Math.ceil(left / plan.perWeek) : 0;
  const finish = new Date(Date.now() + weeks * 7 * 86400000);
  const suggest = CUR.sessions.filter((s) => !isDone(s.id)).slice(0, plan.perWeek || 3);
  const rev = reviewNeeded();

  const moduleGrid = st.modules.map((m) => {
    const ss = CUR.sessions.filter((s) => s.module === m);
    const dn = ss.filter((s) => isDone(s.id)).length;
    return `<div class="module-card">
      <div class="module-head"><h3>${escapeHtml(m)}</h3><span class="chip">${dn}/${ss.length}</span></div>
      <div class="session-list">
        ${ss.map((s) => `<a class="session-item ${isDone(s.id) ? "done" : ""}" href="#${s.id}">
          <span class="si-check">${isDone(s.id) ? "✓" : "○"}</span>
          <span class="si-title">${escapeHtml(s.title_vi)}</span>
        </a>`).join("")}
      </div>
      <button class="mini-btn" data-quiz-module="${escapeHtml(m)}">🧪 Kiểm tra module</button>
    </div>`;
  }).join("");

  $("home-view").innerHTML = `
    <div class="hero">
      <div>
        <h1>${escapeHtml(CUR.meta.title || "AI AUTOMATION")}</h1>
        <p>${escapeHtml(CUR.meta.subtitle || "Học Sale thực chiến, song ngữ Việt–Anh")}</p>
      </div>
      <div class="stats">
        <div class="stat"><b>${st.pct}%</b><small>Hoàn thành</small></div>
        <div class="stat"><b>${st.done}/${st.total}</b><small>Bài học</small></div>
        <div class="stat"><b>${st.modules.length}</b><small>Module</small></div>
        <div class="stat"><b>${libCount}</b><small>Tài liệu</small></div>
      </div>
    </div>

    <div class="home-tools">
      <div class="tool-card">
        <h3>🎯 Mục tiêu học</h3>
        <div class="plan-row">
          <label>Bài/tuần <input type="number" id="planWeek" min="1" value="${plan.perWeek || 3}"></label>
          <label>Phút đào sâu/ngày <input type="number" id="planMin" min="5" step="5" value="${plan.minPerDay || 30}"></label>
          <button class="mini-btn" id="planSave">Lưu</button>
        </div>
        <p class="plan-out">Còn <b>${left}</b> bài · ~<b>${weeks}</b> tuần · dự kiến xong <b>${left ? finish.toLocaleDateString("vi-VN") : "—"}</b></p>
        <p class="plan-suggest">Tuần này nên học: ${suggest.length ? suggest.map((s) => `<a href="#${s.id}">${escapeHtml(s.title_vi)}</a>`).join(" · ") : "🎉 Đã học hết!"}</p>
      </div>

      <div class="tool-card">
        <h3>⏱️ Phiên đào sâu</h3>
        <div class="timer-display" id="timerDisplay">00:00</div>
        <div class="timer-btns">
          <button class="mini-btn" id="tStart">Bắt đầu</button>
          <button class="mini-btn" id="tPause">Tạm dừng</button>
          <button class="mini-btn" id="tStop">Kết thúc</button>
        </div>
        <p>Hôm nay: <b>${STATE.studylog[todayKey()] || 0}</b> phút · 🔥 streak <b>${streakDays()}</b> ngày</p>
      </div>

      <div class="tool-card">
        <h3>🔁 Cần ôn lại</h3>
        ${rev.length ? `<div class="chips">${rev.map((s) => `<button class="chip-btn" data-quiz-quick="${s.id}">${escapeHtml(s.title_vi)}</button>`).join("")}</div>`
          : `<p class="muted">Chưa có bài nào cần ôn. 👍</p>`}
      </div>

      <div class="tool-card">
        <h3>📝 Thu hoạch</h3>
        <p class="muted">Kiểm tra tổng kết toàn bộ kiến thức đã học.</p>
        <button class="mini-btn primary" id="quizCourse">🧪 Kiểm tra tổng kết toàn khoá</button>
        <button class="mini-btn" id="addSessionBtn">➕ Thêm module / bài học</button>
      </div>
    </div>

    <h2 class="section-title">Chương trình học</h2>
    <div class="modules">${moduleGrid}</div>
  `;

  // listeners
  $("planSave").onclick = () => {
    STATE.plan = { perWeek: +$("planWeek").value || 3, minPerDay: +$("planMin").value || 30 };
    saveState(); toast("Đã lưu mục tiêu"); renderHome();
  };
  $("tStart").onclick = timerStart; $("tPause").onclick = timerPause; $("tStop").onclick = timerStop;
  $("quizCourse").onclick = () => startQuiz({ scope: "toàn khoá", context: courseContext(), title: "Kiểm tra tổng kết toàn khoá" });
  $("addSessionBtn").onclick = openAddSession;
  document.querySelectorAll("[data-quiz-module]").forEach((b) => b.onclick = () => {
    const m = b.dataset.quizModule;
    startQuiz({ scope: "module: " + m, context: moduleContext(m), title: "Kiểm tra module: " + m });
  });
  document.querySelectorAll("[data-quiz-quick]").forEach((b) => b.onclick = () => quickQuiz(b.dataset.quizQuick));
}

function courseContext() {
  return CUR.sessions.map((s) => s.title_vi + ": " + (s.slides || []).map((sl) => (sl.lines || []).join(" ")).join(" ")).join("\n").slice(0, 6000);
}
function moduleContext(m) {
  return CUR.sessions.filter((s) => s.module === m).map((s) => s.title_vi + ": " + (s.slides || []).map((sl) => (sl.lines || []).join(" ")).join(" ")).join("\n").slice(0, 6000);
}
function sessionContext(s) {
  return s.title_vi + " — " + (s.slides || []).map((sl) => (sl.label ? sl.label + ": " : "") + (sl.lines || []).join(" ")).join("\n");
}

/* ---------- Timer ---------- */
let timerInt = null, timerSec = 0, timerRunning = false;
function timerFmt(s) { const m = Math.floor(s / 60), r = s % 60; return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`; }
function timerStart() {
  if (timerRunning) return; timerRunning = true;
  timerInt = setInterval(() => { timerSec++; const d = $("timerDisplay"); if (d) d.textContent = timerFmt(timerSec); }, 1000);
}
function timerPause() { timerRunning = false; clearInterval(timerInt); }
function timerStop() {
  timerPause();
  const mins = Math.round(timerSec / 60);
  if (mins > 0) {
    const k = todayKey();
    STATE.studylog[k] = (STATE.studylog[k] || 0) + mins;
    saveState(); toast(`+${mins} phút hôm nay 🔥`);
  }
  timerSec = 0; const d = $("timerDisplay"); if (d) d.textContent = "00:00";
  renderHome();
}

/* ================= SESSION ================= */
let curSession = null, curTab = "learn";
function renderSession(s) {
  curSession = s; curTab = "learn";
  const rv = STATE.reviewlog[s.id];
  const badge = rv ? `✔ Ôn ${new Date(rv.ts).toLocaleDateString("vi-VN")} · ${rv.score}/10` : "Chưa ôn";
  $("session-view").innerHTML = `
    <div class="crumbs"><a href="#home">← Trang chủ</a> · <span>${escapeHtml(s.module)}</span></div>
    <div class="session-top">
      <h1>${escapeHtml(s.title_vi)}</h1>
      <div class="toolbar">
        <button class="mini-btn ${isDone(s.id) ? "done" : "primary"}" id="btnDone">${isDone(s.id) ? "✓ Đã hoàn thành" : "Đánh dấu hoàn thành"}</button>
        <button class="mini-btn" id="btnQuick">🧠 Kiểm tra nhanh</button>
        <span class="review-badge">${badge}</span>
        ${s.custom ? `<button class="mini-btn danger" id="btnDelSession">🗑 Xoá bài học</button>` : ""}
      </div>
    </div>
    <div class="tabs">
      <button class="tab active" data-tab="learn">📖 Bài học</button>
      <button class="tab" data-tab="deep">🧠 Đào sâu</button>
      <button class="tab" data-tab="lib">📚 Thư viện</button>
      <button class="tab" data-tab="ai">🤖 Hỏi AI</button>
    </div>
    <div id="tabBody" class="tab-body"></div>
  `;
  $("btnDone").onclick = () => toggleDone(s);
  $("btnQuick").onclick = () => quickQuiz(s.id);
  if ($("btnDelSession")) $("btnDelSession").onclick = () => delSession(s);
  document.querySelectorAll(".tab").forEach((t) => t.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active"); curTab = t.dataset.tab; renderTab();
  });
  renderTab();
}

function toggleDone(s) {
  if (isDone(s.id)) delete STATE.progress[s.id];
  else STATE.progress[s.id] = Date.now();
  saveState(); renderSession(s);
}
async function delSession(s) {
  if (!confirm("Xoá bài học này?")) return;
  try { await api("DELETE", "/api/curriculum/sessions/" + s.id); CUR = await api("GET", "/api/curriculum"); goHome(); toast("Đã xoá"); }
  catch (e) { toast(e.message); }
}

function renderTab() {
  const body = $("tabBody");
  if (curTab === "learn") renderLearnTab(body);
  else if (curTab === "deep") renderDeepTab(body);
  else if (curTab === "lib") renderLibTab(body);
  else if (curTab === "ai") renderAiTab(body);
}

/* ---------- Tab: Bài học ---------- */
function renderLearnTab(body) {
  const s = curSession;
  body.innerHTML = `
    <div class="learn-actions">
      <button class="mini-btn" id="listenLesson">🎧 Nghe bài (chế độ ngồi xe)</button>
      <button class="mini-btn" id="addSlideBtn">➕ Thêm kiến thức</button>
      <span class="quick-add">
        Thêm tài liệu:
        <button class="chip-btn" data-add="youtube">YouTube</button>
        <button class="chip-btn" data-add="facebook">Reel FB</button>
        <button class="chip-btn" data-add="pdf">PDF</button>
        <button class="chip-btn" data-add="image">Ảnh</button>
        <button class="chip-btn" data-add="text">Text</button>
        <button class="chip-btn" data-add="link">Link</button>
      </span>
    </div>
    <div class="slides">${renderSlides(s, { allowDelete: true })}</div>
  `;
  $("listenLesson").onclick = () => TTS.start(sessionToSentences(s), "🎧 " + s.title_vi, s);
  $("addSlideBtn").onclick = openAddSlide;
  document.querySelectorAll("[data-add]").forEach((b) => b.onclick = () => openAddResource(b.dataset.add));
  document.querySelectorAll(".slide-del").forEach((b) => b.onclick = async () => {
    if (!confirm("Xoá slide này?")) return;
    try { await api("DELETE", `/api/curriculum/sessions/${s.id}/slides/${b.dataset.slideN}`); CUR = await api("GET", "/api/curriculum"); curSession = CUR.sessions.find((x) => x.id === s.id); renderTab(); toast("Đã xoá slide"); }
    catch (e) { toast(e.message); }
  });
}

/* ---------- Tab: Đào sâu (5 bảng + video) ---------- */
function renderDeepTab(body) {
  const s = curSession;
  body.innerHTML = `
    <div class="deep-grid">
      <div class="panel">
        <div class="panel-h">📖 Nội dung bài học <button class="mini-btn" id="listenAll">🎧 Nghe toàn bộ đào sâu</button></div>
        <div class="panel-scroll">${renderSlides(s)}</div>
      </div>
      ${deepPanel("examples", "🌍 Ví dụ thực tế", "Gợi ý bằng AI")}
      ${deepPanel("tools", "🧰 Công cụ / Thư viện", "Gợi ý bằng AI")}
      ${deepPanel("videos", "🎬 Video liên quan", "Tìm video bằng AI")}
      ${deepPanel("practice", "🏋️ Hướng dẫn thực hành", "Soạn bằng AI")}
      <div class="panel">
        <div class="panel-h">🤔 Hỏi AI tra cứu</div>
        <div class="ask-row">
          <input id="deepAsk" placeholder="Hỏi điều muốn tra cứu về bài này...">
          <label class="chk"><input type="checkbox" id="deepWeb"> tìm web</label>
          <button class="mini-btn" id="deepAskBtn">Hỏi</button>
        </div>
        <div id="deepAskOut" class="ai-out"></div>
      </div>
    </div>
  `;
  $("listenAll").onclick = () => listenDeepAll();
  ["examples", "tools", "videos", "practice"].forEach((kind) => {
    $("gen-" + kind).onclick = () => genKnowledge(kind);
    $("listen-" + kind).onclick = () => listenPanel(kind);
  });
  $("deepAskBtn").onclick = () => deepAsk();
  loadSavedKnowledge();
}
function deepPanel(kind, title, btn) {
  return `<div class="panel" data-kind="${kind}">
    <div class="panel-h">${title}
      <span>
        <button class="mini-btn" id="listen-${kind}" title="Nghe">🎧</button>
        <button class="mini-btn" id="gen-${kind}">✨ ${btn}</button>
      </span>
    </div>
    <div id="out-${kind}" class="ai-out"></div>
  </div>`;
}

async function genKnowledge(kind) {
  if (!ensureKey()) return;
  const out = $("out-" + kind);
  out.innerHTML = `<div class="loading">⏳ Đang gọi AI...</div>`;
  try {
    const r = await api("POST", "/api/knowledge/generate", { kind, context: sessionContext(curSession) });
    if (!r.items.length) { out.innerHTML = `<p class="muted">AI không trả kết quả. Thử lại.</p>`; return; }
    out.innerHTML = r.items.map((it, i) => aiItemCard(kind, it, i)).join("");
    bindItemCards(out, kind);
  } catch (e) { out.innerHTML = `<p class="err">${escapeHtml(e.message)}</p>`; }
}
function aiItemCard(kind, it, i) {
  const isVid = kind === "videos" || /youtu|vimeo/.test(it.url || "");
  return `<div class="ai-item" data-i="${i}">
    <div class="ai-item-body">
      <b>${escapeHtml(it.title || "")}</b>
      <p>${mdLite(it.detail || "")}</p>
      ${it.url ? `<a href="${escapeHtml(it.url)}" target="_blank" rel="noopener">${isVid ? "▶ Xem video" : "🔗 Nguồn"}</a>` : ""}
    </div>
    <div class="ai-item-act">
      <button class="mini-btn save" data-json='${encodeURIComponent(JSON.stringify({ kind, ...it }))}'>💾 Lưu</button>
      <button class="mini-btn discard">✕</button>
    </div>
  </div>`;
}
function bindItemCards(scope, kind) {
  scope.querySelectorAll(".save").forEach((b) => b.onclick = async () => {
    const it = JSON.parse(decodeURIComponent(b.dataset.json));
    await saveKnowledge(it.kind || kind, it.title, it.detail, it.url);
    b.textContent = "✓ Đã lưu"; b.disabled = true;
  });
  scope.querySelectorAll(".discard").forEach((b) => b.onclick = () => b.closest(".ai-item").remove());
}

// Lưu kết quả AI vào KHO KIẾN THỨC + tạo tài liệu text trong THƯ VIỆN (yêu cầu 3)
async function saveKnowledge(kind, title, detail, url) {
  try {
    await api("POST", "/api/knowledge", { sessionId: curSession.id, kind, title, detail, url });
    await api("POST", "/api/resources", { sessionId: curSession.id, type: url ? "link" : "text", title: `[${kind}] ${title}`, url: url || "", note: detail, tags: ["đào-sâu", kind] });
    toast("Đã lưu vào Kho kiến thức + Thư viện");
    loadSavedKnowledge();
  } catch (e) { toast(e.message); }
}

async function loadSavedKnowledge() {
  try {
    const r = await api("GET", "/api/knowledge?sessionId=" + curSession.id);
    window.__savedKnowledge = r.items || [];
  } catch { window.__savedKnowledge = []; }
}

async function deepAsk() {
  if (!ensureKey()) return;
  const q = $("deepAsk").value.trim(); if (!q) return;
  const web = $("deepWeb").checked;
  const out = $("deepAskOut"); out.innerHTML = `<div class="loading">⏳ Đang hỏi AI...</div>`;
  try {
    const r = await api("POST", "/api/chat", { message: q, context: sessionContext(curSession), web });
    out.innerHTML = `<div class="ai-item"><div class="ai-item-body">${mdLite(r.answer)}
      ${citeHtml(r.citations)}</div>
      <div class="ai-item-act"><button class="mini-btn" id="saveAsk">💾 Lưu</button></div></div>`;
    $("saveAsk").onclick = () => saveKnowledge("qa", q, r.answer, (r.citations || [])[0]?.url || "");
  } catch (e) { out.innerHTML = `<p class="err">${escapeHtml(e.message)}</p>`; }
}
function citeHtml(cits) {
  if (!cits || !cits.length) return "";
  return `<div class="cites">Nguồn: ${cits.map((c) => `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">${escapeHtml(c.title || c.url).slice(0, 40)}</a>`).join(" · ")}</div>`;
}

// Nghe 1 bảng
function panelText(kind) {
  const out = $("out-" + kind); if (!out) return [];
  return [...out.querySelectorAll(".ai-item-body")].map((n) => n.innerText.replace(/\s+/g, " ").trim());
}
function listenPanel(kind) {
  const t = panelText(kind);
  if (!t.length) { toast("Chưa có nội dung. Bấm ✨ để AI gợi ý trước."); return; }
  TTS.start(t, "🎧 " + kind);
}
// Nghe TOÀN BỘ đào sâu: bài học + ví dụ + công cụ + video + thực hành + hỏi AI (yêu cầu 1)
function listenDeepAll() {
  let sents = sessionToSentences(curSession);
  for (const k of ["examples", "tools", "videos", "practice"]) sents = sents.concat(panelText(k));
  const askOut = $("deepAskOut"); if (askOut && askOut.innerText.trim()) sents.push(askOut.innerText.replace(/\s+/g, " ").trim());
  TTS.start(sents.filter(Boolean), "🎧 Toàn bộ đào sâu: " + curSession.title_vi);
}

/* ---------- Tab: Thư viện ---------- */
async function renderLibTab(body) {
  body.innerHTML = `<div class="loading">⏳ Đang tải thư viện...</div>`;
  let list = [];
  try { list = (await api("GET", "/api/resources?sessionId=" + curSession.id)).resources; } catch {}
  body.innerHTML = `
    <div class="lib-actions">
      <button class="chip-btn" data-add="youtube">➕ YouTube</button>
      <button class="chip-btn" data-add="facebook">➕ Reel FB</button>
      <button class="chip-btn" data-add="pdf">➕ PDF</button>
      <button class="chip-btn" data-add="image">➕ Ảnh</button>
      <button class="chip-btn" data-add="text">➕ Text</button>
      <button class="chip-btn" data-add="link">➕ Link</button>
      <button class="mini-btn" id="exportMd">⬇️ Xuất .md</button>
    </div>
    <div class="lib-list">${list.length ? list.map(resCard).join("") : `<p class="muted">Chưa có tài liệu. Thêm ở trên.</p>`}</div>
  `;
  document.querySelectorAll("[data-add]").forEach((b) => b.onclick = () => openAddResource(b.dataset.add));
  $("exportMd").onclick = () => exportMd(list);
  bindResCards(list);
}
function resCard(r) {
  let embed = "";
  if (r.type === "youtube") { const m = (r.url || "").match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/); if (m) embed = `<iframe class="embed" src="https://www.youtube.com/embed/${m[1]}" allowfullscreen loading="lazy"></iframe>`; }
  else if (r.type === "image" && r.url) embed = `<img class="embed-img" src="${escapeHtml(r.url)}" loading="lazy">`;
  else if (r.type === "facebook" && r.url) embed = `<iframe class="embed" src="https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(r.url)}" loading="lazy"></iframe>`;
  return `<div class="res-card" data-id="${r.id}">
    <div class="res-head">
      <span class="res-type">${r.type}</span>
      <b>${escapeHtml(r.title || "(không tên)")}</b>
      <div class="res-act">
        <button class="mini-btn insight-btn">✨ Rút insight</button>
        <button class="mini-btn del-res">🗑</button>
      </div>
    </div>
    ${r.url && (r.type === "link" || r.type === "pdf") ? `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">🔗 ${escapeHtml(r.url).slice(0, 60)}</a>` : ""}
    ${r.note ? `<p class="res-note">${mdLite(r.note)}</p>` : ""}
    ${(r.tags || []).length ? `<div class="tags">${r.tags.map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join("")}</div>` : ""}
    ${embed}
    ${r.insight ? insightHtml(r) : `<div class="insight-slot"></div>`}
  </div>`;
}
function insightHtml(r) {
  return `<div class="insight">${mdLite(r.insight)}${citeHtml(r.insightCitations)}<small class="via">via ${escapeHtml(r.insightVia || "")}</small></div>`;
}
function bindResCards(list) {
  document.querySelectorAll(".res-card").forEach((card) => {
    const id = card.dataset.id;
    card.querySelector(".del-res").onclick = async () => { if (!confirm("Xoá tài liệu?")) return; await api("DELETE", "/api/resources/" + id); renderTab(); };
    card.querySelector(".insight-btn").onclick = async (e) => {
      if (!ensureKey()) return;
      const slot = card.querySelector(".insight-slot") || card.querySelector(".insight");
      const b = e.target; b.disabled = true; b.textContent = "⏳...";
      try {
        const r = await api("POST", "/api/insight", { resourceId: id });
        const html = `<div class="insight">${mdLite(r.insight)}${citeHtml(r.citations)}<small class="via">via ${escapeHtml(r.via || "")}</small></div>`;
        if (slot) slot.outerHTML = html; else card.insertAdjacentHTML("beforeend", html);
        b.textContent = "✓ Đã rút";
      } catch (err) { toast(err.message); b.disabled = false; b.textContent = "✨ Rút insight"; }
    };
  });
}
function exportMd(list) {
  let md = `# Thư viện — ${curSession.title_vi}\n\n`;
  for (const r of list) {
    md += `## ${r.title}\n- Loại: ${r.type}\n`;
    if (r.url) md += `- Nguồn: ${r.url}\n`;
    if (r.note) md += `\n${r.note}\n`;
    if (r.insight) md += `\n**Insight:**\n${r.insight}\n`;
    md += `\n---\n\n`;
  }
  const blob = new Blob([md], { type: "text/markdown" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `thu-vien-${curSession.id}.md`; a.click();
}

/* ---------- Tab: Hỏi AI ---------- */
function renderAiTab(body) {
  body.innerHTML = `
    <div class="chat">
      <div id="chatLog" class="chat-log"></div>
      <div class="ask-row">
        <input id="chatInput" placeholder="Hỏi coach về bài này...">
        <label class="chk"><input type="checkbox" id="chatWeb"> tìm web</label>
        <button class="mini-btn primary" id="chatSend">Gửi</button>
      </div>
    </div>`;
  $("chatSend").onclick = chatSend;
  $("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") chatSend(); });
}
async function chatSend() {
  if (!ensureKey()) return;
  const inp = $("chatInput"); const q = inp.value.trim(); if (!q) return;
  const log = $("chatLog");
  log.insertAdjacentHTML("beforeend", `<div class="bubble me">${escapeHtml(q)}</div>`);
  inp.value = ""; log.insertAdjacentHTML("beforeend", `<div class="bubble ai" id="pending">⏳...</div>`);
  log.scrollTop = log.scrollHeight;
  try {
    const r = await api("POST", "/api/chat", { message: q, context: sessionContext(curSession), web: $("chatWeb").checked });
    $("pending").outerHTML = `<div class="bubble ai">${mdLite(r.answer)}${citeHtml(r.citations)}</div>`;
  } catch (e) { $("pending").outerHTML = `<div class="bubble ai err">${escapeHtml(e.message)}</div>`; }
  log.scrollTop = log.scrollHeight;
}

/* ================= QUIZ ================= */
async function quickQuiz(sessionId) {
  const s = CUR.sessions.find((x) => x.id === sessionId); if (!s) return;
  startQuiz({ scope: "bài: " + s.title_vi, context: sessionContext(s), count: 4, title: "Kiểm tra nhanh: " + s.title_vi, sessionId });
}
async function startQuiz({ scope, context, count, title, sessionId }) {
  if (!ensureKey()) return;
  openModal(title, `<div class="loading">⏳ Đang tạo đề...</div>`);
  try {
    const r = await api("POST", "/api/quiz/generate", { context, count: count || 6, scope });
    renderQuiz(r.questions || [], { title, sessionId, scope });
  } catch (e) { $("modalBody").innerHTML = `<p class="err">${escapeHtml(e.message)}</p>`; }
}
function renderQuiz(questions, meta) {
  if (!questions.length) { $("modalBody").innerHTML = `<p class="muted">Không tạo được đề. Thử lại.</p>`; return; }
  const html = questions.map((q, i) => {
    if (q.type === "mcq") {
      return `<div class="quiz-q" data-i="${i}" data-type="mcq" data-answer="${q.answer}">
        <p><b>Câu ${i + 1}.</b> ${escapeHtml(q.q)}</p>
        ${(q.options || []).map((o, j) => `<label class="quiz-opt"><input type="radio" name="q${i}" value="${j}"> ${escapeHtml(o)}</label>`).join("")}
        <div class="explain" hidden>${escapeHtml(q.explain || "")}</div>
      </div>`;
    }
    return `<div class="quiz-q" data-i="${i}" data-type="essay" data-guide="${encodeURIComponent(q.guide || "")}">
      <p><b>Câu ${i + 1}.</b> ${escapeHtml(q.q)}</p>
      <textarea rows="3" placeholder="Trả lời của bạn..."></textarea>
      <div class="explain" hidden></div>
    </div>`;
  }).join("");
  $("modalBody").innerHTML = `<div class="quiz">${html}</div>
    <div class="quiz-foot"><button class="mini-btn primary" id="quizSubmit">Nộp bài</button><div id="quizResult"></div></div>`;
  $("quizSubmit").onclick = () => submitQuiz(questions, meta);
}
async function submitQuiz(questions, meta) {
  const qs = [...document.querySelectorAll(".quiz-q")];
  let mcqScore = 0, mcqCount = 0;
  const essays = [];
  qs.forEach((node) => {
    const i = +node.dataset.i;
    if (node.dataset.type === "mcq") {
      mcqCount++;
      const chosen = node.querySelector("input:checked");
      const ans = +node.dataset.answer;
      const ok = chosen && +chosen.value === ans;
      if (ok) mcqScore++;
      node.classList.add(ok ? "correct" : "wrong");
      node.querySelectorAll(".quiz-opt").forEach((lab, j) => { if (j === ans) lab.classList.add("is-answer"); });
      node.querySelector(".explain").hidden = false;
    } else {
      essays.push({ i, q: questions[i].q, guide: decodeURIComponent(node.dataset.guide || ""), answer: node.querySelector("textarea").value });
    }
  });
  const result = $("quizResult"); result.innerHTML = `<div class="loading">⏳ Đang chấm...</div>`;
  let essayScores = [];
  if (essays.length) {
    try { const g = await api("POST", "/api/quiz/grade", { items: essays }); essayScores = g.results || []; }
    catch (e) { result.innerHTML = `<p class="err">${e.message}</p>`; }
  }
  essays.forEach((es, k) => {
    const node = qs.find((n) => +n.dataset.i === es.i);
    const sc = essayScores[k] || { score: 0, feedback: "" };
    const ex = node.querySelector(".explain"); ex.hidden = false;
    ex.innerHTML = `<b>${sc.score}/10</b> — ${escapeHtml(sc.feedback || "")}`;
  });
  const essayAvg = essayScores.length ? essayScores.reduce((a, b) => a + (b.score || 0), 0) / essayScores.length : null;
  const mcq10 = mcqCount ? (mcqScore / mcqCount) * 10 : null;
  let total;
  if (mcq10 != null && essayAvg != null) total = (mcq10 + essayAvg) / 2;
  else total = mcq10 != null ? mcq10 : (essayAvg != null ? essayAvg : 0);
  total = Math.round(total * 10) / 10;

  result.innerHTML = `<div class="quiz-score">Điểm: <b>${total}/10</b> ${mcqCount ? `· Trắc nghiệm ${mcqScore}/${mcqCount}` : ""}</div>
    <button class="mini-btn" id="saveQuizLib">📚 Lưu vào thư viện</button>`;

  // Lưu reviewlog cho kiểm tra nhanh theo bài
  if (meta.sessionId) { STATE.reviewlog[meta.sessionId] = { ts: Date.now(), score: total }; saveState(); }

  // Lưu kết quả vào thư viện (yêu cầu 3)
  $("saveQuizLib").onclick = async () => {
    const sid = meta.sessionId || (curSession && curSession.id) || CUR.sessions[0]?.id;
    let note = `# ${meta.title} — Điểm ${total}/10\n\n`;
    questions.forEach((q, i) => {
      note += `**Câu ${i + 1}:** ${q.q}\n`;
      if (q.type === "mcq") note += `- Đáp án đúng: ${q.options?.[q.answer] || ""}\n- Giải thích: ${q.explain || ""}\n\n`;
      else { const es = essays.find((e) => e.i === i); note += `- Trả lời: ${es?.answer || ""}\n- Gợi ý: ${q.guide || ""}\n\n`; }
    });
    try { await api("POST", "/api/resources", { sessionId: sid, type: "text", title: `[Kiểm tra] ${meta.title} (${total}/10)`, note, tags: ["kiểm-tra", "nhắc-nhớ"] }); toast("Đã lưu kết quả vào thư viện"); }
    catch (e) { toast(e.message); }
  };
}

/* ================= MODALS: add session / slide / resource / settings ================= */
function openAddSession() {
  const mods = [...new Set(CUR.sessions.map((s) => s.module))];
  openModal("Thêm module / bài học", `
    <label class="fld">Module <input id="asModule" list="modList" placeholder="Chọn hoặc gõ module mới"></label>
    <datalist id="modList">${mods.map((m) => `<option value="${escapeHtml(m)}">`).join("")}</datalist>
    <label class="fld">Tiêu đề (VI) <input id="asTitleVi"></label>
    <label class="fld">Tiêu đề (EN) <input id="asTitleEn"></label>
    <label class="fld">Phụ đề <input id="asSub"></label>
    <button class="mini-btn primary" id="asSave">Tạo bài học</button>
  `);
  $("asSave").onclick = async () => {
    const body = { module: $("asModule").value.trim(), title_vi: $("asTitleVi").value.trim(), title_en: $("asTitleEn").value.trim(), subtitle: $("asSub").value.trim() };
    if (!body.module || !body.title_vi) { toast("Nhập module và tiêu đề VI"); return; }
    try { const r = await api("POST", "/api/curriculum/sessions", body); CUR = await api("GET", "/api/curriculum"); closeModal(); location.hash = "#" + r.session.id; toast("Đã tạo bài học"); }
    catch (e) { toast(e.message); }
  };
}
function openAddSlide() {
  openModal("Thêm kiến thức (slide)", `
    <label class="fld">Loại
      <select id="slKind">
        <option value="concept">Khái niệm</option><option value="steps">Quy trình (đánh số)</option>
        <option value="technique">Kỹ thuật</option><option value="example">Ví dụ</option>
        <option value="practice">Thực hành</option><option value="pitfall">Lỗi thường gặp</option>
        <option value="terms">Thuật ngữ (A = B)</option>
      </select></label>
    <label class="fld">Nhãn <input id="slLabel" placeholder="vd: Khái niệm"></label>
    <label class="fld">Nội dung (mỗi dòng 1 ý) <textarea id="slLines" rows="5"></textarea></label>
    <button class="mini-btn primary" id="slSave">Thêm slide</button>
  `);
  $("slSave").onclick = async () => {
    const lines = $("slLines").value.split("\n").map((x) => x.trim()).filter(Boolean);
    if (!lines.length) { toast("Nhập nội dung"); return; }
    try { await api("POST", `/api/curriculum/sessions/${curSession.id}/slides`, { kind: $("slKind").value, label: $("slLabel").value.trim(), lines }); CUR = await api("GET", "/api/curriculum"); curSession = CUR.sessions.find((x) => x.id === curSession.id); closeModal(); renderTab(); toast("Đã thêm slide"); }
    catch (e) { toast(e.message); }
  };
}
function openAddResource(type) {
  const isFile = type === "pdf" || type === "image";
  openModal("Thêm tài liệu: " + type, `
    <label class="fld">Tiêu đề <input id="rTitle"></label>
    ${isFile
      ? `<label class="fld">Chọn file <input type="file" id="rFile" accept="${type === "pdf" ? "application/pdf" : "image/*"}"></label>`
      : `<label class="fld">${type === "text" ? "Nội dung" : "URL / Link"} ${type === "text" ? `<textarea id="rUrl" rows="4"></textarea>` : `<input id="rUrl" placeholder="https://...">`}</label>`}
    <label class="fld">Tag (phẩy) <input id="rTags" placeholder="vd: chốt-sale, ví-dụ"></label>
    <button class="mini-btn primary" id="rSave">Lưu tài liệu</button>
  `);
  $("rSave").onclick = async () => {
    const tags = ($("rTags").value || "").split(",").map((x) => x.trim()).filter(Boolean);
    try {
      if (isFile) {
        const f = $("rFile").files[0]; if (!f) { toast("Chọn file"); return; }
        const fd = new FormData(); fd.append("file", f); fd.append("sessionId", curSession.id); fd.append("type", type); fd.append("title", $("rTitle").value || f.name); fd.append("tags", JSON.stringify(tags));
        await api("POST", "/api/resources/upload", fd);
      } else {
        const val = $("rUrl").value.trim(); if (!val) { toast("Nhập nội dung/URL"); return; }
        const body = { sessionId: curSession.id, type, title: $("rTitle").value.trim(), tags };
        if (type === "text") body.note = val; else body.url = val;
        await api("POST", "/api/resources", body);
      }
      closeModal(); toast("Đã thêm tài liệu");
      if (curTab === "lib") renderTab();
    } catch (e) { toast(e.message); }
  };
}

async function openSettings() {
  let info = SETTINGS;
  try { info = await api("GET", "/api/settings"); SETTINGS = info; } catch {}
  openModal("⚙️ Cài đặt AI (OpenAI)", `
    <p class="muted">Key chỉ lưu trên máy chủ của bạn, không commit lên Git. ${info.envKey ? "<b>(Đang dùng key từ biến môi trường)</b>" : ""}</p>
    <label class="fld">OpenAI API Key <input id="setKey" type="password" placeholder="${info.hasKey ? "•••• đã lưu, nhập để đổi" : "sk-..."}"></label>
    <label class="fld">Model
      <select id="setModel">
        <option value="gpt-4o-mini"${info.model === "gpt-4o-mini" ? " selected" : ""}>gpt-4o-mini (rẻ, nhanh)</option>
        <option value="gpt-4o"${info.model === "gpt-4o" ? " selected" : ""}>gpt-4o (mạnh hơn)</option>
        <option value="gpt-4.1-mini"${info.model === "gpt-4.1-mini" ? " selected" : ""}>gpt-4.1-mini</option>
      </select></label>
    <button class="mini-btn primary" id="setSave">Lưu</button>
    <p class="muted" style="margin-top:8px">Trạng thái: ${info.hasKey ? "✅ Đã có key" : "⚠️ Chưa có key — các tính năng AI sẽ báo lỗi"}</p>
  `);
  $("setSave").onclick = async () => {
    try { const r = await api("POST", "/api/settings", { openaiKey: $("setKey").value, model: $("setModel").value }); SETTINGS = { ...SETTINGS, hasKey: r.hasKey, model: r.model }; closeModal(); toast("Đã lưu cài đặt"); }
    catch (e) { toast(e.message); }
  };
}
function ensureKey() {
  if (SETTINGS.hasKey) return true;
  toast("Chưa có OpenAI key — mở ⚙️ Cài đặt để nhập.");
  openSettings();
  return false;
}

/* ================= INIT ================= */
async function loadCurriculumRetry(n = 5) {
  for (let i = 0; i < n; i++) {
    try { return await api("GET", "/api/curriculum"); } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  throw new Error("Không tải được giáo án");
}

async function init() {
  // TTS voices
  if (window.speechSynthesis) { TTS.loadVoices(); speechSynthesis.onvoiceschanged = () => TTS.loadVoices(); }
  // mini-player controls
  $("mpToggle").onclick = () => TTS.toggle();
  $("mpNext").onclick = () => TTS.next();
  $("mpPrev").onclick = () => TTS.prev();
  $("mpClose").onclick = () => TTS.stop();
  $("mpRate").onchange = (e) => { TTS.rate = +e.target.value; if (TTS.playing) TTS.speakCurrent(); };
  $("mpVoice").onchange = (e) => { TTS.voice = TTS.voices.find((v) => v.name === e.target.value) || TTS.voice; if (TTS.playing) TTS.speakCurrent(); };
  // modal + settings
  $("modalClose").onclick = closeModal;
  $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
  $("settingsBtn").onclick = openSettings;
  $("brandLink").onclick = (e) => { e.preventDefault(); goHome(); };

  // load data
  try {
    CUR = await loadCurriculumRetry();
    window.__appReady = true;
  } catch (e) {
    $("home-view").innerHTML = `<p class="err" style="padding:40px">Không tải được dữ liệu. Thử tải lại trang.</p>`;
    // tự reload 1 lần
    if (!sessionStorage.getItem("reloaded")) { sessionStorage.setItem("reloaded", "1"); setTimeout(() => location.reload(), 1500); }
    return;
  }
  try { STATE = await api("GET", "/api/state"); } catch {}
  if (!STATE.plan) STATE.plan = { perWeek: 3, minPerDay: 30 };
  if (!STATE.progress) STATE.progress = {};
  if (!STATE.studylog) STATE.studylog = {};
  if (!STATE.reviewlog) STATE.reviewlog = {};
  try { SETTINGS = await api("GET", "/api/settings"); } catch {}

  window.addEventListener("hashchange", route);
  route();
}

// Cold-start guard: nếu sau 8s chưa sẵn sàng thì reload 1 lần
setTimeout(() => {
  if (!window.__appReady && !sessionStorage.getItem("reloaded")) { sessionStorage.setItem("reloaded", "1"); location.reload(); }
}, 8000);

init();
