/* Agent 面试通关 — 多邻国式学习 H5
 * 数据: data/questions/_chapters.json + 每章一个 json（可自由增减文件）
 * 进度: localStorage(aiinterview.v1)
 * LLM : 设置页配置 OpenAI 兼容 API（baseURL/model/apiKey），支持流式解读与批量生成选择题
 */
"use strict";

/* ================= 常量与状态 ================= */
const LS_KEY = "aiinterview.v1";
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = {
  chapters: [],        // [{id,file,title,icon,color,desc,count}]
  cache: {},           // chapterId -> questions
  progress: null,      // 进度持久化
  view: "path",
  route: null,         // {name, chapter, seq} 当前学习会话
};

function defaultProgress() {
  return {
    xp: 0,
    streak: 0,
    lastDay: "",
    days: {},                 // "2026-09-02": true
    chapters: {},             // chapterId: { learned: [qid...], quizDone: bool, bestAccuracy: 0 }
    settings: {
      baseURL: "", model: "", apiKey: "",
      unlockAll: false,       // 解锁全部章节
      theme: "light",
      autoAI: true,           // 学习卡片答完自动请求 AI 解读（有 quiz 时）
    },
  };
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      const d = defaultProgress();
      state.progress = Object.assign(d, p);
      state.progress.settings = Object.assign(d.settings, p.settings || {});
      return;
    }
  } catch (e) { console.warn("progress load fail", e); }
  state.progress = defaultProgress();
}
function saveProgress() { localStorage.setItem(LS_KEY, JSON.stringify(state.progress)); }

function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function touchStreak() {
  const t = today();
  const p = state.progress;
  if (p.lastDay === t) return;
  const y = new Date(Date.now() - 864e5);
  const ystr = `${y.getFullYear()}-${String(y.getMonth()+1).padStart(2,"0")}-${String(y.getDate()).padStart(2,"0")}`;
  p.streak = (p.lastDay === ystr) ? p.streak + 1 : 1;
  p.lastDay = t; p.days[t] = true;
}
function chProg(id) {
  const p = state.progress;
  if (!p.chapters[id]) p.chapters[id] = { learned: [], quizDone: false, bestAccuracy: 0 };
  return p.chapters[id];
}

/* ================= 数据加载 ================= */
const LS_QUIZ_KEY = "aiinterview.quizgen.v1"; // qid -> quiz（前端批量生成结果持久化）

function loadGenQuizzes() {
  try { return JSON.parse(localStorage.getItem(LS_QUIZ_KEY) || "{}"); }
  catch (e) { return {}; }
}
function saveGenQuiz(qid, quiz) {
  const c = loadGenQuizzes();
  c[qid] = quiz;
  try { localStorage.setItem(LS_QUIZ_KEY, JSON.stringify(c)); }
  catch (e) { console.warn("quiz 缓存写入失败（可能超容量）", e); }
}

async function fetchJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}
async function loadChapters() {
  const meta = await fetchJSON("data/questions/_chapters.json");
  state.chapters = (meta.chapters || []).filter(c => c.id !== "_chapters");
  // 支持用户自建章节文件：目录约定 data/questions/*.json（除 _ 开头）都会被 _chapters.json 引用；
  // 若用户手动加了文件却没登记，则仍以 _chapters.json 为准（增删文件后重跑 tools/extract_questions.py 或手改清单）。
}
async function loadChapter(id) {
  if (state.cache[id]) return state.cache[id];
  const meta = state.chapters.find(c => c.id === id);
  const data = await fetchJSON(`data/questions/${meta.file}`);
  const qs = data.questions || [];
  // 合并前端批量生成的 quiz（localStorage 持久化，优先级低于 JSON 文件里的 quiz）
  const gen = loadGenQuizzes();
  for (const q of qs) {
    if (!q.quiz && gen[q.id]) q.quiz = gen[q.id];
  }
  state.cache[id] = qs;
  return qs;
}

/* ================= markdown 渲染 ================= */
function mdRender(src) {
  // 图片路径改写：Images_attachments/.. -> data/assets/..
  const fixed = String(src).replace(/\((Images_attachments\/[^)]+)\)/g, "(data/assets/$1)");
  const html = marked.parse(fixed);
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
}

