/**
 * Tokenbill 로컬 대화 뷰어
 *
 * `npx github:Jonghoon5922/tokenbill --viewer` 로 실행하면 127.0.0.1 전용 웹 뷰어가 뜬다.
 * Claude Code·Codex·Gemini CLI의 로컬 로그를 읽어 세션별 대화(입력/출력/도구 호출)를 보여준다.
 * 어떤 데이터도 외부로 전송하지 않는다 — 전부 이 PC 안에서만 읽고 표시한다.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

const BASES = {
  "claude-code": path.join(os.homedir(), ".claude", "projects"),
  "codex": path.join(os.homedir(), ".codex", "sessions"),
  "gemini": path.join(os.homedir(), ".gemini", "tmp"),
};

function* walkFiles(dir, exts) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p, exts);
    else if (e.isFile() && exts.some((x) => e.name.endsWith(x))) yield p;
  }
}

// 경로 검증 — 허용된 로그 디렉터리 밖 파일은 절대 열지 않는다
function allowedFile(file) {
  const r = path.resolve(file);
  return Object.values(BASES).some((b) => r.startsWith(path.resolve(b) + path.sep));
}

// ── Claude Code 파서 ────────────────────────────────────────
function claudeProjectName(file) {
  // ~/.claude/projects/<경로를-대시로-인코딩한-폴더>/<세션>.jsonl → 마지막 경로 조각만 표시
  const folder = path.basename(path.dirname(file));
  const parts = folder.split("-").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : folder;
}
function claudeText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
}
function parseClaudeSession(file, full) {
  let lines;
  try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch { return null; }
  const s = { source: "claude-code", file, project: claudeProjectName(file),
              start: "", end: "", msgs: 0, tokens: 0, title: "", model: "", entries: [] };
  const seen = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.timestamp) { if (!s.start) s.start = e.timestamp; s.end = e.timestamp; }
    if (e.cwd && !s.cwdSeen) { s.project = path.basename(e.cwd) || s.project; s.cwdSeen = true; }
    if (e.type === "user" && e.message && !e.isMeta) {
      const c = e.message.content;
      const isToolResult = Array.isArray(c) && c.some((b) => b && b.type === "tool_result");
      const text = claudeText(c);
      if (isToolResult) {
        if (full && text) s.entries.push({ role: "tool_result", time: e.timestamp, text: text.slice(0, 4000) });
        continue;
      }
      if (!text || text.startsWith("<command-name>") || text.startsWith("<local-command")) continue;
      s.msgs++;
      if (!s.title) s.title = text.slice(0, 80).replace(/\s+/g, " ");
      if (full) s.entries.push({ role: "user", time: e.timestamp, text });
    } else if (e.type === "assistant" && e.message) {
      const m = e.message;
      const dedup = `${m.id || ""}:${e.requestId || e.uuid || ""}`;
      const dup = dedup !== ":" && seen.has(dedup);
      if (!dup) seen.add(dedup);
      const u = m.usage;
      if (u && !dup) {
        s.tokens += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) +
                    (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
      }
      if (m.model && !m.model.includes("synthetic")) s.model = m.model;
      if (full && Array.isArray(m.content)) {
        for (const b of m.content) {
          if (!b) continue;
          if (b.type === "text" && b.text) s.entries.push({ role: "assistant", time: e.timestamp, model: m.model, text: b.text });
          else if (b.type === "thinking" && b.thinking) s.entries.push({ role: "thinking", time: e.timestamp, text: b.thinking.slice(0, 4000) });
          else if (b.type === "tool_use") s.entries.push({ role: "tool_use", time: e.timestamp, tool: b.name,
            text: JSON.stringify(b.input || {}, null, 1).slice(0, 2000) });
        }
      }
    }
  }
  return s.msgs || s.tokens ? s : null;
}

// ── Codex 파서 (형식이 자주 바뀌어 최선 노력) ───────────────
function codexText(c) {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.map((b) => (b && (b.text || b.content)) || "").filter(Boolean).join("\n");
}
function parseCodexSession(file, full) {
  let lines;
  try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch { return null; }
  const s = { source: "codex", file, project: "", start: "", end: "", msgs: 0, tokens: 0, title: "", model: "codex", entries: [] };
  let prev = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const ts = e.timestamp || e.ts || "";
    if (ts) { if (!s.start) s.start = ts; s.end = ts; }
    const p = e.payload || e;
    if (p.type === "turn_context") { if (p.model) s.model = String(p.model); if (p.cwd) s.project = path.basename(p.cwd); }
    if (p.type === "session_meta" && p.cwd) s.project = path.basename(p.cwd);
    // 대화: response_item(message) / user_message / agent_message 형식 모두 시도
    let role = null, text = "";
    if (p.type === "message" && p.role) { role = p.role; text = codexText(p.content); }
    else if (p.type === "response_item" && p.payload && p.payload.type === "message") { role = p.payload.role; text = codexText(p.payload.content); }
    else if (p.type === "user_message") { role = "user"; text = p.message || codexText(p.content); }
    else if (p.type === "agent_message") { role = "assistant"; text = p.message || codexText(p.content); }
    if (role && text && !text.startsWith("<user_instructions>") && !text.startsWith("<environment_context>")) {
      if (role === "user") { s.msgs++; if (!s.title) s.title = text.slice(0, 80).replace(/\s+/g, " "); }
      if (full) s.entries.push({ role: role === "user" ? "user" : "assistant", time: ts, model: s.model, text });
    }
    const info = p.info;
    const usage = (info && (info.last_token_usage || info.total_token_usage)) || (p.type === "token_count" && p.usage) || null;
    if (usage) {
      let inTok = (usage.input_tokens || 0) + (usage.cached_input_tokens || 0);
      let outTok = usage.output_tokens || 0;
      if (info && info.total_token_usage && !info.last_token_usage) {
        const t = info.total_token_usage;
        const cur = { i: (t.input_tokens || 0) + (t.cached_input_tokens || 0), o: t.output_tokens || 0 };
        inTok = Math.max(0, cur.i - (prev ? prev.i : 0));
        outTok = Math.max(0, cur.o - (prev ? prev.o : 0));
        prev = cur;
      }
      s.tokens += inTok + outTok;
    }
  }
  return s.msgs || s.tokens ? s : null;
}

// ── Gemini 파서 ─────────────────────────────────────────────
function parseGeminiSession(file, full) {
  let content;
  try { content = fs.readFileSync(file, "utf8"); } catch { return null; }
  let rec;
  try { rec = JSON.parse(content); } catch { return null; }
  if (!Array.isArray(rec.messages)) return null;
  const s = { source: "gemini", file, project: rec.projectHash ? rec.projectHash.slice(0, 8) : "",
              start: rec.startTime || "", end: rec.lastUpdated || "", msgs: 0, tokens: 0, title: "",
              model: rec.model || "gemini", entries: [] };
  for (const m of rec.messages) {
    if (!m) continue;
    const text = typeof m.content === "string" ? m.content : (m.text || "");
    if (m.type === "user") {
      s.msgs++;
      if (!s.title && text) s.title = text.slice(0, 80).replace(/\s+/g, " ");
      if (full && text) s.entries.push({ role: "user", time: m.timestamp || "", text });
    } else if (m.type === "gemini") {
      if (m.tokens) {
        const t = m.tokens;
        s.tokens += (t.input || t.prompt || 0) + (t.output || t.candidates || 0) + (t.thoughts || 0) + (t.tool || 0);
      }
      if (full && text) s.entries.push({ role: "assistant", time: m.timestamp || "", model: m.model || s.model, text });
    }
  }
  return s.msgs || s.tokens ? s : null;
}

// ── Cursor 파서 (SQLite — Node 22.5+ 내장 node:sqlite 필요, 없으면 조용히 생략) ──
let nodeSqlite = null;
try { nodeSqlite = require("node:sqlite"); } catch {}
function cursorDbPath() {
  if (process.env.TOKENBILL_CURSOR_DB) return process.env.TOKENBILL_CURSOR_DB;  // 테스트용 오버라이드
  if (process.platform === "win32") return path.join(process.env.APPDATA || "", "Cursor", "User", "globalStorage", "state.vscdb");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  return path.join(os.homedir(), ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}
function cursorOpen() {
  const p = cursorDbPath();
  if (!nodeSqlite || !fs.existsSync(p)) return null;
  try { return new nodeSqlite.DatabaseSync(p, { readOnly: true }); }
  catch {
    // Cursor 실행 중 잠금 대비 — 임시 복사본으로 열기
    try {
      const tmp = path.join(os.tmpdir(), "tokenbill-cursor.vscdb");
      fs.copyFileSync(p, tmp);
      try { fs.copyFileSync(p + "-wal", tmp + "-wal"); } catch {}
      return new nodeSqlite.DatabaseSync(tmp, { readOnly: true });
    } catch { return null; }
  }
}
function cursorIso(ms) { return typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : ""; }
function cursorSessions(full, onlyId) {
  const db = cursorOpen();
  if (!db) return [];
  const out = [];
  let rows = [];
  try { rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all(); } catch {}
  let bubbleStmt = null;
  try { bubbleStmt = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?"); } catch {}
  for (const r of rows) {
    let c;
    try { c = JSON.parse(r.value); } catch { continue; }
    const id = c.composerId || String(r.key).slice("composerData:".length);
    if (onlyId && id !== onlyId) continue;
    const s = { source: "cursor", file: "cursor:" + id, project: "", start: cursorIso(c.createdAt),
                end: cursorIso(c.lastUpdatedAt || c.createdAt), msgs: 0, tokens: 0,
                title: (c.name || "").slice(0, 80), model: "cursor", entries: [] };
    // 구형: conversation 배열에 버블 인라인 / 신형: 헤더만 있고 버블은 bubbleId:* 키로 분리 저장
    let bubbles = Array.isArray(c.conversation) ? c.conversation : [];
    const headers = Array.isArray(c.fullConversationHeadersOnly) ? c.fullConversationHeadersOnly : [];
    if (!bubbles.length && headers.length && bubbleStmt && (full || !s.title)) {
      for (const h of headers) {
        try {
          const row = bubbleStmt.get("bubbleId:" + id + ":" + h.bubbleId);
          if (row) { const b = JSON.parse(row.value); if (b.type === undefined) b.type = h.type; bubbles.push(b); }
        } catch {}
        if (!full && bubbles.length >= 3) break;  // 목록에서는 제목 추출용으로 앞부분만
      }
    }
    for (const b of bubbles) {
      if (!b) continue;
      const text = typeof b.text === "string" ? b.text : "";
      const tc = b.tokenCount;
      if (tc) s.tokens += (tc.inputTokens || 0) + (tc.outputTokens || 0);
      if (b.type === 1) {
        s.msgs++;
        if (!s.title && text) s.title = text.slice(0, 80).replace(/\s+/g, " ");
        if (full && text) s.entries.push({ role: "user", time: cursorIso(b.createdAt) || s.start, text });
      } else if (b.type === 2 && full && text) {
        s.entries.push({ role: "assistant", time: cursorIso(b.createdAt) || s.start, model: (b.modelType || "cursor"), text });
      }
    }
    if (!s.msgs && headers.length) s.msgs = headers.filter((h) => h && h.type === 1).length;
    if (s.msgs) out.push(s);
  }
  try { db.close(); } catch {}
  return out;
}
function cursorMeta(s) {
  return { source: s.source, file: s.file, project: s.project, start: s.start, end: s.end,
           msgs: s.msgs, tokens: s.tokens, title: s.title, model: s.model };
}

const PARSERS = { "claude-code": parseClaudeSession, "codex": parseCodexSession, "gemini": parseGeminiSession };
const EXTS = { "claude-code": [".jsonl"], "codex": [".jsonl"], "gemini": [".json"] };

// 목록은 파일 mtime 기준으로 캐시 (대화 열람은 항상 새로 읽음)
const listCache = new Map();
function sessionMeta(source, file) {
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
  const c = listCache.get(file);
  if (c && c.mtime === mtime) return c.meta;
  const s = PARSERS[source](file, false);
  const meta = s ? { source: s.source, file: s.file, project: s.project, start: s.start, end: s.end,
                     msgs: s.msgs, tokens: s.tokens, title: s.title, model: s.model } : null;
  listCache.set(file, { mtime, meta });
  return meta;
}
function listSessions() {
  const out = [];
  for (const source of Object.keys(BASES)) {
    for (const file of walkFiles(BASES[source], EXTS[source])) {
      const m = sessionMeta(source, file);
      if (m && m.msgs > 0) out.push(m);
    }
  }
  try { cursorSessions(false).forEach((s) => out.push(cursorMeta(s))); } catch {}
  out.sort((a, b) => (b.start || "").localeCompare(a.start || ""));
  return out.slice(0, 500);
}
function grepSession(s, q, hits) {
  for (const e of s.entries) {
    if ((e.role !== "user" && e.role !== "assistant") || !e.text) continue;
    const idx = e.text.toLowerCase().indexOf(q);
    if (idx < 0) continue;
    hits.push({ source: s.source, file: s.file, project: s.project, start: s.start, role: e.role, time: e.time,
                snippet: e.text.slice(Math.max(0, idx - 60), idx + q.length + 120).replace(/\s+/g, " ") });
    if (hits.length >= 50) return;
  }
}
function searchSessions(q) {
  q = q.toLowerCase();
  const hits = [];
  for (const source of Object.keys(BASES)) {
    for (const file of walkFiles(BASES[source], EXTS[source])) {
      if (hits.length >= 50) return hits;
      const s = PARSERS[source](file, true);
      if (s) grepSession(s, q, hits);
    }
  }
  try {
    for (const s of cursorSessions(true)) {
      if (hits.length >= 50) break;
      grepSession(s, q, hits);
    }
  } catch {}
  return hits;
}

// ── HTML (인라인 단일 페이지 — 렌더링은 클라이언트 DOM API로만, innerHTML 미사용) ──
const PAGE = `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tokenbill 로컬 뷰어</title>
<style>
:root{--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;
--border:rgba(11,11,11,.1);--accent:#2a78d6;--accent-ink:#1c5cab;--chip:#f0efec;
--cc:#8a63d2;--codex:#66707d;--gem:#2a78d6}
@media(prefers-color-scheme:dark){:root{--page:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;
--muted:#898781;--grid:#2c2c2a;--border:rgba(255,255,255,.1);--accent:#3987e5;--accent-ink:#86b6ef;--chip:#262624}}
*{box-sizing:border-box;margin:0}
body{background:var(--page);color:var(--ink);font-family:"IBM Plex Sans KR","Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif;line-height:1.5;height:100vh;display:flex;flex-direction:column}
header{padding:12px 18px 10px;border-bottom:1px solid var(--grid);display:flex;align-items:center;gap:14px;flex-wrap:wrap}
header h1{font-size:1.05rem;font-weight:700}header h1 b{color:var(--accent)}
header .note{font-size:.72rem;color:var(--muted)}
#q{margin-left:auto;width:300px;max-width:100%;padding:7px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--ink);font:inherit;font-size:.84rem}
#filters{display:flex;gap:8px;padding:9px 18px;border-bottom:1px solid var(--grid);align-items:center;flex-wrap:wrap}
.chip{display:inline-flex;align-items:center;padding:4px 12px;border-radius:999px;border:1px solid var(--border);background:var(--surface);cursor:pointer;font:inherit;font-size:.75rem;color:var(--ink2)}
.chip:hover{background:var(--chip)}
.chip.on{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.chip .dot2{width:8px;height:8px;border-radius:2px;margin-right:6px}
.chip.on .dot2{background:#fff!important}
#filters select{padding:5px 9px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--ink);font:inherit;font-size:.75rem;max-width:220px}
#sum{margin-left:auto;font-size:.73rem;color:var(--muted);font-variant-numeric:tabular-nums}
main{flex:1;display:flex;min-height:0}
#side{width:360px;flex:none;border-right:1px solid var(--grid);overflow-y:auto;padding:8px;background:var(--page)}
.sess{display:flex;gap:10px;align-items:flex-start;padding:9px 12px;border-radius:9px;border:1px solid var(--border);border-left:3px solid var(--grid);cursor:pointer;margin-bottom:5px;background:var(--surface)}
.sess:hover{background:var(--chip)}.sess.on{background:color-mix(in srgb,var(--accent) 10%,var(--surface));border-color:color-mix(in srgb,var(--accent) 40%,var(--border))}
.sess .body{flex:1;min-width:0}
.sess .t{font-size:.8rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sess .m{font-size:.68rem;color:var(--muted);display:flex;gap:6px;margin-top:3px;align-items:center;flex-wrap:wrap}
.sess .proj{background:var(--chip);border-radius:5px;padding:0 6px;color:var(--ink2);max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sess .tok{font-size:.73rem;font-weight:700;color:var(--accent-ink);white-space:nowrap;font-variant-numeric:tabular-nums;padding-top:2px}
.src{display:inline-block;padding:0 6px;border-radius:999px;color:#fff;font-size:.64rem;font-weight:600;line-height:1.5;white-space:nowrap;flex:none}
#view{flex:1;overflow-y:auto;padding:20px 26px}
.msg{max-width:860px;margin:0 auto 14px}
.msg .hd{font-size:.7rem;color:var(--muted);margin-bottom:3px;display:flex;gap:10px}
.msg .bd{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:11px 14px;font-size:.85rem;white-space:pre-wrap;word-break:break-word}
.msg.user .bd{border-left:3px solid var(--accent)}
.msg.tool .bd,.msg.think .bd{font-size:.74rem;color:var(--ink2);font-family:ui-monospace,Consolas,monospace;background:var(--chip)}
.msg details summary{cursor:pointer;font-size:.72rem;color:var(--muted)}
.empty{color:var(--muted);text-align:center;padding:60px 20px;font-size:.88rem}
.sumcard{max-width:860px;margin:0 auto 18px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 16px;display:flex;gap:6px 16px;align-items:center;flex-wrap:wrap;font-size:.78rem;color:var(--ink2)}
.sumcard b{color:var(--ink)}
.sumcard .bigtok{margin-left:auto;font-size:.95rem;font-weight:700;color:var(--accent-ink);font-variant-numeric:tabular-nums}
@media(max-width:760px){#side{width:220px}}
</style></head><body>
<header><h1>Token<b>bill</b> 로컬 뷰어</h1>
<span class="note">이 PC의 로그만 읽습니다 — 아무것도 업로드되지 않아요</span>
<input id="q" placeholder="대화 내용 검색 (Enter)"></header>
<div id="filters">
  <span id="chips"></span>
  <select id="projSel"><option value="">모든 프로젝트</option></select>
  <select id="perSel">
    <option value="">전체 기간</option><option value="today">오늘</option>
    <option value="7d">최근 7일</option><option value="30d">최근 30일</option>
    <option value="month">이번 달</option><option value="prev">지난 달</option>
  </select>
  <span id="sum"></span>
</div>
<main><div id="side"></div><div id="view"><p class="empty">왼쪽에서 세션을 선택하세요</p></div></main>
<script>
(function(){
"use strict";
var SRC={"claude-code":["Claude Code","var(--cc)"],"codex":["Codex","var(--codex)"],"gemini":["Gemini","var(--gem)"],"cursor":["Cursor","#4f8f6b"]};
var ROLE={user:"나",assistant:"AI",tool_use:"도구 호출",tool_result:"도구 결과",thinking:"생각"};
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
function fmtTok(n){return n>=1e9?(n/1e9).toFixed(1)+"B":n>=1e6?(n/1e6).toFixed(1)+"M":n>=1e3?Math.round(n/1e3)+"K":String(n)}
function dt(s){return s?s.slice(0,16).replace("T"," "):""}
function pad(n){return String(n).length<2?"0"+n:String(n)}
function isoD(d){return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate())}
function srcBadge(s){var b=el("span","src",SRC[s]?SRC[s][0]:s);b.style.background=SRC[s]?SRC[s][1]:"var(--accent)";return b}
var side=document.getElementById("side"),view=document.getElementById("view");
var chips=document.getElementById("chips"),projSel=document.getElementById("projSel"),
    perSel=document.getElementById("perSel"),sum=document.getElementById("sum"),qIn=document.getElementById("q");
var ALL=[],F={src:"",proj:"",per:""};

// ── 필터 (검색 결과에도 동일하게 적용) ──
function inPeriod(startIso){
  if(!F.per)return true;
  var st=(startIso||"").slice(0,10);if(!st)return false;
  var now=new Date();
  if(F.per==="today")return st===isoD(now);
  if(F.per==="7d")return st>=isoD(new Date(now.getFullYear(),now.getMonth(),now.getDate()-6));
  if(F.per==="30d")return st>=isoD(new Date(now.getFullYear(),now.getMonth(),now.getDate()-29));
  if(F.per==="month")return st.slice(0,7)===isoD(now).slice(0,7);
  if(F.per==="prev")return st.slice(0,7)===isoD(new Date(now.getFullYear(),now.getMonth()-1,1)).slice(0,7);
  return true}
function passes(x){return(!F.src||x.source===F.src)&&(!F.proj||x.project===F.proj)&&inPeriod(x.time||x.start)}
function refresh(){var q=qIn.value.trim();if(q)runSearch(q);else renderList()}

function renderChips(){
  chips.textContent="";
  var present=[];ALL.forEach(function(s){if(present.indexOf(s.source)<0)present.push(s.source)});
  function chip(label,val,color){
    var b=el("button","chip"+(F.src===val?" on":""));
    if(color){var d=el("span","dot2");d.style.background=color;b.appendChild(d)}
    b.appendChild(document.createTextNode(label));
    b.addEventListener("click",function(){F.src=val;renderChips();refresh()});
    chips.appendChild(b)}
  chip("전체","",null);
  present.forEach(function(p){chip(SRC[p]?SRC[p][0]:p,p,SRC[p]?SRC[p][1]:"var(--accent)")})}
function renderProjects(){
  var cnt={};ALL.forEach(function(s){if(s.project)cnt[s.project]=(cnt[s.project]||0)+1});
  while(projSel.options.length>1)projSel.remove(1);
  Object.keys(cnt).sort().forEach(function(p){projSel.appendChild(new Option(p+" ("+cnt[p]+")",p))})}

function sessCard(s,titleText,metaExtra){
  var d=el("div","sess");
  d.style.borderLeftColor=SRC[s.source]?SRC[s.source][1]:"var(--accent)";
  var body=el("div","body");
  body.appendChild(el("div","t",titleText));
  var m=el("div","m");m.appendChild(srcBadge(s.source));
  if(s.project)m.appendChild(el("span","proj",s.project));
  m.appendChild(el("span","",metaExtra));
  body.appendChild(m);d.appendChild(body);
  if(s.tokens!==undefined)d.appendChild(el("span","tok",fmtTok(s.tokens)));
  d.addEventListener("click",function(){
    Array.prototype.forEach.call(side.children,function(c){c.classList.remove("on")});
    d.classList.add("on");loadSession(s)});
  return d}

function renderList(){
  var list=ALL.filter(passes);
  var tot=0;list.forEach(function(s){tot+=s.tokens});
  sum.textContent=list.length+"개 세션 · "+fmtTok(tot)+" tok";
  side.textContent="";
  if(!list.length){side.appendChild(el("p","empty","조건에 맞는 세션이 없습니다"));return}
  list.forEach(function(s){side.appendChild(sessCard(s,s.title||"(제목 없음)",dt(s.start)+" · "+s.msgs+"건"))})}

function runSearch(q){
  side.textContent="";side.appendChild(el("p","empty","검색 중…"));
  fetch("/api/search?q="+encodeURIComponent(q)).then(function(r){return r.json()}).then(function(hits){
    hits=hits.filter(passes);
    sum.textContent="검색 "+hits.length+"건";
    side.textContent="";
    if(!hits.length){side.appendChild(el("p","empty","조건에 맞는 검색 결과가 없습니다"));return}
    hits.forEach(function(h){side.appendChild(sessCard(h,"…"+h.snippet+"…",dt(h.time||h.start)))})})
  .catch(function(){side.textContent="";side.appendChild(el("p","empty","검색 실패"))})}

function loadList(){
  fetch("/api/sessions").then(function(r){return r.json()}).then(function(list){
    ALL=list;renderChips();renderProjects();renderList()})
  .catch(function(){side.textContent="";side.appendChild(el("p","empty","목록을 불러오지 못했습니다"))})}

function loadSession(s){
  view.textContent="";view.appendChild(el("p","empty","불러오는 중…"));
  fetch("/api/session?file="+encodeURIComponent(s.file)).then(function(r){return r.json()}).then(function(d){
    view.textContent="";
    var sc=el("div","sumcard");sc.appendChild(srcBadge(d.source));
    if(d.project){var b1=el("span");b1.appendChild(el("b","",d.project));sc.appendChild(b1)}
    sc.appendChild(el("span","",dt(d.start)+" ~ "+dt(d.end).slice(11)));
    if(d.model)sc.appendChild(el("span","",d.model));
    sc.appendChild(el("span","bigtok",fmtTok(d.tokens)+" tok"));
    view.appendChild(sc);
    d.entries.forEach(function(e){
      var role=e.role==="tool_use"||e.role==="tool_result"?"tool":e.role==="thinking"?"think":e.role;
      var m=el("div","msg "+role);
      if(e.role==="tool_use"||e.role==="tool_result"||e.role==="thinking"){
        var det=el("details");var summ=el("summary","",ROLE[e.role]+(e.tool?" — "+e.tool:"")+"  ("+dt(e.time).slice(11)+")");
        det.appendChild(summ);var bd=el("div","bd",e.text);det.appendChild(bd);m.appendChild(det)}
      else{var hd=el("div","hd");hd.appendChild(el("span","",ROLE[e.role]||e.role));
        if(e.model)hd.appendChild(el("span","",e.model));hd.appendChild(el("span","",dt(e.time)));
        m.appendChild(hd);m.appendChild(el("div","bd",e.text))}
      view.appendChild(m)});
    view.scrollTop=0})
  .catch(function(){view.textContent="";view.appendChild(el("p","empty","세션을 불러오지 못했습니다"))})}

projSel.addEventListener("change",function(){F.proj=this.value;refresh()});
perSel.addEventListener("change",function(){F.per=this.value;refresh()});
qIn.addEventListener("keydown",function(ev){if(ev.key==="Enter")refresh()});
loadList();
})();
</script></body></html>`;

function json(res, obj) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function start(port, opts) {
  port = port || 8377;
  opts = opts || {};
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    // DNS 리바인딩 방지 — 로컬 호스트명이 아닌 Host 헤더는 거부
    const hostHdr = String(req.headers.host || "");
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(hostHdr)) { res.writeHead(403); return res.end("forbidden"); }
    try {
      if (req.method === "OPTIONS") {
        // 공개 사이트 → 로컬 주소 fetch에 필요한 PNA/CORS preflight 응답
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Private-Network": "true",
        });
        return res.end();
      }
      if (u.pathname === "/api/ping") {
        // 포탈(tokenbill.my)의 '뷰어 실행 중' 감지용 — 민감 정보 없음이라 CORS 허용
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        return res.end('{"ok":true,"app":"tokenbill-viewer"}');
      }
      if (u.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(PAGE);
      }
      if (u.pathname === "/api/sessions") return json(res, listSessions());
      if (u.pathname === "/api/session") {
        const file = u.searchParams.get("file") || "";
        if (/^cursor:[A-Za-z0-9-]{1,64}$/.test(file)) {
          return json(res, cursorSessions(true, file.slice(7))[0] || { entries: [] });
        }
        if (!allowedFile(file)) { res.writeHead(403); return res.end("forbidden"); }
        const source = Object.keys(BASES).find((s) => path.resolve(file).startsWith(path.resolve(BASES[s]) + path.sep));
        const s = PARSERS[source](file, true);
        return json(res, s || { entries: [] });
      }
      if (u.pathname === "/api/search") {
        const q = (u.searchParams.get("q") || "").trim();
        return json(res, q.length >= 2 ? searchSessions(q) : []);
      }
      res.writeHead(404); res.end("not found");
    } catch (e) {
      res.writeHead(500); res.end(String(e.message || e));
    }
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}`;
    process.stderr.write(`[tokenbill] 로컬 뷰어 실행 중: ${url}\n`);
    process.stderr.write(`[tokenbill] 이 PC의 로그만 읽으며, 어떤 데이터도 외부로 전송하지 않습니다.\n`);
    if (opts.openBrowser !== false) {
      const opener = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
      try { require("child_process").exec(opener); } catch {}
    }
  });
  server.on("error", (e) => {
    if (opts.silent) { process.stderr.write(`[tokenbill] 뷰어 자동 실행 생략: ${e.message}\n`); return; }
    process.stderr.write(`[tokenbill] 뷰어 시작 실패: ${e.message} (다른 포트: --port 8378)\n`);
    process.exit(1);
  });
}

module.exports = { start };
