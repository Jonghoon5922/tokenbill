"""Tokenbill — AI API 비용 대시보드 백엔드."""
import os
import secrets
import time
from collections import defaultdict, deque
from datetime import date, timedelta

import httpx

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from . import models
from .collector import cooldown_remaining_sec, sync_all_users, sync_user, MANUAL_COOLDOWN_MIN
from .notify import alerts_available, send_email
from .providers.collectors import detect_openai_write_scope, fetch_org_name
from .providers.prices import estimate_cost
from .db import get_db, init_db
from .security import (create_token, current_user, decrypt_key, encrypt_key,
                       hash_password, mask_key, verify_password)

init_db()

app = FastAPI(title="Tokenbill API", version="0.1.0")

PROVIDERS = ["openai", "anthropic", "google"]
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")  # 설정하면 구글 로그인 활성화
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "").lower()    # 이 이메일 계정은 로그인 시 관리자로 자동 승격
# AUTH_GOOGLE_ONLY=1 이면 이메일/비밀번호 가입·로그인을 막고 구글 로그인만 허용
AUTH_GOOGLE_ONLY = os.environ.get("AUTH_GOOGLE_ONLY", "") == "1"


def _maybe_promote_admin(user: models.User, db: Session) -> None:
    if ADMIN_EMAIL and user.email == ADMIN_EMAIL and not user.is_admin:
        user.is_admin = True
        db.commit()


def admin_user(user: models.User = Depends(current_user)) -> models.User:
    if not user.is_admin:
        raise HTTPException(403, "관리자 권한이 필요합니다")
    return user


# ── 레이트 리밋 (인메모리, IP 기준) ─────────────────────────
_rate_buckets: dict[str, deque] = defaultdict(deque)


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else "?")


def rate_limit(request: Request, scope: str, limit: int, window_sec: int) -> None:
    """window_sec 동안 IP당 limit회 초과 시 429."""
    key = f"{scope}:{_client_ip(request)}"
    now = time.time()
    q = _rate_buckets[key]
    while q and q[0] < now - window_sec:
        q.popleft()
    if len(q) >= limit:
        raise HTTPException(429, "요청이 너무 잦습니다 — 잠시 후 다시 시도해 주세요")
    q.append(now)


# ── 스키마 ──────────────────────────────────────────────────
class AuthIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    nickname: str | None = Field(default=None, max_length=32)  # 회원가입 시 선택 입력


class SettingsIn(BaseModel):
    budget_usd: float | None = Field(default=None, ge=0)
    fx_rate: float | None = Field(default=None, gt=0)
    currency: str | None = Field(default=None, pattern="^(USD|KRW)$")
    nickname: str | None = Field(default=None, max_length=32)  # ""이면 별명 해제


class KeyIn(BaseModel):
    provider: str = Field(pattern="^(openai|anthropic|google)$")
    api_key: str = Field(min_length=4, max_length=512)
    label: str = Field(default="", max_length=64)  # 비우면 조직 이름 자동 결정


class GoogleAuthIn(BaseModel):
    credential: str = Field(min_length=20, max_length=4096)  # Google ID 토큰(JWT)


# ── 인증 ────────────────────────────────────────────────────
@app.get("/api/auth/config")
def auth_config():
    """로그인 화면 설정 — 구글 클라이언트 ID가 있으면 프론트가 구글 버튼을 띄운다."""
    return {
        "google_client_id": GOOGLE_CLIENT_ID or None,
        # 구글이 설정되지 않았는데 전용 모드를 켜면 잠기므로, 둘 다 충족할 때만 전용 모드
        "google_only": bool(AUTH_GOOGLE_ONLY and GOOGLE_CLIENT_ID),
    }