/* ================= 路由 / 视图切换 ================= */
function setView(name) {
  state.view = name;
  render();
}
function render() {
  const view = $("#view");
  $("#bottombar").hidden = !["path", "stats", "settings"].includes(state.view);
  $("#btn-back").hidden = state.view !== "lesson"; // 仅答题/学习页显示
  $("#progress-wrap").hidden = !(["lesson", "result"].includes(state.view) && state.route && state.route.list);
  document.body.classList.toggle("dark", state.progress.settings.theme === "dark");
  const tab = { path: "path", stats: "stats", settings: "settings" }[state.view];
  $$("#bottombar .tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  $("#streak-n").textContent = state.progress.streak;
  $("#xp-n").textContent = state.progress.xp;
  if (state.view === "path") renderPath(view);
  else if (state.view === "stats") renderStats(view);
  else if (state.view === "settings") renderSettings(view);
  else if (state.view === "lesson") {
    if (state.route && state.route.list) renderLessonStep(view); // 会话进行中：直接渲染当前步，不重建列表
    else renderLesson(view);
  }
  else if (state.view === "result") renderResult(view);
  window.scrollTo(0, 0);
}

/* ================= 路径视图（多邻国地图） ================= */
function chapterUnlocked(idx) {
  if (state.progress.settings.unlockAll) return true;
  if (idx === 0) return true;
  const prev = state.chapters[idx - 1];
  const pp = state.progress.chapters[prev.id];
  return !!(pp && pp.learned.length > 0); // 学过上一章任意一题即解锁（宽松）
}
function renderPath(el) {
  const totalQ = state.chapters.reduce((s, c) => s + c.count, 0);
  const learnedQ = Object.values(state.progress.chapters).reduce((s, c) => s + c.learned.length, 0);
  const pct = totalQ ? Math.round(learnedQ / totalQ * 100) : 0;
  el.innerHTML = `
    <div class="path-hero">
      <h1>Agent 面试通关</h1>
      <p>AI 应用开发 · ${state.chapters.length} 章 · ${totalQ} 题</p>
      <div class="progress-wrap total-bar" style="padding:0 30px">
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <span class="progress-num">${pct}%</span>
      </div>
    </div>
    <div class="path" id="path"></div>`;
  const path = $("#path", el);
  const zig = [-64, -32, 0, 32, 64]; // 蛇形偏移（420px 容器内收敛，节点72px+余量）
  state.chapters.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "node-row";
    const cp = state.progress.chapters[c.id] || { learned: [], quizDone: false };
    const learned = cp.learned.length;
    const done = learned >= c.count;
    const unlocked = chapterUnlocked(i);
    let cls = done ? "done" : (unlocked ? "current" : "locked");
    const icon = unlocked ? c.icon : "🔒";
    row.innerHTML = `
      <button class="node ${cls}" style="color:#fff; --tx:${zig[i % zig.length]}px" data-i="${i}" ${unlocked ? "" : "disabled"}>
        <span class="n-icon">${icon}</span>
        ${done ? '<span class="n-check">✓</span>' : ""}
        <span class="n-label">${esc(c.title)} ${learned}/${c.count}</span>
      </button>`;
    path.appendChild(row);
  });
  $$(".node", path).forEach(n => n.addEventListener("click", () => openChapterPopup(+n.dataset.i)));
}

function openChapterPopup(idx) {
  const c = state.chapters[idx];
  const cp = chProg(c.id);
  const learned = cp.learned.length;
  const quizCount = state.cache[c.id] ? state.cache[c.id].filter(q => q.quiz).length : 0;
  const popup = document.createElement("div");
  popup.className = "popover-mask";
  popup.innerHTML = `
    <div class="popover" onclick="event.stopPropagation()">
      <h3>${c.icon} ${esc(c.title)}</h3>
      ${c.desc ? `<div class="p-desc">${esc(c.desc)}</div>` : ""}
      <div class="p-meta">
        <span>📖 题目 <b>${c.count}</b></span>
        <span>✅ 已学 <b>${learned}</b></span>
        <span class="q-count-slot">🎯 练习题 <b>…</b></span>
      </div>
      <div class="p-actions">
        <button class="btn btn-primary" id="pp-learn">${learned ? "继续学习" : "开始学习"}</button>
        <button class="btn btn-ghost" id="pp-quiz" hidden>章节测验</button>
      </div>
    </div>`;
  popup.addEventListener("click", () => popup.remove());
  document.body.appendChild(popup);
  $("#pp-learn", popup).addEventListener("click", () => { popup.remove(); startLesson(c.id, "learn"); });
  const qz = $("#pp-quiz", popup);
  qz.addEventListener("click", () => { popup.remove(); startLesson(c.id, "quiz"); });
  // 异步加载章节，更新练习题数
  loadChapter(c.id).then(qs => {
    const n = qs.filter(q => q.quiz).length;
    $(".q-count-slot", popup).innerHTML = `🎯 练习题 <b>${n}</b>`;
    if (n > 0) { qz.hidden = false; qz.textContent = `章节测验 (${n})`; qz.className = "btn " + (cp.quizDone ? "btn-ghost" : "btn-blue"); }
    else { $(".q-count-slot", popup).innerHTML = `🎯 练习题 <b>0</b>（可去设置页批量生成）`; }
  }).catch(() => { $(".q-count-slot", popup).innerHTML = `🎯 练习题 <b>?</b>`; });
}

