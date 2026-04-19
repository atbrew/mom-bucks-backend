"""Admin commands: `mb admin reset` (destroy-and-rebuild).

This is the last-resort nuke button. The activities/vault refresh is a
breaking schema change, so per design §8 we wipe the Firestore data,
the Auth users, and Storage profile photos rather than migrate.

Prod is protected by a double gate: `--yes-i-know-this-is-prod` *and*
an interactive typed confirmation. No emergency flag combinations
bypass both.
"""

from __future__ import annotations

import os

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
            "`mb admin reset` needs Admin-SDK access. Either run against "
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
