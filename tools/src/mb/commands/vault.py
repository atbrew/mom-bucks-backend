"""Vault commands: configure, deposit, claim-interest, preview, unlock, show.

Most commands are thin wrappers around Cloud Functions callables
(business logic in `functions/src/handlers/*.ts`). `configure` is the
one exception: no `configureVault` callable exists yet (deferred per
design §2), so this command writes `children.vault` directly via the
Admin SDK. `show` is a debug/read helper, also via the Admin SDK.

All monetary values on the CLI surface are **euros** (float). The
callables speak integer cents — conversion happens in this module.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

import click
from rich.console import Console
from rich.table import Table

from ..admin import AdminClient
from ..client import FirestoreClient, ProjectConfig, sign_in

console = Console()


# ─── Helpers ──────────────────────────────────────────────────────

def _euros_to_cents(amount: float) -> int:
    """Convert a euro amount to integer cents, rounding half-to-even."""
    return round(amount * 100)


def _format_cents(cents: int | None) -> str:
    """Render an integer-cents amount as a Euro string. None → '—'."""
    if cents is None:
        return "—"
    return f"\u20ac{cents / 100:.2f}"


def _get_client(ctx: click.Context) -> FirestoreClient:
    """Sign in and return a FirestoreClient for callable commands."""
    config: ProjectConfig = ctx.obj["config"]
    email = ctx.obj.get("email")
    password = ctx.obj.get("password")
    if not email or not password:
        raise click.UsageError("Use --email and --password on the parent group.")
    token_data = sign_in(config, email, password)
    return FirestoreClient(config, token_data["idToken"], token_data["localId"])


def _admin_client(config: ProjectConfig) -> AdminClient:
    """Open an Admin-SDK client, or raise a helpful UsageError."""
    sa_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not config.emulator and not sa_path:
        raise click.UsageError(
            "`mb vault configure` / `mb vault show` need Admin-SDK access. "
            "Either run against `--project emu`, or set "
            "GOOGLE_APPLICATION_CREDENTIALS to a service-account key.",
        )
    return AdminClient(config.project_id, sa_path)


# ─── Group ────────────────────────────────────────────────────────

@click.group("vault")
@click.option("--email", envvar="MB_EMAIL", required=True, help="User email.")
@click.option("--password", envvar="MB_PASSWORD", required=True, help="User password.")
@click.pass_context
def vault_group(ctx: click.Context, email: str, password: str) -> None:
    """Vault management (interest, matching, deposit/unlock cycle)."""
    ctx.obj["email"] = email
    ctx.obj["password"] = password


# ─── configure (Admin SDK) ────────────────────────────────────────

@vault_group.command("configure")
@click.option("--child-id", required=True, help="Child document ID.")
@click.option(
    "--target", required=True, type=float,
    help="Savings target in euros.",
)
@click.option(
    "--weekly-rate", "weekly_rate", default=None, type=float,
    help=(
        "Weekly interest rate as a decimal (0.01 = 1%/week). "
        "Omit to disable interest."
    ),
)
@click.option(
    "--match-rate", "match_rate", default=None, type=float,
    help=(
        "Match rate as a decimal (0.5 = 50% bonus on deposits, "
        "1.0 = dollar-for-dollar). Omit to disable matching."
    ),
)
@click.pass_context
def configure_vault(
    ctx: click.Context,
    child_id: str,
    target: float,
    weekly_rate: float | None,
    match_rate: float | None,
) -> None:
    """Write the child.vault nested map via the Admin SDK.

    A `configureVault` callable is deferred (design §2); this command
    fills the gap for the CLI until that exists. Target, interest, and
    matching are overwritten atomically. Existing `balance` and
    `unlockedAt` are preserved — reconfiguring a vault must never wipe
    savings the child has already accumulated.
    """
    config: ProjectConfig = ctx.obj["config"]
    target_cents = _euros_to_cents(target)
    if target_cents <= 0:
        raise click.UsageError("--target must be > 0.")
    if weekly_rate is not None and weekly_rate < 0:
        raise click.UsageError("--weekly-rate must be >= 0.")
    if match_rate is not None and match_rate < 0:
        raise click.UsageError("--match-rate must be >= 0.")

    now = datetime.now(timezone.utc)

    admin = _admin_client(config)
    try:
        ref = admin.db.document(f"children/{child_id}")
        snap = ref.get()
        if not snap.exists:
            raise click.ClickException(f"Child {child_id} not found.")
        existing = (snap.to_dict() or {}).get("vault") or {}
        existing_balance = int(existing.get("balance", 0) or 0)
        existing_unlocked_at = existing.get("unlockedAt")
        vault_map: dict[str, Any] = {
            "balance": existing_balance,
            "target": target_cents,
            "unlockedAt": existing_unlocked_at,
            "interest": (
                None
                if weekly_rate is None
                else {"weeklyRate": weekly_rate, "lastAccrualWrite": now}
            ),
            "matching": None if match_rate is None else {"rate": match_rate},
        }
        ref.update({"vault": vault_map})
    finally:
        admin.close()

    bits = [f"target={_format_cents(target_cents)}"]
    bits.append("interest=off" if weekly_rate is None
                else f"interest={weekly_rate:g}/wk")
    bits.append("matching=off" if match_rate is None
                else f"matching={match_rate:g}")
    console.print(f"[green]Vault configured:[/green] " + ", ".join(bits))


# ─── deposit (callable) ──────────────────────────────────────────

@vault_group.command("deposit")
@click.option("--child-id", required=True, help="Child document ID.")
@click.option(
    "--amount", required=True, type=float,
    help="Amount to deposit from main balance, in euros.",
)
@click.pass_context
def deposit_to_vault(ctx: click.Context, child_id: str, amount: float) -> None:
    """Call depositToVault (interest first, deposit, match, unlock check)."""
    client = _get_client(ctx)
    amount_cents = _euros_to_cents(amount)
    result = client.call_function("depositToVault", {
        "childId": child_id,
        "amount": amount_cents,
    })
    interest = int(result.get("interestClaimed", 0))
    deposited = int(result.get("deposited", 0))
    matched = int(result.get("matched", 0))
    remained = int(result.get("remainedInMain", 0))
    unlocked = bool(result.get("unlocked", False))
    console.print(
        f"[green]Deposit accepted:[/green] "
        f"interest={_format_cents(interest)}, "
        f"deposited={_format_cents(deposited)}, "
        f"matched={_format_cents(matched)}, "
        f"remained-in-main={_format_cents(remained)}, "
        f"unlocked={'yes' if unlocked else 'no'}"
    )


# ─── claim-interest (callable) ───────────────────────────────────

@vault_group.command("claim-interest")
@click.option("--child-id", required=True, help="Child document ID.")
@click.pass_context
def claim_interest(ctx: click.Context, child_id: str) -> None:
    """Call claimInterest. No-op if nothing has accrued."""
    client = _get_client(ctx)
    result = client.call_function("claimInterest", {"childId": child_id})
    paid = int(result.get("paid", 0))
    unlocked = bool(result.get("unlocked", False))
    console.print(
        f"[green]Interest claimed:[/green] paid={_format_cents(paid)}, "
        f"unlocked={'yes' if unlocked else 'no'}"
    )


# ─── preview (callable) ──────────────────────────────────────────

@vault_group.command("preview")
@click.option("--child-id", required=True, help="Child document ID.")
@click.pass_context
def preview_interest(ctx: click.Context, child_id: str) -> None:
    """Call getClaimableInterest (read-only; safe to poll)."""
    client = _get_client(ctx)
    result = client.call_function("getClaimableInterest", {"childId": child_id})
    claimable = int(result.get("claimable", 0))
    console.print(
        f"[green]Claimable interest:[/green] {_format_cents(claimable)}"
    )


# ─── unlock (callable) ───────────────────────────────────────────

@vault_group.command("unlock")
@click.option("--child-id", required=True, help="Child document ID.")
@click.pass_context
def unlock(ctx: click.Context, child_id: str) -> None:
    """Call unlockVault. Rejects if vault isn't at target yet."""
    client = _get_client(ctx)
    result = client.call_function("unlockVault", {"childId": child_id})
    released = int(result.get("released", 0))
    console.print(
        f"[green]Vault released:[/green] {_format_cents(released)} → main balance"
    )


