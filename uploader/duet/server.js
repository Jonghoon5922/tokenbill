/**
 * Duet MCP 도구와 세션 수명. Python duet/server.py 를 옮긴 것.
 *
 * 이 프로세스가 세션 하나다. 뜰 때 _미참여/ 에 자기 파일을 만들고, 30초마다 하트비트를
 * 찍고, 끝날 때 중지로 적는다. 훅조차 못 돌면 읽는 쪽이 하트비트 90초 초과로 잡는다.
 */
"use strict";
const core = require("./core");

const VERSION = "0.2.0";
const CLIENT_LABELS = { "claude-ai": "Claude Desktop", "claude-code": "Claude Code", "cursor": "Cursor" };

function labelClient(name) {
  if (!name) return "알 수 없음";
  if (name.toLowerCase().startsWith("local-agent-mode-")) return "Claude Desktop";
  return CLIENT_LABELS[name.toLowerCase()] || name;
}
function guessClient() {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return "Claude Code";
  if (process.env.CURSOR_TRACE_ID) return "Cursor";
  return "알 수 없음";
}

/** 열린 타스크 목록을 안내문에 넣는다. 연결할 때 한 번만 전달된다. */
function buildInstructions() {
  const open = core.listTasks().filter((t) => [core.WAITING, core.RUNNING, core.ATTENTION].includes(t.status));
  const here = core.projectName(process.cwd());
  const lines = [
    "이 세션이 어떤 일감(타스크)에 속하는지 기록하는 도구다. 진행 로그는 네가 직접 쓴다 — 이 도구는 아무것도 요약해주지 않는다.",
    "",
    here ? `이 창의 프로젝트: ${here}` :
      "이 창은 프로젝트 폴더가 아닌 곳(임시 폴더)에서 떴다. **타스크를 만들 때 project를 네가 정해라** — " +
      "일의 주제로 짧게, 사용자가 부르는 말로 ('rag', '서재', 'tokenbill' — 날짜·해시·설명 금지). 이미 있는 프로젝트면 그 이름을 그대로 쓴다: " +
      (core.projects().filter(Boolean).join(", ") || "(없음)") + ". 비워 두면 만들어지지 않는다.",
    "",
  ];
  if (open.length) {
    const mine = here ? open.filter((t) => t.project === here) : [];
    const others = open.filter((t) => !mine.includes(t));
    const line = (t) => `- [${t.id}] ${t.title} (${t.status}, 세션 ${t.counts[core.RUNNING]}개 진행중)`;
    if (mine.length) { lines.push(`이 프로젝트(${here})의 열린 타스크:`, ...mine.slice(0, 12).map(line)); if (others.length) lines.push(""); }
    if (others.length) lines.push(mine.length ? "다른 프로젝트의 열린 타스크 (부를 때는 프로젝트/T00n):" : "열린 타스크:", ...others.slice(0, 12).map((t) => `- [${t.ref}] ${t.title} (${t.status})`));
  } else {
    lines.push("지금 열린 타스크가 없다. 새 일이면 create_task로 만든다.");
  }
  lines.push(
    "",
    "**모든 일은 타스크를 타고 간다.** 사용자가 자연어로 일을 시키면 묻지 말고: (1) 열린 타스크 중 그 일이면 join_task, 아니면 create_task 후 join_task — (2) 일하면서 report_progress로 한 줄씩 — (3) 끝나면 complete_session. 이 순서를 사용자가 매번 말하지 않아도 스스로 한다.",
    "타스크는 끝을 판정할 수 있는 한 덩어리다. 한두 마디로 끝날 질문·잔일은 타스크 없이 그냥 한다.",
    "제목·설명·진행 로그·마무리는 사용자가 쓰는 말로, 포스트잇에 적듯 짧고 평범하게. 제목은 명사구(X '…을 …한다', X '— 로 나열'), 설명은 한 문장. 사용자가 한국어면 한국어다.",
    "**계획을 세웠으면 그 자리에서 타스크다.** 사용자에게 계획을 보여주는 순간 create_task로 만들고 계획의 요지를 description에 적어라 — 사용자가 '타스크에 넣어'라고 따로 말하지 않는다. 일을 실제로 시작할 때 join_task, 그 뒤로는 report_progress.",
    "세션 하나는 타스크 하나다. 끝내고 다른 일을 시키면 그냥 join_task를 불러라 — 새 세션으로 이어진다. 한 창이 타스크를 순서대로 여러 개 해도 된다.",
    "프로젝트는 폴더다. 이 창의 타스크는 이 창의 프로젝트에 만들어지고 번호는 프로젝트 안에서 1부터다. 같은 프로젝트 안에서는 T001로, 다른 프로젝트 것은 duet/T001처럼 부른다.",
  );
  return lines.join("\n");
}

