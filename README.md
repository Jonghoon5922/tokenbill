# Tokenbill (토큰빌) — AI API 비용 대시보드

OpenAI·Anthropic API 사용 비용과 토큰을 한 화면에서 추적하는 서비스.
FastAPI + SQLite + 바닐라 JS 프론트엔드(단일 HTML).

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

API 문서: http://localhost:8000/docs (FastAPI 자동 생성)

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

## 배포 — 리눅스 서버 + Podman

### 1) 이미지 빌드

```bash
podman build -f Containerfile -t tokenbill:0.1 .
```

### 2) 실행

```bash
# DB 보관용 볼륨 (SQLite 파일이 컨테이너 밖에 남아 재배포해도 유지됨)
podman volume create tokenbill-data

podman run -d --name tokenbill \
  -p 8000:8000 \
  -v tokenbill-data:/data \
  -e SECRET_KEY="$(openssl rand -hex 32)" \
  --restart unless-stopped \
  tokenbill:0.1
```

주의: `SECRET_KEY`는 한 번 정하면 **바꾸지 말 것** — 이 키로 API 키를 암호화하므로,
바뀌면 저장된 프로바이더 키를 복호화할 수 없다. 위처럼 매번 생성하지 말고
`openssl rand -hex 32` 결과를 어딘가(예: `/etc/tokenbill/secret`)에 보관하고 재사용할 것:

```bash
sudo mkdir -p /etc/tokenbill && openssl rand -hex 32 | sudo tee /etc/tokenbill/secret
podman run -d --name tokenbill -p 8000:8000 -v tokenbill-data:/data \
  -e SECRET_KEY="$(sudo cat /etc/tokenbill/secret)" --restart unless-stopped tokenbill:0.1
```

### 3) 부팅 시 자동 시작 (systemd Quadlet, podman ≥ 4.4)

`~/.config/containers/systemd/tokenbill.container` (rootless 기준):

```ini
[Unit]
Description=tokenbill

[Container]
Image=localhost/tokenbill:0.1
PublishPort=8000:8000
Volume=tokenbill-data:/data
EnvironmentFile=/etc/tokenbill/env        # SECRET_KEY=... 한 줄

[Service]
Restart=always

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user start tokenbill
loginctl enable-linger $USER   # 로그아웃 후에도 유지
```

구버전 podman이면 `podman generate systemd --new --name tokenbill`로 유닛 파일 생성.

### 4) 새 버전 배포

```bash
podman build -f Containerfile -t tokenbill:0.2 .
podman stop tokenbill && podman rm tokenbill
# 같은 볼륨으로 다시 run (데이터 유지)
```

### 5) HTTPS

외부 공개 시 앞단에 Caddy나 nginx를 두는 것을 권장.
Caddy면 `Caddyfile`에 `내도메인.com { reverse_proxy localhost:8000 }` 두 줄로 끝.

사용자가 늘면 `DATABASE_URL` 환경변수로 Postgres 전환 가능 (드라이버 추가 필요).

## 다음 단계 아이디어

- 예산 초과 시 이메일/텔레그램 알림 (스케줄러에서 체크)
- 프로바이더 cost API 연동으로 정확한 청구 금액 표시
- "한 단계 싼 모델로 바꾸면 월 $X 절약" 시뮬레이션
- Google (Cloud Billing), 기타 프로바이더 추가
