"""Tests for `mb vault` commands.

The callable-backed subcommands (deposit, claim-interest, preview,
unlock) are thin wrappers — we verify that arguments are marshalled
correctly (euros → cents) and that the rendered output contains the
fields the operator cares about. `configure` and `show` use the Admin
SDK directly and get their own tests.
"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from click.testing import CliRunner

from mb.cli import main


def _patched_client(mock_client: MagicMock):
    """Patch the sign_in + FirestoreClient pair used by callable-backed
    subcommands."""
    return (
        patch(
            "mb.commands.vault.sign_in",
            return_value={"idToken": "t", "localId": mock_client.uid},
        ),
        patch(
            "mb.commands.vault.FirestoreClient",
            return_value=mock_client,
        ),
    )


# ─── deposit ───────────────────────────────────────────────────────

def test_deposit_passes_integer_cents_and_renders_result():
    """`--amount 10.00` must reach `depositToVault` as `1000` (cents).
    All five result fields — interest, deposited, matched, remainder,
    unlocked — must appear in the CLI output, matching design §4.6's
    worked example."""
    runner = CliRunner()
    mock_client = MagicMock()
    mock_client.uid = "u1"
    mock_client.call_function.return_value = {
        "interestClaimed": 2,
        "deposited": 4,
        "matched": 4,
        "remainedInMain": 6,
        "unlocked": True,
    }

    p1, p2 = _patched_client(mock_client)
    with p1, p2:
        result = runner.invoke(main, [
            "vault",
            "--email", "p@x.com",
            "--password", "pw",
            "deposit",
            "--child-id", "child-1",
            "--amount", "10.00",
        ])

    assert result.exit_code == 0, result.output
    mock_client.call_function.assert_called_once_with("depositToVault", {
        "childId": "child-1",
        "amount": 1000,
    })
    # All four monetary fields + the unlocked flag are visible.
    assert "0.02" in result.output   # interest
    assert "0.04" in result.output   # deposited / matched
    assert "0.06" in result.output   # remained-in-main
    assert "yes" in result.output    # unlocked


# ─── claim-interest ────────────────────────────────────────────────

def test_claim_interest_renders_paid_and_unlocked():
    runner = CliRunner()
    mock_client = MagicMock()
    mock_client.uid = "u1"
    mock_client.call_function.return_value = {"paid": 10, "unlocked": False}

    p1, p2 = _patched_client(mock_client)
    with p1, p2:
        result = runner.invoke(main, [
            "vault",
            "--email", "p@x.com",
            "--password", "pw",
            "claim-interest",
            "--child-id", "child-1",
        ])

    assert result.exit_code == 0, result.output
    mock_client.call_function.assert_called_once_with(
        "claimInterest", {"childId": "child-1"},
    )
    assert "0.10" in result.output
    assert "no" in result.output  # unlocked flag


# ─── preview ───────────────────────────────────────────────────────

def test_preview_renders_claimable_amount():
    """The preview subcommand mirrors design §4.3 — read-only, returns
    `{claimable}`. It's safe to call repeatedly, so the CLI only has to
    show the number without any "action taken" text."""
    runner = CliRunner()
    mock_client = MagicMock()
    mock_client.uid = "u1"
    mock_client.call_function.return_value = {"claimable": 42}

    p1, p2 = _patched_client(mock_client)
    with p1, p2:
        result = runner.invoke(main, [
            "vault",
            "--email", "p@x.com",
            "--password", "pw",
            "preview",
            "--child-id", "child-1",
        ])

    assert result.exit_code == 0, result.output
    mock_client.call_function.assert_called_once_with(
        "getClaimableInterest", {"childId": "child-1"},
    )
    assert "0.42" in result.output


# ─── unlock ────────────────────────────────────────────────────────

def test_unlock_renders_released_amount():
    runner = CliRunner()
    mock_client = MagicMock()
    mock_client.uid = "u1"
    mock_client.call_function.return_value = {"released": 5000}

    p1, p2 = _patched_client(mock_client)
    with p1, p2:
        result = runner.invoke(main, [
            "vault",
            "--email", "p@x.com",
            "--password", "pw",
            "unlock",
            "--child-id", "child-1",
        ])

    assert result.exit_code == 0, result.output
    mock_client.call_function.assert_called_once_with(
        "unlockVault", {"childId": "child-1"},
    )
    assert "50.00" in result.output


# ─── configure (Admin SDK) ─────────────────────────────────────────

def _patched_admin(mock_admin: MagicMock):
    return patch("mb.commands.vault.AdminClient", return_value=mock_admin)


def test_configure_writes_vault_map_with_interest_and_matching():
    """With both `--weekly-rate` and `--match-rate`, the vault map must
    contain full `interest` and `matching` sub-objects. On a fresh
    child (no pre-existing vault) `balance=0` and `unlockedAt=None`
    are the sentinel values."""
    runner = CliRunner()
    mock_ref = MagicMock()
    mock_snap = MagicMock()
    mock_snap.exists = True
    mock_snap.to_dict.return_value = {"name": "Sam"}
    mock_ref.get.return_value = mock_snap
    mock_admin = MagicMock()
    mock_admin.db.document.return_value = mock_ref

    with _patched_admin(mock_admin):
        result = runner.invoke(main, [
            "--project", "emu",       # skips the credentials check
            "vault",
            "--email", "p@x.com",
            "--password", "pw",
            "configure",
            "--child-id", "child-1",
            "--target", "50.00",
            "--weekly-rate", "0.01",
            "--match-rate", "0.5",
        ])

    assert result.exit_code == 0, result.output
    mock_admin.db.document.assert_called_once_with("children/child-1")
    # Captures the vault map exactly — if callable-less `configure`
    # drifts away from the rules schema this asserts will catch it.
    args, _ = mock_ref.update.call_args
    (payload,) = args
    vault = payload["vault"]
    assert vault["balance"] == 0
    assert vault["target"] == 5000
    assert vault["unlockedAt"] is None
    assert vault["interest"]["weeklyRate"] == 0.01
    assert isinstance(vault["interest"]["lastAccrualWrite"], datetime)
    assert vault["matching"] == {"rate": 0.5}


def test_configure_omits_interest_and_matching_when_rates_absent():
    """Design §4.2: `--weekly-rate` absent → `interest = null`; same
    for matching. Omitted rates must produce explicit `None` fields
    (not missing keys), so Firestore records "disabled" atomically."""
    runner = CliRunner()
    mock_ref = MagicMock()
    mock_snap = MagicMock()
    mock_snap.exists = True
    mock_snap.to_dict.return_value = {"name": "Sam"}
    mock_ref.get.return_value = mock_snap
    mock_admin = MagicMock()
    mock_admin.db.document.return_value = mock_ref

    with _patched_admin(mock_admin):
        result = runner.invoke(main, [
            "--project", "emu",
            "vault",
            "--email", "p@x.com",
            "--password", "pw",
            "configure",
            "--child-id", "child-1",
            "--target", "25.00",
        ])

    assert result.exit_code == 0, result.output
    args, _ = mock_ref.update.call_args
    (payload,) = args
    vault = payload["vault"]
    assert vault["target"] == 2500
    assert vault["interest"] is None
    assert vault["matching"] is None


def test_configure_preserves_existing_balance_and_unlocked_at():
    """Reconfiguring a vault (changing target / interest / matching)
    must NOT wipe the balance the child has already saved. Likewise,
    an already-unlocked vault stays unlocked — the configure path is
    for knob-twiddling, not lifecycle state machine."""
    runner = CliRunner()
    existing_unlock = datetime(2026, 1, 1, tzinfo=timezone.utc)
    mock_ref = MagicMock()
    mock_snap = MagicMock()
    mock_snap.exists = True
    mock_snap.to_dict.return_value = {
        "name": "Sam",
        "vault": {
            "balance": 1234,
            "target": 5000,
            "unlockedAt": existing_unlock,
            "interest": None,
            "matching": None,
        },
    }
    mock_ref.get.return_value = mock_snap
    mock_admin = MagicMock()
    mock_admin.db.document.return_value = mock_ref

    with _patched_admin(mock_admin):
        result = runner.invoke(main, [
            "--project", "emu",
            "vault",
            "--email", "p@x.com",
            "--password", "pw",
            "configure",
            "--child-id", "child-1",
            "--target", "100.00",
            "--weekly-rate", "0.02",
        ])

    assert result.exit_code == 0, result.output
    args, _ = mock_ref.update.call_args
    (payload,) = args
    vault = payload["vault"]
    assert vault["balance"] == 1234
    assert vault["unlockedAt"] == existing_unlock
    assert vault["target"] == 10000
    assert vault["interest"]["weeklyRate"] == 0.02


def test_configure_rejects_missing_child():
    """No such child → refuse before writing, so we never materialise
    a phantom `children/{unknown}.vault` field via `update()` (which
    upserts the document for nested keys)."""
    runner = CliRunner()
    mock_snap = MagicMock()
    mock_snap.exists = False
    mock_ref = MagicMock()
    mock_ref.get.return_value = mock_snap
    mock_admin = MagicMock()
    mock_admin.db.document.return_value = mock_ref

    with _patched_admin(mock_admin):
        result = runner.invoke(main, [
            "--project", "emu",
            "vault",
            "--email", "p@x.com",
            "--password", "pw",
            "configure",
            "--child-id", "ghost",
            "--target", "10.00",
        ])

    assert result.exit_code != 0
    assert "ghost" in result.output
    mock_ref.update.assert_not_called()


# ─── show (Admin SDK) ──────────────────────────────────────────────

def test_show_prints_vault_map_fields():
    """Renders every field of a fully-configured vault map (balance,
    target, unlockedAt=null, interest rate, matching rate) so the
    operator can debug without an emulator UI tab open."""
    runner = CliRunner()
    mock_snap = MagicMock()
    mock_snap.exists = True
    mock_snap.to_dict.return_value = {
        "name": "Sam",
        "vault": {
            "balance": 4200,
            "target": 5000,
            "unlockedAt": None,
            "interest": {
                "weeklyRate": 0.01,
                "lastAccrualWrite": datetime(2026, 4, 18, tzinfo=timezone.utc),
            },
            "matching": {"rate": 0.5},
        },
    }
    mock_ref = MagicMock()
    mock_ref.get.return_value = mock_snap
    mock_admin = MagicMock()
    mock_admin.db.document.return_value = mock_ref

    with _patched_admin(mock_admin):
        result = runner.invoke(main, [
            "--project", "emu",
            "vault",
            "--email", "p@x.com",
            "--password", "pw",
            "show",
            "--child-id", "child-1",
        ])

    assert result.exit_code == 0, result.output
    assert "42.00" in result.output   # balance
    assert "50.00" in result.output   # target
    assert "saving" in result.output  # unlockedAt=null
    assert "0.01" in result.output    # weeklyRate
    assert "0.5" in result.output     # match rate


def test_show_reports_missing_vault():
    """`vault == null` (child exists, no vault configured yet) is not
    an error — it's the initial state. Print a hint toward `configure`
    instead of a raw map dump."""
    runner = CliRunner()
    mock_snap = MagicMock()
    mock_snap.exists = True
    mock_snap.to_dict.return_value = {"name": "Sam", "vault": None}
    mock_ref = MagicMock()
    mock_ref.get.return_value = mock_snap
    mock_admin = MagicMock()
    mock_admin.db.document.return_value = mock_ref

    with _patched_admin(mock_admin):
        result = runner.invoke(main, [
            "--project", "emu",
            "vault",
            "--email", "p@x.com",
            "--password", "pw",
            "show",
            "--child-id", "child-1",
        ])

    assert result.exit_code == 0, result.output
    assert "not configured" in result.output.lower()
    assert "configure" in result.output.lower()
