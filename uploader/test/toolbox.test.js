const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const tb = require("../toolbox");

test("SKILL.md 머리말에서 이름·설명을 읽고, 없는 폴더는 거절한다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sk-"));
  fs.mkdirSync(path.join(dir, "demo-skill"));
  fs.writeFileSync(path.join(dir, "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: 데모 설명\n---\n\n본문");
  assert.throws(() => tb.installSkill(dir), /SKILL.md/);
  assert.throws(() => tb.removeSkill("../탈출"), /이상/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("MCP 템플릿은 토큰을 자리표시자로 바꾼다", () => {
  const t = tb.mcpTemplate(["tokenbill"]);
  const args = ((t.mcpServers.tokenbill || {}).args) || [];
  assert.ok(args.includes("--token"), "플래그는 남아야 한다");
  assert.ok(args.some((a) => /^\$\{.*TOKEN\}$/.test(a)), "토큰 값은 자리표시자여야 한다");
  assert.ok(!args.some((a) => /^tbu_/.test(a)), "원문 토큰이 남으면 안 된다");
});

test("스캔 결과에는 원문 토큰이 없다", () => {
  const raw = JSON.stringify(tb.scanMcp());
  assert.ok(!/tbu_[A-Za-z0-9_-]{10,}/.test(raw) && !/acv_[A-Za-z0-9_-]{10,}/.test(raw));
});

test("Claude Code 스킬 폴더 밖(내려받은 폴더 등)의 스킬은 옮기지 않는다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loose-"));
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: loose-skill\ndescription: 아무 데나 있는 스킬\n---\n");
  assert.throws(() => tb.installSkill(dir), /\.claude\/skills/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("스캔 결과는 개인·프로젝트·플러그인 출처만 담는다", () => {
  const { skills } = tb.scanSkills();
  for (const s of skills) assert.ok(["personal", "project", "plugin"].includes(s.source), s.source);
});