@app.post("/api/auth/google")
def google_login(body: GoogleAuthIn, request: Request, db: Session = Depends(get_db)):
    rate_limit(request, "auth", 20, 300)
    """Google Identity Services ID 토큰 검증 → 이메일 기준 자동 가입/로그인."""
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(400, "구글 로그인이 설정되지 않았습니다")
    try:
        r = httpx.get("https://oauth2.googleapis.com/tokeninfo",
                      params={"id_token": body.credential}, timeout=10)
    except Exception:
        raise HTTPException(502, "구글 인증 서버에 연결할 수 없습니다")
    if r.status_code != 200:
        raise HTTPException(401, "구글 인증에 실패했습니다")
    info = r.json()
    # aud가 우리 클라이언트 ID인지 확인 — 다른 앱용 토큰 재사용 방지
    if info.get("aud") != GOOGLE_CLIENT_ID or info.get("email_verified") not in ("true", True):
        raise HTTPException(401, "구글 인증에 실패했습니다")
    email = (info.get("email") or "").lower()
    if not email:
        raise HTTPException(401, "구글 계정에서 이메일을 확인할 수 없습니다")
    user = db.query(models.User).filter_by(email=email).first()
    if user is None:
        # 구글 가입 계정 — 비밀번호 로그인은 불가능한 무작위 해시로 채운다
        # 구글 계정 이름을 초기 별명으로 사용 (없으면 이메일 앞부분)
        nick = (info.get("name") or "").strip()[:32] or email.split("@")[0][:32]
        user = models.User(email=email, password_hash=hash_password(secrets.token_hex(32)), nickname=nick)
        db.add(user)
        db.commit()
    _maybe_promote_admin(user, db)
    return {"token": create_token(user.id)}


@app.post("/api/auth/register")
def register(body: AuthIn, request: Request, db: Session = Depends(get_db)):
    rate_limit(request, "auth", 10, 300)
    if AUTH_GOOGLE_ONLY and GOOGLE_CLIENT_ID:
        raise HTTPException(400, "구글 로그인만 지원합니다")
    if not (body.nickname or "").strip():
        raise HTTPException(400, "별명을 입력해 주세요")
    if db.query(models.User).filter_by(email=body.email.lower()).first():
        raise HTTPException(409, "이미 가입된 이메일입니다")
    user = models.User(email=body.email.lower(), password_hash=hash_password(body.password),
                       nickname=(body.nickname or "").strip()[:32] or None)
    db.add(user)
    db.commit()
    return {"token": create_token(user.id)}


@app.post("/api/auth/login")
def login(body: AuthIn, request: Request, db: Session = Depends(get_db)):
    rate_limit(request, "auth", 10, 300)
    if AUTH_GOOGLE_ONLY and GOOGLE_CLIENT_ID:
        raise HTTPException(400, "구글 로그인만 지원합니다")
    user = db.query(models.User).filter_by(email=body.email.lower()).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "이메일 또는 비밀번호가 올바르지 않습니다")
    _maybe_promote_admin(user, db)
    return {"token": create_token(user.id)}


# ── 사용자 설정 ─────────────────────────────────────────────
@app.get("/api/me")
def me(user: models.User = Depends(current_user)):
    return {
        "email": user.email, "is_admin": user.is_admin, "nickname": user.nickname,
        "budget_usd": user.budget_usd,
        "fx_rate": user.fx_rate, "currency": user.currency,
        "last_sync_at": user.last_sync_at.isoformat() + "Z" if user.last_sync_at else None,
        "cooldown_sec": cooldown_remaining_sec(user),
        "cooldown_min": MANUAL_COOLDOWN_MIN,
        "alerts_available": alerts_available(),
        "upload_token": user.upload_token,
    }


@app.patch("/api/me")
def update_me(body: SettingsIn, user: models.User = Depends(current_user), db: Session = Depends(get_db)):
    if body.budget_usd is not None:
        user.budget_usd = body.budget_usd
    if body.fx_rate is not None:
        user.fx_rate = body.fx_rate
    if body.currency is not None:
        user.currency = body.currency
    if body.nickname is not None:
        nick = body.nickname.strip()[:32]
        if not nick:
            raise HTTPException(400, "별명은 비울 수 없습니다")
        user.nickname = nick
    db.commit()
    return {"ok": True}


