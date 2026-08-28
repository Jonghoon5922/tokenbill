"""Tokenbill — AI API 비용 대시보드 백엔드."""
import os
import secrets
from datetime import date, timedelta

import httpx

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from . import models
from .collector import cooldown_remaining_sec, sync_all_users, sync_user, MANUAL_COOLDOWN_MIN
from .providers.collectors import fetch_org_name
from .db import get_db, init_db
from .security import (create_token, current_user, encrypt_key, hash_password,
                       mask_key, verify_password)

init_db()

app = FastAPI(title="Tokenbill API", version="0.1.0")

PROVIDERS = ["openai", "anthropic", "google"]
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")  # 설정하면 구글 로그인 활성화
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "").lower()    # 이 이메일 계정은 로그인 시 관리자로 자동 승격


def _maybe_promote_admin(user: models.User, db: Session) -> None:
    if ADMIN_EMAIL and user.email == ADMIN_EMAIL and not user.is_admin:
        user.is_admin = True
        db.commit()


def admin_user(user: models.User = Depends(current_user)) -> models.User:
    if not user.is_admin:
        raise HTTPException(403, "관리자 권한이 필요합니다")
    return user


# ── 스키마 ──────────────────────────────────────────────────
class AuthIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class SettingsIn(BaseModel):
    budget_usd: float | None = Field(default=None, ge=0)
    fx_rate: float | None = Field(default=None, gt=0)
    currency: str | None = Field(default=None, pattern="^(USD|KRW)$")


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
    return {"google_client_id": GOOGLE_CLIENT_ID or None}


@app.post("/api/auth/google")
def google_login(body: GoogleAuthIn, db: Session = Depends(get_db)):
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
        user = models.User(email=email, password_hash=hash_password(secrets.token_hex(32)))
        db.add(user)
        db.commit()
    _maybe_promote_admin(user, db)
    return {"token": create_token(user.id)}


@app.post("/api/auth/register")
def register(body: AuthIn, db: Session = Depends(get_db)):
    if db.query(models.User).filter_by(email=body.email.lower()).first():
        raise HTTPException(409, "이미 가입된 이메일입니다")
    user = models.User(email=body.email.lower(), password_hash=hash_password(body.password))
    db.add(user)
    db.commit()
    return {"token": create_token(user.id)}


@app.post("/api/auth/login")
def login(body: AuthIn, db: Session = Depends(get_db)):
    user = db.query(models.User).filter_by(email=body.email.lower()).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "이메일 또는 비밀번호가 올바르지 않습니다")
    _maybe_promote_admin(user, db)
    return {"token": create_token(user.id)}


# ── 사용자 설정 ─────────────────────────────────────────────
@app.get("/api/me")
def me(user: models.User = Depends(current_user)):
    return {
        "email": user.email, "is_admin": user.is_admin, "budget_usd": user.budget_usd,
        "fx_rate": user.fx_rate, "currency": user.currency,
        "last_sync_at": user.last_sync_at.isoformat() + "Z" if user.last_sync_at else None,
        "cooldown_sec": cooldown_remaining_sec(user),
        "cooldown_min": MANUAL_COOLDOWN_MIN,
    }


@app.patch("/api/me")
def update_me(body: SettingsIn, user: models.User = Depends(current_user), db: Session = Depends(get_db)):
    if body.budget_usd is not None:
        user.budget_usd = body.budget_usd
    if body.fx_rate is not None:
        user.fx_rate = body.fx_rate
    if body.currency is not None:
        user.currency = body.currency
    db.commit()
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
    key = models.ProviderKey(
        user_id=user.id, provider=body.provider, label=label,
        key_encrypted=encrypt_key(body.api_key), key_masked=mask_key(body.api_key),
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


# ── 스케줄러: 매일 1회 자동 수집 (03:00 KST = 18:00 UTC) ────
scheduler = BackgroundScheduler(timezone="UTC")
scheduler.add_job(sync_all_users, "cron", hour=18, minute=0)


@app.on_event("startup")
def _start_scheduler():
    scheduler.start()


@app.on_event("shutdown")
def _stop_scheduler():
    scheduler.shutdown(wait=False)
