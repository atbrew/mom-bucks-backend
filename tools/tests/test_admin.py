"""Tests for ``mb.admin.AdminClient`` error-translation boundary.

The Admin SDK signals input validation with a bare ``ValueError`` and
backend errors with ``firebase_admin.exceptions.FirebaseError``. The
CLI's top-level handler intentionally does NOT swallow either of those
broadly (that would mask logic bugs in command code). Instead,
``AdminClient`` translates them into ``AuthError`` at the SDK
boundary; these tests pin that translation in place.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import firebase_admin.exceptions
import pytest

from mb.admin import AdminClient
from mb.client import AuthError


def _make_client() -> AdminClient:
    """Construct an ``AdminClient`` without touching credentials or
    Firestore — both are stubbed so we can exercise the translation
    layer in isolation."""
    with patch("mb.admin.credentials.ApplicationDefault"), \
         patch("mb.admin.firebase_admin.initialize_app", return_value=MagicMock()), \
         patch("mb.admin.firestore.client", return_value=MagicMock()):
        return AdminClient(project_id="test-project")


def test_create_user_translates_value_error_into_auth_error():
    """Admin SDK's ``validate_email`` raises a bare ``ValueError`` for
    malformed input. AdminClient must translate it to ``AuthError`` so
    the CLI's narrow top-level handler can render it cleanly."""
    client = _make_client()
    with patch("mb.admin.auth.create_user",
               side_effect=ValueError('Malformed email address string: "…".')):
        with pytest.raises(AuthError) as excinfo:
            client.create_user(email="…", password="pw", display_name="Test")
    assert "Malformed email" in str(excinfo.value)


def test_create_user_translates_firebase_error_into_auth_error():
    """Backend errors (e.g. duplicate email, quota) come back as
    ``FirebaseError``. Same boundary, same translation."""
    client = _make_client()
    fake = firebase_admin.exceptions.FirebaseError(
        code="ALREADY_EXISTS", message="Email already in use",
    )
    with patch("mb.admin.auth.create_user", side_effect=fake):
        with pytest.raises(AuthError) as excinfo:
            client.create_user(email="a@b.com", password="pw", display_name="T")
    assert "Email already in use" in str(excinfo.value)


def test_get_user_by_email_returns_none_for_missing_user():
    """``UserNotFoundError`` is a normal-path signal (caller wants to
    distinguish "missing" from "error"), so the translation layer
    must NOT swallow it as a generic ``AuthError`` — the method
    should keep returning ``None`` for missing users."""
    client = _make_client()
    not_found = firebase_admin.auth.UserNotFoundError(
        message="User not found",
    )
    with patch("mb.admin.auth.get_user_by_email", side_effect=not_found):
        assert client.get_user_by_email("ghost@example.com") is None


def test_get_user_by_email_translates_other_firebase_errors():
    """Non-NotFound Admin SDK errors (e.g. malformed email) must still
    surface as ``AuthError`` — only the NotFound case is special."""
    client = _make_client()
    with patch("mb.admin.auth.get_user_by_email",
               side_effect=ValueError('Malformed email address string: "…".')):
        with pytest.raises(AuthError):
            client.get_user_by_email("…")


def test_delete_user_translates_value_error_into_auth_error():
    """``delete_user`` validates UID format and raises ``ValueError``
    on garbage input — same translation rule applies."""
    client = _make_client()
    with patch("mb.admin.auth.delete_user",
               side_effect=ValueError("UID must be a non-empty string")):
        with pytest.raises(AuthError):
            client.delete_user("")