@app.post("/api/alerts/test")
def alert_test(user: models.User = Depends(current_user)):
    if not alerts_available():
        raise HTTPException(400, "서버에 이메일 발송(SMTP)이 설정되지 않았습니다")
    ok = send_email(user.email, "✅ Tokenbill 알림 테스트",
                    "예산의 80%·100% 도달 시 이 주소로 알림 메일이 발송됩니다.")
    if not ok:
        raise HTTPException(502, "발송 실패 — 서버 SMTP 설정을 확인해 주세요")
    return {"ok": True}


# ── 프로바이더 키 ───────────────────────────────────────────
@app.get("/api/providers")
def list_providers(user: models.User = Depends(current_user), db: Session = Depends(get_db)):
    month_start = date.today().replace(day=1)
    # 이번 달 비용을 키(조직)별로 한 번에 집계
    cost_by_key = dict(db.query(
        models.UsageDaily.key_id, func.coalesce(func.sum(models.UsageDaily.cost_usd), 0.0),
    ).filter(
        models.UsageDaily.user_id == user.id,
        models.UsageDaily.day >= month_start,
    ).group_by(models.UsageDaily.key_id).all())
    out = []
    for p in PROVIDERS:
        keys = [k for k in user.keys if k.provider == p]
        key_rows = [{
            "id": k.id,
            "label": k.label,
            "key_masked": k.key_masked,
            "status": k.last_status,
            "warning": k.warning,
            "month_cost_usd": round(cost_by_key.get(k.id, 0.0), 2),
        } for k in keys]
        out.append({
            "provider": p,
            "connected": bool(keys),
            "keys": key_rows,
            "month_cost_usd": round(sum(r["month_cost_usd"] for r in key_rows), 2),
        })
    return out


@app.post("/api/providers")
def add_provider(body: KeyIn, user: models.User = Depends(current_user), db: Session = Depends(get_db)):
    # 같은 키 중복 등록 방지 — 사용량이 이중 집계되는 것을 막는다
    for k in user.keys:
        if k.provider == body.provider:
            try:
                if decrypt_key(k.key_encrypted) == body.api_key:
                    raise HTTPException(409, f"이미 '{k.label}'(으)로 등록된 키입니다")
            except HTTPException:
                raise
            except Exception:
                pass  # 복호화 실패한 옛 키는 비교 불가 — 무시
    label = body.label.strip()
    existing_labels = {k.label for k in user.keys if k.provider == body.provider}
    if label and label in existing_labels:
        raise HTTPException(409, f"'{label}' 이름의 조직이 이미 연결되어 있습니다 — 다른 이름을 사용해 주세요")
    if not label:
        # API에서 조직 이름을 가져오고, 안 되면 "조직 N"으로 자동 부여. 중복이면 번호를 붙인다.
        base = fetch_org_name(body.provider, body.api_key) or \
               ("데모 조직" if body.api_key.lower().startswith("demo") else "조직")
        label, n = (base if base != "조직" else "조직 1"), 2
        while label in existing_labels:
            label = f"{base} {n}"
            n += 1
    # OpenAI 키의 쓰기 권한 감지 — 과다 권한이면 지속 경고 표시 (등록은 허용)
    warning = None
    if body.provider == "openai" and detect_openai_write_scope(body.api_key):
        warning = "전체 권한 키입니다 — Read only Admin 키로 교체를 권장합니다"
    key = models.ProviderKey(
        user_id=user.id, provider=body.provider, label=label,
        key_encrypted=encrypt_key(body.api_key), key_masked=mask_key(body.api_key),
        warning=warning,
    )
    db.add(key)
    db.commit()
    db.refresh(user)
    # 등록 직후 1회 즉시 수집 (쿨다운 무시 — 첫 데이터를 바로 보여주기 위해)
    results = sync_user(db, user)
    return {"ok": True, "key_id": key.id, "sync": results}


