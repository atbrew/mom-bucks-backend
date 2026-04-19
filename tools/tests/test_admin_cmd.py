"""Tests for `mb admin reset`.

The reset nukes Firestore + Auth + Storage; the tests here check the
prod safety gate and the three-wipe sequence on dev/emu. Actual wipe
helpers (`_wipe_firestore`, `_wipe_auth`, `_wipe_storage`) are patched
out — we only assert that the command orchestrates them in the right
order and gates prod correctly.
"""
from __future__ import annotations

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
