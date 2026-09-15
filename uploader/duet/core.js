/**
 * Duet 핵심 — 폴더와 파일, 그리고 상태 규칙. (Python duet/core.py 를 그대로 옮긴 것)
 *
 *   ~/.duet/
 *   ├── duet/                    프로젝트 = 폴더
 *   │   ├── T001-대시보드-만들기/
 *   │   │   ├── task.md          제목·설명 (+ 사람이 정한 상태 한 줄)
 *   │   │   └── s-a1b2c3d4.json  세션 (그 프로세스만 쓴다)
 *   │   └── T002-…/
 *   ├── _미분류/                 어느 프로젝트인지 못 알아낸 타스크
 *   ├── _미참여/                 아직 join 안 한 세션 파일
 *   ├── _보관/                   끝난 프로젝트를 폴더째 옮겨 두는 곳
 *   └── 프로젝트.md              폴더 경로 = 부르는 이름
 *
 * 규칙 두 개가 전부다:
 * 1. 타스크 상태는 저장하지 않고 센다. 세션 파일을 세서 정한다.
 *    전부 완료면 완료, 하나라도 살아 있으면 진행중, 끊긴 세션이 남았으면 확인 필요.
 * 2. 사람이 정한 것이 이긴다. task.md 에 `상태: 완료` 한 줄이 있으면 그게 상태다.
 *
 * 한 파일에 두 주인이 없다. 세션 파일은 그 세션의 프로세스만 쓴다. task.md 는 편집만 쓴다.
 * 기록 형식은 Python 판과 같아서 어느 쪽으로 만든 기록이든 서로 읽는다.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const HOME_ENV = "DUET_HOME";
const IDLE_DIRNAME = "_미참여";
const ARCHIVE_DIRNAME = "_보관";
const UNSORTED_DIRNAME = "_미분류";
const ALIAS_FILENAME = "프로젝트.md";

const HEARTBEAT_SEC = 30;
const STALE_SEC = 90;

const WAITING = "대기", RUNNING = "진행중", DONE = "완료", STOPPED = "중지";
const ATTENTION = "확인 필요", HOLD = "보류", CANCELLED = "취소";
const TASK_STATUSES = [WAITING, RUNNING, ATTENTION, DONE, HOLD, CANCELLED];
const HUMAN_STATUSES = [DONE, HOLD, CANCELLED];
const CLOSED = [DONE, STOPPED];

const TASK_DIR = /^(T\d{3,})(?:-.*)?$/;
const STATUS_LINE = /^상태:\s*(\S+)\s*$/m;
const PROJECT_LINE = /^프로젝트:\s*(.+?)\s*$/m;
const META_LINE = /^(?:상태|프로젝트):\s*.*$/;
const NOT_PROJECT = new Set(["", "/", "\\", "system32", "windows", "desktop", "바탕 화면", "temp", "tmp"]);
const TEMP_FOLDER = /^(scratch|tmp|temp)[-_.]/i;
const BAD_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

class DuetError extends Error {}

function pad(n, w = 2) { return String(n).padStart(w, "0"); }
/** 로컬 시각, 밀리초까지. Python 의 isoformat(timespec="milliseconds") 와 같은 꼴. */
function now() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
function age(stamp) {
  const t = Date.parse(stamp || "");
  return Number.isNaN(t) ? Infinity : (Date.now() - t) / 1000;
}

const migrated = new Set();
function home() {
  const override = process.env[HOME_ENV];
  const base = override ? path.resolve(override) : path.join(os.homedir(), ".duet");
  fs.mkdirSync(path.join(base, IDLE_DIRNAME), { recursive: true });
  if (!migrated.has(base)) { migrated.add(base); migrateFlatLayout(base); }
  return base;
}

// ── 세션 파일 ─────────────────────────────────────────────────

