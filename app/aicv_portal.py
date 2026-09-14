"""AICV 포탈 — 증거 기반 AI 활용 능력 이력서 공개 프로필. (tokenbill 컨테이너에 흡수됨)

aicv.tokenbill.my 요청은 main.py의 Host 분기(_HostDispatch)가 이 앱으로 넘긴다.
DB(aicv.db)·SECRET_KEY는 tokenbill과 분리 유지 — AICV_DATABASE_URL·AICV_SECRET_KEY 환경변수.

FastAPI + SQLite 단일 파일 서버.
로그인은 tokenbill과 동일: JWT + bcrypt, GOOGLE_CLIENT_ID 설정 시 구글 로그인,
AUTH_GOOGLE_ONLY=1 이면 구글 전용.

흐름:
  aicv-mcp (로컬) → POST /api/evidence (X-Upload-Token) → /r/<핸들> 공개 프로필
"""
import html
import json
import os
import re
import secrets
from datetime import datetime, timedelta
from pathlib import Path

import bcrypt as _bcrypt
import httpx
import jwt
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import (Boolean, Column, DateTime, ForeignKey, Integer,
                        String, Text, create_engine)
from sqlalchemy.orm import Session, declarative_base, sessionmaker

# ── 설정 ────────────────────────────────────────────────────
SECRET_KEY = os.environ.get("AICV_SECRET_KEY", "dev-secret-change-me")  # tokenbill SECRET_KEY와 반드시 분리 (토큰 교차 검증 방지)
JWT_ALG = "HS256"
TOKEN_TTL_HOURS = 24 * 14
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
# 관리자: 쉼표로 구분한 이메일 목록 — 이 계정으로 로그인하면 /admin 접근 가능
ADMIN_EMAILS = {e.strip().lower() for e in (os.environ.get("ADMIN_EMAILS") or os.environ.get("ADMIN_EMAIL", "")).split(",") if e.strip()}
AUTH_GOOGLE_ONLY = os.environ.get("AUTH_GOOGLE_ONLY", "") == "1"
DATABASE_URL = os.environ.get("AICV_DATABASE_URL", "sqlite:///./aicv.db")
STATIC_DIR = Path("static") / "aicv"

# ── DB ──────────────────────────────────────────────────────
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False}
                       if DATABASE_URL.startswith("sqlite") else {})