@app.delete("/api/providers/{key_id}")
def delete_provider(key_id: int, user: models.User = Depends(current_user), db: Session = Depends(get_db)):
    key = next((k for k in user.keys if k.id == key_id), None)
    if not key:
        raise HTTPException(404, "연결된 키가 없습니다")
    db.query(models.UsageDaily).filter_by(user_id=user.id, key_id=key.id).delete()
    db.delete(key)
    db.commit()
    return {"ok": True}


# ── 수동 갱신 ───────────────────────────────────────────────
@app.post("/api/sync")
def manual_sync(user: models.User = Depends(current_user), db: Session = Depends(get_db)):
    remain = cooldown_remaining_sec(user)
    if remain > 0:
        raise HTTPException(429, f"{(remain + 59) // 60}분 후에 다시 갱신할 수 있습니다")
    if not user.keys:
        raise HTTPException(400, "연결된 프로바이더가 없습니다")
    return {"ok": True, "sync": sync_user(db, user)}


# ── 사용량 조회 ─────────────────────────────────────────────
@app.get("/api/usage/daily")
def usage_daily(days: int = 30, user: models.User = Depends(current_user), db: Session = Depends(get_db)):
    days = min(max(days, 1), 90)
    start = date.today() - timedelta(days=days - 1)
    rows = db.query(
        models.UsageDaily.day, models.UsageDaily.provider,
        func.sum(models.UsageDaily.cost_usd), func.sum(models.UsageDaily.input_tokens + models.UsageDaily.output_tokens),
    ).filter(
        models.UsageDaily.user_id == user.id, models.UsageDaily.day >= start,
    ).group_by(models.UsageDaily.day, models.UsageDaily.provider).all()
    return [
        {"day": d.isoformat(), "provider": p, "cost_usd": round(c, 4), "tokens": int(t)}
        for d, p, c, t in rows
    ]


@app.get("/api/usage/models")
def usage_models(user: models.User = Depends(current_user), db: Session = Depends(get_db)):
    month_start = date.today().replace(day=1)
    rows = db.query(
        models.UsageDaily.provider, models.UsageDaily.model,
        func.sum(models.UsageDaily.cost_usd),
        func.sum(models.UsageDaily.input_tokens), func.sum(models.UsageDaily.output_tokens),
    ).filter(
        models.UsageDaily.user_id == user.id, models.UsageDaily.day >= month_start,
    ).group_by(models.UsageDaily.provider, models.UsageDaily.model).all()
    return [
        {"provider": p, "model": m, "cost_usd": round(c, 4),
         "input_tokens": int(i), "output_tokens": int(o)}
        for p, m, c, i, o in rows
    ]


@app.get("/api/usage/breakdown")
def usage_breakdown(user: models.User = Depends(current_user), db: Session = Depends(get_db)):
    """이번 달 키(조직) × 프로젝트 × 모델 분해 — 대시보드 드릴다운용."""
    month_start = date.today().replace(day=1)
    rows = db.query(
        models.UsageDaily.key_id, models.UsageDaily.provider,
        models.UsageDaily.project_id, models.UsageDaily.project_name, models.UsageDaily.model,
        func.sum(models.UsageDaily.cost_usd),
        func.sum(models.UsageDaily.input_tokens), func.sum(models.UsageDaily.output_tokens),
    ).filter(
        models.UsageDaily.user_id == user.id, models.UsageDaily.day >= month_start,
    ).group_by(
        models.UsageDaily.key_id, models.UsageDaily.provider,
        models.UsageDaily.project_id, models.UsageDaily.project_name, models.UsageDaily.model,
    ).all()
    return [
        {"key_id": k, "provider": p, "project_id": pid, "project_name": pname, "model": m,
         "cost_usd": round(c, 4), "input_tokens": int(i), "output_tokens": int(o)}
        for k, p, pid, pname, m, c, i, o in rows
    ]