# ─── show (Admin SDK) ────────────────────────────────────────────

@vault_group.command("show")
@click.option("--child-id", required=True, help="Child document ID.")
@click.pass_context
def show_vault(ctx: click.Context, child_id: str) -> None:
    """Print the child.vault nested map via Admin SDK (debug view)."""
    config: ProjectConfig = ctx.obj["config"]
    admin = _admin_client(config)
    try:
        snap = admin.db.document(f"children/{child_id}").get()
        if not snap.exists:
            raise click.ClickException(f"Child {child_id} not found.")
        data = snap.to_dict() or {}
    finally:
        admin.close()

    vault = data.get("vault")
    if vault is None:
        console.print(
            "[yellow]Vault not configured.[/yellow] "
            "Use `mb vault configure` to set one up."
        )
        return

    table = Table(title=f"Vault — {data.get('name', child_id)}")
    table.add_column("Field")
    table.add_column("Value")
    table.add_row("balance", _format_cents(vault.get("balance")))
    table.add_row("target", _format_cents(vault.get("target")))
    unlocked_at = vault.get("unlockedAt")
    table.add_row(
        "unlockedAt",
        unlocked_at.isoformat() if unlocked_at else "— (saving)",
    )
    interest = vault.get("interest")
    if interest is None:
        table.add_row("interest", "disabled")
    else:
        rate = interest.get("weeklyRate")
        last = interest.get("lastAccrualWrite")
        table.add_row(
            "interest.weeklyRate",
            f"{rate:g}" if isinstance(rate, (int, float)) else "—",
        )
        table.add_row(
            "interest.lastAccrualWrite",
            last.isoformat() if last else "—",
        )
    matching = vault.get("matching")
    if matching is None:
        table.add_row("matching", "disabled")
    else:
        rate = matching.get("rate")
        table.add_row(
            "matching.rate",
            f"{rate:g}" if isinstance(rate, (int, float)) else "—",
        )
    console.print(table)
