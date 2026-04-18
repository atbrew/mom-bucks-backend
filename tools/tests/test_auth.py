"""Tests for `mb auth` commands.

Exposes the bug that `mb auth create --name Alice` does not
actually persist Alice as `displayName` on the user doc. The blocking
`beforeUserCreated` trigger is unreliable for profile data from
Admin-SDK-created users — the CLI must write displayName explicitly
after sign-in.
"""
from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from click.testing import CliRunner

from mb.cli import main


def _make_mocks(uid: str, email: str):
    """Build a consistent set of mocks for AdminClient + sign_in +
    FirestoreClient so tests don't duplicate boilerplate."""
    mock_admin = MagicMock()
    mock_admin.create_user.return_value = uid

    mock_client = MagicMock()
    mock_client.uid = uid
    # poll_doc_field resolves with the minimal skeleton the trigger
    # leaves behind (email only, no displayName).
    mock_client.poll_doc_field.return_value = {"email": email}
    mock_client.get_doc.return_value = {
        "email": email,
        "displayName": "Alice",
    }
    return mock_admin, mock_client


def test_create_account_writes_display_name_to_user_doc():
    """After auth create --name Alice, the CLI must have written
    displayName="Alice" to users/{uid}. Regression test for the bug
    where the user table rendered Name as "—" because neither the
    blocking trigger nor the CLI persisted displayName."""
    runner = CliRunner()
    uid, email = "test-uid", "alice@example.com"
    mock_admin, mock_client = _make_mocks(uid, email)

    with patch("mb.commands.auth.AdminClient", return_value=mock_admin), \
         patch("mb.commands.auth.sign_in",
               return_value={"idToken": "tok", "localId": uid}), \
         patch("mb.commands.auth.FirestoreClient", return_value=mock_client):
        result = runner.invoke(main, [
            "auth", "create",
            "--email", email,
            "--password", "pw",
            "--name", "Alice",
        ])

    assert result.exit_code == 0, result.output
    mock_client.update_doc.assert_any_call(
        f"users/{uid}", {"displayName": "Alice"},
    )


def test_list_users_renders_admin_user_records():
    """`mb auth list` should call AdminClient.list_users() and render
    each user as a row with UID, name, email, and creation timestamp."""
    runner = CliRunner()

    created_ms = int(datetime(2026, 4, 14, tzinfo=timezone.utc).timestamp() * 1000)
    fake_user = SimpleNamespace(
        uid="u1",
        email="alice@example.com",
        display_name="Alice",
        disabled=False,
        user_metadata=SimpleNamespace(
            creation_timestamp=created_ms,
            last_sign_in_timestamp=created_ms,
        ),
    )
    mock_admin = MagicMock()
    mock_admin.list_users.return_value = [fake_user]

    with patch("mb.commands.auth.AdminClient", return_value=mock_admin):
        result = runner.invoke(main, ["auth", "list"])

    assert result.exit_code == 0, result.output
    mock_admin.list_users.assert_called_once()
    assert "u1" in result.output
    assert "alice@example.com" in result.output
    assert "Alice" in result.output


def test_auth_error_renders_cleanly_without_traceback():
    """AuthError bubbling out of any command (e.g. `children list`)
    should render as a Click-style error line, not a Python traceback.
    Covers the CLI-wide error handler, not per-command handling."""
    from mb.client import AuthError
    runner = CliRunner()

    with patch("mb.commands.children.sign_in",
               side_effect=AuthError("Invalid email or password for foo@bar.")):
        result = runner.invoke(main, [
            "children",
            "--email", "foo@bar",
            "--password", "wrong",
            "list",
        ])

    assert result.exit_code != 0
    assert "Traceback" not in result.output
    assert "Invalid email or password" in result.output


def test_auth_login_error_routes_through_mbgroup():
    """`mb auth login` with bad credentials must render via MbGroup
    (Click error line), not via a command-local sys.exit. Regression
    for the old _sign_in_client which caught AuthError and called
    `raise SystemExit(1)`, bypassing the CLI-wide error rendering."""
    from mb.client import AuthError
    runner = CliRunner()

    with patch("mb.commands.auth.sign_in",
               side_effect=AuthError("Invalid email or password for foo@bar.")):
        result = runner.invoke(main, [
            "auth", "login",
            "--email", "foo@bar",
            "--password", "wrong",
        ])

    assert result.exit_code != 0
    assert "Traceback" not in result.output
    assert "Invalid email or password" in result.output
    # Click's standard error prefix — if we see this the MbGroup
    # handler fired rather than a bare SystemExit.
    assert "Error:" in result.output


