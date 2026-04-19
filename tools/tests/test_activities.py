"""Tests for `mb activities` commands.

Covers `parse_schedule` (pure shorthand → Schedule map) and the
create/edit/claim command flows. These are callable-driven; the CLI
just marshals arguments and renders the result.
"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import click
import pytest
from click.testing import CliRunner

from mb.cli import main
from mb.commands.activities import parse_schedule


# ─── parse_schedule ────────────────────────────────────────────────

@pytest.mark.parametrize("shorthand,expected", [
    ("daily", {"kind": "DAILY"}),
    ("DAILY", {"kind": "DAILY"}),
    ("  daily  ", {"kind": "DAILY"}),
    ("weekly:sun", {"kind": "WEEKLY", "dayOfWeek": 0}),
    ("weekly:mon", {"kind": "WEEKLY", "dayOfWeek": 1}),
    ("weekly:sat", {"kind": "WEEKLY", "dayOfWeek": 6}),
    ("monthly:1", {"kind": "MONTHLY", "dayOfMonth": 1}),
    ("monthly:15", {"kind": "MONTHLY", "dayOfMonth": 15}),
    ("monthly:31", {"kind": "MONTHLY", "dayOfMonth": 31}),
])
def test_parse_schedule_accepts_valid_shorthand(shorthand, expected):
    """Pure table-driven: valid shorthands map to the callable shape."""
    assert parse_schedule(shorthand) == expected


@pytest.mark.parametrize("bad", [
    "",
    "never",
    "weekly",          # missing day
    "weekly:xyz",      # unknown day
    "monthly",         # missing day-of-month
    "monthly:0",       # out of range
    "monthly:32",      # out of range
    "monthly:abc",     # not an int
])
def test_parse_schedule_rejects_bad_shorthand(bad):
    """Every bad input raises UsageError — never silently returns junk."""
    with pytest.raises(click.UsageError):
        parse_schedule(bad)


# ─── Command flows ─────────────────────────────────────────────────

def _patched_client(mock_client: MagicMock):
    """Patch sign_in + FirestoreClient for the activities module."""
    return (
        patch(
            "mb.commands.activities.sign_in",
            return_value={"idToken": "t", "localId": mock_client.uid},
        ),
        patch(
            "mb.commands.activities.FirestoreClient",
            return_value=mock_client,
        ),
    )


def test_create_activity_calls_callable_with_cents_and_uppercased_type():
    """`mb activities create --reward 5.00 --type chore --schedule weekly:sat`
    must invoke `createActivity` with integer cents (500), uppercased type
    ('CHORE'), and a WEEKLY Schedule map. The CLI is a dumb terminal:
    every validation lives server-side."""
    runner = CliRunner()
    mock_client = MagicMock()
    mock_client.uid = "u1"
    mock_client.call_function.return_value = {"activityId": "a-1"}

    p1, p2 = _patched_client(mock_client)
    with p1, p2:
        result = runner.invoke(main, [
            "activities",
            "--email", "p@x.com",
            "--password", "pw",
            "create",
            "--child-id", "child-1",
            "--title", "Take out the bins",
            "--reward", "5.00",
            "--type", "chore",
            "--schedule", "weekly:sat",
        ])

    assert result.exit_code == 0, result.output
    mock_client.call_function.assert_called_once_with("createActivity", {
        "childId": "child-1",
        "title": "Take out the bins",
        "reward": 500,
        "type": "CHORE",
        "schedule": {"kind": "WEEKLY", "dayOfWeek": 6},
    })
    assert "a-1" in result.output


def test_edit_activity_patches_only_supplied_fields():
    """`mb activities edit --reward 7.50` must send a patch with just
    `reward` — not a whole-doc overwrite. Schedule omitted → patch omits
    `schedule`, so the callable won't recompute nextClaimAt."""
    runner = CliRunner()
    mock_client = MagicMock()
    mock_client.uid = "u1"
    mock_client.call_function.return_value = {}

    p1, p2 = _patched_client(mock_client)
    with p1, p2:
        result = runner.invoke(main, [
            "activities",
            "--email", "p@x.com",
            "--password", "pw",
            "edit",
            "--child-id", "child-1",
            "--activity-id", "a-1",
            "--reward", "7.50",
        ])

    assert result.exit_code == 0, result.output
    mock_client.call_function.assert_called_once_with("updateActivity", {
        "childId": "child-1",
        "activityId": "a-1",
        "patch": {"reward": 750},
    })