/* ================= 学习会话 ================= */
function startLesson(chapterId, mode) {
  state.route = { chapter: chapterId, mode, seq: 0, correct: 0, total: 0, t0: Date.now(), mistakeIds: [] };
  setView("lesson");
}
async function renderLesson(el) {
  const r = state.route;
  const meta = state.chapters.find(c => c.id === r.chapter);
  el.innerHTML = `<div class="loading-center"><div class="spinner"></div>加载中…</div>`;
  let questions;
  try { questions = await loadChapter(r.chapter); } catch (e) {
    el.innerHTML = `<div class="loading-center">章节加载失败：${esc(e.message)}</div>`;
    return;
  }
  if (r.mode === "learn") {
    // 学习模式：未学题目优先（每轮最多 8 题），全学完则复习已学题
    const cp = chProg(r.chapter);
    const fresh = questions.filter(q => !cp.learned.includes(q.id));
    const old = questions.filter(q => cp.learned.includes(q.id));
    r.list = (fresh.length ? fresh : old).slice(0, 8);
    if (!r.list.length) r.list = questions.slice(0, 8);
  } else {
    const withQuiz = questions.filter(q => q.quiz);
    r.list = shuffle(withQuiz).slice(0, 10);
  }
  r.total = r.list.length;
  r.answered = 0;
  if (!r.list.length) { finishLesson(); return; }
  renderLessonStep(el);
}

function shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function renderLessonStep(el) {
  const r = state.route;
  const meta = state.chapters.find(c => c.id === r.chapter);
  const q = r.list[r.seq];
  $("#progress-wrap").hidden = false;
  $("#lesson-progress").style.width = `${Math.round(r.seq / r.total * 100)}%`;
  $("#lesson-progress-num").textContent = `${r.seq + 1}/${r.total}`;

  if (!q) { finishLesson(); return; }

  if (r.mode === "learn") {
    el.innerHTML = `
      <div class="lesson-wrap">
        <div class="lesson-head">
          <button class="lesson-x" id="lx">✕</button>
          <div class="prompt-tag">${meta.icon} ${esc(meta.title)} · 学习</div>
        </div>
        <div class="lesson-body">
          <div class="q-title">${esc(q.title)}</div>
          <div class="q-sub">先自己想一想，再展开答案 👇</div>
          <details class="more" id="ans-reveal">
            <summary>查看参考答案</summary>
            <div class="study-card" style="margin-top:10px"><div class="md">${mdRender(q.answer_md)}</div></div>
          </details>
          <div class="ai-box" id="ai-zone" hidden>
            <div class="ai-head">🤖 AI 追问解读</div>
            <div class="md" id="ai-content"></div>
          </div>
        </div>
        <div class="lesson-foot">
          <button class="btn btn-ghost btn-sm" id="btn-prev" ${r.seq === 0 ? "disabled" : ""}>← 上一题</button>
          <button class="btn btn-ghost btn-sm" id="btn-ai">🤖 AI 解读</button>
          <button class="btn btn-primary" id="btn-next">继续</button>
        </div>
      </div>`;
    $("#lx").addEventListener("click", () => { if (confirmExit()) setView("path"); });
    $("#btn-next").addEventListener("click", () => { markLearned(q.id); r.seq++; renderLessonStep(el); });
    const prevBtn = $("#btn-prev");
    if (prevBtn && !prevBtn.disabled) prevBtn.addEventListener("click", () => { r.seq = Math.max(0, r.seq - 1); renderLessonStep(el); });
    $("#btn-ai").addEventListener("click", () => askAI(q));
    // 互斥：展开参考答案时收起 AI 解读
    const reveal = $("#ans-reveal");
    reveal.addEventListener("toggle", () => {
      if (reveal.open) { const z = $("#ai-zone"); if (z) z.hidden = true; }
    });
  } else {
    renderQuizStep(el, q);
  }
}

function confirmExit() { return true; } // 轻量：直接退出（进度已即时保存）

function markLearned(qid) {
  const cp = chProg(state.route.chapter);
  if (!cp.learned.includes(qid)) {
    cp.learned.push(qid);
    state.progress.xp += 10;
    touchStreak(); saveProgress();
  }
}