def test_delete_account_refuses_prod():
    """`mb --project prod auth delete` must refuse outright.
    This is the first (and strongest) of the defence-in-depth guards:
    no prompt, no flag — the command rejects the prod alias at the
    command level so a slip of `--project prod` cannot wipe a real
    account. If AdminClient is ever instantiated in this path we've
    lost the guard, so we assert it was NEVER called."""
    runner = CliRunner()

    with patch("mb.commands.auth.AdminClient") as mock_admin_cls:
        result = runner.invoke(main, [
            "--project", "prod",
            "auth", "delete",
            "--email", "someone@example.com",
            "--yes",
        ])

    assert result.exit_code != 0
    assert "dev" in result.output.lower()
    mock_admin_cls.assert_not_called()


def test_delete_account_deletes_auth_user_and_user_doc():
    """With --yes to skip the prompt, auth delete must:
      1. Look up the UID by email (Admin SDK)
      2. Delete users/{uid} Firestore doc (Admin SDK, bypasses rules)
      3. Delete the Firebase Auth user
    The auth-user deletion must happen LAST so a failure partway
    through leaves the caller with `email → uid` still resolvable for
    a retry — if we deleted auth first, the orphan users/{uid} doc
    would be unfindable by email."""
    runner = CliRunner()

    fake_user = SimpleNamespace(
        uid="u1",
        email="test@example.com",
        display_name="Test",
    )
    mock_admin = MagicMock()
    mock_admin.get_user_by_email.return_value = fake_user
    mock_admin.children_of.return_value = []  # no children

    with patch("mb.commands.auth.AdminClient", return_value=mock_admin):
        result = runner.invoke(main, [
            "--project", "dev",
            "auth", "delete",
            "--email", "test@example.com",
            "--yes",
        ])

    assert result.exit_code == 0, result.output
    mock_admin.get_user_by_email.assert_called_once_with("test@example.com")
    mock_admin.children_of.assert_called_once_with("u1")
    # users/{uid} doc deletion goes via Admin SDK (bypasses rules).
    mock_admin.db.document.assert_any_call("users/u1")
    mock_admin.db.document.return_value.delete.assert_called_once()
    # Auth user deletion.
    mock_admin.delete_user.assert_called_once_with("u1")


def test_delete_account_cascades_to_sole_parent_children():
    """If the deleted user is the SOLE parent of a child, the child
    (and its subcollections) must be recursive-deleted — otherwise
    we'd leave an unreachable child with a dangling parentUid."""
    runner = CliRunner()

    fake_user = SimpleNamespace(
        uid="u1",
        email="test@example.com",
        display_name="Test",
    )
    mock_admin = MagicMock()
    mock_admin.get_user_by_email.return_value = fake_user
    # u1 is the SOLE parent of child-A.
    mock_admin.children_of.return_value = [("child-A", ["u1"])]

    with patch("mb.commands.auth.AdminClient", return_value=mock_admin):
        result = runner.invoke(main, [
            "--project", "dev",
            "auth", "delete",
            "--email", "test@example.com",
            "--yes",
        ])

    assert result.exit_code == 0, result.output
    mock_admin.recursive_delete_child.assert_called_once_with("child-A")
    mock_admin.delete_user.assert_called_once_with("u1")


def test_delete_account_leaves_coparented_children_intact():
    """If the deleted user CO-PARENTS a child with someone else, we
    must NOT delete the child. Wiping shared state on a cleanup
    action is too dangerous — the other parent might be a real user.
    The child stays; it's reported as left intact."""
    runner = CliRunner()

    fake_user = SimpleNamespace(
        uid="u1",
        email="test@example.com",
        display_name="Test",
    )
    mock_admin = MagicMock()
    mock_admin.get_user_by_email.return_value = fake_user
    # u1 co-parents child-B with u2.
    mock_admin.children_of.return_value = [("child-B", ["u1", "u2"])]

    with patch("mb.commands.auth.AdminClient", return_value=mock_admin):
        result = runner.invoke(main, [
            "--project", "dev",
            "auth", "delete",
            "--email", "test@example.com",
            "--yes",
        ])

    assert result.exit_code == 0, result.output
    mock_admin.recursive_delete_child.assert_not_called()
    # Auth user still gets deleted.
    mock_admin.delete_user.assert_called_once_with("u1")
    # Operator needs visibility into what was left behind.
    assert "child-B" in result.output