class Session {
  constructor(data = {}) {
    this.id = data.id;
    this.title = data.title || "";
    this.client = data.client || "알 수 없음";
    this.status = data.status || RUNNING;
    this.cwd = data.cwd || "";
    this.client_session = data.client_session || "";
    this.started = data.started || "";
    this.heartbeat = data.heartbeat || "";
    this.summary = data.summary || "";
    this.by_human = !!data.by_human;
    this.progress = Array.isArray(data.progress) ? data.progress : [];
    this.path = null;
  }
  get alive() { return !CLOSED.includes(this.status) && age(this.heartbeat) <= STALE_SEC; }
  get shownStatus() { return CLOSED.includes(this.status) ? this.status : (this.alive ? RUNNING : STOPPED); }
  toDict() {
    return { id: this.id, title: this.title, client: this.client, cwd: this.cwd, client_session: this.client_session,
      status: this.shownStatus, by_human: this.by_human, alive: this.alive, started: this.started,
      heartbeat: this.heartbeat, summary: this.summary, progress: this.progress };
  }
  toFile() {
    return { id: this.id, title: this.title, client: this.client, status: this.status, cwd: this.cwd,
      client_session: this.client_session, started: this.started, heartbeat: this.heartbeat,
      summary: this.summary, by_human: this.by_human, progress: this.progress };
  }
  /** 임시 파일에 쓰고 바꿔치기한다. 읽는 쪽이 반쪽 JSON 을 보지 않게. */
  save() {
    const tmp = `${this.path}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.toFile(), null, 2), "utf8");
    fs.renameSync(tmp, this.path);
  }
}

function readSession(file) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  const s = new Session(data);
  s.path = file;
  return s;
}
function readSessions(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^s-.*\.json$/.test(n)).sort(); } catch { return []; }
  return names.map((n) => readSession(path.join(dir, n))).filter(Boolean)
    .sort((a, b) => (a.started < b.started ? -1 : a.started > b.started ? 1 : 0));
}

// ── 타스크 ────────────────────────────────────────────────────

class Task {
  constructor({ id, title, description, override, dir, sessions }) {
    Object.assign(this, { id, title, description, override, dir, sessions: sessions || [] });
  }
  get project() { const n = path.basename(path.dirname(this.dir)); return n === UNSORTED_DIRNAME ? "" : n; }
  get ref() { return `${this.project || UNSORTED_DIRNAME}/${this.id}`; }
  get counts() {
    const c = { [RUNNING]: 0, [DONE]: 0, [STOPPED]: 0 };
    for (const s of this.sessions) c[s.shownStatus]++;
    return c;
  }
  get status() {
    if (this.override) return this.override;
    const c = this.counts;
    if (!this.sessions.length) return WAITING;
    if (c[RUNNING]) return RUNNING;
    if (c[STOPPED]) return ATTENTION;
    return DONE;
  }
  get lastActivity() {
    const stamps = this.sessions.map((s) => s.heartbeat).filter(Boolean);
    return stamps.length ? stamps.reduce((a, b) => (a > b ? a : b)) : "";
  }
  get warning() {
    return this.status === ATTENTION ? `끊긴 세션 ${this.counts[STOPPED]}개 — 이어갈지 끝낼지 사람이 정한다` : "";
  }
  toDict() {
    return { id: this.id, ref: this.ref, project: this.project, title: this.title, status: this.status,
      counts: this.counts, override: this.override, warning: this.warning, last_activity: this.lastActivity };
  }
  toDetail() {
    return { ...this.toDict(), description: this.description, folder: this.dir, sessions: this.sessions.map((s) => s.toDict()) };
  }
}

function readTask(dir) {
  const text = fs.readFileSync(path.join(dir, "task.md"), "utf8");
  let override = null;
  const m = STATUS_LINE.exec(text);
  if (m) {
    const written = m[1] === STOPPED ? HOLD : m[1];
    if (HUMAN_STATUSES.includes(written)) override = written;
  }
  const lines = text.split(/\r?\n/).filter((ln) => !META_LINE.test(ln));
  const title = lines.length ? lines[0].replace(/^#\s*/, "").trim() : path.basename(dir);
  return new Task({
    id: TASK_DIR.exec(path.basename(dir))[1], title,
    description: lines.slice(1).join("\n").trim(), override, dir, sessions: readSessions(dir),
  });
}
function writeTask(dir, title, description, override) {
  const out = [`# ${title}`];
  if (override) out.push(`상태: ${override}`);
  out.push("", (description || "").trim(), "");
  fs.writeFileSync(path.join(dir, "task.md"), out.join("\n"), "utf8");
}
function safeRead(dir) { try { return readTask(dir); } catch { return null; } }

// ── 프로젝트 폴더 ───────────────────────────────────────────────

function projectDir(name, base) {
  const folder = (name || "").trim() || UNSORTED_DIRNAME;
  if (folder !== UNSORTED_DIRNAME && (folder.startsWith("_") || BAD_CHARS.test(folder))) {
    BAD_CHARS.lastIndex = 0;
    throw new DuetError(`프로젝트 이름으로 쓸 수 없다: ${name}`);
  }
  BAD_CHARS.lastIndex = 0;
  return path.join(base || home(), folder);
}
function projectDirs(base) {
  const root = base || home();
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory() && (!e.name.startsWith("_") || e.name === UNSORTED_DIRNAME))
    .map((e) => path.join(root, e.name)).sort();
}
function taskDirsIn(folder) {
  let entries = [];
  try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory() && TASK_DIR.test(e.name)).map((e) => path.join(folder, e.name)).sort();
}
function taskDirs() { return projectDirs().flatMap(taskDirsIn); }
function archiveDir() { const p = path.join(home(), ARCHIVE_DIRNAME); fs.mkdirSync(p, { recursive: true }); return p; }

