# Tokenbill — Podman/Docker 공용 이미지
FROM python:3.12-slim

# 보안: 비루트 사용자로 실행
RUN useradd -m -u 1000 app

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY static ./static

# SQLite DB를 볼륨으로 분리하기 위한 데이터 디렉터리
RUN mkdir -p /data && chown app:app /data
ENV DATABASE_URL=sqlite:////data/tokenbill.db

USER app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
