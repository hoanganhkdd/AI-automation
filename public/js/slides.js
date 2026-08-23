// Render slide + markdown nhẹ + trích text cho đọc to (TTS)
(function () {
function escapeHtml(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// **đậm**, *nghiêng*, xuống dòng
function mdLite(s = "") {
  let t = escapeHtml(s);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  t = t.replace(/\*([^*]+)\*/g, "<i>$1</i>");
  t = t.replace(/\n/g, "<br>");
  return t;
}

const KIND_ICON = {
  title: "🎯", concept: "💡", steps: "🪜", technique: "🛠️",
  example: "🌍", practice: "🏋️", pitfall: "⚠️", terms: "📚",
};
const KIND_LABEL = {
  concept: "Khái niệm", steps: "Quy trình", technique: "Kỹ thuật",
  example: "Ví dụ", practice: "Thực hành", pitfall: "Lỗi thường gặp", terms: "Thuật ngữ",
};

// Bản dịch tiếng Anh cho nội dung bài học (VI -> EN), do app.js nạp vào
let LTRANS = {};
function setLessonTrans(map) { Object.assign(LTRANS, map || {}); }
function enOf(text) { const e = LTRANS[text]; return e && e !== text ? `<div class="ln-en">${mdLite(e)}</div>` : ""; }

function renderSlide(slide, opts = {}) {
  const lines = slide.lines || [];
  const delBtn = slide.custom && opts.allowDelete
    ? `<button class="slide-del" data-slide-n="${slide.n}" title="Xoá slide">🗑</button>` : "";

  if (slide.kind === "title") {
    return `<div class="slide slide-title">
      <div class="kicker">${escapeHtml(lines[1] || "")}</div>
      <h2>${escapeHtml(lines[0] || "")}</h2>
      <p class="subtitle">${escapeHtml(lines[2] || "")}</p>
    </div>`;
  }

  const label = slide.label || KIND_LABEL[slide.kind] || "";
  const icon = KIND_ICON[slide.kind] || "•";
  let inner = "";

  if (slide.kind === "steps") {
    inner = `<ol class="steps">${lines.map((l) => `<li>${mdLite(l)}${enOf(l)}</li>`).join("")}</ol>`;
  } else if (slide.kind === "terms") {
    inner = `<div class="terms">${lines.map((l) => {
      const idx = l.indexOf("=");
      if (idx > -1) return `<div class="term"><span class="term-k">${mdLite(l.slice(0, idx).trim())}</span><span class="term-v">${mdLite(l.slice(idx + 1).trim())}${enOf(l)}</span></div>`;
      return `<div class="term"><span class="term-v">${mdLite(l)}${enOf(l)}</span></div>`;
    }).join("")}</div>`;
  } else if (slide.kind === "example") {
    inner = `<div class="example-box">${lines.map((l) => `<p>${mdLite(l)}${enOf(l)}</p>`).join("")}</div>`;
  } else {
    inner = `<ul class="bullets">${lines.map((l) => `<li>${mdLite(l)}${enOf(l)}</li>`).join("")}</ul>`;
  }

  const cls = slide.kind === "pitfall" ? "slide slide-pitfall" : "slide";
  return `<div class="${cls}" data-kind="${slide.kind}">
    <div class="slide-head"><span class="slide-icon">${icon}</span><span class="slide-label">${escapeHtml(label)}</span>${delBtn}</div>
    ${inner}
  </div>`;
}

function renderSlides(session, opts = {}) {
  return (session.slides || []).map((s) => renderSlide(s, opts)).join("");
}

// ----- Trích text cho TTS -----
function slideToText(slide) {
  const lines = slide.lines || [];
  if (slide.kind === "title") return lines.filter(Boolean).join(". ");
  const label = slide.label || KIND_LABEL[slide.kind] || "";
  const body = lines.map((l) => l.replace(/\*\*/g, "").replace(/\*/g, "").replace(/\n/g, " ")).join(". ");
  return (label ? label + ". " : "") + body;
}
function sessionToSentences(session) {
  const out = [];
  for (const s of session.slides || []) {
    const lines = s.lines || [];
    if (s.kind === "title") { out.push(lines.filter(Boolean).join(". ")); continue; }
    const label = s.label || KIND_LABEL[s.kind] || "";
    if (label) out.push(label);
    for (const l of lines) out.push(l.replace(/\*\*/g, "").replace(/\*/g, "").replace(/\n/g, " ").trim());
  }
  return out.filter(Boolean);
}

window.SLIDES = { renderSlide, renderSlides, slideToText, sessionToSentences, mdLite, escapeHtml, setLessonTrans };
})();
