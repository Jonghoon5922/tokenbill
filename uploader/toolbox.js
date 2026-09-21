/**
 * 스킬·MCP 관리기 — 이 PC에 흩어진 스킬과 MCP 설정을 찾아 모은다.
 *
 * 읽기만 하고(설치는 viewer 쪽에서 ~/.claude/skills 안으로만), 어떤 것도 밖으로 보내지 않는다.
 * 토큰처럼 보이는 값은 찾는 즉시 마스킹해서 화면에도 원문이 가지 않게 한다.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const HOME = os.homedir();
const SKILLS_HOME = path.join(HOME, ".claude", "skills");   // Claude Code가 실제로 읽는 자리
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".venv", "venv", ".next", "target"]);

// ── 공통 ────────────────────────────────────────────────────
function* findSkillFiles(root, maxDepth) {
  const stack = [[root, 0]];
  let seen = 0;
  while (stack.length) {
    const [dir, depth] = stack.pop();
    if (depth > maxDepth) continue;
    if (++seen > 20000) return;   // 폴더가 너무 많으면 여기서 멈춘다 (PC가 느려지지 않게)
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isFile() && e.name === "SKILL.md") yield path.join(dir, e.name);
      else if (e.isDirectory() && !SKIP_DIRS.has(e.name)) stack.push([path.join(dir, e.name), depth + 1]);
    }
  }
}

/** SKILL.md 머리말에서 이름·설명을 꺼낸다. 없으면 폴더 이름으로 대신한다. */
function readSkillMeta(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8").slice(0, 4000); } catch { return null; }
  const dir = path.dirname(file);
  const meta = { name: path.basename(dir), description: "" };
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (fm) {
    const name = /^name:\s*(.+)$/m.exec(fm[1]);
    const desc = /^description:\s*(.+)$/m.exec(fm[1]);
    if (name) meta.name = name[1].trim().replace(/^["']|["']$/g, "");
    if (desc) meta.description = desc[1].trim().replace(/^["']|["']$/g, "");
  }
  if (!meta.description) {
    const body = text.replace(/^---[\s\S]*?---/, "").split(/\r?\n/)
      .map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    meta.description = (body[0] || "").slice(0, 160);
  }
  let mtime = 0, size = 0;
  try { const st = fs.statSync(file); mtime = st.mtimeMs; size = st.size; } catch {}
  return { ...meta, dir, file, mtime, size,
    hash: crypto.createHash("sha1").update(text).digest("hex").slice(0, 12),
    files: safeList(dir) };
}
function safeList(dir) {
  try { return fs.readdirSync(dir).filter((n) => n !== "SKILL.md").slice(0, 12); } catch { return []; }
}
const short = (p) => p.replace(HOME, "~").replace(/\\/g, "/");

/** Claude Code가 기억하는 프로젝트 폴더들 — 저장소 안 .claude/skills를 여기서 찾는다. */
function claudeProjects() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HOME, ".claude.json"), "utf8"));
    return Object.keys(j.projects || {}).filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  } catch { return []; }
}

// ── 스킬 모으기 ─────────────────────────────────────────────
function scanSkills() {
  const roots = [
    { root: SKILLS_HOME, depth: 2, source: "installed", label: "설치됨 (Claude Code)" },
    { root: path.join(HOME, ".claude", "plugins"), depth: 5, source: "plugin", label: "플러그인" },
    { root: path.join(HOME, ".bxca", "assistant-skills"), depth: 3, source: "bxca", label: "회사 어시스턴트" },
    { root: path.join(HOME, ".bxcabackup", "assistant-skills"), depth: 3, source: "bxca", label: "회사 어시스턴트 (백업)" },
    { root: path.join(HOME, "Downloads"), depth: 6, source: "folder", label: "내려받은 폴더" },
    { root: path.join(HOME, "Documents"), depth: 5, source: "folder", label: "문서 폴더" },
  ];
  for (const p of claudeProjects()) {
    roots.push({ root: path.join(p, ".claude", "skills"), depth: 2, source: "project", label: `프로젝트 — ${path.basename(p)}` });
  }

  const found = [], seenDir = new Set();
  for (const r of roots) {
    for (const file of findSkillFiles(r.root, r.depth)) {
      const dir = path.dirname(file);
      if (seenDir.has(dir)) continue;
      seenDir.add(dir);
      const meta = readSkillMeta(file);
      if (!meta) continue;
      found.push({ ...meta, source: r.source, origin: r.label, dir_short: short(dir),
        installed: dir.toLowerCase().startsWith(SKILLS_HOME.toLowerCase()) });
    }
  }
  // 같은 스킬이 여러 자리에 있으면 하나로 묶는다 (이름 기준, 사본 목록을 함께)
  const byName = new Map();
  for (const s of found.sort((a, b) => Number(b.installed) - Number(a.installed) || b.mtime - a.mtime)) {
    const key = s.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, { ...s, copies: [] });
    else byName.get(key).copies.push({ dir_short: s.dir_short, origin: s.origin, hash: s.hash, mtime: s.mtime });
  }
  const list = [...byName.values()].sort((a, b) =>
    Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name, "ko"));
  return { skills: list, installed_dir: short(SKILLS_HOME), total: found.length };
}