/** 그 프로젝트의 다음 번호로 타스크 폴더를 만든다. mkdir 이 원자적이라 동시에 만들어도 진 쪽만 밀린다. */
function nextTaskDir(folder, title) {
  fs.mkdirSync(folder, { recursive: true });
  const slug = (title || "").replace(BAD_CHARS, "").trim().replace(/\s+/g, "-").slice(0, 40).replace(/^[-. ]+|[-. ]+$/g, "");
  const used = new Set(taskDirsIn(folder).map((p) => TASK_DIR.exec(path.basename(p))[1]));
  for (let n = 1; ; n++) {
    const tid = `T${pad(n, 3)}`;
    if (used.has(tid)) continue;
    const candidate = path.join(folder, slug ? `${tid}-${slug}` : tid);
    try { fs.mkdirSync(candidate); return candidate; } catch (e) { if (e.code !== "EEXIST") throw e; }
  }
}

// ── 타스크 찾기·만들기·고치기 ────────────────────────────────────

function parseRef(ref) {
  let text = String(ref).trim(), project = null;
  if (text.includes("/")) {
    const i = text.lastIndexOf("/");
    project = text.slice(0, i).trim();
    text = text.slice(i + 1);
    if (project === UNSORTED_DIRNAME) project = "";
  }
  const number = text.trim().toUpperCase().replace(/^T+/, "");
  if (!/^\d+$/.test(number)) throw new DuetError(`타스크 id가 아니다: ${ref}`);
  return [project, `T${pad(Number(number), 3)}`];
}
const tidOf = (dir) => TASK_DIR.exec(path.basename(dir))[1];

function findTask(ref, hint) {
  const [project, tid] = parseRef(ref);
  if (project !== null) {
    const hit = taskDirsIn(projectDir(project)).find((p) => tidOf(p) === tid);
    if (hit) return hit;
    throw new DuetError(`${project || UNSORTED_DIRNAME}/${tid} 타스크가 없다.`);
  }
  if (hint !== undefined && hint !== null) {
    const hit = taskDirsIn(projectDir(hint)).find((p) => tidOf(p) === tid);
    if (hit) return hit;
  }
  const found = taskDirs().filter((p) => tidOf(p) === tid);
  if (found.length === 1) return found[0];
  if (!found.length) throw new DuetError(`${tid} 타스크가 없다.`);
  throw new DuetError(`${tid}가 여러 프로젝트에 있다: ${found.map((p) => `${path.basename(path.dirname(p))}/${tid}`).join(", ")}. 프로젝트를 붙여서 불러라.`);
}
function getTask(ref, hint) { return readTask(findTask(ref, hint)); }