# ── 리더보드 ────────────────────────────────────────────────
TIERS = [  # (최소 토큰, 이모지, 칭호) — 큰 것부터
    (1_000_000_000, "🌌", "AGI 소환자"),
    (100_000_000, "🔥", "토큰 버너"),
    (10_000_000, "⚡", "컨텍스트 마스터"),
    (1_000_000, "🔨", "프롬프트 장인"),
    (100_000, "📦", "토큰 수집가"),
    (0, "🌱", "프롬프트 입문"),
]


def _tier(tokens: int) -> dict:
    for min_tok, emoji, name in TIERS:
        if tokens >= min_tok:
            nxt = None
            idx = TIERS.index((min_tok, emoji, name))
            if idx > 0:
                nxt = {"name": TIERS[idx - 1][2], "at": TIERS[idx - 1][0]}
            return {"emoji": emoji, "name": name, "next": nxt}
    return {"emoji": "🌱", "name": "프롬프트 입문", "next": None}


def _mask_email(email: str) -> str:
    local = email.split("@")[0]
    return (local[:4] + "***") if len(local) > 4 else (local[:1] + "***")


@app.get("/api/leaderboard")
def leaderboard(user: models.User = Depends(current_user), db: Session = Depends(get_db)):
    """이번 달 토큰 사용량 순위 — 이름은 마스킹, 본인 행만 식별 가능."""
    month_start = date.today().replace(day=1)
    rows = db.query(
        models.UsageDaily.user_id,
        func.coalesce(func.sum(models.UsageDaily.input_tokens + models.UsageDaily.output_tokens), 0),
    ).filter(models.UsageDaily.day >= month_start).group_by(models.UsageDaily.user_id) \
     .order_by(func.sum(models.UsageDaily.input_tokens + models.UsageDaily.output_tokens).desc()).all()
    names = {u.id: (u.nickname or _mask_email(u.email)) for u in db.query(models.User).all()}
    board = [{"rank": i + 1, "name": names.get(uid, "?"), "tokens": int(t),
              "tier": _tier(int(t)), "me": uid == user.id}
             for i, (uid, t) in enumerate(rows)]
    mine = next((b for b in board if b["me"]), None)
    my_tokens = mine["tokens"] if mine else 0
    my_rank = mine["rank"] if mine else len(board) + 1
    total = max(len(board), 1)
    return {
        "top": board[:10],
        "me": {"rank": my_rank, "tokens": my_tokens, "tier": _tier(my_tokens),
               "percentile": round(my_rank / total * 100)},
        "total_users": len(board),
    }


# ── 구독 사용량 업로더 (MCP) ────────────────────────────────
IMPORT_SOURCES = {"claude-code": "Claude Code", "codex": "Codex CLI", "gemini": "Gemini CLI"}


class ImportRow(BaseModel):
    day: date
    model: str = Field(min_length=1, max_length=128)
    input_tokens: int = Field(ge=0, le=10**12)
    output_tokens: int = Field(ge=0, le=10**12)


class ImportIn(BaseModel):
    source: str = Field(pattern="^(claude-code|codex|gemini)$")
    rows: list[ImportRow] = Field(max_length=2000)


def _uploader_user(request: Request, db: Session) -> models.User:
    token = request.headers.get("x-upload-token", "")
    user = db.query(models.User).filter_by(upload_token=token).first() if token else None
    if user is None:
        raise HTTPException(401, "업로드 토큰이 유효하지 않습니다 — 마이페이지에서 발급하세요")
    return user


@app.post("/api/uploader/token")
def uploader_token(user: models.User = Depends(current_user), db: Session = Depends(get_db)):
    """업로드 토큰 발급/재발급 (재발급 시 이전 토큰은 무효)."""
    user.upload_token = "tbu_" + secrets.token_urlsafe(24)
    db.commit()
    return {"upload_token": user.upload_token}


