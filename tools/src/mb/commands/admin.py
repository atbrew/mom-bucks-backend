"""Admin commands: `mb admin reset` + `mb admin fast-forward`.

`reset` is the last-resort nuke button. The activities/vault refresh is
a breaking schema change, so per design §8 we wipe the Firestore data,
the Auth users, and Storage profile photos rather than migrate. Prod is
protected by a double gate: `--yes-i-know-this-is-prod` *and* an
interactive typed confirmation.

`fast-forward` is an emulator-only time machine. The Firestore emulator
has no clock knob of its own — `serverTimestamp()` reads host time —
so to exercise multi-day scenarios (allowance claim cycles, interest
accrual over a week, unlock-then-reconfigure flows) we rewind the
relevant Firestore fields instead of trying to move the clock. It is
refused on `dev` and `prod` because those are shared environments
where moving a child's `lastAccrualWrite` backwards would mis-compute
real interest for real users.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import click
from rich.console import Console

from ..admin import AdminClient
from ..client import ProjectConfig

console = Console()


def _require_admin_sdk(config: ProjectConfig) -> AdminClient:
    """Open the Admin SDK; raise if the caller has no credentials."""
    sa_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not config.emulator and not sa_path:
        raise click.UsageError(
            "`mb admin` commands need Admin-SDK access. Either run against "
            "`--project emu`, or set GOOGLE_APPLICATION_CREDENTIALS to a "
            "service-account key.",
        )
    return AdminClient(config.project_id, sa_path)


def _wipe_firestore(admin) -> int:
    """Recursively delete every root collection. Returns #collections wiped."""
    wiped = 0
    for col in admin.db.collections():
        console.print(f"  Firestore: recursive delete [bold]{col.id}[/bold]…")
        admin.db.recursive_delete(col)
        wiped += 1
    return wiped


def _wipe_auth(admin) -> int:
    """Delete every Firebase Auth user in 1000-UID batches. Returns count."""
    from firebase_admin import auth

    uids = [u.uid for u in admin.list_users()]
    if not uids:
        return 0
    total = len(uids)
    deleted = 0
    for i in range(0, total, 1000):
        chunk = uids[i:i + 1000]
        result = auth.delete_users(chunk, app=admin.app)
        deleted += result.success_count
        if result.failure_count:
            for err in result.errors:
                bad_uid = chunk[err.index]
                console.print(
                    f"  [yellow]Auth: failed to delete {bad_uid}: "
                    f"{err.reason}[/yellow]"
                )
    return deleted


def _wipe_storage(project_id: str) -> int:
    """Delete objects under `children/` in the default bucket.

    Scoped to `children/` because that's where every user-uploaded file
    in this project lives (profile photos). Leaving Functions-generated
    artefacts elsewhere alone is safer than a blanket delete if the
    bucket grows other prefixes later.
    """
    from firebase_admin import storage

    bucket_name = f"{project_id}.firebasestorage.app"
    try:
        bucket = storage.bucket(bucket_name)
    except Exception as e:
        console.print(f"  [yellow]Storage: bucket unavailable ({e})[/yellow]")
        return 0

    try:
        blobs = list(bucket.list_blobs(prefix="children/"))
    except Exception as e:
        # Emulator may 404 on list when the bucket is empty / never used.
        console.print(f"  [yellow]Storage: list failed ({e})[/yellow]")
        return 0
    if not blobs:
        return 0
    try:
        bucket.delete_blobs(blobs)
    except Exception as e:
        console.print(f"  [yellow]Storage: batch delete failed ({e})[/yellow]")
        return 0
    return len(blobs)


@click.group("admin")
def admin_group() -> None:
    """Project-wide admin operations (reset, …)."""


@admin_group.command("reset")
@click.option(
    "--yes-i-know-this-is-prod",
    "yes_prod",
    is_flag=True,
    default=False,
    help="Required (along with interactive typed confirm) for --project prod.",
)
@click.pass_context
def reset(ctx: click.Context, yes_prod: bool) -> None:
    """Destroy Firestore + Auth + Storage data for the target project.

    Used after a breaking schema change to wipe the slate before
    re-seeding. Safe on the emulator (`make clean` already does this).
    On `--project dev` it's a single-step typed confirmation; on
    `--project prod` it requires both a typed-confirmation AND the
    `--yes-i-know-this-is-prod` flag.
    """
    config: ProjectConfig = ctx.obj["config"]
    alias: str = ctx.obj["project_alias"]

    if alias == "emu":
        pass
    elif alias == "prod":
        if not yes_prod:
            raise click.ClickException(
                "Refusing to wipe prod without --yes-i-know-this-is-prod.",
            )
        typed = click.prompt(
            "Type 'reset' (without quotes) to wipe mom-bucks PROD",
            default="",
            show_default=False,
        )
        if typed.strip() != "reset":
            raise click.ClickException("Aborted — confirmation text mismatch.")
    else:
        typed = click.prompt(
            f"Type 'reset' (without quotes) to wipe mom-bucks {alias.upper()}",
            default="",
            show_default=False,
        )
        if typed.strip() != "reset":
            raise click.ClickException("Aborted — confirmation text mismatch.")

    console.print(
        f"[bold red]About to wipe {alias} "
        f"({config.project_id})[/bold red]"
    )

    admin = _require_admin_sdk(config)
    try:
        console.print("\n[bold]1/3[/bold] Firestore…")
        wiped_cols = _wipe_firestore(admin)
        console.print(f"  [green]OK[/green] wiped {wiped_cols} collection(s)")

        console.print("\n[bold]2/3[/bold] Auth users…")
        deleted_users = _wipe_auth(admin)
        console.print(f"  [green]OK[/green] deleted {deleted_users} user(s)")

        console.print("\n[bold]3/3[/bold] Storage (children/*)…")
        deleted_blobs = _wipe_storage(config.project_id)
        console.print(f"  [green]OK[/green] deleted {deleted_blobs} object(s)")
    finally:
        admin.close()

    console.print("\n[bold green]Reset complete.[/bold green]")