function createTask(title, description = "", project = "") {
  title = (title || "").trim();
  if (!title) throw new DuetError("타스크 제목이 비어 있다.");
  const dir = nextTaskDir(projectDir(project), title);
  writeTask(dir, title, description, null);
  return readTask(dir);
}
function listTasks(status) {
  reap();
  let tasks = taskDirs().map(safeRead).filter(Boolean);
  if (status) tasks = tasks.filter((t) => t.status === status);
  const key = (t) => `${t.lastActivity} ${t.project} ${t.id}`;
  return tasks.sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
}
function projects() {
  const out = [];
  for (const p of projectDirs()) {
    const n = path.basename(p);
    if (n === UNSORTED_DIRNAME) { if (taskDirsIn(p).length) out.push(""); } else out.push(n);
  }
  return out;
}
function words(s) { return new Set(s.toLowerCase().split(/[\s·,]+/).filter((w) => w.length > 1)); }
function similarTasks(title, limit = 3) {
  const ws = words(title), lower = title.toLowerCase(), found = [];
  for (const t of listTasks()) {
    if ([DONE, CANCELLED].includes(t.status)) continue;
    const other = words(t.title), tl = t.title.toLowerCase();
    const nested = lower.includes(tl) || tl.includes(lower);
    if (nested || [...ws].some((w) => other.has(w))) found.push(t);
  }
  return found.slice(0, limit);
}
function updateTask(ref, { title, description, project, hint } = {}) {
  const task = getTask(ref, hint);
  const newTitle = title == null ? task.title : title.trim();
  if (!newTitle) throw new DuetError("타스크 제목이 비어 있다.");
  const newDesc = description == null ? task.description : description.trim();
  writeTask(task.dir, newTitle, newDesc, task.override);
  if (project != null && project.trim() !== task.project) {
    if (task.counts[RUNNING]) throw new DuetError("살아 있는 세션이 붙어 있어 다른 프로젝트로 못 옮긴다.");
    const target = nextTaskDir(projectDir(project), newTitle);
    fs.rmdirSync(target);
    fs.renameSync(task.dir, target);
    return readTask(target);
  }
  return readTask(task.dir);
}
function setStatus(ref, status, hint) {
  if (status != null && !HUMAN_STATUSES.includes(status)) {
    throw new DuetError(`고를 수 있는 상태: ${HUMAN_STATUSES.join(", ")}. '${WAITING}'·'${RUNNING}'·'${ATTENTION}'는 세션이 없느냐 살아 있느냐 끊겼느냐는 사실이라 고르는 것이 아니다. 되돌리려면 status=null(🔒 풀기).`);
  }
  const task = getTask(ref, hint);
  writeTask(task.dir, task.title, task.description, status || null);
  return readTask(task.dir);
}

// ── 세션 ─────────────────────────────────────────────────────

function aliases() {
  let text;
  try { text = fs.readFileSync(path.join(home(), ALIAS_FILENAME), "utf8"); } catch { return {}; }
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const folder = line.slice(0, i).trim(), name = line.slice(i + 1).trim();
    if (folder && name) out[path.normalize(folder).toLowerCase()] = name;
  }
  return out;
}
function projectName(cwd) {
  if (!cwd) return "";
  const named = aliases()[path.normalize(cwd).toLowerCase()];
  if (named) return named;
  const name = path.basename(cwd).trim();
  if (NOT_PROJECT.has(name.toLowerCase()) || name.startsWith(".") || TEMP_FOLDER.test(name)) return "";
  return name;
}
function registerSession(client = "알 수 없음", cwd = "", clientSession = "") {
  const s = new Session({ id: "s-" + crypto.randomBytes(4).toString("hex"), client, cwd, client_session: clientSession, started: now(), heartbeat: now() });
  s.path = path.join(home(), IDLE_DIRNAME, `${s.id}.json`);
  s.save();
  return s;
}
function join(session, ref, title = "") {
  if (CLOSED.includes(session.status)) {
    const done = taskOf(session);
    throw new DuetError(`이 세션은 ${done ? `[${done.ref}] ${done.title}을(를)` : "일을"} 이미 끝냈다. 세션 하나는 타스크 하나다 — 다른 일은 새 세션에서.`);
  }
  const current = taskOf(session);
  if (current && session.progress.length) throw new DuetError(`이 세션은 이미 [${current.ref}] ${current.title}에 붙어 보고까지 했다. 세션 하나는 타스크 하나다.`);
  const dir = findTask(ref, projectName(session.cwd));
  const busy = readSessions(dir).find((s) => s.id !== session.id && s.alive);
  if (busy) {
    throw new DuetError(`[${path.basename(path.dirname(dir))}/${tidOf(dir)}]에는 이미 살아 있는 세션이 있다: '${busy.title || busy.id}' (${busy.client}). 타스크 하나에는 세션 하나만 붙는다 — 그 세션이 끝나거나 멈춘 뒤에 이어받는다. 같은 일을 다른 창에서 하고 있는 게 아닌지 사용자에게 확인하라.`);
  }
  const old = session.path;
  session.title = (title || "").trim() || session.title;
  session.status = RUNNING;
  session.heartbeat = now();
  session.path = path.join(dir, `${session.id}.json`);
  session.save();
  if (old !== session.path) { try { fs.unlinkSync(old); } catch {} }
  // 사람이 고정해 둔 상태는 새 세션이 붙는 순간 푼다 — 다시 일하는 타스크가 '완료'로 남아 있지 않게.
  const joined = readTask(dir);
  if (joined.override) { writeTask(dir, joined.title, joined.description, null); return readTask(dir); }
  return joined;
}
function taskOf(session) {
  if (!session.path || !TASK_DIR.test(path.basename(path.dirname(session.path)))) return null;
  return safeRead(path.dirname(session.path));
}
function heartbeat(session) { if (!CLOSED.includes(session.status)) { session.heartbeat = now(); session.save(); } }
function report(session, message, percent = null) {
  message = (message || "").trim();
  if (!message) throw new DuetError("진행 내용이 비어 있다.");
  if (CLOSED.includes(session.status)) throw new DuetError("이미 끝난 세션이다. 보고할 수 없다.");
  const entry = { t: now(), msg: message, pct: percent == null ? null : percent };
  session.progress.push(entry);
  session.heartbeat = entry.t;
  session.save();
  return entry;
}
/** 세션을 끝낸다. 먼저 적힌 종료가 남는다 — 나중 것이 덮지 않는다. */
function finish(session, status, summary = "") {
  const onDisk = session.path ? readSession(session.path) : null;
  if (onDisk && CLOSED.includes(onDisk.status)) { session.status = onDisk.status; session.summary = onDisk.summary; return taskOf(session); }
  session.status = status;
  session.summary = (summary || "").trim();
  session.save();
  return taskOf(session);
}
function setSessionStatus(ref, sessionId, status, hint) {
  if (!CLOSED.includes(status)) throw new DuetError("세션은 완료 또는 중지로만 바꾼다.");
  const task = getTask(ref, hint);
  const s = task.sessions.find((x) => x.id === sessionId);
  if (!s) throw new DuetError(`${task.ref}에 ${sessionId} 세션이 없다.`);
  if (s.alive) throw new DuetError("아직 살아 있는 세션이다. 그 창을 닫거나 pause_session을 부르게 하라.");
  s.status = status; s.by_human = true; s.save();
  return readTask(task.dir);
}