// ── MCP 모으기 ──────────────────────────────────────────────
const SECRET_KEYS = /(token|key|secret|password|pass|credential|api)/i;
const SECRET_VALUE = /^(tbu_|acv_|sk-|ghp_|github_pat_|npm_|xox[baprs]-)/i;
// `--token` 같은 플래그 바로 뒤 값만 비밀로 본다. 경로에 'token'이 들어간 것(…/tokenbill/…)과 헷갈리지 않게.
const SECRET_FLAG = /^--?[a-z0-9-]*(token|key|secret|password|pass|credential)$/i;
const isSecretArg = (args, i) => SECRET_VALUE.test(String(args[i])) || (i > 0 && SECRET_FLAG.test(String(args[i - 1])));

/** 토큰처럼 보이는 값을 가린다. 화면에도 원문은 보내지 않는다. */
function maskArgs(args) {
  const list = args || [];
  return list.map((v, i) => {
    const a = String(v);
    return isSecretArg(list, i) ? a.slice(0, 4) + "…" + a.slice(-2) : a;
  });
}
function maskEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    out[k] = SECRET_KEYS.test(k) || SECRET_VALUE.test(String(v))
      ? String(v).slice(0, 4) + "…" + String(v).slice(-2) : v;
  }
  return out;
}
function mcpEntry(name, cfg, scope, where) {
  return {
    name, scope, where: short(where),
    type: cfg.type || (cfg.url ? "http" : "stdio"),
    command: cfg.command || cfg.url || "",
    args: maskArgs(cfg.args),
    env: maskEnv(cfg.env),
    has_secret: (cfg.args || []).some((a, i) => isSecretArg(cfg.args, i)) ||
      Object.entries(cfg.env || {}).some(([k, v]) => SECRET_KEYS.test(k) || SECRET_VALUE.test(String(v))),
  };
}
function scanMcp() {
  const out = [];
  const cfgPath = path.join(HOME, ".claude.json");
  let j = null;
  try { j = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch {}
  if (j) {
    for (const [name, cfg] of Object.entries(j.mcpServers || {})) out.push(mcpEntry(name, cfg, "user", cfgPath));
    for (const [proj, v] of Object.entries(j.projects || {})) {
      for (const [name, cfg] of Object.entries((v && v.mcpServers) || {})) {
        out.push(mcpEntry(name, cfg, "local", `${cfgPath} → ${path.basename(proj)}`));
      }
    }
  }
  for (const p of claudeProjects()) {
    const f = path.join(p, ".mcp.json");
    try {
      const k = JSON.parse(fs.readFileSync(f, "utf8"));
      for (const [name, cfg] of Object.entries(k.mcpServers || {})) out.push(mcpEntry(name, cfg, "project", f));
    } catch {}
  }
  return { servers: out, config: short(cfgPath) };
}

/** 다른 PC로 옮길 때 쓰는 .mcp.json 템플릿 — 비밀값은 환경변수 자리표시자로. */
function mcpTemplate(names) {
  const cfgPath = path.join(HOME, ".claude.json");
  let j = {};
  try { j = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch {}
  const pick = names && names.length ? names : Object.keys(j.mcpServers || {});
  const servers = {};
  for (const name of pick) {
    const cfg = (j.mcpServers || {})[name];
    if (!cfg) continue;
    const args = (cfg.args || []).map((a, i) =>
      isSecretArg(cfg.args, i) ? "${" + name.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_TOKEN}" : a);
    const env = {};
    for (const [k, v] of Object.entries(cfg.env || {})) {
      env[k] = SECRET_KEYS.test(k) || SECRET_VALUE.test(String(v)) ? "${" + k + "}" : v;
    }
    servers[name] = { ...(cfg.type ? { type: cfg.type } : {}), command: cfg.command, args,
      ...(Object.keys(env).length ? { env } : {}) };
  }
  return { mcpServers: servers };
}

// ── 옮기기 (쓰기는 ~/.claude/skills 안에서만) ───────────────
function destFor(name) {
  const clean = String(name || "").trim().replace(/[\\/:*?"<>|]/g, "-");
  if (!clean || clean.startsWith(".")) throw new Error("스킬 이름이 이상합니다");
  const dest = path.resolve(SKILLS_HOME, clean);
  if (!dest.startsWith(path.resolve(SKILLS_HOME) + path.sep)) throw new Error("허용되지 않는 경로입니다");
  return dest;
}
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else if (e.isFile()) fs.copyFileSync(a, b);
  }
}
/** 스킬 폴더를 Claude Code가 읽는 자리로 복사한다. */
function installSkill(dir, { overwrite = false } = {}) {
  const src = path.resolve(String(dir || ""));
  if (!fs.existsSync(path.join(src, "SKILL.md"))) throw new Error("SKILL.md가 없는 폴더입니다");
  const meta = readSkillMeta(path.join(src, "SKILL.md"));
  const dest = destFor(meta.name);
  const exists = fs.existsSync(dest);
  if (exists && !overwrite) return { ok: false, exists: true, name: meta.name, dest: short(dest) };
  if (exists) fs.rmSync(dest, { recursive: true, force: true });
  copyDir(src, dest);
  return { ok: true, name: meta.name, dest: short(dest), from: short(src) };
}
/** 설치된 스킬만 지운다. */
function removeSkill(name) {
  const dest = destFor(name);
  if (!fs.existsSync(dest)) throw new Error("설치되어 있지 않습니다");
  fs.rmSync(dest, { recursive: true, force: true });
  return { ok: true, name, dest: short(dest) };
}

module.exports = { scanSkills, scanMcp, mcpTemplate, installSkill, removeSkill, SKILLS_HOME, short };
