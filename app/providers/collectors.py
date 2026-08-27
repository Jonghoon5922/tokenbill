"""프로바이더별 사용량 수집기.

각 수집기는 (api_key, start, end)를 받아
[{"day": date, "model": str, "input_tokens": int, "output_tokens": int, "cost_usd": float}, …]
를 반환한다.

- OpenAI / Anthropic 모두 '조직 관리자(Admin) 키'가 필요하다 (일반 sk- 키로는 사용량 조회 불가).
- 키가 "demo"로 시작하면 실제 호출 없이 데모 데이터를 생성한다 (시연·개발용).
- 비용은 토큰 × 단가표(prices.py) 근사치다.
"""
from __future__ import annotations

import random
from datetime import date, datetime, timedelta, timezone

import httpx

from .prices import estimate_cost

UA = {"User-Agent": "tokenbill/0.1"}


class CollectError(Exception):
    """사용자에게 그대로 보여줄 수 있는 수집 실패 메시지."""


# ── 데모 데이터 ──────────────────────────────────────────────
DEMO_MODELS = {
    "openai": ["gpt-5.2", "gpt-5.2-mini", "o4"],
    "anthropic": ["claude-opus-4.5", "claude-sonnet-4.5", "claude-haiku-4.5"],
    "google": ["gemini-3-pro", "gemini-3-flash"],
}


def collect_demo(provider: str, start: date, end: date, seed: str = "demo") -> list[dict]:
    rng = random.Random(f"{provider}-{seed}")
    rows = []
    d = start
    while d <= end:
        weekend = d.weekday() >= 5
        for model in DEMO_MODELS.get(provider, ["demo-model"]):
            base = rng.uniform(0.2, 1.5) * (0.4 if weekend else 1.0)
            spike = rng.uniform(2.5, 4.0) if rng.random() > 0.96 else 1.0
            in_tok = int(base * spike * rng.uniform(0.3, 0.5) * 1e6)
            out_tok = int(base * spike * rng.uniform(0.05, 0.12) * 1e6)
            rows.append({
                "day": d, "model": model,
                "input_tokens": in_tok, "output_tokens": out_tok,
                "cost_usd": round(estimate_cost(model, in_tok, out_tok), 4),
            })
        d += timedelta(days=1)
    return rows


def _rescale_to_actual(rows: list[dict], actual_by_day: dict[date, float]) -> None:
    """모델별 근사 비용을 cost API 실측 일 총액에 맞게 비례 보정한다.

    usage API는 토큰만 주므로 모델별 비용은 단가표 근사인데,
    하루 합계를 실측값으로 스케일링하면 '합계 = 청구 금액'이 보장된다.
    실측이 없는 날은 근사값을 그대로 둔다.
    """
    if not actual_by_day:
        return
    est_by_day: dict[date, float] = {}
    for r in rows:
        est_by_day[r["day"]] = est_by_day.get(r["day"], 0.0) + r["cost_usd"]
    for r in rows:
        actual = actual_by_day.get(r["day"])
        est = est_by_day.get(r["day"], 0.0)
        if actual is not None and est > 0:
            r["cost_usd"] = round(r["cost_usd"] * actual / est, 4)


# ── OpenAI ──────────────────────────────────────────────────
def _openai_daily_costs(client: httpx.Client, api_key: str, start_ts: int, end_ts: int) -> dict[date, float]:
    """OpenAI Costs API — 일 단위 실제 청구 금액. 실패하면 빈 dict(근사값 유지)."""
    headers = {"Authorization": f"Bearer {api_key}", **UA}
    params = {"start_time": start_ts, "end_time": end_ts, "bucket_width": "1d", "limit": 31}
    out: dict[date, float] = {}
    try:
        while True:
            r = client.get("https://api.openai.com/v1/organization/costs", params=params, headers=headers)
            if r.status_code != 200:
                return {}
            data = r.json()
            for bucket in data.get("data", []):
                d = datetime.fromtimestamp(bucket["start_time"], tz=timezone.utc).date()
                for item in bucket.get("results", []):
                    amt = (item.get("amount") or {}).get("value", 0) or 0
                    out[d] = out.get(d, 0.0) + float(amt)
            if data.get("has_more") and data.get("next_page"):
                params["page"] = data["next_page"]
            else:
                break
    except Exception:
        return {}
    return out


