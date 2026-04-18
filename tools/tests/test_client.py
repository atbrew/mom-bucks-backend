"""Low-level FirestoreClient tests.

Focused on behaviours that are easy to regress and hard to spot from a
CLI-level test — URL encoding in upload_file is the current motivator.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from mb.client import FirestoreClient, ProjectConfig, get_project_config


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


def test_emu_project_alias_routes_every_endpoint_to_localhost():
    """The `emu` alias is load-bearing: it must point every one of the
    four REST endpoints (Auth, Firestore, callables, Storage) at the
    local emulator suite. If any one of them leaks to a `*.googleapis.com`
    host, a developer thinking they're exercising the emulator would
    silently hit the live dev project — wasting quota and, worse,
    producing misleading test results.
    """
    config = get_project_config("emu")
    assert config.emulator is True
    assert config.project_id == "mom-bucks-dev-b3772"
    # Auth emulator wraps the real API path under its own origin.
    assert config.auth_url_base.startswith("http://localhost:9099/")
    assert "identitytoolkit.googleapis.com" in config.auth_url_base
    # Firestore emulator prefixes `/v1/projects/...` under its own host.
    assert config.firestore_url.startswith(
        "http://localhost:8080/v1/projects/mom-bucks-dev-b3772"
    )
    # Callables: emulator URL shape is `host/project/region`, not
    # `region-project.cloudfunctions.net` — regression guard for that
    # divergence.
    assert (
        config.functions_url
        == "http://localhost:5005/mom-bucks-dev-b3772/us-central1"
    )
    # Storage: plain host swap is enough, no path prefix.
    assert config.storage_url_base == "http://localhost:9199"
    # API key is not required in emulator mode — `require_api_key`
    # returns a sentinel string so the Auth REST call still has a
    # non-empty query param.
    assert config.require_api_key() == "fake-emulator-key"


def test_prod_and_dev_aliases_still_point_at_google_hosts():
    """Complement to the emu test — prove the two live aliases are
    untouched by the emulator branches (no accidental localhost leak)."""
    for alias in ("dev", "prod"):
        config = get_project_config(alias)
        assert config.emulator is False
        assert config.auth_url_base == "https://identitytoolkit.googleapis.com/v1"
        assert config.firestore_url.startswith(
            "https://firestore.googleapis.com/v1/projects/"
        )
        assert config.functions_url.endswith(".cloudfunctions.net")
        assert config.storage_url_base == "https://firebasestorage.googleapis.com"
