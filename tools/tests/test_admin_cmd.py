"""Tests for `mb admin reset` and `mb admin fast-forward`.

Reset nukes Firestore + Auth + Storage; its tests check the prod
safety gate and the three-wipe sequence on dev/emu. Actual wipe
helpers (`_wipe_firestore`, `_wipe_auth`, `_wipe_storage`) are patched
out — we only assert that the command orchestrates them in the right
order and gates prod correctly.

Fast-forward rewinds `nextClaimAt` on activities and
`vault.interest.lastAccrualWrite` on the child doc. Its tests assert
the emulator-only gate and that the two rewind helpers apply the
offset without touching unrelated fields.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

from click.testing import CliRunner

from mb.cli import main


def _patch_all(admin_obj: MagicMock):
    """Patch the three `_wipe_*` helpers + AdminClient so the reset
    command exercises only the orchestration path."""
    return (
        patch("mb.commands.admin.AdminClient", return_value=admin_obj),
        patch("mb.commands.admin._wipe_firestore", return_value=3),
        patch("mb.commands.admin._wipe_auth", return_value=5),
        patch("mb.commands.admin._wipe_storage", return_value=2),
    )


def test_reset_runs_all_three_wipe_steps_on_emu():
    """Happy path on the emulator alias: all three `_wipe_*` helpers
    must fire, in order, and AdminClient.close() must be called on the
    way out so the firebase_admin app name is freed."""
    runner = CliRunner()
    mock_admin = MagicMock()
    pa, pf, pu, ps = _patch_all(mock_admin)

    with pa, pf as fire, pu as user, ps as stor:
        result = runner.invoke(main, ["--project", "emu", "admin", "reset"])

    assert result.exit_code == 0, result.output
    fire.assert_called_once_with(mock_admin)
    user.assert_called_once_with(mock_admin)
    stor.assert_called_once_with("mom-bucks-dev-b3772")
    mock_admin.close.assert_called_once()
    # Counts bubble up to the operator.
    assert "3 collection" in result.output
    assert "5 user" in result.output
    assert "2 object" in result.output


def test_reset_refuses_prod_without_flag():
    """First prod gate: `--yes-i-know-this-is-prod` absent → refuse
    before ever touching Admin SDK. Regression guard: if the flag
    check slips, we want `_wipe_firestore` to be observably not called."""
    runner = CliRunner()
    mock_admin = MagicMock()
    pa, pf, pu, ps = _patch_all(mock_admin)

    with pa as admin_cls, pf as fire, pu as user, ps as stor:
        result = runner.invoke(main, ["--project", "prod", "admin", "reset"])

    assert result.exit_code != 0
    assert "prod" in result.output.lower()
    admin_cls.assert_not_called()
    fire.assert_not_called()
    user.assert_not_called()
    stor.assert_not_called()


def test_reset_refuses_prod_when_typed_confirmation_mismatches():
    """Second prod gate: flag is present, but the user types 'no'.
    The command must abort before wiping anything."""
    runner = CliRunner()
    mock_admin = MagicMock()
    pa, pf, pu, ps = _patch_all(mock_admin)

    with pa as admin_cls, pf as fire, pu, ps:
        result = runner.invoke(
            main,
            [
                "--project", "prod",
                "admin", "reset",
                "--yes-i-know-this-is-prod",
            ],
            input="not-reset\n",
        )

    assert result.exit_code != 0
    assert "confirmation" in result.output.lower()
    admin_cls.assert_not_called()
    fire.assert_not_called()


def test_reset_proceeds_on_prod_with_both_gates_satisfied(monkeypatch):
    """Both gates OK → the command goes through. Guards against over-
    tightening the prod gates in a future change that would then make
    the reset command un-runnable for a deliberate prod wipe.

    GOOGLE_APPLICATION_CREDENTIALS must be set on a real prod wipe, so
    we simulate that here with monkeypatch — otherwise _require_admin_sdk
    would refuse before any of the patched `_wipe_*` helpers fired.
    """
    runner = CliRunner()
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", "/tmp/fake-sa.json")
    mock_admin = MagicMock()
    pa, pf, pu, ps = _patch_all(mock_admin)

    with pa, pf as fire, pu as user, ps as stor:
        result = runner.invoke(
            main,
            [
                "--project", "prod",
                "admin", "reset",
                "--yes-i-know-this-is-prod",
            ],
            input="reset\n",
        )

    assert result.exit_code == 0, result.output
    fire.assert_called_once_with(mock_admin)
    user.assert_called_once_with(mock_admin)
    stor.assert_called_once_with("mom-bucks-prod-81096")


# ─── fast-forward ──────────────────────────────────────────────────

def _make_activity_doc(doc_id: str, next_at: datetime | None, title: str):
    """Fake Firestore ActivitySnapshot for `collection.stream()` iteration."""
    ref = MagicMock()
    ref.update = MagicMock()
    snap = MagicMock()
    snap.id = doc_id
    snap.reference = ref
    snap.to_dict.return_value = {
        "title": title,
        "nextClaimAt": next_at,
    }
    return snap, ref


def _fake_admin_with_activities(activity_snaps, vault_doc):
    """Build a MagicMock AdminClient whose `.db` returns activities
    via `.collection(...).stream()` and the child doc via `.document(...).get()`.

    `vault_doc` is the child doc's `.to_dict()` payload (or None → not found).
    """
    admin = MagicMock()

    col = MagicMock()
    col.stream.return_value = iter(activity_snaps)
    doc_ref = MagicMock()
    snap = MagicMock()
    snap.exists = vault_doc is not None
    snap.to_dict.return_value = vault_doc or {}
    doc_ref.get.return_value = snap
    doc_ref.update = MagicMock()

    def collection_side_effect(path: str):
        if path.endswith("/activities"):
            return col
        raise AssertionError(f"unexpected collection path: {path}")

    def document_side_effect(path: str):
        if path.startswith("children/") and "/" not in path[len("children/"):]:
            return doc_ref
        raise AssertionError(f"unexpected document path: {path}")

    admin.db.collection.side_effect = collection_side_effect
    admin.db.document.side_effect = document_side_effect
    return admin, doc_ref


def test_fast_forward_refuses_non_emu_aliases():
    """Emulator-only gate: fast-forward must refuse `dev` and `prod`.

    Regression guard against a future operator looking at this command
    as a "quick way to make an activity claimable" on a shared project,
    which would silently shift other users' interest accrual windows.
    """
    runner = CliRunner()
    with patch("mb.commands.admin.AdminClient") as admin_cls:
        for alias in ("dev", "prod"):
            result = runner.invoke(
                main,
                [
                    "--project", alias,
                    "admin", "fast-forward",
                    "--child-id", "c1",
                    "--days", "7",
                ],
            )
            assert result.exit_code != 0, result.output
            assert "emulator-only" in result.output
        admin_cls.assert_not_called()


def test_fast_forward_refuses_non_positive_days():
    """`--days 0` and `--days -1` should be UsageErrors — a zero or
    negative offset is either a no-op or a "fast-backward" that makes
    no sense against the wall clock."""
    runner = CliRunner()
    with patch("mb.commands.admin.AdminClient") as admin_cls:
        for days in ("0", "-1"):
            result = runner.invoke(
                main,
                [
                    "--project", "emu",
                    "admin", "fast-forward",
                    "--child-id", "c1",
                    "--days", days,
                ],
            )
            assert result.exit_code != 0
        admin_cls.assert_not_called()


def test_fast_forward_rewinds_activities_and_interest():
    """Happy path: two activities + an interest-enabled vault. The
    rewind must apply the same offset to every `nextClaimAt` and to
    `vault.interest.lastAccrualWrite`, using a dotted-path update so
    concurrent `vault.balance` writes don't race.
    """
    runner = CliRunner()
    base = datetime(2026, 4, 19, 12, 0, tzinfo=timezone.utc)
    snap_a, ref_a = _make_activity_doc("a1", base, "Take out bins")
    snap_b, ref_b = _make_activity_doc(
        "a2", base + timedelta(days=1), "Tidy room",
    )
    vault_doc = {
        "vault": {
            "balance": 100,
            "target": 500,
            "unlockedAt": None,
            "interest": {
                "weeklyRate": 0.01,
                "lastAccrualWrite": base,
            },
            "matching": None,
        },
    }
    admin, child_ref = _fake_admin_with_activities(
        [snap_a, snap_b], vault_doc,
    )

    with patch("mb.commands.admin.AdminClient", return_value=admin):
        result = runner.invoke(
            main,
            [
                "--project", "emu",
                "admin", "fast-forward",
                "--child-id", "c1",
                "--days", "7",
            ],
        )

    assert result.exit_code == 0, result.output
    # Both activities rewound by exactly 7 days.
    ref_a.update.assert_called_once_with(
        {"nextClaimAt": base - timedelta(days=7)},
    )
    ref_b.update.assert_called_once_with(
        {"nextClaimAt": (base + timedelta(days=1)) - timedelta(days=7)},
    )
    # Interest clock rewound via dotted-path update (preserves balance).
    child_ref.update.assert_called_once_with(
        {"vault.interest.lastAccrualWrite": base - timedelta(days=7)},
    )
    admin.close.assert_called_once()
    assert "rewound 2" in result.output


def test_fast_forward_skips_activities_without_next_claim_at():
    """An activity missing `nextClaimAt` is malformed (the callables
    always write one), but the fast-forwarder is a debug tool — skip
    quietly rather than crash mid-run and leave partial writes."""
    runner = CliRunner()
    base = datetime(2026, 4, 19, 12, 0, tzinfo=timezone.utc)
    snap_ok, ref_ok = _make_activity_doc("a1", base, "Take out bins")
    snap_broken, ref_broken = _make_activity_doc("a2", None, "Missing field")
    vault_doc = {"vault": None}
    admin, _ = _fake_admin_with_activities(
        [snap_ok, snap_broken], vault_doc,
    )

    with patch("mb.commands.admin.AdminClient", return_value=admin):
        result = runner.invoke(
            main,
            [
                "--project", "emu",
                "admin", "fast-forward",
                "--child-id", "c1",
                "--days", "3",
            ],
        )

    assert result.exit_code == 0, result.output
    ref_ok.update.assert_called_once()
    ref_broken.update.assert_not_called()
    assert "rewound 1, skipped 1" in result.output


def test_fast_forward_skips_when_no_interest_config():
    """No vault, or a vault with `interest: null`, should rewind
    activities only — no child-doc update, no crash. Needed because
    plain savings goals (no weekly rate) are a valid config."""
    runner = CliRunner()
    base = datetime(2026, 4, 19, 12, 0, tzinfo=timezone.utc)
    snap, _ = _make_activity_doc("a1", base, "Take out bins")
    vault_doc = {"vault": {"balance": 0, "target": 500, "interest": None}}
    admin, child_ref = _fake_admin_with_activities([snap], vault_doc)

    with patch("mb.commands.admin.AdminClient", return_value=admin):
        result = runner.invoke(
            main,
            [
                "--project", "emu",
                "admin", "fast-forward",
                "--child-id", "c1",
                "--days", "2",
            ],
        )

    assert result.exit_code == 0, result.output
    child_ref.update.assert_not_called()
    assert "no interest config" in result.output


def test_fast_forward_dry_run_writes_nothing():
    """`--dry-run` prints the plan but must not call `.update()` on
    any ref. Regression guard for the common "I forgot the flag"
    foot-gun."""
    runner = CliRunner()
    base = datetime(2026, 4, 19, 12, 0, tzinfo=timezone.utc)
    snap, ref = _make_activity_doc("a1", base, "Take out bins")
    vault_doc = {
        "vault": {
            "balance": 100,
            "target": 500,
            "interest": {"weeklyRate": 0.01, "lastAccrualWrite": base},
        },
    }
    admin, child_ref = _fake_admin_with_activities([snap], vault_doc)

    with patch("mb.commands.admin.AdminClient", return_value=admin):
        result = runner.invoke(
            main,
            [
                "--project", "emu",
                "admin", "fast-forward",
                "--child-id", "c1",
                "--days", "5",
                "--dry-run",
            ],
        )

    assert result.exit_code == 0, result.output
    ref.update.assert_not_called()
    child_ref.update.assert_not_called()
    assert "Dry-run" in result.output