const str = (d) => ({ type: "string", description: d });
const TOOLS = [
  { name: "list_tasks", description: "타스크 목록. 어느 타스크에 참여할지 고를 때 먼저 호출한다. ref가 부르는 이름이다 (duet/T001).",
    inputSchema: { type: "object", properties: { status: str("이 상태만 (대기·진행중·확인 필요·완료·보류·취소)") } } },
  { name: "create_task", description:
      "새 타스크를 만든다(`대기`). 참여까지 하지는 않으므로, 이 세션이 그 일을 할 것이면 이어서 join_task를 호출하라.\n" +
      "**말**: 사용자가 쓰는 말로. 한국어로 시키면 한국어. 사람이 포스트잇에 적듯 짧고 평범하게 — 기계가 쓴 티(줄표 나열, 괄호 설명, '…한다' 문장체, 용어 나열)가 나면 안 된다.\n" +
      "**title**: 명사구 2~6단어. 결과물 이름이지 문장이 아니다. O: 'README 다시 쓰기', '보드 영문화', '로그인 화면 DBIO 전환', '인스톨러' / X: '보드 다듬기 — 배지·검색 문구·번호순·버튼 말', '폴더가 없는 창은 프로젝트 이름을 Claude가 정한다', '리팩터링 논의'. 프로젝트 이름은 넣지 마라 (X: 'Duet 대시보드 만들기' / O: '대시보드 만들기'). 세션 하나로 끝날 잔일이면 타스크를 만들지 말고 그냥 해라.\n" +
      "**description**: 동료에게 메신저로 한 줄 남기듯. 한 문장, 길어야 두 문장. 왜 하는지·뭐가 되면 끝인지만. O: 'scratch 폴더에서 연 창은 폴더 이름이 쓸모없으니 Claude가 주제로 짓게.' / X: '임시 폴더는 프로젝트가 아니다. 그런 창에서 타스크를 만들 때는 … 이름 없이 만들면 거절하고 후보를 보여준다.' 계획을 세웠으면 그 요지가 여기 들어간다 — 요지지 목록이 아니다.\n" +
      "**project**: 보통 비워 둔다 — 이 창이 뜬 폴더의 프로젝트에 만들어진다. 다른 프로젝트 일을 대신 만들 때만 적는다. 번호는 그 프로젝트 안에서 1부터 난다. 이 창이 프로젝트 폴더가 아닌 곳에서 떴으면(안내문에 그렇게 적혀 있다) 네가 일의 주제로 짧게 짓는다 — 이미 있는 프로젝트면 그 이름 그대로.\n" +
      "비슷한 타스크가 이미 있으면 만들지 않고 후보를 돌려준다. 같은 일이면 그것에 join하고, 정말 다른 일이면 confirm=true로 다시 불러라.",
    inputSchema: { type: "object", properties: { title: str("제목"), description: str("설명"), project: str("프로젝트"), confirm: { type: "boolean" } }, required: ["title"] } },
  { name: "join_task", description: "이 세션을 타스크에 묶는다. 타스크가 `진행중`이 되고 이 세션의 보고가 그 타스크에 쌓인다. 세션 하나는 타스크 하나에만 붙는다. task_id는 이 프로젝트 것이면 T001, 다른 프로젝트 것이면 duet/T001. session_title은 이 창이 이 타스크에서 맡은 몫을 짧게 ('DBIO 전환', '설계서 빌드').",
    inputSchema: { type: "object", properties: { task_id: str("타스크"), session_title: str("이 창이 맡은 몫") }, required: ["task_id"] } },
  { name: "get_task", description: "타스크 하나의 속을 본다 — 설명, 붙어 있는 세션들, 각 세션이 남긴 진행 로그. **다른 세션이 어디까지 했는지 읽고 이어받을 때 쓴다.** 같은 타스크에 참여했다면 일을 시작하기 전에 한 번 읽어라.",
    inputSchema: { type: "object", properties: { task_id: str("타스크") }, required: ["task_id"] } },
  { name: "update_task", description: "타스크의 제목·설명·상태를 고친다. **사용자가 그렇게 하라고 했을 때만 쓴다** — 일이 어디까지 됐는지는 report_progress로 남기는 것이지 설명을 고쳐 적는 게 아니다. status는 완료·보류·취소 중 하나. 대기·진행중·확인 필요는 세션이 없느냐 살아 있느냐 끊겼느냐는 사실이라 고를 수 없다. 사람이 정한 상태로 적혀 자동 규칙(세션을 세는 것)을 덮는다. `자동`을 주면 그 줄을 지워 다시 세게 한다. project를 주면 그 프로젝트로 옮긴다 — 번호가 새로 난다.",
    inputSchema: { type: "object", properties: { task_id: str("타스크"), title: str("제목"), description: str("설명"), status: str("완료·보류·취소·자동"), project: str("옮길 프로젝트") }, required: ["task_id"] } },
  { name: "pause_session", description: "이 세션을 여기서 멈춘다(`중지`). 일이 끝나지 않았는데 사용자가 \"여기까지\"라고 할 때 쓴다. 끝냈으면 complete_session이다. 중지된 세션이 있으면 타스크는 닫히지 않고 사람이 판단하도록 열린 채 남는다.",
    inputSchema: { type: "object", properties: { reason: str("여기까지 한 이유") }, required: ["reason"] } },
  { name: "report_progress", description: "이 세션의 진행 로그를 한 줄 남긴다. 다음 세션이 읽고 이어받을 수 있게 무엇을 했고 어디까지 됐는지 사실만 쓴다. 한 문장, 사람이 수첩에 적듯 (O: '로그인 화면 DBIO 3개 전환, 컴파일 통과' / X: '(1) … (2) … 다음 단계로 …', X: 용어 나열). 일을 실제로 시작할 때 join하고, 시작한 뒤에 남겨라 — 계획은 로그가 아니다.",
    inputSchema: { type: "object", properties: { message: str("한 줄"), percent: { type: "integer" } }, required: ["message"] } },
  { name: "complete_session", description: "이 세션의 일이 끝났다고 보고한다. 타스크의 세션이 전부 완료면 타스크도 `완료`가 된다. summary는 사람이 읽는 마무리 한 줄 — 무엇이 됐는지만, 한 문장.",
    inputSchema: { type: "object", properties: { summary: str("마무리 한 줄") }, required: ["summary"] } },
];

