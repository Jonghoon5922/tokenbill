"""DB 모델.

핵심 설계: 원본 로그는 프로바이더에 두고, 우리는
"날짜 × 프로바이더 × 모델" 단위의 요약 행(UsageDaily)만 보관한다.
"""
from datetime import datetime, date
from sqlalchemy import Boolean, String, Float, Integer, Date, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .db import Base


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    # 사용자 설정
    budget_usd: Mapped[float] = mapped_column(Float, default=100.0)
    fx_rate: Mapped[float] = mapped_column(Float, default=1380.0)
    currency: Mapped[str] = mapped_column(String(3), default="USD")
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    nickname: Mapped[str | None] = mapped_column(String(32), nullable=True)  # 리더보드 표시 이름
    # 예산 알림 (이메일)
    alert_month: Mapped[str | None] = mapped_column(String(7), nullable=True)   # 알림 이력 기준 달 (YYYY-MM)
    alert_level: Mapped[int] = mapped_column(Integer, default=0)                # 0=없음 1=80% 2=100% 발송됨
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    keys: Mapped[list["ProviderKey"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class ProviderKey(Base):
    __tablename__ = "provider_keys"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    provider: Mapped[str] = mapped_column(String(32))          # openai | anthropic | google
    label: Mapped[str] = mapped_column(String(64), default="기본")  # 조직 구분용 이름
    key_encrypted: Mapped[str] = mapped_column(String(2048))   # Fernet 암호화
    key_masked: Mapped[str] = mapped_column(String(64))        # 표시용 (sk-…abcd)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_status: Mapped[str] = mapped_column(String(255), default="pending")  # ok | error: … | pending
    warning: Mapped[str | None] = mapped_column(String(255), nullable=True)   # 권한 과다 등 지속 경고

    user: Mapped["User"] = relationship(back_populates="keys")
    __table_args__ = (UniqueConstraint("user_id", "provider", "label", name="uq_user_provider_label"),)


class UsageDaily(Base):
    __tablename__ = "usage_daily"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    key_id: Mapped[int | None] = mapped_column(ForeignKey("provider_keys.id"), index=True, nullable=True)
    day: Mapped[date] = mapped_column(Date, index=True)
    provider: Mapped[str] = mapped_column(String(32))
    project_id: Mapped[str | None] = mapped_column(String(64), nullable=True)    # OpenAI project / Anthropic workspace
    project_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    model: Mapped[str] = mapped_column(String(128))
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    __table_args__ = (UniqueConstraint("user_id", "key_id", "day", "provider", "project_id", "model", name="uq_usage_row"),)
