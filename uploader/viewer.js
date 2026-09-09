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
  out.sort((a, b) => (b.start || "").localeCompare(a.start || ""));
  return out.slice(0, 500);
}
function searchSessions(q) {
  q = q.toLowerCase();
  const hits = [];
  for (const source of Object.keys(BASES)) {
    for (const file of walkFiles(BASES[source], EXTS[source])) {
      if (hits.length >= 50) return hits;
      const s = PARSERS[source](file, true);
      if (!s) continue;
      for (const e of s.entries) {
        if ((e.role !== "user" && e.role !== "assistant") || !e.text) continue;
        const idx = e.text.toLowerCase().indexOf(q);
        if (idx < 0) continue;
        hits.push({ source: s.source, file: s.file, project: s.project, start: s.start, role: e.role, time: e.time,
                    snippet: e.text.slice(Math.max(0, idx - 60), idx + q.length + 120).replace(/\s+/g, " ") });
        if (hits.length >= 50) break;
      }
    }
  }
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
header{padding:12px 18px;border-bottom:1px solid var(--grid);display:flex;align-items:center;gap:14px;flex-wrap:wrap}
header h1{font-size:1.05rem;font-weight:700}header h1 b{color:var(--accent)}
header .note{font-size:.74rem;color:var(--muted)}
#q{margin-left:auto;width:280px;padding:7px 10px;border:1px solid var(--border);border-radius:7px;background:var(--surface);color:var(--ink);font:inherit;font-size:.84rem}
main{flex:1;display:flex;min-height:0}
#side{width:340px;flex:none;border-right:1px solid var(--grid);overflow-y:auto;padding:8px}
.sess{padding:9px 10px;border-radius:8px;cursor:pointer;margin-bottom:2px}
.sess:hover{background:var(--chip)}.sess.on{background:color-mix(in srgb,var(--accent) 12%,transparent)}
.sess .t{font-size:.8rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sess .m{font-size:.7rem;color:var(--muted);display:flex;gap:8px;margin-top:2px}
.src{display:inline-block;padding:0 6px;border-radius:999px;color:#fff;font-size:.64rem;font-weight:600;line-height:1.5;white-space:nowrap;flex:none}
.sess .m{flex-wrap:wrap}
#view{flex:1;overflow-y:auto;padding:20px 26px}
.msg{max-width:860px;margin:0 auto 14px}
.msg .hd{font-size:.7rem;color:var(--muted);margin-bottom:3px;display:flex;gap:10px}
.msg .bd{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:11px 14px;font-size:.85rem;white-space:pre-wrap;word-break:break-word}
.msg.user .bd{border-left:3px solid var(--accent)}
.msg.tool .bd,.msg.think .bd{font-size:.74rem;color:var(--ink2);font-family:ui-monospace,Consolas,monospace;background:var(--chip)}
.msg details summary{cursor:pointer;font-size:.72rem;color:var(--muted)}
.empty{color:var(--muted);text-align:center;padding:60px 20px;font-size:.88rem}
.sumline{max-width:860px;margin:0 auto 18px;font-size:.78rem;color:var(--ink2);padding-bottom:12px;border-bottom:1px solid var(--grid)}
@media(max-width:760px){#side{width:200px}}
</style></head><body>
<header><h1>Token<b>bill</b> 로컬 뷰어</h1>
<span class="note">이 PC의 로그만 읽습니다 — 아무것도 업로드되지 않아요</span>
<input id="q" placeholder="대화 내용 검색 (Enter)"></header>
<main><div id="side"></div><div id="view"><p class="empty">왼쪽에서 세션을 선택하세요</p></div></main>
<script>
(function(){
"use strict";
var SRC={"claude-code":["Claude Code","var(--cc)"],"codex":["Codex","var(--codex)"],"gemini":["Gemini","var(--gem)"]};
var ROLE={user:"나",assistant:"AI",tool_use:"도구 호출",tool_result:"도구 결과",thinking:"생각"};
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
function fmtTok(n){return n>=1e9?(n/1e9).toFixed(1)+"B":n>=1e6?(n/1e6).toFixed(1)+"M":n>=1e3?Math.round(n/1e3)+"K":String(n)}
function dt(s){return s?s.slice(0,16).replace("T"," "):""}
function srcBadge(s){var b=el("span","src",SRC[s]?SRC[s][0]:s);b.style.background=SRC[s]?SRC[s][1]:"var(--accent)";return b}
var side=document.getElementById("side"),view=document.getElementById("view");
function loadList(){
  fetch("/api/sessions").then(function(r){return r.json()}).then(function(list){
    side.textContent="";
    if(!list.length){side.appendChild(el("p","empty","세션이 없습니다"));return}
    list.forEach(function(s){
      var d=el("div","sess");
      var t=el("div","t",s.title||"(제목 없음)");d.appendChild(t);
      var m=el("div","m");m.appendChild(srcBadge(s.source));
      m.appendChild(el("span","",(s.project||"")+" · "+dt(s.start)+" · "+s.msgs+"건 · "+fmtTok(s.tokens)+" tok"));
      d.appendChild(m);
      d.addEventListener("click",function(){
        Array.prototype.forEach.call(side.children,function(c){c.classList.remove("on")});
        d.classList.add("on");loadSession(s)});
      side.appendChild(d)})})
  .catch(function(){side.appendChild(el("p","empty","목록을 불러오지 못했습니다"))})}
function loadSession(s){
  view.textContent="";view.appendChild(el("p","empty","불러오는 중…"));
  fetch("/api/session?file="+encodeURIComponent(s.file)).then(function(r){return r.json()}).then(function(d){
    view.textContent="";
    var sum=el("div","sumline");sum.appendChild(srcBadge(d.source));
    sum.appendChild(el("span",""," "+(d.project||"")+" · "+dt(d.start)+" ~ "+dt(d.end).slice(11)+" · "+(d.model||"")+" · 총 "+fmtTok(d.tokens)+" tok"));
    view.appendChild(sum);
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
document.getElementById("q").addEventListener("keydown",function(ev){
  if(ev.key!=="Enter")return;var q=this.value.trim();
  if(!q){loadList();return}
  side.textContent="";side.appendChild(el("p","empty","검색 중…"));
  fetch("/api/search?q="+encodeURIComponent(q)).then(function(r){return r.json()}).then(function(hits){
    side.textContent="";
    if(!hits.length){side.appendChild(el("p","empty","검색 결과 없음"));return}
    hits.forEach(function(h){
      var d=el("div","sess");
      d.appendChild(el("div","t","…"+h.snippet+"…"));
      var m=el("div","m");m.appendChild(srcBadge(h.source));
      m.appendChild(el("span","",(h.project||"")+" · "+dt(h.time||h.start)));d.appendChild(m);
      d.addEventListener("click",function(){loadSession(h)});
      side.appendChild(d)})})
  .catch(function(){side.textContent="";side.appendChild(el("p","empty","검색 실패"))})});
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
