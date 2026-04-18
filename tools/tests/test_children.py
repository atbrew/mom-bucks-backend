"""Tests for `mb children` commands.

Focused on the `delete` command, which mirrors `auth delete` in
behaviour: confirmation prompt by default, --yes for scripts, hard
refusal on missing target.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from click.testing import CliRunner

from mb.cli import main


def _patched_client(mock_client: MagicMock):
    """Patch the sign_in + FirestoreClient pair used by every children
    subcommand. Returns a context-manager-friendly tuple of patches."""
    return (
        patch("mb.commands.children.sign_in",
              return_value={"idToken": "t", "localId": mock_client.uid}),
        patch("mb.commands.children.FirestoreClient", return_value=mock_client),
    )


# ─── delete ────────────────────────────────────────────────────────

def test_delete_child_happy_path_with_yes_skips_prompt():
    """With --yes the CLI must delete the child doc directly without
    waiting on a prompt — required for scripted teardown."""
    runner = CliRunner()
    mock_client = MagicMock()
    mock_client.uid = "parent-uid"
    mock_client.get_doc.return_value = {
        "name": "Sam",
        "parentUids": ["parent-uid"],
        "balance": 500,
    }

    p1, p2 = _patched_client(mock_client)
    with p1, p2:
        result = runner.invoke(main, [
            "children",
            "--email", "p@x.com",
            "--password", "pw",
            "delete",
            "--child-id", "child-1",
            "--yes",
        ])

    assert result.exit_code == 0, result.output
    mock_client.delete_doc.assert_called_once_with("children/child-1")
    # Operator must see a hint that subcollections cascade server-side,
    # otherwise they'll panic and try to delete them manually.
    assert "cascade" in result.output.lower()


def test_delete_child_aborts_without_confirmation():
    """Without --yes and a "n" answer, the command must abort and
    delete nothing. Same fat-finger guard as `auth delete`."""
    runner = CliRunner()
    mock_client = MagicMock()
    mock_client.uid = "parent-uid"
    mock_client.get_doc.return_value = {
        "name": "Sam",
        "parentUids": ["parent-uid"],
        "balance": 0,
    }

    p1, p2 = _patched_client(mock_client)
    with p1, p2:
        result = runner.invoke(main, [
            "children",
            "--email", "p@x.com",
            "--password", "pw",
            "delete",
            "--child-id", "child-1",
        ], input="n\n")

    assert result.exit_code != 0
    mock_client.delete_doc.assert_not_called()


def test_delete_child_reports_missing_child():
    """If the child doc doesn't exist, exit non-zero with a clear
    message — and never attempt the delete (the trigger only runs on
    actual deletions, so a missing doc is a no-op anyway, but we want
    the operator to know they typed the wrong ID)."""
    runner = CliRunner()
    mock_client = MagicMock()
    mock_client.uid = "parent-uid"
    mock_client.get_doc.return_value = None

    p1, p2 = _patched_client(mock_client)
    with p1, p2:
        result = runner.invoke(main, [
            "children",
            "--email", "p@x.com",
            "--password", "pw",
            "delete",
            "--child-id", "ghost",
            "--yes",
        ])

    assert result.exit_code != 0
    assert "ghost" in result.output
    mock_client.delete_doc.assert_not_called()


def test_delete_child_warns_when_co_parented():
    """Co-parented children share state — when one parent runs `delete`,
    the OTHER parents lose access too. The CLI must surface the
    co-parent UIDs in the confirmation block so the operator sees the
    blast radius before typing y."""
    runner = CliRunner()
    mock_client = MagicMock()
    mock_client.uid = "parent-uid"
    mock_client.get_doc.return_value = {
        "name": "Sam",
        "parentUids": ["parent-uid", "co-parent-uid"],
        "balance": 0,
    }

    p1, p2 = _patched_client(mock_client)
    with p1, p2:
        result = runner.invoke(main, [
            "children",
            "--email", "p@x.com",
            "--password", "pw",
            "delete",
            "--child-id", "child-1",
            "--yes",
        ])

    assert result.exit_code == 0, result.output
    # Co-parent UID must appear in the warning text.
    assert "co-parent-uid" in result.output
    # And the delete still proceeds — co-parented does not block,
    # only warns.
    mock_client.delete_doc.assert_called_once_with("children/child-1")
