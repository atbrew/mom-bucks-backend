"""Low-level FirestoreClient tests.

Focused on behaviours that are easy to regress and hard to spot from a
CLI-level test — URL encoding in upload_file is the current motivator.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from mb.client import FirestoreClient, ProjectConfig


def _client() -> FirestoreClient:
    config = ProjectConfig(
        project_id="proj",
        api_key="k",
        api_key_env="X",
        region="us-central1",
    )
    return FirestoreClient(config, id_token="tok", uid="u1")


def test_upload_file_passes_object_name_through_params(tmp_path):
    """upload_file must hand the object name to requests via `params=`
    (which handles URL-encoding correctly) rather than string-mangling
    the URL itself. Regression for the old `.replace("/", "%2F")`
    that left spaces, `#`, `%`, etc. unescaped.

    We feed a path containing a space and `#` — if those leak into the
    URL unencoded, the upload will hit the wrong object (or 400).
    """
    local = tmp_path / "hello.jpg"
    local.write_bytes(b"\xff\xd8\xff\xd9")  # minimal JPEG-ish bytes
    storage_path = "users/u1/my photo#1/profile.jpg"

    fake_resp = MagicMock(status_code=200)
    with patch("mb.client.requests.post", return_value=fake_resp) as post:
        client = _client()
        returned = client.upload_file(storage_path, str(local))

    assert returned == storage_path
    assert post.call_count == 1
    _, kwargs = post.call_args
    # Object name is in params, not inlined in the URL.
    assert kwargs["params"]["name"] == storage_path
    assert kwargs["params"]["uploadType"] == "media"
    # The URL itself must not contain the raw storage_path (which
    # would have happened with the old string replace).
    called_url = post.call_args.args[0]
    assert "my photo" not in called_url
    assert "#1" not in called_url