def collect_openai(api_key: str, start: date, end: date) -> list[dict]:
    """OpenAI Usage API (organization/usage/completions), 일 단위 × 모델별."""
    start_ts = int(datetime(start.year, start.month, start.day, tzinfo=timezone.utc).timestamp())
    end_ts = int(datetime(end.year, end.month, end.day, tzinfo=timezone.utc).timestamp()) + 86400
    rows: list[dict] = []
    params = {
        "start_time": start_ts, "end_time": end_ts,
        "bucket_width": "1d", "group_by": "model", "limit": 31,
    }
    headers = {"Authorization": f"Bearer {api_key}", **UA}
    url = "https://api.openai.com/v1/organization/usage/completions"
    with httpx.Client(timeout=30) as client:
        while True:
            r = client.get(url, params=params, headers=headers)
            if r.status_code == 401:
                raise CollectError("인증 실패 — 조직 Admin 키(sk-admin…)가 필요합니다")
            if r.status_code == 403:
                raise CollectError("권한 부족 — 키에 usage 읽기 권한이 없습니다")
            if r.status_code != 200:
                raise CollectError(f"OpenAI 응답 오류 (HTTP {r.status_code})")
            data = r.json()
            for bucket in data.get("data", []):
                d = datetime.fromtimestamp(bucket["start_time"], tz=timezone.utc).date()
                for item in bucket.get("results", []):
                    in_tok = item.get("input_tokens", 0) or 0
                    out_tok = item.get("output_tokens", 0) or 0
                    model = item.get("model") or "unknown"
                    if in_tok == 0 and out_tok == 0:
                        continue
                    rows.append({
                        "day": d, "model": model,
                        "input_tokens": in_tok, "output_tokens": out_tok,
                        "cost_usd": round(estimate_cost(model, in_tok, out_tok), 4),
                    })
            if data.get("has_more") and data.get("next_page"):
                params["page"] = data["next_page"]
            else:
                break
        # 실제 청구 금액으로 보정
        _rescale_to_actual(rows, _openai_daily_costs(client, api_key, start_ts, end_ts))
    return rows


# ── Anthropic ───────────────────────────────────────────────
def _anthropic_daily_costs(client: httpx.Client, headers: dict, start: date, end: date) -> dict[date, float]:
    """Anthropic cost_report — 일 단위 실제 청구 금액. 실패하면 빈 dict(근사값 유지)."""
    params = {
        "starting_at": f"{start.isoformat()}T00:00:00Z",
        "ending_at": f"{(end + timedelta(days=1)).isoformat()}T00:00:00Z",
        "bucket_width": "1d",
        "limit": 31,
    }
    out: dict[date, float] = {}
    try:
        while True:
            r = client.get("https://api.anthropic.com/v1/organizations/cost_report", params=params, headers=headers)
            if r.status_code != 200:
                return {}
            data = r.json()
            for bucket in data.get("data", []):
                d = datetime.fromisoformat(bucket["starting_at"].replace("Z", "+00:00")).date()
                for item in bucket.get("results", []):
                    out[d] = out.get(d, 0.0) + float(item.get("amount", 0) or 0)
            if data.get("has_more") and data.get("next_page"):
                params["page"] = data["next_page"]
            else:
                break
    except Exception:
        return {}
    return out
def collect_anthropic(api_key: str, start: date, end: date) -> list[dict]:
    """Anthropic Admin API usage_report/messages, 일 단위 × 모델별."""
    headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01", **UA}
    params = {
        "starting_at": f"{start.isoformat()}T00:00:00Z",
        "ending_at": f"{(end + timedelta(days=1)).isoformat()}T00:00:00Z",
        "bucket_width": "1d",
        "group_by[]": "model",
        "limit": 31,
    }
    url = "https://api.anthropic.com/v1/organizations/usage_report/messages"
    rows: list[dict] = []
    with httpx.Client(timeout=30) as client:
        while True:
            r = client.get(url, params=params, headers=headers)
            if r.status_code in (401, 403):
                raise CollectError("인증 실패 — Admin 키(sk-ant-admin…)가 필요합니다")
            if r.status_code != 200:
                raise CollectError(f"Anthropic 응답 오류 (HTTP {r.status_code})")
            data = r.json()
            for bucket in data.get("data", []):
                d = datetime.fromisoformat(bucket["starting_at"].replace("Z", "+00:00")).date()
                for item in bucket.get("results", []):
                    in_tok = (item.get("uncached_input_tokens", 0) or 0) + \
                             (item.get("cache_creation_input_tokens", 0) or 0) + \
                             (item.get("cache_read_input_tokens", 0) or 0)
                    out_tok = item.get("output_tokens", 0) or 0
                    model = item.get("model") or "unknown"
                    if in_tok == 0 and out_tok == 0:
                        continue
                    rows.append({
                        "day": d, "model": model,
                        "input_tokens": in_tok, "output_tokens": out_tok,
                        "cost_usd": round(estimate_cost(model, in_tok, out_tok), 4),
                    })
            if data.get("has_more") and data.get("next_page"):
                params["page"] = data["next_page"]
            else:
                break
        # 실제 청구 금액으로 보정
        _rescale_to_actual(rows, _anthropic_daily_costs(client, headers, start, end))
    return rows


# ── Google ──────────────────────────────────────────────────
def collect_google(api_key: str, start: date, end: date) -> list[dict]:
    raise CollectError("Google AI는 준비 중입니다 (Cloud Billing 연동 필요) — 데모 키(demo…)로 체험해 보세요")


COLLECTORS = {
    "openai": collect_openai,
    "anthropic": collect_anthropic,
    "google": collect_google,
}


def collect(provider: str, api_key: str, start: date, end: date) -> list[dict]:
    if api_key.lower().startswith("demo"):
        # 키 문자열을 시드로 써서 조직(키)마다 다른 데모 데이터를 생성
        return collect_demo(provider, start, end, seed=api_key)
    fn = COLLECTORS.get(provider)
    if fn is None:
        raise CollectError(f"지원하지 않는 프로바이더: {provider}")
    return fn(api_key, start, end)
