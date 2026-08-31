#!/usr/bin/env node
/**
 * Tokenbill MCP 업로더
 *
 * - 시작 시 로컬 AI 사용 로그(~/.claude, ~/.codex)를 스캔해 tokenbill.my로 업로드
 * - MCP(stdio) 서버로 동작: sync_usage(수동 동기화), my_rank(내 순위 조회) 도구 제공
 *
 * 등록 예:
 *   claude mcp add tokenbill -- npx -y github:Jonghoon5922/tokenbill --token tbu_...
 *   codex mcp add tokenbill -- npx -y github:Jonghoon5922/tokenbill --token tbu_...
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");
const readline = require("readline");

// ── 설정 ────────────────────────────────────────────────────
function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const TOKEN = arg("--token") || process.env.TOKENBILL_TOKEN || "";
const SERVER = (arg("--server") || process.env.TOKENBILL_SERVER || "https://tokenbill.my").replace(/\/$/, "");
const LOOKBACK_DAYS = 60;

function log(msg) { process.stderr.write(`[tokenbill] ${msg}\n`); }

// ── HTTP ────────────────────────────────────────────────────
function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(SERVER + urlPath);
    const mod = url.protocol === "http:" ? http : https;
    const data = body ? JSON.stringify(body) : null;
    const req = mod.request(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Upload-Token": TOKEN,
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
      timeout: 30000,
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); }
        catch { resolve({ status: res.statusCode, json: {} }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (data) req.write(data);
    req.end();
  });
}

// ── 로그 스캔 공통 ──────────────────────────────────────────
function* walkFiles(dir, ext) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p, ext);
    else if (e.isFile() && e.name.endsWith(ext)) yield p;
  }
}
function cutoffDay() {
  const d = new Date(Date.now() - LOOKBACK_DAYS * 86400000);
  return d.toISOString().slice(0, 10);
}
function addRow(agg, day, model, inTok, outTok) {
  if (!day || day < cutoffDay()) return;
  const k = `${day}|${model}`;
  const a = agg.get(k) || { day, model, input_tokens: 0, output_tokens: 0 };
  a.input_tokens += inTok;
  a.output_tokens += outTok;
  agg.set(k, a);
}

// ── Claude Code (~/.claude/projects/**/*.jsonl) ─────────────
function collectClaudeCode() {
  const agg = new Map();
  const seen = new Set();
  const base = path.join(os.homedir(), ".claude", "projects");
  for (const file of walkFiles(base, ".jsonl")) {
    let lines;
    try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch { continue; }
    for (const line of lines) {
      if (!line.includes('"usage"')) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const u = e && e.message && e.message.usage;
      if (e.type !== "assistant" || !u || !e.timestamp) continue;
      const model = (e.message.model || "claude").slice(0, 128);
      if (model.includes("synthetic")) continue;
      const dedup = `${e.message.id || ""}:${e.requestId || e.uuid || ""}`;
      if (dedup !== ":" && seen.has(dedup)) continue;
      seen.add(dedup);
      const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      addRow(agg, e.timestamp.slice(0, 10), model, inTok, u.output_tokens || 0);
    }
  }
  return [...agg.values()];
}

// ── Codex CLI (~/.codex/sessions/**/*.jsonl) — 형식이 자주 바뀌어 최선 노력 ──
function collectCodex() {
  const agg = new Map();
  const base = path.join(os.homedir(), ".codex", "sessions");
  for (const file of walkFiles(base, ".jsonl")) {
    let lines;
    try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch { continue; }
    let model = "codex";
    let prev = null; // total 누적치를 주는 형식 대응: 직전 총계와의 차이를 사용
    for (const line of lines) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const p = e.payload || e;
      if (p && p.type === "turn_context" && p.model) model = String(p.model).slice(0, 128);
      const info = p && p.info;
      const usage = (info && (info.last_token_usage || info.total_token_usage)) ||
                    (p && p.type === "token_count" && p.usage) || null;
      if (!usage) continue;
      const day = (e.timestamp || e.ts || "").slice(0, 10);
      let inTok = (usage.input_tokens || 0) + (usage.cached_input_tokens || 0);
      let outTok = usage.output_tokens || 0;
      if (info && info.total_token_usage && !info.last_token_usage) {
        // 누적 총계 형식이면 직전 값과의 증가분만 반영
        const t = info.total_token_usage;
        const cur = { i: (t.input_tokens || 0) + (t.cached_input_tokens || 0), o: t.output_tokens || 0 };
        inTok = Math.max(0, cur.i - (prev ? prev.i : 0));
        outTok = Math.max(0, cur.o - (prev ? prev.o : 0));
        prev = cur;
      }
      if (inTok || outTok) addRow(agg, day, model, inTok, outTok);
    }
  }
  return [...agg.values()];
}

