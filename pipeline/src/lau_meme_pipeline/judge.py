"""Humour judge (AC-PIPE-09): keep recipes the LLM scored 3–5 on the rubric; anything unreadable is dropped."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

MIN_SCORE = 3


@dataclass
class JudgeResult:
    kept: list[dict] = field(default_factory=list)
    rejected: dict[str, str] = field(default_factory=dict)


def judge(recipes: Sequence[Mapping], scores: Mapping[str, object]) -> JudgeResult:
    result = JudgeResult()
    for r in recipes:
        score = scores.get(r["id"]) if isinstance(scores, Mapping) else None
        if not isinstance(score, int) or isinstance(score, bool) or not 1 <= score <= 5:
            result.rejected[r["id"]] = "unreadable"
        elif score < MIN_SCORE:
            result.rejected[r["id"]] = "low_score"
        else:
            result.kept.append({**r, "score": score})
    return result
