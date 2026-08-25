"""모델별 단가표 ($ / 1M tokens).

프로바이더의 usage API는 토큰 수를 주고, 비용 API는 별도이거나 항목 매핑이 번거로워
MVP에서는 토큰 × 단가로 비용을 근사 계산한다. 단가가 바뀌면 여기만 수정하면 된다.
모르는 모델은 DEFAULT 단가를 쓰고 모델명 그대로 표시된다.
"""

# (input, output)
PRICES: dict[str, tuple[float, float]] = {
    # OpenAI
    "gpt-5.2": (1.75, 14.0),
    "gpt-5.2-mini": (0.35, 2.8),
    "gpt-5.1": (1.25, 10.0),
    "gpt-4.1": (2.0, 8.0),
    "gpt-4.1-mini": (0.4, 1.6),
    "gpt-4o": (2.5, 10.0),
    "o4": (2.5, 20.0),
    "o3": (2.0, 8.0),
    # Anthropic
    "claude-opus-4.5": (5.0, 25.0),
    "claude-sonnet-4.5": (3.0, 15.0),
    "claude-haiku-4.5": (1.0, 5.0),
    "claude-opus-4-1": (15.0, 75.0),
    "claude-sonnet-4": (3.0, 15.0),
    # Google
    "gemini-3-pro": (2.0, 12.0),
    "gemini-3-flash": (0.3, 2.5),
    "gemini-2.5-pro": (1.25, 10.0),
    "gemini-2.5-flash": (0.3, 2.5),
}
DEFAULT = (2.0, 8.0)


def estimate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    """모델명 부분 일치로 단가를 찾아 비용($)을 근사한다."""
    key = model.lower()
    price = None
    for name, p in PRICES.items():
        if key.startswith(name) or name in key:
            price = p
            break
    if price is None:
        price = DEFAULT
    return input_tokens / 1e6 * price[0] + output_tokens / 1e6 * price[1]
