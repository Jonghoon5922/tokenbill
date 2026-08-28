"""알림 — 이메일(SMTP)로 예산 경고를 보낸다.

서버 환경변수로 발송 계정을 한 번만 설정하면, 각 사용자의 로그인 이메일로 발송된다.
  SMTP_USER  발송 계정 (예: Gmail 주소)
  SMTP_PASS  비밀번호 (Gmail이면 '앱 비밀번호')
  SMTP_HOST  기본 smtp.gmail.com
  SMTP_PORT  기본 587 (STARTTLS)
"""
import os
import smtplib
from datetime import date
from email.mime.text import MIMEText
from email.utils import formataddr

from sqlalchemy import func
from sqlalchemy.orm import Session

from . import models

SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "")

ALERT_LEVELS = [(2, 100), (1, 80)]  # (레벨, 예산 대비 %)


def alerts_available() -> bool:
    return bool(SMTP_USER and SMTP_PASS)


def send_email(to: str, subject: str, body: str) -> bool:
    if not alerts_available():
        return False
    try:
        msg = MIMEText(body, "plain", "utf-8")
        msg["Subject"] = subject
        msg["From"] = formataddr(("Tokenbill", SMTP_USER))
        msg["To"] = to
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as s:
            s.starttls()
            s.login(SMTP_USER, SMTP_PASS)
            s.sendmail(SMTP_USER, [to], msg.as_string())
        return True
    except Exception:
        return False


def check_budget_alert(db: Session, user: models.User) -> None:
    """이번 달 비용이 예산의 80%/100%를 넘으면 각 1회씩 이메일 알림."""
    if not alerts_available() or user.budget_usd <= 0:
        return
    month = date.today().strftime("%Y-%m")
    if user.alert_month != month:  # 달이 바뀌면 알림 이력 리셋
        user.alert_month = month
        user.alert_level = 0
    cost = db.query(func.coalesce(func.sum(models.UsageDaily.cost_usd), 0.0)).filter(
        models.UsageDaily.user_id == user.id,
        models.UsageDaily.day >= date.today().replace(day=1),
    ).scalar()
    pct = cost / user.budget_usd * 100
    for level, threshold in ALERT_LEVELS:
        if pct >= threshold and (user.alert_level or 0) < level:
            if threshold >= 100:
                subject = "🚨 Tokenbill — 이번 달 예산을 초과했습니다"
                body = (f"이번 달 AI API 비용이 ${cost:.2f}로 "
                        f"예산(${user.budget_usd:.0f})을 넘었습니다 ({pct:.0f}%).\n\n"
                        f"대시보드에서 상세 내역을 확인하세요.")
            else:
                subject = "⚠️ Tokenbill — 예산의 80%에 도달했습니다"
                body = (f"이번 달 AI API 비용이 ${cost:.2f}로 "
                        f"예산(${user.budget_usd:.0f})의 {pct:.0f}%에 도달했습니다.\n\n"
                        f"대시보드에서 상세 내역을 확인하세요.")
            if send_email(user.email, subject, body):
                user.alert_level = level
                db.commit()
            break
