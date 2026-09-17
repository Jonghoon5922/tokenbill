// 규칙이 지켜지는지만 본다. Python tests/test_core.py 의 요지.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

let core;
test.beforeEach(() => {
  process.env.DUET_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "duet-test-"));
  delete require.cache[require.resolve("../core")];
  core = require("../core");
});
test.afterEach(() => { try { fs.rmSync(process.env.DUET_HOME, { recursive: true, force: true }); } catch {} });

const stale = (s) => { s.heartbeat = new Date(Date.now() - 200000).toISOString().slice(0, 23); s.save(); };

test("타스크는 프로젝트 폴더 안에 번호가 매겨진다", () => {
  const a = core.createTask("하나", "", "duet"), b = core.createTask("둘", "", "duet"), c = core.createTask("남의 것", "", "nefss");
  assert.deepEqual([a.id, b.id, c.id], ["T001", "T002", "T001"]);
  assert.equal(a.ref, "duet/T001");
  assert.ok(fs.readFileSync(path.join(a.dir, "task.md"), "utf8").startsWith("# 하나"));
});

test("프로젝트를 모르면 미분류다", () => {
  const t = core.createTask("모름");
  assert.equal(t.project, "");
  assert.equal(t.ref, "_미분류/T001");
});

test("프로젝트가 붙은 이름은 거기서만, 번호만 오면 힌트 먼저", () => {
  core.createTask("하나", "", "duet"); core.createTask("하나", "", "nefss");
  assert.equal(core.getTask("duet/T001").project, "duet");
  assert.equal(core.getTask("nefss/1").project, "nefss");
  assert.throws(() => core.getTask("T001"), /여러 프로젝트/);
  assert.equal(core.getTask("T001", "nefss").project, "nefss");
});

test("세션이 전부 완료면 타스크가 완료, 끊긴 게 남으면 확인 필요", () => {
  const t = core.createTask("전환", "", "duet");
  const a = core.registerSession();
  assert.equal(core.join(a, t.ref, "DBIO").status, core.RUNNING);
  assert.equal(core.finish(a, core.DONE, "끝").status, core.DONE);
  const b = core.registerSession();
  core.join(b, t.ref, "Bean");
  const after = core.finish(b, core.STOPPED, "여기까지");
  assert.equal(after.status, core.ATTENTION);
  assert.match(after.warning, /끊긴 세션 1개/);
});

test("하트비트가 끊기면 중지로 친다", () => {
  const t = core.createTask("전환", "", "duet");
  const s = core.registerSession();
  core.join(s, t.ref);
  stale(s);
  assert.equal(core.getTask(t.ref).counts[core.STOPPED], 1);
  assert.deepEqual(core.reap(), [s.id]);
  assert.deepEqual(core.reap(), []);
});

test("진행중인 타스크에는 같이 못 붙는다", () => {
  const t = core.createTask("전환", "", "duet");
  const a = core.registerSession("Claude Code"), b = core.registerSession("Claude Desktop");
  core.join(a, t.ref, "DBIO");
  assert.throws(() => core.join(b, t.ref, "Bean"), /이미 살아 있는 세션/);
  core.finish(a, core.DONE, "끝");
  assert.equal(core.join(b, t.ref, "Bean").status, core.RUNNING);
});

test("사람이 적은 상태가 이기고, 지우면 다시 센다", () => {
  const t = core.createTask("전환", "", "duet");
  const s = core.registerSession();
  core.join(s, t.ref);
  assert.equal(core.setStatus(t.ref, core.HOLD).status, core.HOLD);
  core.finish(s, core.DONE, "끝");
  assert.equal(core.getTask(t.ref).status, core.HOLD);
  assert.equal(core.setStatus(t.ref, null).status, core.DONE);
  for (const bad of [core.WAITING, core.RUNNING, core.ATTENTION, "아무거나"]) assert.throws(() => core.setStatus(t.ref, bad));
});

test("끝난 세션은 사람이 바꾸고, 살아 있는 세션은 못 바꾼다", () => {
  const t = core.createTask("전환", "", "duet");
  const s = core.registerSession();
  core.join(s, t.ref);
  assert.throws(() => core.setSessionStatus(t.ref, s.id, core.DONE), /살아 있는/);
  core.finish(s, core.STOPPED, "여기까지");
  const after = core.setSessionStatus(t.ref, s.id, core.DONE);
  assert.equal(after.status, core.DONE);
  assert.equal(after.sessions[0].by_human, true);
});