// ── 보관·삭제 (프로젝트 폴더째) ───────────────────────────────────

function projectTasks(name, archived = false) {
  return taskDirsIn(projectDir(name, archived ? archiveDir() : undefined)).map(safeRead).filter(Boolean);
}
function listArchived() {
  const out = projectDirs(archiveDir()).flatMap((p) => taskDirsIn(p).map(safeRead).filter(Boolean));
  const key = (t) => `${t.project} ${t.id}`;
  return out.sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
}
function archiveProject(name) {
  const src = projectDir(name), tasks = projectTasks(name);
  if (!tasks.length) throw new DuetError(`'${name || UNSORTED_DIRNAME}'에 타스크가 없다.`);
  const busy = tasks.filter((t) => t.counts[RUNNING]).map((t) => t.ref);
  if (busy.length) throw new DuetError(`살아 있는 세션이 있다: ${busy.join(", ")}. 창을 닫고 나서 보관한다.`);
  const target = path.join(archiveDir(), path.basename(src));
  if (fs.existsSync(target)) throw new DuetError(`보관함에 '${path.basename(src)}'이 이미 있다. 먼저 되돌리거나 이름을 바꿔라.`);
  fs.renameSync(src, target);
  return projectTasks(name, true);
}
function unarchiveProject(name) {
  const src = projectDir(name, archiveDir());
  if (!fs.existsSync(src)) throw new DuetError(`보관함에 '${name || UNSORTED_DIRNAME}'이 없다.`);
  const target = path.join(home(), path.basename(src));
  if (fs.existsSync(target)) throw new DuetError(`보드에 '${path.basename(src)}'이 이미 있다.`);
  fs.renameSync(src, target);
  return projectTasks(name);
}
function deleteTask(ref, hint) {
  const task = getTask(ref, hint);
  if (task.counts[RUNNING]) throw new DuetError("살아 있는 세션이 붙어 있어 지울 수 없다. 그 창을 닫거나 끝낸 뒤에.");
  fs.rmSync(task.dir, { recursive: true, force: true });
  return task.ref;
}
function deleteProject(name) {
  const folder = projectDir(name);
  if (!fs.existsSync(folder)) throw new DuetError(`'${name || UNSORTED_DIRNAME}' 프로젝트가 없다.`);
  const busy = projectTasks(name).filter((t) => t.counts[RUNNING]).map((t) => t.ref);
  if (busy.length) throw new DuetError(`살아 있는 세션이 있다: ${busy.join(", ")}. 창을 닫은 뒤에 지운다.`);
  fs.rmSync(folder, { recursive: true, force: true });
  return path.basename(folder);
}