def test_edit_activity_refuses_no_op_patch():
    """No fields passed → refuse before signing in; otherwise the CLI
    would do a round-trip just to send an empty patch. Matches Click's
    usual "require at least one flag" guard used elsewhere."""
    runner = CliRunner()
    with patch("mb.commands.activities.sign_in") as mock_sign_in:
        result = runner.invoke(main, [
            "activities",
            "--email", "p@x.com",
            "--password", "pw",
            "edit",
            "--child-id", "child-1",
            "--activity-id", "a-1",
        ])
    assert result.exit_code != 0
    assert "at least one" in result.output.lower()
    mock_sign_in.assert_not_called()


def test_claim_activity_renders_amount_balance_and_next_claim():
    """claimActivity returns `{amount, newBalance, nextClaimAt}`; the
    CLI must show all three so the operator doesn't need to follow up
    with `children balance` + `activities list`."""
    runner = CliRunner()
    mock_client = MagicMock()
    mock_client.uid = "u1"
    mock_client.call_function.return_value = {
        "amount": 500,
        "newBalance": 1500,
        "nextClaimAt": "2026-04-25T00:00:00Z",
    }

    p1, p2 = _patched_client(mock_client)
    with p1, p2:
        result = runner.invoke(main, [
            "activities",
            "--email", "p@x.com",
            "--password", "pw",
            "claim",
            "--child-id", "child-1",
            "--activity-id", "a-1",
        ])

    assert result.exit_code == 0, result.output
    assert "5.00" in result.output       # amount
    assert "15.00" in result.output      # newBalance
    assert "2026-04-25" in result.output  # nextClaimAt


def test_list_activities_renders_schedule_and_claimable_flag():
    """`activities list` must reverse-map the Schedule shape back to
    shorthand and compute claimable? from `nextClaimAt <= now`. One
    claimable and one not-yet row proves both branches of the clock
    compare."""
    runner = CliRunner()
    mock_client = MagicMock()
    mock_client.uid = "u1"
    # One claimable (past), one not-yet (future).
    past = datetime(2020, 1, 1, tzinfo=timezone.utc)
    future = datetime(2999, 1, 1, tzinfo=timezone.utc)
    mock_client.list_collection.return_value = [
        {
            "_id": "a-now",
            "title": "Pocket money",
            "type": "ALLOWANCE",
            "reward": 500,
            "schedule": {"kind": "WEEKLY", "dayOfWeek": 6},
            "nextClaimAt": past,
        },
        {
            "_id": "a-later",
            "title": "Dishes",
            "type": "CHORE",
            "reward": 200,
            "schedule": {"kind": "DAILY"},
            "nextClaimAt": future,
        },
    ]

    p1, p2 = _patched_client(mock_client)
    with p1, p2:
        # Widen the Rich console output so the Schedule column isn't
        # truncated mid-word by the default 80-col terminal in tests.
        result = runner.invoke(main, [
            "activities",
            "--email", "p@x.com",
            "--password", "pw",
            "list",
            "--child-id", "child-1",
        ], env={"COLUMNS": "200"})

    assert result.exit_code == 0, result.output
    # Schedule shorthand is reversed back from the map.
    assert "weekly:sat" in result.output
    assert "daily" in result.output
    # And the claimable? column is populated for both rows.
    assert "yes" in result.output
    assert "no" in result.output
