# Tokenbill (토큰빌) — 내 AI 작업실

AI는 쓰는 것으로 끝. 기록은 Tokenbill이 쌓고, 쌓인 기록은 실력이 됩니다.

- 🏆 **리더보드** · 이번 달 얼마나 태웠나 — 6단계 티어, 월마다 새 판 (Claude Code·Codex·Gemini CLI·API)
- 🗂️ **대화 뷰어** · 무슨 일을 했었나 — 지난 AI 대화를 한곳에서 검색 `local`
- 📋 **작업 보드** · 지금 뭘 하고 있나 — AI 세션이 알아서 남기는 일감 기록 `local`
- 📄 **AICV** · 그래서 뭘 할 수 있나 — 작업 로그가 증명하는 AI 활용 이력서 (aicv.tokenbill.my)

설치는 명령 한 줄, 이후는 전자동. 대화 내용은 서버로 올라가지 않습니다.
`local` 표시 기능은 내 PC(127.0.0.1)에서만 동작합니다.

서비스: https://tokenbill.my · 로컬 도구: `npx -y tokenbill-mcp@latest`
스택: FastAPI + SQLite + 바닐라 JS(단일 HTML) / 업로더·뷰어·보드: 의존성 0 Node.

## 실행 방법

```bash
pip install -r requirements.txt
cp .env.example .env          # SECRET_KEY를 긴 랜덤 문자열로 변경
export $(cat .env | xargs)    # 또는 환경변수로 직접 설정
uvicorn app.main:app --reload
```

http://localhost:8000 접속 → 회원가입 → 프로바이더 키 등록.

- **체험(데모)**: 키에 `demo` 로 시작하는 아무 값이나 넣으면 가짜 사용 데이터가 생성됩니다.
- **실제 연동**: OpenAI는 조직 **Admin 키**(`sk-admin-…`, platform.openai.com → Organization → Admin Keys),
  Anthropic도 **Admin 키**(`sk-ant-admin-…`, console.anthropic.com → Settings → Admin Keys)가 필요합니다.
  일반 API 키로는 사용량 조회가 안 됩니다.
- Google AI는 Cloud Billing 연동이 필요해서 MVP에서는 미지원(데모만 가능).
- **다중 조직**: 프로바이더당 키를 여러 개(조직별 이름 붙여서) 등록할 수 있고,
  대시보드에서 조직별 이번 달 비용이 나뉘어 보입니다. 차트·합계는 전체 조직 합산 기준.
- **프로젝트 드릴다운**: 조직 행을 클릭하면 프로젝트(OpenAI Project / Anthropic
  Workspace) 단위로 펼쳐지고, 프로젝트마다 모델별 비용·토큰이 표시됩니다.
- **구글 로그인** (선택): `GOOGLE_CLIENT_ID` 환경변수를 설정하면 로그인 화면에
  "Google로 계속하기" 버튼이 나타납니다. Google Cloud Console에서 OAuth 클라이언트
  ID(웹)를 만들고, 승인된 JavaScript 출처에 서비스 도메인(https)을 등록해야 합니다.
  도메인 없이 공인 IP로는 Google 정책상 동작하지 않습니다.

API 문서: http://localhost:8000/docs (FastAPI 자동 생성)

## MCP 업로더 + Duet 타스크 보드

`npx -y tokenbill-mcp@latest` 하나가 Claude Code 창마다 붙어 세 가지를 한다:

