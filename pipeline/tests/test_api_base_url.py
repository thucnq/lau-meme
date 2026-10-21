"""API_BASE_URL: https for every real host; plain http only for a loopback Worker (`wrangler dev`, docs/dev/setup.md).

The network is mocked at the connection layer (http.client); nothing real is contacted.
"""

import http.client
import json

import pytest

FAKE_BEARER = "test-token-not-a-secret"


def install_fake_connections(monkeypatch) -> list[dict]:
    """Replace HTTPConnection and HTTPSConnection; record which one each request used."""
    seen: list[dict] = []

    def fake(kind: str):
        class FakeConnection:
            def __init__(self, host, port=None, *args, **kwargs):
                self.host, self.port = host, port

            def request(self, method, url, body=None, headers=None, **kwargs):
                seen.append({"kind": kind, "host": self.host, "port": self.port, "method": method, "path": url})

            def getresponse(self):
                class Res:
                    status = 200

                    def read(self, *args):
                        return json.dumps({"status": "rollback", "rollback_to": 1, "version": None}).encode()

                return Res()

            def close(self):
                pass

        return FakeConnection

    monkeypatch.setattr(http.client, "HTTPConnection", fake("http"))
    monkeypatch.setattr(http.client, "HTTPSConnection", fake("https"))
    return seen


@pytest.mark.parametrize("base_url", ["http://localhost:8787/lau-meme", "http://127.0.0.1:8787/lau-meme"])
def test_batch_client_allows_plain_http_to_loopback(monkeypatch, base_url):
    from lau_meme_pipeline.batch import HttpBatchClient

    seen = install_fake_connections(monkeypatch)
    HttpBatchClient(base_url, FAKE_BEARER).get_state()
    assert [(r["kind"], r["port"], r["path"]) for r in seen] == [("http", 8787, "/lau-meme/api/pipeline/state")]


def test_rollback_client_allows_plain_http_to_loopback(monkeypatch):
    from lau_meme_pipeline.rollback import HttpRollbackClient

    seen = install_fake_connections(monkeypatch)
    HttpRollbackClient("http://localhost:8787/lau-meme", FAKE_BEARER).post_rollback(None)
    assert [(r["kind"], r["path"]) for r in seen] == [("http", "/lau-meme/api/pipeline/rollback")]


@pytest.mark.parametrize("base_url", ["http://dinoduct.fun/lau-meme", "http://localhost.evil.example/lau-meme"])
def test_plain_http_to_a_real_host_is_refused(base_url):
    from lau_meme_pipeline.batch import HttpBatchClient
    from lau_meme_pipeline.rollback import HttpRollbackClient

    with pytest.raises(ValueError):
        HttpBatchClient(base_url, FAKE_BEARER)
    with pytest.raises(ValueError):
        HttpRollbackClient(base_url, FAKE_BEARER)


def test_https_still_uses_tls(monkeypatch):
    from lau_meme_pipeline.batch import HttpBatchClient

    seen = install_fake_connections(monkeypatch)
    HttpBatchClient("https://dinoduct.fun/lau-meme", FAKE_BEARER).get_state()
    assert seen[0]["kind"] == "https"