# ─── fast-forward ──────────────────────────────────────────────────

def _rewind_activities(
    admin: AdminClient,
    child_id: str,
    offset: timedelta,
    dry_run: bool,
) -> tuple[int, int]:
    """Rewind every activity's `nextClaimAt` by `offset`.

    Returns `(rewound, skipped)`. Activities without a `nextClaimAt`
    are skipped — they'd be malformed anyway (the callables always
    write one on create), but the fast-forwarder is a debug tool,
    not a repair tool.
    """
    col = admin.db.collection(f"children/{child_id}/activities")
    rewound = 0
    skipped = 0
    for doc in col.stream():
        data = doc.to_dict() or {}
        next_at = data.get("nextClaimAt")
        if not isinstance(next_at, datetime):
            skipped += 1
            continue
        new_at = next_at - offset
        title = data.get("title", doc.id)
        console.print(
            f"  activity [bold]{title}[/bold] "
            f"nextClaimAt: {next_at.isoformat()} → {new_at.isoformat()}"
        )
        if not dry_run:
            doc.reference.update({"nextClaimAt": new_at})
        rewound += 1
    return rewound, skipped


def _rewind_vault_interest(
    admin: AdminClient,
    child_id: str,
    offset: timedelta,
    dry_run: bool,
) -> bool:
    """Rewind `children/{id}.vault.interest.lastAccrualWrite` by `offset`.

    Returns True if the field was rewound, False if it was absent
    (no vault, no interest config, or no `lastAccrualWrite`). Uses a
    dotted-path update so a concurrent `depositToVault` writing
    `vault.balance` doesn't race with the rewind.
    """
    ref = admin.db.document(f"children/{child_id}")
    snap = ref.get()
    if not snap.exists:
        raise click.ClickException(f"Child {child_id} not found.")
    data = snap.to_dict() or {}
    interest = ((data.get("vault") or {}).get("interest")) or None
    if not interest:
        return False
    last = interest.get("lastAccrualWrite")
    if not isinstance(last, datetime):
        return False
    new_last = last - offset
    console.print(
        f"  vault.interest.lastAccrualWrite: "
        f"{last.isoformat()} → {new_last.isoformat()}"
    )
    if not dry_run:
        ref.update({"vault.interest.lastAccrualWrite": new_last})
    return True


@admin_group.command("fast-forward")
@click.option("--child-id", required=True, help="Child document ID.")
@click.option(
    "--days", required=True, type=float,
    help="How far to rewind, in days. Fractions are allowed (e.g. 0.5 = 12h).",
)
@click.option(
    "--dry-run", is_flag=True, default=False,
    help="Print the plan, don't write.",
)
@click.pass_context
def fast_forward(
    ctx: click.Context,
    child_id: str,
    days: float,
    dry_run: bool,
) -> None:
    """Rewind time-sensitive fields on a child (emulator only).

    The Firestore emulator uses host time for `serverTimestamp()` and
    has no per-request clock control, so to simulate elapsed time we
    rewind the fields the callables read from:

    \b
      children/{child_id}/activities/*/nextClaimAt
      children/{child_id}.vault.interest.lastAccrualWrite

    Rewinding by N days makes every activity's next claim N days
    earlier (claimable now if that puts it in the past) and makes the
    next vault write accrue N days of interest. The callables'
    schedule math then advances `nextClaimAt` forward from real-now
    on the next claim, so repeated fast-forward→claim cycles walk a
    realistic scenario without any real-world waiting.

    Scoped to `--project emu`. Refuses to run against dev or prod so
    a mis-typed alias can't silently corrupt a shared environment's
    interest clock.

    Example — simulate a week of interest accrual:

    \b
      mb --project emu vault configure --child-id X --target 50 --weekly-rate 0.01
      mb --project emu vault deposit --child-id X --amount 10
      mb --project emu admin fast-forward --child-id X --days 7
      mb --project emu vault claim-interest --child-id X
    """
    config: ProjectConfig = ctx.obj["config"]
    alias: str = ctx.obj["project_alias"]

    if alias != "emu":
        raise click.ClickException(
            f"fast-forward is emulator-only; refusing alias '{alias}'. "
            "Rewinding a shared environment's clock would mis-compute "
            "interest for other users.",
        )
    if days <= 0:
        raise click.UsageError("--days must be > 0.")

    offset = timedelta(days=days)
    console.print(
        f"[bold]{'[DRY-RUN] ' if dry_run else ''}"
        f"Fast-forward[/bold] child={child_id} by {days} day(s) "
        f"({offset.total_seconds():.0f}s)"
    )

    admin = _require_admin_sdk(config)
    try:
        console.print("\n[bold]1/2[/bold] Activities…")
        rewound, skipped = _rewind_activities(admin, child_id, offset, dry_run)
        console.print(
            f"  [green]OK[/green] rewound {rewound}, skipped {skipped}",
        )

        console.print("\n[bold]2/2[/bold] Vault interest…")
        did = _rewind_vault_interest(admin, child_id, offset, dry_run)
        console.print(
            f"  [green]OK[/green] {'rewound' if did else 'no interest config — skipped'}",
        )
    finally:
        admin.close()

    if dry_run:
        console.print("\n[yellow]Dry-run — no writes.[/yellow]")
    else:
        console.print("\n[bold green]Fast-forward complete.[/bold green]")
