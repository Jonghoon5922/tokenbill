/**
 * Duet 보드 (로컬 웹, 127.0.0.1:8737). Python duet/web.py 와 같은 API.
 *
 * 폴더를 읽어 그대로 보여준다. 요청이 올 때마다 ~/.duet 를 다시 읽고, 폴더가 바뀌면
 * /api/events(SSE) 로 알려 화면이 그때만 다시 읽는다. board.html 은 Python 판과 같은 파일이다.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const core = require("./core");

const PAGE = path.join(__dirname, "board.html");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = Number(process.env.DUET_PORT) || 8737;
const REPO_URL = "https://github.com/Jonghoon5922/duet";

function pageStamp(version) {
  try { return `${version}-${Math.floor(fs.statSync(PAGE).mtimeMs / 1000)}`; } catch { return version; }
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let buf = "";
    req.setEncoding("utf8");  // 한글이 청크 경계에서 깨지지 않게
    req.on("data", (c) => (buf += c));
    req.on("end", () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); } });
  });
}
/** core 호출 하나를 HTTP 응답으로. 규칙 위반은 400, 디스크는 500. */
function run(res, fn) {
  try { return fn(); }
  catch (e) {
    if (e instanceof core.DuetError) { json(res, 400, { detail: e.message }); return undefined; }
    json(res, 500, { detail: String(e.message || e) });
    return undefined;
  }
}
const archivedCount = () => new Set(core.listArchived().map((t) => t.project)).size;
const ref = (project, tid) => `${project}/${tid}`;

