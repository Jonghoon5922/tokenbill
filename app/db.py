"""데이터베이스 설정 — SQLite + SQLAlchemy."""
import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

DB_URL = os.environ.get("DATABASE_URL", "sqlite:///./tokenbill.db")

engine = create_engine(DB_URL, connect_args={"check_same_thread": False} if DB_URL.startswith("sqlite") else {})
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def init_db():
    """테이블 생성 + 구버전 스키마 자동 마이그레이션 (SQLite).

    v0.1 → 다중 조직: provider_keys에 label, usage_daily에 key_id가 추가되고
    유니크 제약이 바뀌었다. SQLite는 제약 변경 ALTER가 안 되므로
    구버전 테이블을 rename → 새로 생성 → 데이터 복사 방식으로 재구축한다.
    """
    from . import models  # noqa: F401 — Base.metadata에 모델 등록

    if DB_URL.startswith("sqlite"):
        with engine.begin() as conn:
            pk_cols = [r[1] for r in conn.exec_driver_sql("PRAGMA table_info(provider_keys)")]
            if pk_cols and "label" not in pk_cols:
                conn.exec_driver_sql("ALTER TABLE provider_keys RENAME TO provider_keys_old")
                # SQLite는 rename 후에도 인덱스 이름이 유지되어 create_all과 충돌 → 미리 제거
                conn.exec_driver_sql("DROP INDEX IF EXISTS ix_provider_keys_user_id")
            ud_cols = [r[1] for r in conn.exec_driver_sql("PRAGMA table_info(usage_daily)")]
            if ud_cols and "key_id" not in ud_cols:
                conn.exec_driver_sql("ALTER TABLE usage_daily RENAME TO usage_daily_old")
                conn.exec_driver_sql("DROP INDEX IF EXISTS ix_usage_daily_user_id")
                conn.exec_driver_sql("DROP INDEX IF EXISTS ix_usage_daily_day")

    Base.metadata.create_all(engine)

    if DB_URL.startswith("sqlite"):
        with engine.begin() as conn:
            olds = {r[0] for r in conn.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_old'")}
            if "provider_keys_old" in olds:
                conn.exec_driver_sql(
                    "INSERT INTO provider_keys (id, user_id, provider, label, key_encrypted, key_masked, created_at, last_status) "
                    "SELECT id, user_id, provider, '기본', key_encrypted, key_masked, created_at, last_status "
                    "FROM provider_keys_old")
                conn.exec_driver_sql("DROP TABLE provider_keys_old")
            if "usage_daily_old" in olds:
                # 기존 요약 행은 (user, provider)당 키가 1개였으므로 그 키에 귀속시킨다
                conn.exec_driver_sql(
                    "INSERT INTO usage_daily (id, user_id, key_id, day, provider, model, cost_usd, input_tokens, output_tokens) "
                    "SELECT u.id, u.user_id, k.id, u.day, u.provider, u.model, u.cost_usd, u.input_tokens, u.output_tokens "
                    "FROM usage_daily_old u "
                    "LEFT JOIN provider_keys k ON k.user_id = u.user_id AND k.provider = u.provider")
                conn.exec_driver_sql("DROP TABLE usage_daily_old")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