@app.post("/api/usage/import")
def usage_import(body: ImportIn, request: Request, db: Session = Depends(get_db)):
    """구독 사용량 업로드 — 해당 소스·기간의 기존 행을 교체(멱등)."""
    rate_limit(request, "import", 60, 3600)
    user = _uploader_user(request, db)
    today = date.today()
    # (day, model)로 합산 + 미래 날짜 제외
    agg: dict[tuple, list[int]] = {}
    for r in body.rows:
        if r.day > today:
            continue
        k = (r.day, r.model[:128])
        a = agg.setdefault(k, [0, 0])
        a[0] += r.input_tokens
        a[1] += r.output_tokens
    if not agg:
        return {"ok": True, "rows": 0}
    lo, hi = min(k[0] for k in agg), max(k[0] for k in agg)
    db.query(models.UsageDaily).filter(
        models.UsageDaily.user_id == user.id,
        models.UsageDaily.provider == body.source,
        models.UsageDaily.day >= lo, models.UsageDaily.day <= hi,
    ).delete()
    for (d, model), (in_tok, out_tok) in agg.items():
        db.add(models.UsageDaily(
            user_id=user.id, key_id=None, day=d, provider=body.source,
            project_id=None, project_name=None, model=model,
            cost_usd=round(estimate_cost(model, in_tok, out_tok), 4),
            input_tokens=in_tok, output_tokens=out_tok,
        ))
    db.commit()
    return {"ok": True, "rows": len(agg), "from": lo.isoformat(), "to": hi.isoformat()}


@app.get("/api/uploader/me")
def uploader_me(request: Request, db: Session = Depends(get_db)):
    """업로더/MCP용 내 순위 요약 (업로드 토큰 인증)."""
    rate_limit(request, "import", 60, 3600)
    user = _uploader_user(request, db)
    month_start = date.today().replace(day=1)
    rows = db.query(
        models.UsageDaily.user_id,
        func.coalesce(func.sum(models.UsageDaily.input_tokens + models.UsageDaily.output_tokens), 0),
    ).filter(models.UsageDaily.day >= month_start).group_by(models.UsageDaily.user_id) \
     .order_by(func.sum(models.UsageDaily.input_tokens + models.UsageDaily.output_tokens).desc()).all()
    my_tokens, my_rank = 0, len(rows) + 1
    for i, (uid, t) in enumerate(rows):
        if uid == user.id:
            my_tokens, my_rank = int(t), i + 1
            break
    my_cost = db.query(func.coalesce(func.sum(models.UsageDaily.cost_usd), 0.0)).filter(
        models.UsageDaily.user_id == user.id, models.UsageDaily.day >= month_start).scalar()
    return {"nickname": user.nickname, "rank": my_rank, "total_users": max(len(rows), 1),
            "tokens": my_tokens, "cost_usd": round(my_cost, 4), "tier": _tier(my_tokens)}


@app.get("/api/leaderboard/public")
def leaderboard_public(request: Request, db: Session = Depends(get_db)):
    """로그인 없이 볼 수 있는 리더보드 — 별명·티어·토큰량만 노출."""
    rate_limit(request, "pub-lb", 30, 60)
    month_start = date.today().replace(day=1)
    rows = db.query(
        models.UsageDaily.user_id,
        func.coalesce(func.sum(models.UsageDaily.input_tokens + models.UsageDaily.output_tokens), 0),
    ).filter(models.UsageDaily.day >= month_start).group_by(models.UsageDaily.user_id) \
     .order_by(func.sum(models.UsageDaily.input_tokens + models.UsageDaily.output_tokens).desc()).limit(10).all()
    names = {u.id: (u.nickname or _mask_email(u.email)) for u in db.query(models.User).all()}
    return {
        "top": [{"rank": i + 1, "name": names.get(uid, "?"), "tokens": int(t), "tier": _tier(int(t))}
                for i, (uid, t) in enumerate(rows)],
        "total_users": db.query(func.count(models.User.id)).scalar(),
    }


