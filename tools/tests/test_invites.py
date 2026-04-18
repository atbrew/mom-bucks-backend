"""Tests for `mb invites` commands."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from click.testing import CliRunner

from mb.cli import main


# ─── send ───────────────────────────────────────────────────────────

def test_send_invite_calls_sendInvite_callable_not_direct_firestore():
    """`invites send` must invoke the `sendInvite` callable, not write
    directly to Firestore. Rules now block client writes to /invites
    (`allow write: if false`), and the callable is what stamps
    `invitedByUid`, lowercases `invitedEmail`, denormalises `childName`
    + `invitedByDisplayName`, and sets a server-side `expiresAt`."""
    runner = CliRunner()

    mock_client = MagicMock()
    mock_client.uid = "parent-uid"
    mock_client.call_function.return_value = {"token": "abc123"}

    with patch("mb.commands.invites.sign_in",
               return_value={"idToken": "t", "localId": "parent-uid"}), \
         patch("mb.commands.invites.FirestoreClient", return_value=mock_client):
        result = runner.invoke(main, [
            "invites",
            "--email", "p@x.com",
            "--password", "pw",
            "send",
            "--child-id", "c1",
            "--email", "Invitee@X.com",
        ])

    assert result.exit_code == 0, result.output
    # No direct Firestore writes.
    mock_client.create_doc.assert_not_called()
    # Callable invoked with the raw payload; the server does normalisation.
    mock_client.call_function.assert_called_once_with(
        "sendInvite",
        {"childId": "c1", "invitedEmail": "Invitee@X.com"},
    )
    # Token is surfaced to the user so they can share it.
    assert "abc123" in result.output


# ─── inbox ──────────────────────────────────────────────────────────

def test_inbox_queries_invitedEmail_lowercased_against_caller_email():
    """`invites inbox` must query by the caller's Auth email, lowercased,
    because `sendInvite` stores `invitedEmail` already lowercased and
    rules require `resource.data.invitedEmail == request.auth.token.email.lower()`
    on list. Mixed-case caller emails must still hit the index."""
    runner = CliRunner()

    mock_client = MagicMock()
    mock_client.uid = "bob-uid"
    mock_client.query.return_value = [
        {"_id": "tok1", "childId": "sam", "invitedEmail": "bob@x.com",
         "invitedByUid": "alice", "invitedByDisplayName": "Alice",
         "childName": "Sam"},
    ]

    with patch("mb.commands.invites.sign_in",
               return_value={"idToken": "t", "localId": "bob-uid"}), \
         patch("mb.commands.invites.FirestoreClient", return_value=mock_client):
        result = runner.invoke(main, [
            "invites",
            "--email", "Bob@X.COM",
            "--password", "pw",
            "inbox",
        ])

    assert result.exit_code == 0, result.output
    mock_client.query.assert_called_once_with(
        "invites", "invitedEmail", "EQUAL", "bob@x.com",
    )
    # Renders the key fields so a user can act on the invite.
    assert "tok1" in result.output
    assert "Sam" in result.output
    assert "Alice" in result.output


def test_inbox_prints_a_helpful_message_when_empty():
    runner = CliRunner()
    mock_client = MagicMock()
    mock_client.uid = "bob-uid"
    mock_client.query.return_value = []

    with patch("mb.commands.invites.sign_in",
               return_value={"idToken": "t", "localId": "bob-uid"}), \
         patch("mb.commands.invites.FirestoreClient", return_value=mock_client):
        result = runner.invoke(main, [
            "invites",
            "--email", "bob@x.com",
            "--password", "pw",
            "inbox",
        ])

    assert result.exit_code == 0, result.output
    assert "No invites" in result.output


# ─── sent ───────────────────────────────────────────────────────────

def test_sent_queries_invitedByUid_against_callers_uid():
    """`invites sent` lists invites the caller sent — the rule allows
    list when `resource.data.invitedByUid == request.auth.uid`."""
    runner = CliRunner()

    mock_client = MagicMock()
    mock_client.uid = "alice-uid"
    mock_client.query.return_value = [
        {"_id": "tok1", "childId": "sam", "invitedEmail": "bob@x.com",
         "invitedByUid": "alice-uid", "acceptedByUid": None,
         "childName": "Sam"},
    ]

    with patch("mb.commands.invites.sign_in",
               return_value={"idToken": "t", "localId": "alice-uid"}), \
         patch("mb.commands.invites.FirestoreClient", return_value=mock_client):
        result = runner.invoke(main, [
            "invites",
            "--email", "alice@x.com",
            "--password", "pw",
            "sent",
        ])

    assert result.exit_code == 0, result.output
    mock_client.query.assert_called_once_with(
        "invites", "invitedByUid", "EQUAL", "alice-uid",
    )
    assert "tok1" in result.output
    assert "bob@x.com" in result.output


def test_sent_marks_accepted_vs_pending_so_the_user_knows_whats_revocable():
    runner = CliRunner()
    mock_client = MagicMock()
    mock_client.uid = "alice-uid"
    mock_client.query.return_value = [
        {"_id": "acc1", "childId": "sam", "invitedEmail": "bob@x.com",
         "invitedByUid": "alice-uid", "acceptedByUid": "bob-uid",
         "childName": "Sam"},
        {"_id": "pen1", "childId": "sam", "invitedEmail": "carol@x.com",
         "invitedByUid": "alice-uid", "acceptedByUid": None,
         "childName": "Sam"},
    ]

    with patch("mb.commands.invites.sign_in",
               return_value={"idToken": "t", "localId": "alice-uid"}), \
         patch("mb.commands.invites.FirestoreClient", return_value=mock_client):
        result = runner.invoke(main, [
            "invites",
            "--email", "alice@x.com",
            "--password", "pw",
            "sent",
        ])

    assert result.exit_code == 0, result.output
    # Status column should distinguish — "accepted" is a revocation
    # blocker, "pending" is revocable.
    assert "accepted" in result.output.lower()
    assert "pending" in result.output.lower()


# ─── revoke ─────────────────────────────────────────────────────────

def test_revoke_calls_revokeInvite_callable_with_token():
    """`invites revoke` calls the `revokeInvite` callable — clients
    cannot delete invite docs directly (`allow write: if false`)."""
    runner = CliRunner()
    mock_client = MagicMock()
    mock_client.uid = "alice-uid"
    mock_client.call_function.return_value = {}

    with patch("mb.commands.invites.sign_in",
               return_value={"idToken": "t", "localId": "alice-uid"}), \
         patch("mb.commands.invites.FirestoreClient", return_value=mock_client):
        result = runner.invoke(main, [
            "invites",
            "--email", "alice@x.com",
            "--password", "pw",
            "revoke",
            "--token", "tok-to-kill",
        ])

    assert result.exit_code == 0, result.output
    mock_client.call_function.assert_called_once_with(
        "revokeInvite", {"token": "tok-to-kill"},
    )
    assert "revoked" in result.output.lower()