/* ---------- 答题（quiz）步骤 ---------- */
function renderQuizStep(el, q) {
  const r = state.route;
  const meta = state.chapters.find(c => c.id === r.chapter);
  const quiz = q.quiz;
  if (!quiz) { // 兜底：无预生成选择题时按学习卡展示
    r.seq++;
    if (r.seq >= r.list.length) { finishLesson(); return; }
    renderQuizStep(el, r.list[r.seq]);
    return;
  }
  const keys = ["A", "B", "C", "D"].slice(0, quiz.options.length);
  const answeredPick = r.picks ? r.picks[q.id] : undefined; // 已答恢复态（返回上一题）
  el.innerHTML = `
    <div class="lesson-wrap">
      <div class="lesson-head">
        <button class="lesson-x" id="lx">✕</button>
        <div class="prompt-tag">${meta.icon} ${esc(meta.title)} · 测验</div>
      </div>
      <div class="lesson-body">
        <div class="prompt-tag">选择最佳答案</div>
        <div class="q-title">${esc(quiz.stem || q.title)}</div>
        <div class="options" id="opts">
          ${quiz.options.map((o, i) => `
            <button class="option" data-i="${i}">
              <span class="opt-key">${keys[i]}</span>
              <span>${esc(o)}</span>
            </button>`).join("")}
        </div>
        <div class="ai-box" id="ai-zone" hidden>
          <div class="ai-head">🤖 AI 解读</div>
          <div class="md" id="ai-content"></div>
        </div>
      </div>
      <div class="lesson-foot">
        <button class="btn btn-ghost btn-sm" id="btn-prev" ${r.seq === 0 ? "disabled" : ""}>← 上一题</button>
        ${answeredPick !== undefined ? '<button class="btn btn-ghost btn-sm" id="btn-rejudge">📋 查看判题</button>' : ""}
      </div>
    </div>`;
  $("#lx").addEventListener("click", () => setView("path"));
  const prevBtn = $("#btn-prev");
  if (prevBtn && !prevBtn.disabled) prevBtn.addEventListener("click", () => { r.seq = Math.max(0, r.seq - 1); renderLessonStep(el); });

  // 恢复已答状态（返回上一题时不重复计分、锁定选项、不自动弹判题）
  if (answeredPick !== undefined) {
    $$(".option", el).forEach(b => {
      const i = +b.dataset.i; b.disabled = true;
      if (i === quiz.answer) b.classList.add("correct");
      else if (i === answeredPick) b.classList.add("wrong");
    });
    const rj = $("#btn-rejudge");
    if (rj) rj.addEventListener("click", () => showJudge(answeredPick === quiz.answer, quiz.explain || "可展开 AI 解读查看详解。", q, { restore: true }));
    return;
  }

  $$(".option", el).forEach(btn => btn.addEventListener("click", () => {
    const picked = +btn.dataset.i;
    // 记录本题作答（供返回上一题恢复）
    r.picks = r.picks || {};
    r.picks[q.id] = picked;
    const ok = picked === quiz.answer;
    r.total++;
    if (ok) { r.correct++; state.progress.xp += 15; } else r.mistakeIds.push(q.id);
    touchStreak(); saveProgress();
    $$(".option", el).forEach(b => {
      const i = +b.dataset.i; b.disabled = true;
      if (i === quiz.answer) b.classList.add("correct");
      else if (i === picked) b.classList.add("wrong");
    });
    showJudge(ok, quiz.explain || "可展开 AI 解读查看详解。", q);
  }));
}

function fallbackQuiz(q) {
  // 没有预生成 quiz 且无 API 时：题目即问题，把答案首段作为“正确项”的占位测验不做——
  // 改为“自评式”：显示参考答案 + 自评。这里返回 null 由上层走 study 流程更合理。
  return null;
}

function showJudge(ok, explain, q, opts = {}) {
  const old = $("#judge"); if (old) old.remove();
  const j = document.createElement("div");
  j.className = "judge " + (ok ? "good" : "bad"); j.id = "judge";
  j.innerHTML = `
    <div class="j-icon">${ok ? "✅" : "❌"}</div>
    <div style="flex:1">
      <div class="j-title">${ok ? "回答正确！" : "再想想～"}</div>
      <div class="j-exp">${esc(explain).slice(0, 220)}</div>
    </div>
    <button class="btn ${ok ? "btn-primary" : "btn-blue"}" id="j-next">${opts.restore ? "返回本题" : "继续"}</button>`;
  document.body.appendChild(j);
  $("#j-next", j).addEventListener("click", () => {
    j.remove();
    if (opts.restore) { renderLessonStep($("#view")); return; } // 恢复态：仅重绘（上一题操作已改 seq）
    const r = state.route;
    if (!ok) { showAnswerDetail(q); } else { r.seq++; renderLessonStep($("#view")); }
  });
}

function showAnswerDetail(q) {
  const old = $("#judge"); if (old) old.remove();
  const j = document.createElement("div");
  j.className = "judge bad"; j.id = "judge";
  j.innerHTML = `
    <div class="j-icon">📖</div>
    <div style="flex:1">
      <div class="j-title">参考答案</div>
      <div class="md" style="font-size:.84rem; max-height:26vh; overflow:auto; margin-top:6px">${mdRender(q.answer_md)}</div>
    </div>
    <button class="btn btn-primary" id="j-next">继续</button>`;
  document.body.appendChild(j);
  $("#j-next", j).addEventListener("click", () => { j.remove(); state.route.seq++; renderLessonStep($("#view")); });
}

/* ---------- 学习模式的 AI 按钮 / 答题后的 AI ---------- */
const AI_CACHE_KEY = "aiinterview.ai.v1"; // qid -> {md, at}

function loadAICache() {
  try { return JSON.parse(localStorage.getItem(AI_CACHE_KEY) || "{}"); }
  catch (e) { return {}; }
}
function saveAICacheEntry(qid, md) {
  const c = loadAICache();
  c[qid] = { md, at: Date.now() };
  localStorage.setItem(AI_CACHE_KEY, JSON.stringify(c));
}
function getCachedAI(qid) {
  return loadAICache()[qid] || null;
}

