"""Refresh the long-lived Threads token (AC-PIPE-19, ADR 0014): `python -m lau_meme_pipeline.threads_token`.

Reads THREADS_ACCESS_TOKEN, writes the new token to the file THREADS_TOKEN_OUT (mode 600) for the workflow to store as
a secret. The token rides in the request URL, so messages are built from the HTTP status or error type only: never
the URL, the exception text or the response body.
"""

import json
import os
import sys
from collections.abc import Mapping
from urllib.parse import quote

from lau_meme_pipeline.crawl import THREADS_GRAPH, Http, HttpStatus, http_get

REFRESH_URL = f"{THREADS_GRAPH}/refresh_access_token"
SECONDS_PER_DAY = 86400


def _refresh(http: Http, token: str) -> tuple[str, int] | str:
    """(new token, seconds left), or the error text shown after "gia hạn lỗi"."""
    try:
        body = http.text(f"{REFRESH_URL}?grant_type=th_refresh_token&access_token={quote(token)}")
    except HttpStatus as exc:
        return str(exc.status)
    except Exception as exc:
        return type(exc).__name__
    try:
        answer = json.loads(body)
    except ValueError:
        return "phản hồi không phải JSON"
    new_token = answer.get("access_token") if isinstance(answer, dict) else None
    if not isinstance(new_token, str) or not new_token:
        return "thiếu access_token"
    expires_in = answer.get("expires_in")
    return new_token, expires_in if isinstance(expires_in, int) else 0


def _write_secret(path: str, token: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)  # an existing file keeps its old mode otherwise
        os.write(fd, token.encode())
    except OSError:
        os.close(fd)
        os.unlink(path)  # no half-written file: the workflow stores a secret only when the file exists
        raise
    os.close(fd)


def main(env: Mapping[str, str], http: Http) -> int:
    token = env.get("THREADS_ACCESS_TOKEN", "")
    if not token:
        print("Threads token: thiếu cấu hình, bỏ qua")
        return 0
    out = env.get("THREADS_TOKEN_OUT", "")
    if not out:
        print("Threads token: gia hạn lỗi thiếu THREADS_TOKEN_OUT")
        return 1
    result = _refresh(http, token)
    if isinstance(result, str):
        print(f"Threads token: gia hạn lỗi {result}")
        return 1
    new_token, expires_in = result
    try:
        _write_secret(out, new_token)
    except OSError as exc:
        print(f"Threads token: gia hạn lỗi {type(exc).__name__}")
        return 1
    print(f"Threads token: đã gia hạn, còn {expires_in // SECONDS_PER_DAY} ngày")
    return 0


if __name__ == "__main__":
    sys.exit(main(os.environ, Http(http_get)))