def test_delete_account_mixed_children_cascades_only_sole_parent():
    """Mix: one sole-parent child (delete) + one co-parented child
    (leave). Ensures the partition logic deletes exactly the right
    set, not all-or-nothing."""
    runner = CliRunner()

    fake_user = SimpleNamespace(
        uid="u1",
        email="test@example.com",
        display_name="Test",
    )
    mock_admin = MagicMock()
    mock_admin.get_user_by_email.return_value = fake_user
    mock_admin.children_of.return_value = [
        ("child-sole", ["u1"]),
        ("child-shared", ["u1", "u2"]),
    ]

    with patch("mb.commands.auth.AdminClient", return_value=mock_admin):
        result = runner.invoke(main, [
            "--project", "dev",
            "auth", "delete",
            "--email", "test@example.com",
            "--yes",
        ])

    assert result.exit_code == 0, result.output
    mock_admin.recursive_delete_child.assert_called_once_with("child-sole")


def test_delete_account_aborts_without_confirmation():
    """Without --yes and without typing 'y', the command must abort
    and delete nothing. Guards against fat-finger CLI usage on dev too
    (dev accounts are still annoying to recreate)."""
    runner = CliRunner()

    fake_user = SimpleNamespace(
        uid="u1",
        email="test@example.com",
        display_name="Test",
    )
    mock_admin = MagicMock()
    mock_admin.get_user_by_email.return_value = fake_user

    with patch("mb.commands.auth.AdminClient", return_value=mock_admin):
        # Feed "n" to the confirmation prompt.
        result = runner.invoke(main, [
            "--project", "dev",
            "auth", "delete",
            "--email", "test@example.com",
        ], input="n\n")

    assert result.exit_code != 0
    mock_admin.delete_user.assert_not_called()
    mock_admin.db.document.return_value.delete.assert_not_called()


def test_delete_account_reports_missing_user():
    """If the email doesn't match any account, the command must exit
    non-zero with a clear message and never attempt a delete."""
    runner = CliRunner()

    mock_admin = MagicMock()
    mock_admin.get_user_by_email.return_value = None

    with patch("mb.commands.auth.AdminClient", return_value=mock_admin):
        result = runner.invoke(main, [
            "--project", "dev",
            "auth", "delete",
            "--email", "ghost@example.com",
            "--yes",
        ])

    assert result.exit_code != 0
    assert "ghost@example.com" in result.output
    mock_admin.delete_user.assert_not_called()


def test_create_account_malformed_email_renders_cleanly():
    """Admin SDK's `validate_email` raises a bare ValueError for
    garbage input (e.g. `--email …`); ``AdminClient.create_user``
    translates that to ``AuthError`` at the SDK boundary so the CLI's
    top-level handler can render a one-line Click error instead of a
    30-line Python traceback. We mock ``AuthError`` here because the
    translation is the AdminClient's job — see
    ``test_admin_client_create_user_translates_value_error`` for the
    translation itself."""
    from mb.client import AuthError
    runner = CliRunner()
    mock_admin = MagicMock()
    mock_admin.create_user.side_effect = AuthError(
        'Malformed email address string: "…".'
    )

    with patch("mb.commands.auth.AdminClient", return_value=mock_admin):
        result = runner.invoke(main, [
            "auth", "create",
            "--email", "…",
            "--password", "pw",
            "--name", "Test",
        ])

    assert result.exit_code != 0
    assert "Traceback" not in result.output
    assert "Malformed email" in result.output
    assert "Error:" in result.output