- **토큰 업로드** — 시작할 때와 `sync_usage` 도구로 로컬 로그를 tokenbill.my에 올린다.
- **대화 뷰어** — http://127.0.0.1:8377 (이 PC의 로그만 읽는다).
- **Duet 타스크 보드** — http://127.0.0.1:8737. 창에서 한 일이 타스크로 저절로 기록된다.
  Claude가 `create_task`·`join_task`·`report_progress`·`complete_session` 등 도구 8개로 스스로 기록하고,
  보드는 프로젝트(= 창을 연 폴더)별로 보여준다. 기록은 `~/.duet`에 파일로만 남고 서버로 올라가지 않는다.
  규칙과 화면은 [Duet](https://github.com/Jonghoon5922/duet)(Python 판)과 같고 기록 형식도 같다 — `uploader/duet/`.

```bash
claude mcp add -s user tokenbill -- npx -y tokenbill-mcp@latest --token tbu_...
npm test          # Duet 규칙 단위 테스트
npm run smoke     # 진짜 stdio 프로세스 여러 개로 한 바퀴
```

## 구조

```
app/
  main.py                 # FastAPI 앱, 라우트, 스케줄러(매일 03시 KST 자동 수집)
  models.py               # User / ProviderKey / UsageDaily (날짜×프로바이더×모델 요약)
  security.py             # JWT 인증, bcrypt 해시, API 키 Fernet 암호화
  collector.py            # 수집 오케스트레이션, 수동 갱신 쿨다운(10분)
  providers/
    collectors.py         # OpenAI/Anthropic usage API 호출 + 데모 생성기
    prices.py             # 모델별 단가표 (비용 = 토큰 × 단가 근사)
static/index.html         # 프론트엔드 (로그인 + 대시보드)
```

## 설계 메모

- **저장 최소화**: 원본 로그는 프로바이더에 두고, "날짜 × 프로바이더 × 모델 × 비용/토큰"
  요약 행만 보관. 사용자당 하루 수십 행 수준.
- **갱신 정책**: 매일 1회 자동(APScheduler) + "지금 갱신" 수동(10분 쿨다운).
  프로바이더 과금 데이터 자체가 지연 반영이라 실시간성은 목표가 아님.
- **비용 계산**: 금액은 프로바이더 **cost API 실측값** 기준.
  usage API(토큰·모델별)로 분해를 만들고, 모델별 근사 비용을 cost API의 일 총액에 맞게
  비례 보정한다 → 합계는 항상 실제 청구 금액과 일치. cost API 호출이 실패하면
  `prices.py` 단가표 근사값으로 폴백. 단가표는 "싼 모델 절약 시뮬레이션" 등에 계속 사용
  (자동 수집으로 대체 예정 — LiteLLM의 model_prices JSON 참고).
- **키 보안**: API 키는 SECRET_KEY에서 유도한 Fernet 키로 암호화 저장, 화면에는 마스킹만 노출.

## 배포 — 실제 운영 구성 (EC2 + Docker + GitHub Actions)

현재 운영: AWS EC2(Ubuntu 24.04, `ubuntu@52.79.213.236`)에서 **docker**로 실행.
`main`에 푸시하면 GitHub Actions([build.yml](.github/workflows/build.yml))가
이미지를 빌드해 `ghcr.io/jonghoon5922/tokenbill:latest`로 올린다 — 서버에서 빌드하지 않는다.

- SECRET_KEY: 서버의 `~/.tokenbill-secret` 파일에 보관 (한 줄)
- DB: `tokenbill-data` 도커 볼륨 → 컨테이너 `/data/tokenbill.db` (재배포해도 유지)

### 새 버전 배포 절차

```bash
# 0) (스키마 변경이 있는 배포면) DB 백업
docker cp tokenbill:/data /home/ubuntu/tokenbill-data-backup-$(date +%Y%m%d)

# 1) GitHub Actions 빌드 완료 확인 후 pull
docker pull ghcr.io/jonghoon5922/tokenbill:latest

# 2) 컨테이너 교체 (볼륨·시크릿 유지)
docker stop tokenbill && docker rm tokenbill
docker run -d --name tokenbill -p 8000:8000 -v tokenbill-data:/data \
  -e SECRET_KEY="$(cat ~/.tokenbill-secret)" --restart unless-stopped \
  ghcr.io/jonghoon5922/tokenbill:latest

# 3) 확인
docker logs --tail 30 tokenbill
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/
```

롤백: `ghcr.io/jonghoon5922/tokenbill:<커밋 SHA>` 태그로 같은 절차 반복 + 백업 복원.

주의: `SECRET_KEY`는 한 번 정하면 **바꾸지 말 것** — 이 키로 프로바이더 API 키를
암호화하므로, 바뀌면 저장된 키를 복호화할 수 없다.

### 첫 서버 세팅 (참고)

```bash
openssl rand -hex 32 > ~/.tokenbill-secret && chmod 600 ~/.tokenbill-secret
docker volume create tokenbill-data
# 이후 위 "컨테이너 교체" 절차의 run 명령과 동일
```

### HTTPS

외부 공개 시 앞단에 Caddy나 nginx를 두는 것을 권장.
Caddy면 `Caddyfile`에 `내도메인.com { reverse_proxy localhost:8000 }` 두 줄로 끝.

사용자가 늘면 `DATABASE_URL` 환경변수로 Postgres 전환 가능 (드라이버 추가 필요).

## 다음 단계 아이디어

- 예산 초과 시 이메일/텔레그램 알림 (스케줄러에서 체크)
- 프로바이더 cost API 연동으로 정확한 청구 금액 표시
- "한 단계 싼 모델로 바꾸면 월 $X 절약" 시뮬레이션
- Google (Cloud Billing), 기타 프로바이더 추가