async function askAI(q, force = false) {
  const zone = $("#ai-zone"); const content = $("#ai-content");
  if (!zone || !content) return;
  if (!llmReady()) { toast("未配置大模型 API，请到设置页填写"); showSettingsFromAnywhere(); return; }

  // 互斥：展开 AI 解读时收起参考答案
  const reveal = $("#ans-reveal");
  if (reveal) reveal.open = false;

  // 缓存命中：直接渲染（force=true 时走重新生成）
  if (!force) {
    const cached = getCachedAI(q.id);
    if (cached && cached.md) {
      zone.hidden = false;
      renderAIBody(content, cached.md, q);
      return;
    }
  }

  zone.hidden = false;
  content.innerHTML = `<div class="ai-loading">正在生成解读<span class="dots"></span></div>`;
  zone.scrollIntoView({ behavior: "smooth", block: "nearest" });
  try {
    const prompt = `你是一位资深的 AI 应用开发面试官。请针对下面的面试题和参考答案，给出简洁的解读与面试攻略：1) 核心考点一句话；2) 回答框架（要点式）；3) 常见追问 2-3 个及应对思路；4) 一个易错点。用中文，markdown 格式，总长不超过 500 字。\n\n## 面试题\n${q.title}\n\n## 参考答案\n${q.answer_md.slice(0, 3500)}`;
    // 流式输出：边收边渲染
    let acc = "";
    await llmChatStream(prompt, (chunk) => {
      acc += chunk;
      content.innerHTML = mdRender(acc);
      // 流式期间滚动跟随
      const box = content.closest(".ai-box");
      if (box) box.scrollIntoView({ block: "nearest" });
    });
    if (!acc.trim()) throw new Error("模型返回为空");
    saveAICacheEntry(q.id, acc); // 自动缓存
    renderAIBody(content, acc, q);
  } catch (e) {
    content.innerHTML = `<div style="color:var(--red);font-size:.85rem">AI 请求失败：${esc(e.message)}</div>`;
  }
}

/* 渲染 AI 解读正文 + 底部操作条（缓存时间 / 重新解读） */
function renderAIBody(content, md, q) {
  content.innerHTML = mdRender(md);
  // 操作条挂在 content 后（避免被 sanitize 影响，单独一个兄弟节点）
  let foot = content.parentElement.querySelector(".ai-foot");
  if (!foot) {
    foot = document.createElement("div");
    foot.className = "ai-foot";
    foot.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-top:10px;padding-top:8px;border-top:1px dashed #d9c8f5";
    content.parentElement.appendChild(foot);
  }
  const cached = getCachedAI(q.id);
  const when = cached ? new Date(cached.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  foot.innerHTML = `
    <span style="font-size:.72rem;color:var(--ink-faint)">${cached ? "缓存于 " + when : ""}</span>
    <button class="btn btn-ghost btn-sm" style="box-shadow:none;padding:4px 12px" id="ai-regen">🔄 重新解读</button>`;
  const btn = foot.querySelector("#ai-regen");
  if (btn) btn.addEventListener("click", () => askAI(q, true));
}

/* ---------- LLM 流式调用（OpenAI 兼容 SSE） ---------- */
async function llmChatStream(prompt, onChunk, opts = {}) {
  const s = state.progress.settings;
  const res = await fetch(`${s.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${s.apiKey}` },
    body: JSON.stringify({
      model: s.model,
      messages: [
        { role: "system", content: "你是一位资深的 AI 应用开发面试辅导专家。" },
        { role: "user", content: prompt },
      ],
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 1600,
      stream: true,
    }),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 200); } catch (e) {}
    throw new Error(`HTTP ${res.status} ${detail}`);
  }
  if (!res.body) { // 环境不支持流式读取，退回非流式
    const data = await res.json();
    onChunk(data.choices?.[0]?.message?.content ?? "");
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const j = JSON.parse(payload);
        const delta = j.choices?.[0]?.delta?.content ?? "";
        if (delta) onChunk(delta);
      } catch (e) { /* 忽略半包 */ }
    }
  }
}

function showSettingsFromAnywhere() { setView("settings"); }