/** 이 프로세스가 지금 붙어 있는 세션. 앞 타스크를 끝내고 다음에 붙으면 새 세션 파일로 갈아탄다. */
class Current {
  constructor(session) { this.session = session; }
  get project() { return core.projectName(this.session.cwd); }
  renew() {
    const prev = this.session;
    this.session = core.registerSession(prev.client, prev.cwd, prev.client_session);
    return this.session;
  }
}

function start({ log } = {}) {
  const cur = new Current(core.registerSession(guessClient(), process.cwd(), process.env.CLAUDE_CODE_SESSION_ID || ""));
  let closed = false;
  const beat = setInterval(() => { try { core.heartbeat(cur.session); } catch {} }, core.HEARTBEAT_SEC * 1000);
  beat.unref();
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(beat);
    try { core.finish(cur.session, core.STOPPED, "세션 창이 닫힘 (보고 없이 종료)"); } catch {}
  };
  process.on("exit", close);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { close(); process.exit(0); });

  const touch = (clientName) => {
    try {
      const label = labelClient(clientName);
      if (label !== "알 수 없음") cur.session.client = label;
      core.heartbeat(cur.session);
    } catch {}
  };

  /** tools/call 하나를 처리해 결과 객체를 돌려준다. 오류도 객체로 — Python 판과 같다. */
  function call(name, a = {}, clientName) {
    touch(clientName);
    const fail = (e) => ({ error: e.message });
    switch (name) {
      case "list_tasks": {
        const joined = core.taskOf(cur.session);
        return { project: cur.project, joined_task: joined ? joined.ref : null, tasks: core.listTasks(a.status || undefined).map((t) => t.toDict()) };
      }
      case "create_task": {
        if (!a.confirm) {
          const similar = core.similarTasks(a.title || "");
          if (similar.length) return { "만들지_않았다": "비슷한 타스크가 이미 있다.", "후보": similar.map((t) => t.toDict()), next: "같은 일이면 join_task로 붙어라. 정말 다른 일이면 confirm=true로 다시 불러라." };
        }
        const target = (a.project || "").trim() || cur.project;
        if (!target) {
          return { "만들지_않았다": "이 창은 프로젝트 폴더가 아닌 곳에서 떠서 프로젝트를 모른다.", "있는_프로젝트": core.projects().filter(Boolean),
            next: "project에 이름을 넣어 다시 불러라. 있는 프로젝트면 그 이름 그대로, 새 일이면 주제로 짧게 (사용자가 부르는 말로). 사용자에게 묻지 않아도 된다 — 네가 정하고 답에 한 줄 밝혀라." };
        }
        try { return { task: core.createTask(a.title, a.description || "", target).toDict(), next: "이 세션이 이 일을 한다면 join_task를 호출하라." }; }
        catch (e) { return fail(e); }
      }
      case "join_task": {
        let renewed = false;
        try {
          if (core.CLOSED.includes(cur.session.status)) { cur.renew(); renewed = true; }
          const task = core.join(cur.session, a.task_id, a.session_title || "");
          let note = "작업 중간에 report_progress, 끝나면 complete_session을 호출하라.";
          if (renewed) note = `앞 세션은 닫힌 채 두고 새 세션 ${cur.session.id}로 이어진다. ` + note;
          return { task: task.toDict(), session_id: cur.session.id, note };
        } catch (e) { return fail(e); }
      }
      case "get_task": {
        try {
          const task = core.getTask(a.task_id, cur.project);
          const detail = task.toDetail();
          const mine = core.taskOf(cur.session);
          if (mine && mine.ref === task.ref) detail["내_세션"] = cur.session.id;
          return detail;
        } catch (e) { return fail(e); }
      }
      case "update_task": {
        try {
          let task = core.updateTask(a.task_id, { title: a.title, description: a.description, project: a.project, hint: cur.project });
          if (a.status != null) task = core.setStatus(task.ref, a.status === "자동" ? null : a.status);
          const changed = [["제목", a.title], ["설명", a.description], ["상태", a.status], ["프로젝트", a.project]].filter(([, v]) => v != null).map(([k]) => k);
          return { task: task.toDict(), changed: changed.length ? changed : ["없음"], note: `폴더 이름은 그대로 둔다 — 판별자는 ${task.ref}다.` };
        } catch (e) { return fail(e); }
      }
      case "pause_session": {
        let task;
        try { task = core.finish(cur.session, core.STOPPED, a.reason || ""); } catch (e) { return fail(e); }
        if (!task) return { status: core.STOPPED, note: "타스크에 참여하지 않아 닫히기만 했다." };
        return { status: core.STOPPED, task: task.toDict(), note: `[${task.ref}] ${task.title} 은(는) 열어 둔다. 다음 세션이 get_task로 여기까지의 로그를 읽고 이어받을 수 있다.` };
      }
      case "report_progress": {
        let entry;
        try { entry = core.report(cur.session, a.message, a.percent == null ? null : a.percent); } catch (e) { return fail(e); }
        const task = core.taskOf(cur.session);
        const out = { t: entry.t, task_id: task ? task.ref : null };
        if (!task) out.note = "아직 타스크에 참여하지 않았다. join_task를 부르면 이 보고도 함께 따라간다.";
        return out;
      }
      case "complete_session": {
        let task;
        try { task = core.finish(cur.session, core.DONE, a.summary || ""); } catch (e) { return fail(e); }
        if (!task) return { status: core.DONE, note: "타스크에 참여하지 않아 닫히기만 했다." };
        const note = task.status === core.DONE ? `[${task.ref}] ${task.title} 타스크가 자동 완료됐다.`
          : task.warning || `아직 진행중인 세션이 ${task.counts[core.RUNNING]}개 있다.`;
        return { status: core.DONE, task: task.toDict(), note };
      }
      default: return null;
    }
  }

  if (process.env.DUET_NO_BOARD !== "1") {
    try { require("./web").hostInBackground(VERSION, log); } catch (e) { if (log) log("Duet 보드 생략: " + e.message); }
  }
  return { tools: TOOLS, call, instructions: buildInstructions, close, current: cur, has: (n) => TOOLS.some((t) => t.name === n) };
}

module.exports = { start, TOOLS, VERSION, buildInstructions, labelClient };