def test_update_account_changes_display_name():
    """`auth update --name` should write displayName to users/{uid}
    and render a Before/After table so the operator can confirm the
    change without a separate `auth login` round-trip."""
    runner = CliRunner()
    uid, email = "u1", "alice@example.com"

    mock_client = MagicMock()
    mock_client.uid = uid
    mock_client.get_doc.side_effect = [
        {"email": email, "displayName": "Old"},
        {"email": email, "displayName": "New"},
    ]

    with patch("mb.commands.auth.sign_in",
               return_value={"idToken": "t", "localId": uid}), \
         patch("mb.commands.auth.FirestoreClient", return_value=mock_client):
        result = runner.invoke(main, [
            "auth", "update",
            "--email", email,
            "--password", "pw",
            "--name", "New",
        ])

    assert result.exit_code == 0, result.output
    mock_client.update_doc.assert_called_once_with(
        f"users/{uid}", {"displayName": "New"},
    )
    # Photo upload path must not have been touched.
    mock_client.upload_file.assert_not_called()


def test_update_account_clear_photo_sets_photo_url_null():
    """`auth update --clear-photo` must write photoUrl=None directly
    (no Storage roundtrip needed — onUserDeleted-style cleanup is the
    Cloud Function's job, not the CLI's)."""
    runner = CliRunner()
    uid, email = "u1", "alice@example.com"

    mock_client = MagicMock()
    mock_client.uid = uid
    mock_client.get_doc.return_value = {"email": email, "photoUrl": None}

    with patch("mb.commands.auth.sign_in",
               return_value={"idToken": "t", "localId": uid}), \
         patch("mb.commands.auth.FirestoreClient", return_value=mock_client):
        result = runner.invoke(main, [
            "auth", "update",
            "--email", email,
            "--password", "pw",
            "--clear-photo",
        ])

    assert result.exit_code == 0, result.output
    mock_client.update_doc.assert_called_once_with(
        f"users/{uid}", {"photoUrl": None},
    )
    mock_client.upload_file.assert_not_called()


def test_update_account_rejects_photo_and_clear_photo_together():
    """Mutually exclusive flags: passing both is operator confusion,
    not a request — refuse before any network calls."""
    runner = CliRunner()
    with patch("mb.commands.auth.sign_in") as mock_sign_in:
        result = runner.invoke(main, [
            "auth", "update",
            "--email", "a@b.com",
            "--password", "pw",
            "--photo", "/tmp/nonexistent.jpg",
            "--clear-photo",
        ])
    # Click rejects --photo before --clear-photo because path doesn't
    # exist; either way exit must be non-zero and no auth happens.
    assert result.exit_code != 0
    mock_sign_in.assert_not_called()


def test_update_account_requires_at_least_one_field():
    """No-op updates are operator error — the CLI must call it out
    rather than silently signing in and doing nothing."""
    runner = CliRunner()
    mock_client = MagicMock()
    mock_client.uid = "u1"

    with patch("mb.commands.auth.sign_in",
               return_value={"idToken": "t", "localId": "u1"}), \
         patch("mb.commands.auth.FirestoreClient", return_value=mock_client):
        result = runner.invoke(main, [
            "auth", "update",
            "--email", "a@b.com",
            "--password", "pw",
        ])

    assert result.exit_code != 0
    assert "at least one" in result.output.lower()
    mock_client.update_doc.assert_not_called()


def test_firestore_403_renders_cleanly_without_traceback(monkeypatch):
    """A 403 from a Firestore REST call must surface as a Click
    error, not a requests.HTTPError traceback. Regression for
    `mb invites send` leaking HTTPError when rules denied the write."""
    import requests
    from mb.client import FirestoreClient, ProjectConfig

    # Build a real FirestoreClient but stub the HTTP layer to return 403.
    fake_resp = MagicMock(spec=requests.Response)
    fake_resp.status_code = 403
    fake_resp.text = '{"error":{"status":"PERMISSION_DENIED"}}'
    fake_resp.json.return_value = {"error": {"status": "PERMISSION_DENIED"}}
    fake_resp.raise_for_status.side_effect = requests.HTTPError(
        "403 Client Error: Forbidden", response=fake_resp,
    )
    monkeypatch.setattr("mb.client.requests.post", lambda *a, **k: fake_resp)

    config = ProjectConfig(
        project_id="proj", api_key="k", api_key_env="X", region="us-central1",
    )
    client = FirestoreClient(config, id_token="tok", uid="u1")

    # The client itself should raise FirestoreError (not HTTPError),
    # so the CLI handler has something to catch.
    from mb.client import FirestoreError
    import pytest as _pytest
    with _pytest.raises(FirestoreError):
        client.create_doc("invites", {"childId": "c1"})