test("보관과 삭제는 프로젝트 폴더째", () => {
  core.createTask("하나", "", "nefss"); core.createTask("둘", "", "nefss"); const other = core.createTask("남의 것", "", "duet");
  assert.deepEqual(core.archiveProject("nefss").map((t) => t.id), ["T001", "T002"]);
  assert.deepEqual(core.listTasks().map((t) => t.ref), [other.ref]);
  assert.equal(core.unarchiveProject("nefss").length, 2);
  assert.equal(core.deleteProject("nefss"), "nefss");
  assert.deepEqual(core.projects(), ["duet"]);
  assert.equal(core.deleteTask(other.ref), "duet/T001");
});

test("옮기면 번호가 새로 난다, 제목 고쳐도 폴더는 그대로", () => {
  core.createTask("먼저", "", "nefss");
  const t = core.createTask("옮길 것", "", "duet");
  const moved = core.updateTask(t.ref, { project: "nefss" });
  assert.equal(moved.ref, "nefss/T002");
  const renamed = core.updateTask(moved.ref, { title: "새 제목" });
  assert.equal(renamed.title, "새 제목");
  assert.equal(path.basename(renamed.dir), path.basename(moved.dir));
});

test("프로젝트 이름은 폴더에서, 임시 폴더는 아니다", () => {
  assert.equal(core.projectName("C:/project/duet"), "duet");
  assert.equal(core.projectName("C:/Windows/System32"), "");
  assert.equal(core.projectName("C:/x/scratch-2026-09-14-b6b798"), "");
  fs.writeFileSync(path.join(core.home(), "프로젝트.md"), "C:/project/bookshelf = 서재\n", "utf8");
  assert.equal(core.projectName("C:\\project\\bookshelf"), "서재");
});

test("지문은 파일이 바뀔 때만 바뀐다", () => {
  const before = core.fingerprint();
  assert.equal(core.fingerprint(), before);
  const t = core.createTask("하나", "", "duet");
  const after = core.fingerprint();
  assert.notEqual(after, before);
  core.setStatus(t.ref, core.DONE);
  assert.notEqual(core.fingerprint(), after);
});

test("Python 판이 쓴 세션 파일을 그대로 읽는다", () => {
  const t = core.createTask("전환", "", "duet");
  fs.writeFileSync(path.join(t.dir, "s-deadbeef.json"), JSON.stringify({
    id: "s-deadbeef", title: "DBIO", client: "Claude Code", status: "완료", cwd: "C:\\project\\duet", client_session: "",
    started: "2026-09-10T14:00:00.000", heartbeat: "2026-09-10T15:00:00.000", summary: "끝", by_human: false,
    progress: [{ t: "2026-09-10T14:30:00.000", msg: "반", pct: 50 }],
  }, null, 2), "utf8");
  const read = core.getTask(t.ref);
  assert.equal(read.status, core.DONE);
  assert.equal(read.sessions[0].progress[0].msg, "반");
});

test("스프린트: 시작일이 기간에 들면 저절로 묶이고, 겹치는 기간은 거절한다", () => {
  const today = core.now().slice(0, 10);
  const t = core.createTask("일", "", "p");
  const s1 = core.createSprint("p", { name: "이번", start: today, end: today });
  assert.equal(core.getTask(t.ref).sprint, s1.id);
  assert.throws(() => core.createSprint("p", { start: today, end: today }), /겹친다/);
  assert.throws(() => core.createSprint("p", { start: "2099-01-07", end: "2099-01-01" }), /앞이다/);
});

test("스프린트: 옮기면 한 줄로 남고, 상태를 바꿔도 풀리지 않으며, 스프린트를 지우면 풀린다", () => {
  const today = core.now().slice(0, 10);
  const t = core.createTask("일", "", "p");
  core.createSprint("p", { name: "이번", start: today, end: today });
  const later = core.createSprint("p", { name: "나중", start: "2099-01-01", end: "2099-01-07" });
  core.setTaskSprint(t.ref, later.id);
  assert.match(fs.readFileSync(path.join(t.dir, "task.md"), "utf8"), /^스프린트: S2$/m);
  core.setStatus(t.ref, core.DONE);
  let read = core.getTask(t.ref);
  assert.equal(read.sprint, later.id);
  assert.equal(read.title, "일");
  core.deleteSprint("p", later.id);
  read = core.getTask(t.ref);
  assert.equal(read.sprintPin, null);
  assert.equal(read.sprint, "S1");
});

test("스프린트: 날짜로 들어갈 곳을 고르면 적지 않고, '없음'이면 스프린트 밖이다", () => {
  const today = core.now().slice(0, 10);
  const t = core.createTask("일", "", "p");
  const s1 = core.createSprint("p", { name: "이번", start: today, end: today });
  core.setTaskSprint(t.ref, s1.id);
  assert.equal(core.getTask(t.ref).sprintPin, null);
  core.setTaskSprint(t.ref, core.NO_SPRINT);
  assert.equal(core.getTask(t.ref).sprint, "");
});