// ── Gemini CLI (~/.gemini/tmp/**/*.json|.jsonl) ─────────────
function geminiTokens(t) {
  if (!t || typeof t !== "object") return null;
  const n = (keys) => { for (const k of keys) { const v = t[k]; if (typeof v === "number" && v > 0) return Math.floor(v); } return 0; };
  const input = n(["input", "prompt", "input_tokens", "prompt_tokens"]);       // cached 포함값
  const output = n(["output", "candidates", "output_tokens", "candidates_tokens"]);
  const extra = n(["thoughts", "reasoning", "thoughts_tokens", "reasoning_tokens"]) + n(["tool", "tool_tokens"]);
  if (!input && !output && !extra) return null;
  return { input, output: output + extra };
}
function collectGemini() {
  const agg = new Map();
  const base = path.join(os.homedir(), ".gemini", "tmp");
  const handleMsg = (msg, fallbackDay, fallbackModel) => {
    if (!msg || msg.type !== "gemini") return;
    const tok = geminiTokens(msg.tokens);
    if (!tok) return;
    const day = (msg.timestamp || "").slice(0, 10) || fallbackDay;
    const model = String(msg.model || fallbackModel || "gemini").slice(0, 128);
    addRow(agg, day, model, tok.input, tok.output);
  };
  for (const ext of [".json", ".jsonl"]) {
    for (const file of walkFiles(base, ext)) {
      let content;
      try { content = fs.readFileSync(file, "utf8"); } catch { continue; }
      let fallbackDay = "";
      try { fallbackDay = fs.statSync(file).mtime.toISOString().slice(0, 10); } catch {}
      if (ext === ".json") {
        let rec;
        try { rec = JSON.parse(content); } catch { continue; }
        const day = ((rec.startTime || rec.lastUpdated || "").slice(0, 10)) || fallbackDay;
        if (Array.isArray(rec.messages)) rec.messages.forEach((m) => handleMsg(m, day, rec.model));
        else handleMsg(rec, day, rec.model);
      } else {
        for (const line of content.split("\n")) {
          if (!line.includes('"tokens"')) continue;
          try { handleMsg(JSON.parse(line), fallbackDay); } catch {}
        }
      }
    }
  }
  return [...agg.values()];
}

// ── 업로드 ──────────────────────────────────────────────────
async function syncAll() {
  if (!TOKEN) return "업로드 토큰이 없습니다 — --token 또는 TOKENBILL_TOKEN을 설정하세요.";
  const sources = [
    ["claude-code", collectClaudeCode],
    ["codex", collectCodex],
    ["gemini", collectGemini],
  ];
  const results = [];
  for (const [source, collect] of sources) {
    let rows = [];
    try { rows = collect(); } catch (e) { results.push(`${source}: 스캔 실패 (${e.message})`); continue; }
    if (!rows.length) { results.push(`${source}: 사용 기록 없음`); continue; }
    try {
      const r = await request("POST", "/api/usage/import", { source, rows: rows.slice(0, 2000) });
      results.push(r.status === 200
        ? `${source}: ${r.json.rows}일×모델 업로드 (${r.json.from}~${r.json.to})`
        : `${source}: 업로드 실패 (HTTP ${r.status}${r.json.detail ? " — " + r.json.detail : ""})`);
    } catch (e) { results.push(`${source}: 업로드 실패 (${e.message})`); }
  }
  return results.join("\n");
}

async function myRank() {
  try {
    const r = await request("GET", "/api/uploader/me");
    if (r.status !== 200) return `조회 실패 (HTTP ${r.status}${r.json.detail ? " — " + r.json.detail : ""})`;
    const m = r.json;
    const next = m.tier.next ? `다음 티어 '${m.tier.next.name}'까지 ${(m.tier.next.at - m.tokens).toLocaleString()} tok` : "최고 티어!";
    return `${m.tier.emoji} ${m.nickname} — ${m.tier.name}\n이번 달 ${m.tokens.toLocaleString()} tok · $${m.cost_usd} · ${m.rank}위/${m.total_users}명\n${next}\nhttps://tokenbill.my`;
  } catch (e) { return `조회 실패 (${e.message})`; }
}

// ── MCP (stdio, 개행 구분 JSON-RPC) ────────────────────────
const TOOLS = [
  { name: "sync_usage", description: "로컬 AI 사용 로그(Claude Code·Codex·Gemini CLI)를 스캔해 Tokenbill에 지금 업로드합니다.", inputSchema: { type: "object", properties: {} } },
  { name: "my_rank", description: "Tokenbill 토큰 리더보드에서 내 이번 달 순위·티어·사용량을 조회합니다.", inputSchema: { type: "object", properties: {} } },
];

function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
function replyErr(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "tokenbill", version: "0.1.0" },
    });
  }
  if (method === "notifications/initialized" || (method && method.startsWith("notifications/"))) return;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params && params.name;
    let text;
    if (name === "sync_usage") text = await syncAll();
    else if (name === "my_rank") text = await myRank();
    else return replyErr(id, -32602, `unknown tool: ${name}`);
    return reply(id, { content: [{ type: "text", text }] });
  }
  if (id !== undefined) return replyErr(id, -32601, `method not found: ${method}`);
}

// 시작 시 1회 자동 업로드 (백그라운드)
syncAll().then((r) => log("자동 동기화:\n" + r)).catch((e) => log("동기화 오류: " + e.message));

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch((e) => { if (msg.id !== undefined) replyErr(msg.id, -32603, e.message); });
});
rl.on("close", () => process.exit(0));