function createApp(version) {
  return async function handle(req, res) {
    const u = new URL(req.url, "http://127.0.0.1");
    const hostHdr = String(req.headers.host || "");
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(hostHdr)) { res.writeHead(403); return res.end("forbidden"); }
    const p = decodeURIComponent(u.pathname);
    const m = req.method;

    // tokenbill.my 포탈의 '작업 보드 실행 중' 감지용 — 민감 정보 없음이라 CORS 허용 (PNA preflight 포함)
    if (m === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Private-Network": "true",
      });
      return res.end();
    }
    if (m === "GET" && p === "/api/ping") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      return res.end('{"ok":true,"app":"duet-board"}');
    }

    if (m === "GET" && p === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(fs.readFileSync(PAGE, "utf8"));
    }
    if (m === "GET" && p === "/api/tasks") {
      const status = u.searchParams.get("status") || undefined;
      return run(res, () => json(res, 200, {
        tasks: core.listTasks(status).map((t) => t.toDetail()),
        projects: core.projects(), sprints: core.allSprints(), statuses: core.TASK_STATUSES, home: core.home(),
        archived: archivedCount(), version, repo: REPO_URL, page: pageStamp(version),
      }));
    }
    if (m === "GET" && p === "/api/archive") {
      return run(res, () => json(res, 200, {
        tasks: core.listArchived().map((t) => t.toDetail()), archived: archivedCount(), home: core.home(),
        version, repo: REPO_URL, page: pageStamp(version),
      }));
    }
    if (m === "GET" && p === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
      let last = core.fingerprint(), quiet = 0;
      res.write(`event: hello\ndata: ${pageStamp(version)}\n\n`);
      const timer = setInterval(() => {
        let cur;
        try { cur = core.fingerprint(); } catch { return; }
        quiet += 0.5;
        if (cur !== last) { last = cur; quiet = 0; res.write("event: change\ndata: 1\n\n"); }
        else if (quiet >= 15) { quiet = 0; res.write(`event: ping\ndata: ${pageStamp(version)}\n\n`); }
      }, 500);
      req.on("close", () => clearInterval(timer));
      return;
    }
    if (m === "POST" && p === "/api/tasks") {
      const b = await readBody(req);
      return run(res, () => json(res, 201, core.createTask(b.title, b.description || "", b.project || "").toDetail()));
    }
    if (m === "POST" && p === "/api/sprints") {
      const b = await readBody(req);
      return run(res, () => { const sp = core.createSprint(b.project || "", b); json(res, 201, { ...sp, note: `Sprint ${sp.name} created` }); });
    }
    if (m === "PATCH" && p === "/api/sprints") {
      const b = await readBody(req);
      return run(res, () => json(res, 200, core.updateSprint(b.project || "", b.id, b)));
    }
    if (m === "POST" && p === "/api/sprints/delete") {
      const b = await readBody(req);
      return run(res, () => json(res, 200, { deleted: core.deleteSprint(b.project || "", b.id) }));
    }
    if (m === "POST" && p === "/api/projects/archive") {
      const b = await readBody(req);
      return run(res, () => json(res, 200, { moved: core.archiveProject(b.name || "").map((t) => t.ref), note: `Archived '${b.name || core.UNSORTED_DIRNAME}'` }));
    }
    if (m === "POST" && p === "/api/projects/unarchive") {
      const b = await readBody(req);
      return run(res, () => json(res, 200, { moved: core.unarchiveProject(b.name || "").map((t) => t.ref), note: `Restored '${b.name || core.UNSORTED_DIRNAME}'` }));
    }
    let mm;
    if (m === "DELETE" && (mm = /^\/api\/projects\/([^/]+)$/.exec(p))) {
      const name = mm[1] === core.UNSORTED_DIRNAME ? "" : mm[1];
      return run(res, () => { const gone = core.deleteProject(name); json(res, 200, { deleted: gone, note: `Deleted project '${gone}'` }); });
    }
    if ((mm = /^\/api\/tasks\/([^/]+)\/([^/]+)$/.exec(p))) {
      const r = ref(mm[1], mm[2]);
      if (m === "GET") {
        try { return json(res, 200, core.getTask(r).toDetail()); } catch (e) { return json(res, 404, { detail: e.message }); }
      }
      if (m === "PATCH") {
        const b = await readBody(req);
        return run(res, () => json(res, 200, core.updateTask(r, { title: b.title, description: b.description, project: b.project }).toDetail()));
      }
      if (m === "DELETE") return run(res, () => { const gone = core.deleteTask(r); json(res, 200, { deleted: gone, note: `Deleted ${gone}` }); });
    }
    if (m === "POST" && (mm = /^\/api\/tasks\/([^/]+)\/([^/]+)\/sprint$/.exec(p))) {
      const b = await readBody(req);
      return run(res, () => json(res, 200, core.setTaskSprint(ref(mm[1], mm[2]), b.sprint == null ? null : b.sprint).toDetail()));
    }
    if (m === "POST" && (mm = /^\/api\/tasks\/([^/]+)\/([^/]+)\/status$/.exec(p))) {
      const b = await readBody(req);
      return run(res, () => json(res, 200, core.setStatus(ref(mm[1], mm[2]), b.status == null ? null : b.status).toDetail()));
    }
    if (m === "POST" && (mm = /^\/api\/tasks\/([^/]+)\/([^/]+)\/sessions\/([^/]+)\/status$/.exec(p))) {
      const b = await readBody(req);
      if (b.status == null) return json(res, 400, { detail: "세션은 자동으로 되돌릴 수 없다." });
      return run(res, () => json(res, 200, core.setSessionStatus(ref(mm[1], mm[2]), mm[3], b.status).toDetail()));
    }
    res.writeHead(404); res.end("not found");
  };
}

/** 보드를 띄운다. 포트가 이미 잡혀 있으면 조용히 실패한다 (다른 창이 맡고 있다). */
function serve({ port = DEFAULT_PORT, host = DEFAULT_HOST, version = "0.0.0", onError } = {}) {
  const handle = createApp(version);
  const server = http.createServer((req, res) => { handle(req, res).catch((e) => { try { res.writeHead(500); res.end(String(e.message || e)); } catch {} }); });
  server.on("error", (e) => { if (onError) onError(e); });
  server.listen(port, host);
  return server;
}

/**
 * 창마다 이 프로세스가 뜨므로, 포트가 비어 있는 첫 프로세스가 보드를 맡고 나머지는
 * 5초마다 다시 잡아 본다 — 맡은 창이 닫히면 다음 창이 이어받는다.
 */
function hostInBackground(version, log) {
  const tryOnce = () => {
    const server = serve({ version, onError: () => { server.close(); setTimeout(tryOnce, 5000).unref(); } });
    server.on("listening", () => { if (log) log(`Duet 보드: http://${DEFAULT_HOST}:${DEFAULT_PORT}`); });
    server.unref();
  };
  tryOnce();
}

module.exports = { createApp, serve, hostInBackground, DEFAULT_PORT, DEFAULT_HOST, REPO_URL, pageStamp };