/* ================= 结算 ================= */
function finishLesson() {
  const r = state.route;
  if (r.mode === "quiz") {
    const cp = chProg(r.chapter);
    const acc = r.total ? Math.round(r.correct / r.total * 100) : 0;
    if (acc > (cp.bestAccuracy || 0)) cp.bestAccuracy = acc;
    cp.quizDone = r.total > 0 && acc >= 60;
    saveProgress();
    r.result = { acc, correct: r.correct, total: r.total, time: Math.round((Date.now() - r.t0) / 1000) };
  } else {
    r.result = null;
  }
  state.view = "result";
  render();
}
function renderResult(el) {
  const r = state.route;
  const meta = state.chapters.find(c => c.id === r.chapter);
  if (!r.result) {
    el.innerHTML = `
      <div class="result-wrap">
        <div class="r-emoji">🎉</div>
        <h2>学习完成！</h2>
        <div class="r-sub">${meta.icon} ${esc(meta.title)}</div>
        <div class="result-stats">
          <div class="result-stat"><b class="r-xp">+${r.total * 10}</b><span>XP</span></div>
        </div>
        <button class="btn btn-primary" id="r-back">返回路径</button>
      </div>`;
    $("#r-back").addEventListener("click", () => { state.route = null; setView("path"); });
    return;
  }
  const good = r.result.acc >= 60;
  el.innerHTML = `
    <div class="result-wrap">
      <div class="r-emoji">${good ? "🏆" : "💪"}</div>
      <h2>${good ? "测验通过！" : "继续加油！"}</h2>
      <div class="r-sub">${meta.icon} ${esc(meta.title)}</div>
      <div class="result-stats">
        <div class="result-stat"><b class="r-accuracy">${r.result.acc}%</b><span>正确率</span></div>
        <div class="result-stat"><b class="r-xp">${r.result.correct}/${r.result.total}</b><span>答对题数</span></div>
        <div class="result-stat"><b class="r-time">${fmtTime(r.result.time)}</b><span>用时</span></div>
      </div>
      ${r.mistakeIds.length ? `<div class="r-sub" style="margin-bottom:14px">错题 ${r.mistakeIds.length} 个，建议回头复习</div>` : ""}
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        <button class="btn btn-ghost" id="r-retry">再测一次</button>
        <button class="btn btn-primary" id="r-back">返回路径</button>
      </div>
    </div>`;
  $("#r-retry").addEventListener("click", () => startLesson(r.chapter, "quiz"));
  $("#r-back").addEventListener("click", () => { state.route = null; setView("path"); });
}
const fmtTime = (s) => s < 60 ? `${s}s` : `${Math.floor(s/60)}m${s%60}s`;

/* ================= 统计视图 ================= */
function renderStats(el) {
  const totalQ = state.chapters.reduce((s, c) => s + c.count, 0);
  const learnedQ = Object.values(state.progress.chapters).reduce((s, c) => s + c.learned.length, 0);
  const pct = totalQ ? Math.round(learnedQ / totalQ * 100) : 0;
  const R = 62, C = 2 * Math.PI * R;
  const quizDone = state.chapters.filter(c => state.progress.chapters[c.id]?.quizDone).length;
  el.innerHTML = `
    <div class="stats-wrap">
      <div class="stats-hero">
        <div class="ring">
          <svg width="150" height="150">
            <circle cx="75" cy="75" r="${R}" fill="none" stroke="var(--border-soft)" stroke-width="14"/>
            <circle cx="75" cy="75" r="${R}" fill="none" stroke="var(--green)" stroke-width="14"
              stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct/100)}" style="transition:stroke-dashoffset .6s"/>
          </svg>
          <div class="ring-num"><b>${pct}%</b><span>总进度</span></div>
        </div>
        <div class="stat-grid">
          <div class="stat-box"><span class="sb-icon">⚡</span><b>${state.progress.xp}</b><span>经验</span></div>
          <div class="stat-box"><span class="sb-icon">🔥</span><b>${state.progress.streak}</b><span>连续天数</span></div>
          <div class="stat-box"><span class="sb-icon">🏆</span><b>${quizDone}</b><span>测验通过</span></div>
        </div>
      </div>
      <div class="set-card">
        <h3>📚 各章进度</h3>
        <div class="chapter-bars">
          ${state.chapters.map(c => {
            const cp = state.progress.chapters[c.id] || { learned: [] };
            const p = c.count ? Math.round(cp.learned.length / c.count * 100) : 0;
            return `<div class="ch-bar-row">
              <div class="cb-name">${c.icon} ${esc(c.title)}</div>
              <div class="cb-track"><div class="cb-fill" style="width:${p}%; background:${cp.quizDone ? "var(--green)" : (p===100?"var(--learned-green)":"var(--blue)")}"></div></div>
              <div class="cb-num">${cp.learned.length}/${c.count}</div>
            </div>`;
          }).join("")}
        </div>
      </div>
    </div>`;
}

/* ================= 设置视图 ================= */
function llmReady() { const s = state.progress.settings; return !!(s.baseURL && s.model && s.apiKey); }