SessionLocal = sessionmaker(bind=engine, autoflush=False)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    email = Column(String, unique=True, nullable=False)
    password_hash = Column(String)  # 구글 가입이면 없음
    handle = Column(String, unique=True)  # 공개 프로필 URL용
    is_public = Column(Boolean, default=False)
    upload_token = Column(String, unique=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class Evidence(Base):
    __tablename__ = "evidence"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    date = Column(String, nullable=False)  # pack.window.to (YYYY-MM-DD)
    pack = Column(Text, nullable=False)    # 증거 팩 JSON 원문
    uploaded_at = Column(DateTime, default=datetime.utcnow)


class PairCode(Base):
    """기기 연결 코드 — 대시보드에서 발급, MCP가 토큰으로 교환 (10분, 1회용)."""
    __tablename__ = "pair_codes"
    id = Column(Integer, primary_key=True)
    code = Column(String, unique=True, nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    expires_at = Column(DateTime, nullable=False)
    used = Column(Boolean, default=False)


class Resume(Base):
    __tablename__ = "resumes"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    format = Column(String, nullable=False, default="full")
    markdown = Column(Text, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow)


Base.metadata.create_all(engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ── 인증 (tokenbill과 동일 방식) ────────────────────────────
bearer = HTTPBearer(auto_error=False)


def hash_password(pw: str) -> str:
    return _bcrypt.hashpw(pw.encode()[:72], _bcrypt.gensalt()).decode()


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return _bcrypt.checkpw(pw.encode()[:72], (hashed or "").encode())
    except ValueError:
        return False


def create_token(user_id: int) -> str:
    payload = {"sub": str(user_id), "exp": datetime.utcnow() + timedelta(hours=TOKEN_TTL_HOURS)}
    return jwt.encode(payload, SECRET_KEY, algorithm=JWT_ALG)


def current_user(creds: HTTPAuthorizationCredentials | None = Depends(bearer),
                 db: Session = Depends(get_db)) -> User:
    if creds is None:
        raise HTTPException(401, "로그인이 필요합니다")
    try:
        payload = jwt.decode(creds.credentials, SECRET_KEY, algorithms=[JWT_ALG])
        user_id = int(payload["sub"])
    except Exception:
        raise HTTPException(401, "유효하지 않은 토큰입니다")
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(401, "사용자를 찾을 수 없습니다")
    return user


def uploader_user(x_upload_token: str | None = Header(None),
                  db: Session = Depends(get_db)) -> User:
    user = (db.query(User).filter_by(upload_token=x_upload_token).first()
            if x_upload_token else None)
    if user is None:
        raise HTTPException(401, "유효하지 않은 업로드 토큰입니다 — 포탈에서 토큰을 발급받으세요")
    return user


# ── 앱 ──────────────────────────────────────────────────────
app = FastAPI(title="AICV", docs_url="/docs")


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class GoogleAuthIn(BaseModel):
    credential: str = Field(min_length=20, max_length=4096)


class MeIn(BaseModel):
    handle: str | None = Field(None, min_length=3, max_length=30)
    is_public: bool | None = None


class ResumeIn(BaseModel):
    format: str = Field("full", pattern="^(full|career|skills|github)$")
    markdown: str = Field(min_length=10, max_length=200_000)


@app.get("/api/auth/config")
def auth_config():
    return {"google_client_id": GOOGLE_CLIENT_ID or None,
            "google_only": bool(AUTH_GOOGLE_ONLY and GOOGLE_CLIENT_ID)}


def auto_handle(email: str, db: Session) -> str:
    """이메일 앞부분으로 핸들 자동 생성 — 사용자는 공개/비공개만 결정하면 된다."""
    base = re.sub(r"[^a-z0-9-]", "", email.split("@")[0].lower())[:24].strip("-") or "user"
    if len(base) < 3:
        base = (base + "-dev")[:24]
    handle = base
    n = 1
    while handle in RESERVED or db.query(User).filter_by(handle=handle).first():
        n += 1
        handle = f"{base}{n}"
    return handle


@app.post("/api/auth/register")
def register(body: RegisterIn, db: Session = Depends(get_db)):
    if AUTH_GOOGLE_ONLY and GOOGLE_CLIENT_ID:
        raise HTTPException(403, "구글 로그인만 사용할 수 있습니다")
    if db.query(User).filter_by(email=body.email.lower()).first():
        raise HTTPException(409, "이미 가입된 이메일입니다")
    user = User(email=body.email.lower(), password_hash=hash_password(body.password))
    user.handle = auto_handle(user.email, db)
    db.add(user)
    db.commit()
    return {"token": create_token(user.id)}


@app.post("/api/auth/login")
def login(body: RegisterIn, db: Session = Depends(get_db)):
    if AUTH_GOOGLE_ONLY and GOOGLE_CLIENT_ID:
        raise HTTPException(403, "구글 로그인만 사용할 수 있습니다")
    user = db.query(User).filter_by(email=body.email.lower()).first()
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "이메일 또는 비밀번호가 올바르지 않습니다")
    return {"token": create_token(user.id)}


@app.post("/api/auth/google")
def google_login(body: GoogleAuthIn, db: Session = Depends(get_db)):
    """Google Identity Services ID 토큰 검증 → 이메일 기준 자동 가입/로그인."""
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(400, "구글 로그인이 설정되지 않았습니다")
    try:
        r = httpx.get("https://oauth2.googleapis.com/tokeninfo",
                      params={"id_token": body.credential}, timeout=10)
        info = r.json()
    except Exception:
        raise HTTPException(502, "구글 토큰 검증에 실패했습니다")
    if info.get("aud") != GOOGLE_CLIENT_ID or info.get("email_verified") not in ("true", True):
        raise HTTPException(401, "유효하지 않은 구글 계정입니다")
    email = info["email"].lower()
    user = db.query(User).filter_by(email=email).first()
    if user is None:
        user = User(email=email)
        db.add(user)
    if not user.handle:  # 기존 가입자도 로그인 시 자동 부여
        user.handle = auto_handle(email, db)
    db.commit()
    return {"token": create_token(user.id)}


# ── 내 계정 ─────────────────────────────────────────────────
HANDLE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$")
RESERVED = {"api", "docs", "r", "admin", "static", "www", "aicv", "privacy", "terms"}


@app.get("/api/me")
def me(user: User = Depends(current_user), db: Session = Depends(get_db)):
    ev = (db.query(Evidence).filter_by(user_id=user.id)
          .order_by(Evidence.date.desc()).first())
    return {
        "email": user.email, "handle": user.handle, "is_public": user.is_public,
        "upload_token": user.upload_token,
        "last_evidence": ev.date if ev else None,
        "profile_url": f"/r/{user.handle}" if user.handle else None,
    }


@app.patch("/api/me")
def update_me(body: MeIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if body.handle is not None:
        h = body.handle.lower()
        if not HANDLE_RE.match(h) or h in RESERVED:
            raise HTTPException(400, "토큰명은 3~30자 영소문자·숫자·하이픈만 가능합니다")
        taken = db.query(User).filter(User.handle == h, User.id != user.id).first()
        if taken:
            raise HTTPException(409, "이미 사용 중인 토큰명입니다")
        user.handle = h
    if body.is_public is not None:
        if body.is_public and not user.handle:
            raise HTTPException(400, "공개하려면 먼저 토큰명을 설정하세요")
        user.is_public = body.is_public
    db.commit()
    return {"handle": user.handle, "is_public": user.is_public}


@app.delete("/api/me")
def delete_me(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """계정 삭제 — 증거 팩·이력서·연결 코드 포함 전체 데이터를 즉시 삭제한다."""
    db.query(Evidence).filter_by(user_id=user.id).delete()
    db.query(Resume).filter_by(user_id=user.id).delete()
    db.query(PairCode).filter_by(user_id=user.id).delete()
    db.delete(user)
    db.commit()
    return {"ok": True, "message": "계정과 모든 데이터가 삭제되었습니다"}


# ── 기기 연결 (연결 코드 → 토큰 교환) ───────────────────────
# 사용자는 토큰을 볼 필요 없이 "aicv 연결해줘, 코드 XXXXXX" 한마디로 연결한다.
PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # 혼동 문자(I·L·O·0·1) 제외


class PairClaimIn(BaseModel):
    code: str = Field(min_length=4, max_length=16)


@app.post("/api/pair/start")
def pair_start(user: User = Depends(current_user), db: Session = Depends(get_db)):
    # 이전 코드 무효화 후 새 코드 발급 (사용자당 활성 코드 1개)
    db.query(PairCode).filter_by(user_id=user.id, used=False).update({"used": True})
    code = "".join(secrets.choice(PAIR_ALPHABET) for _ in range(6))
    while db.query(PairCode).filter_by(code=code, used=False).first():
        code = "".join(secrets.choice(PAIR_ALPHABET) for _ in range(6))
    db.add(PairCode(code=code, user_id=user.id,
                    expires_at=datetime.utcnow() + timedelta(minutes=10)))
    db.commit()
    return {"code": code, "expires_in_sec": 600}


# 연결 코드 무차별 대입 방어: IP당 10분 창에 10회 시도 제한 (인메모리 — 단일 인스턴스 전제)
_claim_attempts: dict[str, list[float]] = {}


def _rate_limit_claim(ip: str):
    import time
    now = time.time()
    window = [t for t in _claim_attempts.get(ip, []) if now - t < 600]
    if len(window) >= 10:
        raise HTTPException(429, "시도가 너무 많습니다 — 10분 후 다시 시도하세요")
    window.append(now)
    _claim_attempts[ip] = window
    if len(_claim_attempts) > 10000:  # 메모리 상한
        _claim_attempts.clear()


@app.post("/api/pair/claim")
def pair_claim(body: PairClaimIn, request: Request, db: Session = Depends(get_db)):
    ip = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip() or \
         (request.client.host if request.client else "unknown")
    _rate_limit_claim(ip)
    row = db.query(PairCode).filter_by(code=body.code.strip().upper(), used=False).first()
    if row is None or row.expires_at < datetime.utcnow():
        raise HTTPException(400, "연결 코드가 유효하지 않거나 만료됐습니다 — 포탈에서 새 코드를 발급받으세요")
    row.used = True
    user = db.get(User, row.user_id)
    if not user.upload_token:  # 기존 토큰이 있으면 유지 (다른 기기 연결이 안 끊기게)
        user.upload_token = "acv_" + secrets.token_urlsafe(24)
    db.commit()
    return {"upload_token": user.upload_token, "handle": user.handle,
            "visibility": "public" if (user.handle and user.is_public) else "private"}


@app.get("/api/handle/check")
def handle_check(handle: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """토큰명 실시간 중복 확인 — 대시보드 입력 중 피드백용."""
    h = handle.lower().strip()
    if not HANDLE_RE.match(h) or h in RESERVED:
        return {"available": False, "reason": "형식 오류 — 영소문자·숫자·하이픈 3~30자"}
    taken = db.query(User).filter(User.handle == h, User.id != user.id).first()
    if taken:
        return {"available": False, "reason": "이미 사용 중인 토큰명입니다"}
    return {"available": True, "reason": "사용 가능"}


@app.post("/api/uploader/token")
def issue_token(user: User = Depends(current_user), db: Session = Depends(get_db)):
    user.upload_token = "acv_" + secrets.token_urlsafe(24)
    db.commit()
    return {"upload_token": user.upload_token}


# ── 업로드 (MCP → 서버) ─────────────────────────────────────
@app.post("/api/evidence")
def upload_evidence(pack: dict, user: User = Depends(uploader_user),
                    db: Session = Depends(get_db)):
    if pack.get("schema_version") != 1:
        raise HTTPException(400, "지원하지 않는 schema_version 입니다")
    # 프라이버시: 실경로가 포함된 팩은 서버에 받지 않는다
    red = pack.get("redaction") or {}
    if red.get("projects") == "reveal" or any("path" in p for p in pack.get("projects", [])):
        raise HTTPException(400, "실제 경로가 포함된 팩은 업로드할 수 없습니다 (reveal_projects=false로 다시 수집하세요)")
    pack.pop("case_candidates", None)  # 세션 제목은 로컬 전용 — 서버에 저장하지 않는다
    date = ((pack.get("window") or {}).get("to") or "")[:10]
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
        raise HTTPException(400, "window.to 날짜가 올바르지 않습니다")
    # skill_groups(스킬 묶음+설명)는 이력서 발행 때만 함께 오므로,
    # 자동 동기화 팩에 없으면 마지막 팩의 것을 이어받는다 — 자산 섹션이 퇴화하지 않게.
    if not (pack.get("extensions") or {}).get("skill_groups"):
        prev = (db.query(Evidence).filter_by(user_id=user.id)
                .order_by(Evidence.date.desc()).first())
        if prev:
            try:
                prev_groups = (json.loads(prev.pack).get("extensions") or {}).get("skill_groups")
                if prev_groups:
                    pack.setdefault("extensions", {})["skill_groups"] = prev_groups
            except Exception:
                pass
    raw = json.dumps(pack, ensure_ascii=False)
    if len(raw) > 1_000_000:
        raise HTTPException(413, "팩이 너무 큽니다 (1MB 제한)")
    row = db.query(Evidence).filter_by(user_id=user.id, date=date).first()
    if row:
        row.pack, row.uploaded_at = raw, datetime.utcnow()
    else:
        db.add(Evidence(user_id=user.id, date=date, pack=raw))
    # 스냅샷 이력 90개 초과 시 오래된 것 정리
    old = (db.query(Evidence).filter_by(user_id=user.id)
           .order_by(Evidence.date.desc()).offset(90).all())
    for o in old:
        db.delete(o)
    db.commit()
    return {"ok": True, "date": date,
            "profile": f"/r/{user.handle}" if user.handle and user.is_public else None,
            "handle": user.handle,
            "visibility": "public" if (user.handle and user.is_public) else
                          ("private" if user.handle else "no_handle")}


@app.post("/api/resume")
def upload_resume(body: ResumeIn, user: User = Depends(uploader_user),
                  db: Session = Depends(get_db)):
    row = db.query(Resume).filter_by(user_id=user.id, format=body.format).first()
    if row:
        row.markdown, row.updated_at = body.markdown, datetime.utcnow()
    else:
        db.add(Resume(user_id=user.id, format=body.format, markdown=body.markdown))
    db.commit()
    return {"ok": True, "format": body.format,
            "visibility": "public" if (user.handle and user.is_public) else
                          ("private" if user.handle else "no_handle")}


# ── 마크다운 → HTML (제한 렌더러) ───────────────────────────
# 원문을 먼저 전부 이스케이프한 뒤 우리가 아는 구문만 되살린다 — 스크립트 주입 불가.
_INLINE = [
    (re.compile(r"\*\*([^*]+)\*\*"), r"<b>\1</b>"),
    (re.compile(r"(?<!\*)\*([^*]+)\*(?!\*)"), r"<i>\1</i>"),
    (re.compile(r"`([^`]+)`"), r"<code>\1</code>"),
    # 링크는 http(s)만 허용 (이스케이프 후라 따옴표 주입 불가)
    (re.compile(r"\[([^\]]+)\]\((https?://[^)\s]+)\)"),
     r'<a href="\2" rel="noopener nofollow" target="_blank">\1</a>'),
]


def _inline(s: str) -> str:
    for pat, rep in _INLINE:
        s = pat.sub(rep, s)
    return s


def md_to_html(md: str) -> str:
    lines = html.escape(md).replace("\r\n", "\n").split("\n")
    out, i, n = [], 0, len(lines)
    in_list = False

    def close_list():
        nonlocal in_list
        if in_list:
            out.append("</ul>")
            in_list = False

    while i < n:
        line = lines[i]
        s = line.strip()
        if s.startswith("```"):
            close_list()
            block = []
            i += 1
            while i < n and not lines[i].strip().startswith("```"):
                block.append(lines[i])
                i += 1
            out.append("<pre>" + "\n".join(block) + "</pre>")
        elif s.startswith("|") and i + 1 < n and re.match(r"^\|[\s:|-]+\|$", lines[i + 1].strip()):
            close_list()
            header = [c.strip() for c in s.strip("|").split("|")]
            out.append("<table><thead><tr>" +
                       "".join(f"<th>{_inline(c)}</th>" for c in header) +
                       "</tr></thead><tbody>")
            i += 2
            while i < n and lines[i].strip().startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                out.append("<tr>" + "".join(f"<td>{_inline(c)}</td>" for c in cells) + "</tr>")
                i += 1
            out.append("</tbody></table>")
            continue
        elif s.startswith("###"):
            close_list()
            out.append(f"<h4>{_inline(s.lstrip('#').strip())}</h4>")
        elif s.startswith("##"):
            close_list()
            out.append(f"<h3>{_inline(s.lstrip('#').strip())}</h3>")
        elif s.startswith("#"):
            close_list()
            out.append(f"<h2>{_inline(s.lstrip('#').strip())}</h2>")
        elif s.startswith("&gt;"):
            close_list()
            quote = []
            while i < n and lines[i].strip().startswith("&gt;"):
                quote.append(_inline(lines[i].strip()[4:].strip()))
                i += 1
            out.append("<blockquote>" + "<br>".join(quote) + "</blockquote>")
            continue
        elif re.match(r"^[-*] ", s):
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append(f"<li>{_inline(s[2:])}</li>")
        elif re.match(r"^([-*_])\1\1+$", s):
            close_list()
            out.append("<hr>")
        elif s:
            close_list()
            out.append(f"<p>{_inline(s)}</p>")
        i += 1
    close_list()
    return "\n".join(out)


# ── 관리자 ──────────────────────────────────────────────────
def admin_user(user: User = Depends(current_user)) -> User:
    if user.email.lower() not in ADMIN_EMAILS:
        raise HTTPException(403, "관리자 권한이 없습니다")
    return user


@app.get("/api/admin/overview")
def admin_overview(user: User = Depends(admin_user), db: Session = Depends(get_db)):
    now = datetime.utcnow()
    week_ago = now - timedelta(days=7)
    users = db.query(User).order_by(User.created_at.desc()).all()
    last_ev = dict(db.query(Evidence.user_id, Evidence.date)
                   .order_by(Evidence.date.asc()).all())  # 뒤가 최신으로 덮임
    resume_users = {r.user_id for r in db.query(Resume.user_id).distinct()}
    return {
        "totals": {
            "users": len(users),
            "public_profiles": sum(1 for u in users if u.is_public),
            "connected": sum(1 for u in users if u.upload_token),
            "with_resume": len(resume_users),
            "new_users_7d": sum(1 for u in users if u.created_at and u.created_at >= week_ago),
            "uploads_7d": db.query(Evidence).filter(Evidence.uploaded_at >= week_ago).count(),
        },
        "users": [{
            "email": u.email, "handle": u.handle, "is_public": u.is_public,
            "connected": bool(u.upload_token),
            "created_at": u.created_at.isoformat()[:10] if u.created_at else None,
            "last_upload": last_ev.get(u.id),
            "has_resume": u.id in resume_users,
        } for u in users[:200]],
    }


@app.get("/admin", include_in_schema=False)
def admin_page():
    return FileResponse(STATIC_DIR / "admin.html")


@app.get("/api/resume")
def get_resume(format: str | None = None, user: User = Depends(uploader_user),
               db: Session = Depends(get_db)):
    """현재 발행된 이력서 조회 — 부분 수정 후 재발행하는 흐름의 시작점."""
    q = db.query(Resume).filter_by(user_id=user.id)
    if format:
        q = q.filter_by(format=format)
    row = q.order_by(Resume.updated_at.desc()).first()
    if row is None:
        raise HTTPException(404, "발행된 이력서가 없습니다 — 먼저 이력서를 생성해 발행하세요")
    return {"format": row.format, "markdown": row.markdown,
            "updated_at": row.updated_at.isoformat()}


# ── 공개 프로필 ─────────────────────────────────────────────
RUBRIC_LABEL = {
    "verification": "검증 습관", "context_design": "컨텍스트 설계",
    "automation": "자동화", "tooling_extension": "도구 확장",
    "cost_efficiency": "비용 효율",
}


def _fmt_tok(n: int) -> str:
    if n >= 1_000_000_000:
        return f"{n / 1e9:.1f}B"
    if n >= 1_000_000:
        return f"{n / 1e6:.1f}M"
    return f"{n:,}"


@app.get("/r/{handle}", response_class=HTMLResponse)
def profile(handle: str, db: Session = Depends(get_db)):
    user = db.query(User).filter_by(handle=handle.lower(), is_public=True).first()
    if user is None:
        raise HTTPException(404, "공개된 프로필이 없습니다")
    rows = (db.query(Evidence).filter_by(user_id=user.id)
            .order_by(Evidence.date.desc()).limit(30).all())
    if not rows:
        raise HTTPException(404, "아직 업로드된 데이터가 없습니다")
    pack = json.loads(rows[0].pack)
    # 가장 최근에 업로드된 이력서를 표시 (양식 무관 — 마지막 발행이 곧 현재 이력서)
    resume = (db.query(Resume).filter_by(user_id=user.id)
              .order_by(Resume.updated_at.desc()).first())

    e = html.escape
    # 하이라이트·rubric 바·사용량 카드는 프로필에 노출하지 않는다 —
    # "많이 썼다" 계열 숫자는 채용 관점에서 판단 근거가 아니고, 로그 기반 신뢰는 상단 배지가 담당.

    # 직접 만든 자동화 자산 — "쓰는 사람"이 아니라 "만들어 쓰는 사람"임을 보여주는 구간.
    # 발행 시 호스트 LLM이 넘긴 skill_groups(비슷한 스킬 묶음 + 한 줄 설명)가 있으면 그걸 쓰고,
    # 없으면 이름 나열로 폴백.
    ext = pack.get("extensions") or {}
    authored = [s for s in ext.get("custom_skills", []) if s.get("authored")]
    mcp_servers = ext.get("mcp_servers_configured", [])
    groups = ext.get("skill_groups") or []
    assets = ""
    if groups:
        rows_html = ""
        for g in groups[:8]:
            if not isinstance(g, dict):
                continue
            pills = "".join(f'<span class="pill{" mcp" if g.get("kind") == "mcp" else ""}">{e(str(i))}</span>'
                            for i in (g.get("items") or [])[:12])
            rows_html += (f'<div class="asset-group"><div class="asset-head">'
                          f'<b>{e(str(g.get("title", "")))}</b>'
                          f'<span>{e(str(g.get("description", "")))}</span></div>'
                          f'<div class="pills">{pills}</div></div>')
        assets = ('<div class="sec"><h2>직접 만든 자동화 자산</h2>'
                  '<p class="asset-lead">반복 업무를 프롬프트가 아닌 재사용 도구로 만들어 씁니다.</p>'
                  + rows_html + "</div>")
    elif authored or mcp_servers:
        parts = []
        if authored:
            pills = "".join(f'<span class="pill">{e(s["name"])}</span>' for s in authored[:12])
            parts.append(
                f'<p class="asset-lead">커스텀 스킬 <b>{len(authored)}종</b>을 직접 작성·실전 운영.</p>'
                f'<div class="pills">{pills}</div>')
        if mcp_servers:
            names = "".join(f'<span class="pill mcp">{e(s.get("name", ""))}</span>' for s in mcp_servers[:8])
            parts.append(
                f'<p class="asset-lead">MCP 서버 <b>{len(mcp_servers)}개</b>를 직접 개발·구성해 운영합니다.</p>'
                f'<div class="pills">{names}</div>')
        assets = ('<div class="sec"><h2>직접 만든 자동화 자산</h2>' + "".join(parts) + "</div>")

    # 기술 스택 — 로그의 파일 터치에서 자동 집계된 언어를 도메인별로 묶어 표시 (발행마다 자동 갱신)
    STACK_DOMAIN = {
        "Java": "백엔드", "Kotlin": "백엔드", "Python": "백엔드", "Go": "백엔드",
        "Rust": "백엔드", "Ruby": "백엔드", "PHP": "백엔드", "C#": "백엔드",
        "JavaScript": "프론트엔드", "TypeScript": "프론트엔드", "HTML": "프론트엔드",
        "CSS": "프론트엔드", "Vue": "프론트엔드",
        "SQL": "데이터",
        "Shell": "인프라", "PowerShell": "인프라", "Terraform": "인프라",
        "Gradle": "인프라", "YAML": "인프라", "Docker": "인프라",
    }
    DOMAIN_ORDER = ["백엔드", "프론트엔드", "데이터", "인프라"]
    by_domain: dict[str, list[str]] = {}
    for lang in (pack.get("stack") or {}).get("languages", []):
        label = lang.get("label", "")
        dom = STACK_DOMAIN.get(label)
        if dom and label not in by_domain.get(dom, []):
            by_domain.setdefault(dom, []).append(label)
    stack_html = ""
    if by_domain:
        rows_html = ""
        for dom in DOMAIN_ORDER:
            if dom not in by_domain:
                continue
            pills = "".join(f'<span class="pill">{e(l)}</span>' for l in by_domain[dom][:8])
            rows_html += (f'<div class="asset-group"><div class="asset-head"><b>{dom}</b></div>'
                          f'<div class="pills">{pills}</div></div>')
        stack_html = ('<div class="sec"><h2>기술 스택 <small>(사용 로그에서 자동 집계)</small></h2>'
                      + rows_html + "</div>")

    md = ""
    if resume:
        # 이력서 본문의 '상세 사용 이력' 링크는 외부 붙여넣기용 — 자기 프로필 페이지에선 자기참조라 제거
        own_url = f"aicv.tokenbill.my/r/{user.handle}"
        body = "\n".join(l for l in resume.markdown.splitlines() if own_url not in l)
        md = f'<div class="sec md-body"><h2>이력서</h2>{md_to_html(body)}</div>'

    win = pack.get("window", {})
    # OG 설명: 직접 만든 자산 요약 (사용량 숫자는 쓰지 않는다)
    made = []
    if authored:
        made.append(f"커스텀 스킬 {len(authored)}종")
    if mcp_servers:
        made.append(f"MCP 서버 {len(mcp_servers)}개")
    og_desc = ((" · ".join(made) + " 직접 제작·운영 — " if made else "") +
               "로컬 AI 사용 로그로 증명된 AI 활용 능력")
    og_url = f"https://aicv.tokenbill.my/r/{user.handle}"
    return f"""<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(user.handle)} — AICV</title>
<meta name="description" content="{e(og_desc)}">
<meta property="og:type" content="profile">
<meta property="og:site_name" content="AICV">
<meta property="og:title" content="{e(user.handle)}의 AI 활용 능력 — AICV">
<meta property="og:description" content="{e(og_desc)}">
<meta property="og:url" content="{e(og_url)}">
<meta property="og:locale" content="ko_KR">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="{e(user.handle)}의 AI 활용 능력 — AICV">
<meta name="twitter:description" content="{e(og_desc)}">
<link rel="canonical" href="{e(og_url)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&display=swap">
<style>
body{{font-family:'IBM Plex Sans KR','Apple SD Gothic Neo','Malgun Gothic',system-ui,sans-serif;
 max-width:720px;margin:0 auto;padding:32px 20px;background:#f9f9f7;color:#0b0b0b}}
a{{color:#1c5cab}} h1{{margin:0 0 4px}} small{{color:#898781;font-weight:400}}
.badge{{display:inline-block;background:#fcfcfb;border:1px solid rgba(11,11,11,.14);color:#1c5cab;
 border-radius:20px;padding:2px 12px;font-size:13px;margin:6px 0}}
.stats{{display:flex;gap:12px;margin:20px 0;flex-wrap:wrap}}
.stat{{background:#fcfcfb;border:1px solid rgba(11,11,11,.1);border-radius:10px;padding:12px 18px;
 display:flex;flex-direction:column;min-width:90px}}
.stat b{{font-size:20px}} .stat span{{color:#898781;font-size:12px}}
.sec{{margin:28px 0}} h2{{font-size:17px;border-bottom:1px solid #e1e0d9;padding-bottom:6px}}
.row{{display:flex;align-items:center;gap:10px;margin:8px 0}}
.lb{{width:110px;font-size:14px;color:#52514e}} .sc{{width:32px;text-align:right;font-weight:600}}
.bar{{flex:1;height:10px;background:#f0efec;border-radius:6px;overflow:hidden}}
.fill{{height:100%;background:linear-gradient(90deg,#2a78d6,#5b8fe0);border-radius:6px}}
ul{{padding-left:20px}} li{{margin:6px 0}}
.spark{{width:100%;height:64px}} .spark polyline{{fill:none;stroke:#2a78d6;stroke-width:2}}
.md-body{{background:#fcfcfb;border:1px solid rgba(11,11,11,.1);border-radius:10px;padding:6px 20px 16px;
 font-size:14px;line-height:1.7}}
.md-body>h2{{margin:14px -20px 10px;padding:0 20px 6px}}
.md-body h2:not(:first-child),.md-body h3{{font-size:16px;margin:20px 0 8px;color:#3a3a36;
 border:0;padding:0}}
.md-body h4{{font-size:14px;margin:14px 0 6px}}
.md-body blockquote{{margin:10px 0;padding:8px 14px;border-left:3px solid #2a78d6;
 background:#f0efec;border-radius:0 8px 8px 0;color:#52514e;font-size:13px}}
.md-body table{{border-collapse:collapse;width:100%;margin:10px 0;font-size:13px;display:block;
 overflow-x:auto}}
.md-body th,.md-body td{{border:1px solid #e1e0d9;padding:6px 10px;text-align:left}}
.md-body th{{background:#f0efec}}
.md-body code{{background:#f0efec;border:1px solid #e1e0d9;border-radius:4px;padding:1px 5px;
 font-size:12px}}
.md-body pre{{background:#f0efec;border:1px solid #e1e0d9;border-radius:8px;padding:12px;
 overflow-x:auto;font-size:12px}}
.md-body hr{{border:0;border-top:1px solid #e1e0d9;margin:16px 0}}
.md-body p{{margin:8px 0}}
.caveat li{{color:#898781;font-size:13px}}
.asset-lead{{margin:12px 0 8px;font-size:14px;color:#3a3a36}}
.pills{{display:flex;flex-wrap:wrap;gap:8px}}
.pill{{background:#f0efec;border:1px solid rgba(11,11,11,.12);border-radius:16px;padding:4px 12px;
 font-size:13px;color:#0b0b0b}}
.pill em{{font-style:normal;color:#1c5cab;margin-left:6px;font-size:12px}}
.pill.mcp{{border-color:#cabcf0;background:#f1ecfa;color:#5b3fa8}}
.asset-group{{margin:14px 0}}
.asset-head{{margin-bottom:8px;font-size:14px}}
.asset-head b{{color:#0b0b0b}}
.asset-head span{{color:#898781;margin-left:10px;font-size:13px}}
footer{{margin-top:40px;color:#898781;font-size:13px;border-top:1px solid #e1e0d9;padding-top:14px}}
</style></head><body>
<h1>{e(user.handle)} <small>의 AI 활용 능력</small></h1>
<div class="badge">🔍 로컬 사용 로그 기반 · {e(win.get('from', ''))} ~ {e(win.get('to', ''))} · schema v{pack.get('schema_version', 1)}</div>
{assets}
{stack_html}
{md}
<footer>로컬 AI 사용 로그에서 자동 집계된 내용입니다 (기록 보존 기간에 따라 일부 누락 가능) ·
AICV — 실제 작업 로그가 역량을 증명합니다 · <a href="/">나도 만들기</a></footer>
</body></html>"""


# ── 정적 파일 ───────────────────────────────────────────────
@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/privacy", include_in_schema=False)
def privacy():
    return FileResponse(STATIC_DIR / "privacy.html")


@app.get("/terms", include_in_schema=False)
def terms():
    return FileResponse(STATIC_DIR / "terms.html")