# ── 관리자 ──────────────────────────────────────────────────
@app.get("/api/admin/stats")
def admin_stats(admin: models.User = Depends(admin_user), db: Session = Depends(get_db)):
    month_start = date.today().replace(day=1)
    by_provider = dict(db.query(
        models.UsageDaily.provider, func.coalesce(func.sum(models.UsageDaily.cost_usd), 0.0),
    ).filter(models.UsageDaily.day >= month_start).group_by(models.UsageDaily.provider).all())
    return {
        "users": db.query(func.count(models.User.id)).scalar(),
        "keys": db.query(func.count(models.ProviderKey.id)).scalar(),
        "month_cost_usd": round(sum(by_provider.values()), 4),
        "month_cost_by_provider": {p: round(c, 4) for p, c in by_provider.items()},
    }


@app.get("/api/admin/users")
def admin_users(admin: models.User = Depends(admin_user), db: Session = Depends(get_db)):
    month_start = date.today().replace(day=1)
    cost_by_user = dict(db.query(
        models.UsageDaily.user_id, func.coalesce(func.sum(models.UsageDaily.cost_usd), 0.0),
    ).filter(models.UsageDaily.day >= month_start).group_by(models.UsageDaily.user_id).all())
    keys_by_user = dict(db.query(
        models.ProviderKey.user_id, func.count(models.ProviderKey.id),
    ).group_by(models.ProviderKey.user_id).all())
    return [{
        "id": u.id,
        "email": u.email,
        "is_admin": u.is_admin,
        "created_at": u.created_at.isoformat() + "Z",
        "last_sync_at": u.last_sync_at.isoformat() + "Z" if u.last_sync_at else None,
        "keys": keys_by_user.get(u.id, 0),
        "month_cost_usd": round(cost_by_user.get(u.id, 0.0), 4),
    } for u in db.query(models.User).order_by(models.User.id).all()]


@app.delete("/api/admin/users/{user_id}")
def admin_delete_user(user_id: int, admin: models.User = Depends(admin_user), db: Session = Depends(get_db)):
    if user_id == admin.id:
        raise HTTPException(400, "본인 계정은 삭제할 수 없습니다")
    target = db.get(models.User, user_id)
    if target is None:
        raise HTTPException(404, "사용자를 찾을 수 없습니다")
    if target.is_admin:
        raise HTTPException(400, "다른 관리자 계정은 삭제할 수 없습니다")
    db.query(models.UsageDaily).filter_by(user_id=user_id).delete()
    db.delete(target)  # provider_keys는 cascade로 함께 삭제
    db.commit()
    return {"ok": True}


@app.post("/api/admin/sync-all")
def admin_sync_all(admin: models.User = Depends(admin_user), db: Session = Depends(get_db)):
    """모든 사용자 즉시 재수집 (쿨다운 무시)."""
    results = []
    for u in db.query(models.User).all():
        if u.keys:
            results.append({"user_id": u.id, "email": u.email, "sync": sync_user(db, u)})
    return {"ok": True, "synced_users": len(results), "results": results}


# ── 정적 프론트엔드 ─────────────────────────────────────────
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/", include_in_schema=False)
def index():
    # 프론트가 단일 HTML이라 구버전 캐시가 남으면 새 API와 어긋난다 → 항상 재검증
    return FileResponse("static/index.html", headers={"Cache-Control": "no-cache"})


@app.get("/privacy", include_in_schema=False)
def privacy():
    return FileResponse("static/privacy.html")


@app.get("/terms", include_in_schema=False)
def terms():
    return FileResponse("static/terms.html")


# ── 스케줄러: 매일 1회 자동 수집 (03:00 KST = 18:00 UTC) ────
scheduler = BackgroundScheduler(timezone="UTC")
scheduler.add_job(sync_all_users, "cron", hour=18, minute=0)


@app.on_event("startup")
def _start_scheduler():
    scheduler.start()


@app.on_event("shutdown")
def _stop_scheduler():
    scheduler.shutdown(wait=False)