function renderSettings(el) {
  const s = state.progress.settings;
  el.innerHTML = `
    <div class="settings-wrap">
      <div class="set-card">
        <h3>🤖 大模型 API（OpenAI 兼容）</h3>
        <div class="field">
          <label>Base URL</label>
          <input id="s-base" placeholder="https://api.openai.com/v1（或本地 vLLM 等）" value="${esc(s.baseURL)}">
          <div class="hint">一般以 /v1 结尾；也支持 one-api / new-api / Ollama 等 OpenAI 兼容网关</div>
        </div>
        <div class="field">
          <label>Model</label>
          <input id="s-model" placeholder="gpt-4o-mini / qwen2.5-32b-instruct …" value="${esc(s.model)}">
        </div>
        <div class="field">
          <label>API Key</label>
          <input id="s-key" type="password" placeholder="sk-…" value="${esc(s.apiKey)}">
          <div class="hint">仅保存在本机浏览器 localStorage，请求直接从浏览器发出</div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" id="s-save">保存</button>
          <button class="btn btn-ghost btn-sm" id="s-test">测试连通</button>
          <span id="s-test-result"></span>
        </div>
      </div>

      <div class="set-card">
        <h3>🎯 批量生成选择题</h3>
        <p style="font-size:.85rem;color:var(--ink-soft);line-height:1.7;margin-bottom:10px">
          用大模型把各章问答批量衍生为四选一选择题。逐题保存到本浏览器（刷新/关闭不丢失，失败的题重跑即可补齐）；
          也可用 <code>tools/gen_quiz.py</code> 直接生成到 JSON 文件。
          ${llmReady() ? "" : "<b>请先配置并保存上方 API。</b>"}
        </p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <button class="btn btn-blue btn-sm" id="g-run" ${llmReady() ? "" : "disabled"}>🚀 批量生成</button>
          <button class="btn btn-ghost btn-sm" id="g-export" hidden>💾 导出生成结果</button>
          <span style="font-size:.8rem;color:var(--ink-soft)" id="g-count"></span>
        </div>
        <div class="gen-progress" id="g-progress" hidden>
          <div class="gen-bar"><div id="g-bar"></div></div>
          <div class="gen-log" id="g-log"></div>
        </div>
      </div>

      <div class="set-card">
        <h3>🎛️ 学习偏好</h3>
        <div class="switch-row">
          <div><div class="s-label">解锁全部章节</div><div class="s-sub">默认按顺序解锁（学过上一章即可）</div></div>
          <label class="switch"><input type="checkbox" id="s-unlock" ${s.unlockAll ? "checked" : ""}><span class="slider"></span></label>
        </div>
        <div class="switch-row">
          <div><div class="s-label">深色模式</div></div>
          <label class="switch"><input type="checkbox" id="s-dark" ${s.theme === "dark" ? "checked" : ""}><span class="slider"></span></label>
        </div>
      </div>

      <div class="set-card">
        <h3>🗑️ 数据管理</h3>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" id="d-export">导出进度</button>
          <button class="btn btn-ghost btn-sm" id="d-reset">清空学习进度</button>
          <button class="btn btn-ghost btn-sm" id="d-reset-quiz">清除已生成选择题</button>
        </div>
        <p style="font-size:.75rem;color:var(--ink-faint);margin-top:8px">
          学习进度 / AI 解读缓存 / 浏览器内生成的选择题 分别存储，互不影响。
        </p>
      </div>
      <p style="text-align:center;color:var(--ink-faint);font-size:.75rem;padding:8px 0 30px">
        题库数据：data/questions/*.json · 增删章节文件后刷新页面即可
      </p>
    </div>`;

  $("#s-save").addEventListener("click", () => {
    s.baseURL = $("#s-base").value.trim().replace(/\/+$/, "");
    s.model = $("#s-model").value.trim();
    s.apiKey = $("#s-key").value.trim();
    saveProgress();
    $("#g-run").disabled = !llmReady();
    toast("已保存");
  });
  $("#s-test").addEventListener("click", async () => {
    const out = $("#s-test-result");
    if (!llmReady()) { out.innerHTML = `<span class="test-fail">请先填写并保存三项配置</span>`; return; }
    out.textContent = "测试中…";
    try {
      const t0 = Date.now();
      const msg = await llmChat("回复两个字：连通", { maxTokens: 20 });
      out.innerHTML = `<span class="test-ok">✓ ${esc(String(msg).trim().slice(0, 16))}（${Date.now() - t0}ms）</span>`;
    } catch (e) { out.innerHTML = `<span class="test-fail">✗ ${esc(e.message)}</span>`; }
  });
  $("#s-unlock").addEventListener("change", (e) => { s.unlockAll = e.target.checked; saveProgress(); });
  $("#s-dark").addEventListener("change", (e) => { s.theme = e.target.checked ? "dark" : "light"; saveProgress(); render(); });
  $("#d-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state.progress, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "agent-interview-progress.json"; a.click();
  });
  $("#d-reset").addEventListener("click", () => {
    if (confirm("确定清空全部学习进度？（AI 解读缓存与已生成的选择题不受影响）")) {
      localStorage.removeItem(LS_KEY); loadProgress(); render(); toast("已重置");
    }
  });
  const dr = $("#d-reset-quiz");
  if (dr) dr.addEventListener("click", () => {
    if (confirm("确定删除本浏览器内 AI 批量生成的所有选择题？（JSON 文件里预生成的不受影响）")) {
      localStorage.removeItem(LS_QUIZ_KEY); state.cache = {}; render(); toast("已清除");
    }
  });
  const g = $("#g-run");
  if (g) g.addEventListener("click", runBatchGen);
  const ge = $("#g-export");
  if (ge) ge.addEventListener("click", exportGenQuizzes);
  updateGenCount();
}

function updateGenCount() {
  const el = $("#g-count");
  if (!el) return;
  let has = 0, total = 0;
  for (const id in state.cache) { total += state.cache[id].length; has += state.cache[id].filter(q => q.quiz).length; }
  el.textContent = `当前题库 ${Object.keys(state.cache).length} 章 / 已生成练习题 ${has} 个`;
}

