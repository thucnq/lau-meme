"""Roll the current graph version back (AC-GRAPH-06/07): `python -m lau_meme_pipeline.rollback [--version N]`.

The Worker decides and does the switch (`POST <API_BASE_URL>/api/pipeline/rollback`, ADR 0003);
this module only reports.
"""

import argparse
import json
import os
import sys
from dataclasses import dataclass
from typing import Protocol

from lau_meme_pipeline.batch import open_connection, parse_api_url


@dataclass(frozen=True)
class RollbackOutcome:
    ok: bool
    version: int | None
    message: str


class RollbackClient(Protocol):
    def post_rollback(self, version: int | None) -> tuple[int, dict]: ...


class HttpRollbackClient:
    """Network adapter: the Worker API over HTTPS (http only to localhost) with the pipeline token (GitHub Secret)."""

    def __init__(self, base_url: str, token: str) -> None:
        self.tls, self.host, self.port, self.prefix = parse_api_url(base_url)  # prefix e.g. "/lau-meme" (ADR 0007)
        self.token = token

    def post_rollback(self, version: int | None) -> tuple[int, dict]:
        body = json.dumps({} if version is None else {"version": version})
        conn = open_connection(self.tls, self.host, self.port)
        try:
            conn.request(
                "POST",
                self.prefix + "/api/pipeline/rollback",
                body=body,
                headers={
                    "Authorization": f"Bearer {self.token}",
                    "Content-Type": "application/json",
                    "User-Agent": "lau-meme-pipeline",
                },
            )
            res = conn.getresponse()
            raw = res.read()
        finally:
            conn.close()
        try:
            return res.status, json.loads(raw or b"{}")
        except ValueError:
            return res.status, {}


def run_rollback(client: RollbackClient, version: int | None) -> RollbackOutcome:
    status, body = client.post_rollback(version)
    if status == 200:
        target = body.get("rollback_to")
        return RollbackOutcome(ok=True, version=target, message=f"Đã rollback: version hiện hành là {target}.")
    title = body.get("title") or "lỗi không rõ"
    return RollbackOutcome(
        ok=False, version=None, message=f"Rollback thất bại (HTTP {status}): {title}. Bản hiện hành không đổi."
    )


def main(argv: list[str], client: RollbackClient | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m lau_meme_pipeline.rollback", description="Rollback graph")
    parser.add_argument("--version", type=int, default=None, help="version muốn quay về (mặc định: bản trước)")
    args = parser.parse_args(argv)
    if client is None:
        client = HttpRollbackClient(os.environ["API_BASE_URL"], os.environ["PIPELINE_TOKEN"])
    outcome = run_rollback(client, args.version)
    print(outcome.message)
    return 0 if outcome.ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
