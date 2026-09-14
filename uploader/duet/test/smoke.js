// 진짜 stdio MCP 프로세스(uploader/index.js)를 여러 개 띄워 한 바퀴. Python scripts/smoke.py 의 요지.
//   node uploader/duet/test/smoke.js
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "duet-smoke-"));
const INDEX = path.join(__dirname, "..", "..", "index.js");
process.env.DUET_HOME = HOME;
const core = require("../core");
let failed = false;
const check = (label, ok, detail = "") => { console.log(`[${ok ? "OK  " : "FAIL"}] ${label}${detail ? " - " + detail : ""}`); failed = failed || !ok; };

class Client {
  constructor(clientName = "claude-code", cwd = path.join(HOME, "..", "duet")) {
    fs.mkdirSync(cwd, { recursive: true });
    this.proc = spawn(process.execPath, [INDEX], { cwd, env: { ...process.env, DUET_HOME: HOME, DUET_NO_BOARD: "1", TOKENBILL_TOKEN: "" }, stdio: ["pipe", "pipe", "pipe"] });
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.pending = new Map();
    this.rl.on("line", (line) => { let m; try { m = JSON.parse(line); } catch { return; } const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
    this.id = 0;
    this.clientName = clientName;
  }
  rpc(method, params, notify = false) {
    if (notify) { this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); return Promise.resolve({}); }
    const id = ++this.id;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async init() {
    const r = await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: this.clientName, version: "9.9.9" } });
    await this.rpc("notifications/initialized", {}, true);
    this.instructions = r.instructions || "";
    return this;
  }
  async tool(name, args = {}) { const r = await this.rpc("tools/call", { name, arguments: args }); return r.structuredContent || JSON.parse(r.content[0].text); }
  close() { return new Promise((resolve) => { this.proc.on("exit", resolve); this.proc.stdin.end(); }); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`DUET_HOME = ${HOME}\n`);
  const a = await new Client().init();
  check("A 연결, 안내문에 프로젝트와 join_task", a.instructions.includes("join_task") && a.instructions.includes("이 창의 프로젝트: duet"));
  const tools = (await a.rpc("tools/list", {})).tools.map((t) => t.name);
  check("도구 목록에 tokenbill 2개 + duet 8개", tools.includes("sync_usage") && tools.includes("create_task") && tools.length === 10, tools.join(","));

  const made = await a.tool("create_task", { title: "pc101pm 전환", description: "NEFSS→BXM" });
  check("타스크는 이 창의 프로젝트에 T001로", made.task && made.task.ref === "duet/T001", JSON.stringify(made).slice(0, 80));
  const again = await a.tool("create_task", { title: "pc101pm 전환 2차" });
  check("비슷한 제목이면 후보만", "만들지_않았다" in again);
  const joined = await a.tool("join_task", { task_id: "T001", session_title: "DBIO 전환" });
  check("join → 진행중", joined.task && joined.task.status === "진행중", joined.error || "");
  await a.tool("report_progress", { message: "DBIO 5개 전환", percent: 40 });

  const b = await new Client("claude-ai").init();
  const blocked = await b.tool("join_task", { task_id: "duet/T001" });
  check("진행중인 타스크에는 같이 못 붙는다", /이미 살아 있는 세션/.test(blocked.error || ""));
  check("A 완료 → 타스크 완료", (await a.tool("complete_session", { summary: "DBIO 끝" })).task.status === "완료");
  check("B가 이어받으면 다시 진행중", (await b.tool("join_task", { task_id: "duet/T001", session_title: "Bean" })).task.status === "진행중");
  check("세션 둘이 각자 클라이언트 이름", core.getTask("duet/T001").sessions.map((s) => s.client).join(",") === "Claude Code,Claude Desktop", core.getTask("duet/T001").sessions.map((s) => s.client).join(","));
  const paused = await b.tool("pause_session", { reason: "여기까지" });
  check("pause → 확인 필요", paused.task.status === "확인 필요");

  // 임시 폴더에서 뜬 창: 프로젝트 이름 없이는 안 만든다
  const c = await new Client("claude-code", path.join(HOME, "..", "scratch-2026-09-14-abc")).init();
  check("임시 폴더 안내문", c.instructions.includes("project를 네가 정해라"));
  const noname = await c.tool("create_task", { title: "RAG 변환" });
  check("이름 없으면 안 만든다", "만들지_않았다" in noname && Array.isArray(noname["있는_프로젝트"]));
  const named = await c.tool("create_task", { title: "RAG 변환", project: "rag" });
  check("이름 주면 그 프로젝트에", named.task && named.task.ref === "rag/T001");

  await c.close();
  await a.close(); await b.close();
  await sleep(300);
  check("창을 닫으면 보고 없는 세션은 중지", core.getTask("duet/T001").sessions.every((s) => ["완료", "중지"].includes(s.status)));

  console.log(failed ? "\n실패 있음" : "\n전부 통과");
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
