"""인증(JWT, 비밀번호 해시)과 API 키 암호화."""
import base64
import hashlib
import os
from datetime import datetime, timedelta

import bcrypt as _bcrypt
import jwt
from cryptography.fernet import Fernet
from fastapi import Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session

from .db import get_db
from . import models

SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-change-me")
JWT_ALG = "HS256"
TOKEN_TTL_HOURS = 24 * 14

bearer = HTTPBearer(auto_error=False)

# SECRET_KEY에서 Fernet 키 유도 — 운영에서는 SECRET_KEY를 반드시 환경변수로 설정할 것
_fernet = Fernet(base64.urlsafe_b64encode(hashlib.sha256(SECRET_KEY.encode()).digest()))


def hash_password(pw: str) -> str:
    return _bcrypt.hashpw(pw.encode()[:72], _bcrypt.gensalt()).decode()


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return _bcrypt.checkpw(pw.encode()[:72], hashed.encode())
    except ValueError:
        return False


def encrypt_key(api_key: str) -> str:
    return _fernet.encrypt(api_key.encode()).decode()


def decrypt_key(token: str) -> str:
    return _fernet.decrypt(token.encode()).decode()


def mask_key(api_key: str) -> str:
    if len(api_key) <= 12:
        return api_key[:3] + "…"
    return api_key[:7] + "…" + api_key[-4:]


def create_token(user_id: int) -> str:
    payload = {"sub": str(user_id), "exp": datetime.utcnow() + timedelta(hours=TOKEN_TTL_HOURS)}
    return jwt.encode(payload, SECRET_KEY, algorithm=JWT_ALG)


def current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> models.User:
    if creds is None:
        raise HTTPException(401, "로그인이 필요합니다")
    try:
        payload = jwt.decode(creds.credentials, SECRET_KEY, algorithms=[JWT_ALG])
        user_id = int(payload["sub"])
    except Exception:
        raise HTTPException(401, "유효하지 않은 토큰입니다")
    user = db.get(models.User, user_id)
    if user is None:
        raise HTTPException(401, "사용자를 찾을 수 없습니다")
    return user
