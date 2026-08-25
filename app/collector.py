"""수집 오케스트레이션 — 키 복호화 → 프로바이더 호출 → UsageDaily upsert.

갱신 정책: 매일 1회 자동(스케줄러) + 수동 갱신(10분 쿨다운).
"""
from datetime import date, datetime, timedelta

from sqlalchemy import delete
from sqlalchemy.orm import Session

from . import models
from .security import decrypt_key
from .providers.collectors import collect, CollectError

LOOKBACK_DAYS = 45
MANUAL_COOLDOWN_MIN = 10


def cooldown_remaining_sec(user: models.User) -> int:
    if not user.last_sync_at:
        return 0
    elapsed = (datetime.utcnow() - user.last_sync_at).total_seconds()
    return max(0, int(MANUAL_COOLDOWN_MIN * 60 - elapsed))


def sync_user(db: Session, user: models.User) -> dict:
    """해당 사용자의 모든 키에 대해 최근 LOOKBACK_DAYS일을 재수집한다."""
    end = date.today()
    start = end - timedelta(days=LOOKBACK_DAYS)
    results = {}
    for key in user.keys:
        try:
            rows = collect(key.provider, decrypt_key(key.key_encrypted), start, end)
            # 기간 내 기존 행을 지우고 다시 넣는다 (당일 데이터가 계속 갱신되므로)
            db.execute(
                delete(models.UsageDaily).where(
                    models.UsageDaily.user_id == user.id,
                    models.UsageDaily.provider == key.provider,
                    models.UsageDaily.day >= start,
                )
            )
            for r in rows:
                db.add(models.UsageDaily(
                    user_id=user.id, day=r["day"], provider=key.provider, model=r["model"],
                    cost_usd=r["cost_usd"], input_tokens=r["input_tokens"], output_tokens=r["output_tokens"],
                ))
            key.last_status = "ok"
            results[key.provider] = {"ok": True, "rows": len(rows)}
        except CollectError as e:
            key.last_status = f"error: {e}"
            results[key.provider] = {"ok": False, "error": str(e)}
        except Exception as e:  # 네트워크 등 예기치 못한 오류
            key.last_status = "error: 수집 중 오류가 발생했습니다"
            results[key.provider] = {"ok": False, "error": f"수집 실패: {type(e).__name__}"}
    user.last_sync_at = datetime.utcnow()
    db.commit()
    return results


def sync_all_users() -> None:
    """스케줄러용 — 모든 사용자 일일 수집."""
    from .db import SessionLocal
    db = SessionLocal()
    try:
        for user in db.query(models.User).all():
            if user.keys:
                sync_user(db, user)
    finally:
        db.close()