// ── 정리 ─────────────────────────────────────────────────────

/** 하트비트가 끊긴 세션을 중지로 적는다. 쓸 프로세스가 이미 없어서 허용되는 유일한 예외. */
function reap() {
  const dead = [];
  for (const dir of [path.join(home(), IDLE_DIRNAME), ...taskDirs()]) {
    for (const s of readSessions(dir)) {
      if (CLOSED.includes(s.status) || s.alive) continue;
      s.status = STOPPED;
      s.summary = s.summary || "하트비트 끊김 (프로세스 종료 추정)";
      s.save();
      dead.push(s.id);
    }
  }
  return dead;
}

/** ~/.duet 아래 파일들이 지금 어떤 모양인지 한 줄. 바뀌면 값이 바뀐다. 보드가 이걸 보고 다시 읽는다. */
function fingerprint() {
  const root = home(), parts = [];
  const folders = [path.join(root, IDLE_DIRNAME), ...projectDirs(root), ...taskDirs()];
  for (const folder of folders) {
    let entries = [];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !(e.name.endsWith(".json") || e.name === "task.md")) continue;
      try { const st = fs.statSync(path.join(folder, e.name)); parts.push(`${folder}/${e.name}:${st.mtimeMs}:${st.size}`); } catch {}
    }
  }
  parts.push(JSON.stringify(folders.map((f) => path.basename(f)).sort()));
  const digest = crypto.createHash("sha256").update(parts.sort().join("\n")).digest("hex").slice(0, 16);
  return `${parts.length}:${digest}`;
}

/** 옛 평평한 배치(~/.duet/T001-…)를 프로젝트 폴더 아래로. 한 번만 일어난다. */
function migrateFlatLayout(base) {
  for (const root of [base, path.join(base, ARCHIVE_DIRNAME)]) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries.filter((x) => x.isDirectory() && TASK_DIR.test(x.name)).sort((a, b) => a.name.localeCompare(b.name))) {
      const old = path.join(root, e.name);
      let text;
      try { text = fs.readFileSync(path.join(old, "task.md"), "utf8"); } catch { continue; }
      const m = PROJECT_LINE.exec(text);
      let project = m ? m[1].trim() : "";
      if (!project) for (const s of readSessions(old)) { project = projectName(s.cwd); if (project) break; }
      let folder;
      try { folder = projectDir(project, root); } catch { folder = path.join(root, UNSORTED_DIRNAME); }
      fs.mkdirSync(folder, { recursive: true });
      const title = e.name.includes("-") ? e.name.slice(e.name.indexOf("-") + 1) : "";
      const target = nextTaskDir(folder, title.replace(/-/g, " "));
      fs.rmdirSync(target);
      fs.renameSync(old, target);
      fs.writeFileSync(path.join(target, "task.md"), text.split(/\r?\n/).filter((ln) => !PROJECT_LINE.test(ln)).join("\n"), "utf8");
    }
  }
}

module.exports = {
  DuetError, Session, Task,
  HEARTBEAT_SEC, STALE_SEC, WAITING, RUNNING, DONE, STOPPED, ATTENTION, HOLD, CANCELLED,
  TASK_STATUSES, HUMAN_STATUSES, CLOSED, UNSORTED_DIRNAME, IDLE_DIRNAME, ARCHIVE_DIRNAME,
  now, age, home, readSession, readSessions, projectDir, projectDirs, taskDirsIn, taskDirs, archiveDir,
  findTask, getTask, createTask, listTasks, projects, similarTasks, updateTask, setStatus,
  aliases, projectName, registerSession, join, taskOf, heartbeat, report, finish, setSessionStatus,
  projectTasks, listArchived, archiveProject, unarchiveProject, deleteTask, deleteProject, reap, fingerprint,
};