/* ---------- LLM 调用（OpenAI 兼容 / SSE 流式可选） ---------- */
async function llmChat(prompt, opts = {}) {
  const s = state.progress.settings;
  const res = await fetch(`${s.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${s.apiKey}` },
    body: JSON.stringify({
      model: s.model,
      messages: [
        { role: "system", content: "你是一位资深的 AI 应用开发面试辅导专家。" },
        { role: "user", content: prompt },
      ],
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 1600,
    }),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 200); } catch (e) {}
    throw new Error(`HTTP ${res.status} ${detail}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

/* ---------- 批量生成 quiz ---------- */
async function runBatchGen() {
  if (!llmReady()) { toast("请先配置 API"); return; }
  const btn = $("#g-run"); const box = $("#g-progress"); const bar = $("#g-bar"); const log = $("#g-log");
  btn.disabled = true; box.hidden = false; log.innerHTML = "";
  const chapterIds = state.chapters.map(c => c.id);
  let done = 0, okCount = 0, failCount = 0;
  const totalQ = state.chapters.reduce((s, c) => s + c.count, 0);
  for (const id of chapterIds) {
    let qs;
    try { qs = await loadChapter(id); } catch (e) { log.innerHTML += `<div>✗ ${esc(id)} 加载失败</div>`; failCount++; continue; }
    const targets = qs.filter(q => !q.quiz);
    for (const q of targets) {
      try {
        const quiz = await genQuizFor(q);
        if (quiz) { q.quiz = quiz; okCount++; saveGenQuiz(q.id, quiz); } // 逐题持久化
      } catch (e) {
        failCount++;
        log.innerHTML += `<div>✗ ${esc(q.id)}: ${esc(e.message).slice(0, 80)}</div>`;
      }
      done++;
      bar.style.width = `${Math.round(done / totalQ * 100)}%`;
      log.scrollTop = log.scrollHeight;
      await sleep(150); // 温和限速
    }
  }
  log.innerHTML += `<div style="font-weight:700;color:var(--green-dark)">完成：成功 ${okCount}，失败 ${failCount}（已保存到本浏览器，关闭页面不丢失；失败的可重跑批量生成补齐）</div>`;
  btn.disabled = false;
  const ex = $("#g-export");
  if (ex && okCount > 0) ex.hidden = false;
  updateGenCount();
  toast(`生成完成：${okCount} 题`);
}

function exportGenQuizzes() {
  const gen = loadGenQuizzes();
  const byChapter = {};
  // 按章节组织（从全部缓存章节里找 qid 归属）
  const belongs = {};
  for (const cid in state.cache) for (const q of state.cache[cid]) belongs[q.id] = cid;
  const ids = new Set();
  for (const cid in state.cache) for (const q of state.cache[cid]) ids.add(q.id);
  let count = 0;
  for (const [qid, quiz] of Object.entries(gen)) {
    if (!ids.has(qid)) continue; // 章节已不在，跳过
    const cid = belongs[qid] || "unknown";
    (byChapter[cid] = byChapter[cid] || []).push({ id: qid, quiz });
    count++;
  }
  if (!count) { toast("没有可导出的生成结果"); return; }
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), chapters: byChapter }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "gen-quizzes.json"; a.click();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function genQuizFor(q) {
  const prompt = `根据下面的面试题与参考答案，生成一道四选一选择题，考察对核心概念的辨析。要求：干扰项要有迷惑性（常见误解），正确项唯一。严格输出 JSON（不要 markdown 代码块，不要多余文字）：
{"stem": "题干（可基于原题改写）", "options": ["A内容","B内容","C内容","D内容"], "answer": 0, "explain": "一句话解析（60字内）"}

面试题：${q.title}
参考答案：${q.answer_md.slice(0, 3000)}`;
  const out = await llmChat(prompt, { temperature: 0.4, maxTokens: 600 });
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("返回非 JSON");
  const quiz = JSON.parse(m[0]);
  if (!Array.isArray(quiz.options) || quiz.options.length < 2) throw new Error("options 非法");
  quiz.answer = Math.max(0, Math.min(quiz.options.length - 1, +quiz.answer || 0));
  quiz.options = quiz.options.map(o => String(o).replace(/^\s*[A-Da-d]\s*[\)．.、:：]\s*/, "").trim());
  return quiz;
}

/* ================= toast ================= */
let toastTimer = null;
function toast(msg) {
  const root = $("#toast-root");
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  root.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}

/* ================= 启动 ================= */
async function boot() {
  loadProgress();
  try {
    await loadChapters();
  } catch (e) {
    $("#view").innerHTML = `<div class="loading-center">题库加载失败：${esc(e.message)}<br><span style="font-size:.8rem">请通过本地 HTTP 服务打开（如 python -m http.server）</span></div>`;
    return;
  }
  render();
  // 底部导航
  $$("#bottombar .tab").forEach(b => b.addEventListener("click", () => { state.route = null; setView(b.dataset.tab); }));
  $("#btn-back").addEventListener("click", () => { state.route = null; setView("path"); });
}
boot();
