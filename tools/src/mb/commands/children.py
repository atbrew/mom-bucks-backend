"""Children commands: create, list, update, delete, remove-parent."""

from __future__ import annotations

import os
from datetime import datetime, timezone

import click
from rich.console import Console
from rich.table import Table

from ..client import FirestoreClient, ProjectConfig, sign_in

console = Console()


def _try_resolve_emails(
    config: ProjectConfig, uids: list[str]
) -> dict[str, str]:
    """Best-effort UID → email resolution via the Admin SDK.

    Returns `{uid: email}` for every uid we can resolve, and silently
    drops the rest. Falls back to an empty dict if the Admin SDK
    isn't usable (no SA key on dev/prod). The caller is expected to
    render the raw UID for anything the map doesn't cover so the CLI
    keeps working when no SA is configured.
    """
    if not uids:
        return {}
    sa_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not config.emulator and not sa_path:
        return {}
    try:
        from ..admin import AdminClient
        admin = AdminClient(config.project_id, sa_path)
        return admin.get_emails_by_uid(uids)
    except Exception:
        return {}


def _format_parent(uid: str, emails: dict[str, str]) -> str:
    """Render a parent entry as email if resolvable, else UID."""
    return emails.get(uid, uid)


def _get_client(ctx: click.Context) -> FirestoreClient:
    config: ProjectConfig = ctx.obj["config"]
    email = ctx.obj.get("email")
    password = ctx.obj.get("password")
    if not email or not password:
        raise click.UsageError(
            "Use --email and --password on the parent group, or set "
            "MB_EMAIL and MB_PASSWORD environment variables."
        )
    token_data = sign_in(config, email, password)
    return FirestoreClient(config, token_data["idToken"], token_data["localId"])


@click.group("children")
@click.option("--email", envvar="MB_EMAIL", required=True, help="User email.")
@click.option("--password", envvar="MB_PASSWORD", required=True, help="User password.")
@click.pass_context
def children_group(ctx: click.Context, email: str, password: str) -> None:
    """Child management."""
    ctx.obj["email"] = email
    ctx.obj["password"] = password


@children_group.command("create")
@click.option("--name", required=True, help="Child name.")
@click.option(
    "--dob",
    "dob",
    required=True,
    type=click.DateTime(["%Y-%m-%d"]),
    help="Date of birth (YYYY-MM-DD).",
)
@click.option(
    "--photo",
    "photo_path",
    default=None,
    type=click.Path(exists=True),
    help="Path to profile photo (uploaded to Storage).",
)
@click.pass_context
def create_child(
    ctx: click.Context, name: str, dob: datetime, photo_path: str | None,
) -> None:
    """Create a new child."""
    client = _get_client(ctx)
    dob_utc = dob.replace(tzinfo=timezone.utc)
    child_id = client.create_doc_with_server_time(
        "children",
        {
            "name": name,
            "parentUids": [client.uid],
            "dateOfBirth": dob_utc,
            "balance": 0,
            "vaultBalance": 0,
            "createdByUid": client.uid,
            "version": 0,
            "lastTxnAt": None,
            "deletedAt": None,
            "activeCardId": None,
            "photoUrl": None,
        },
        server_time_fields=["createdAt"],
    )
    console.print(
        f"[green]Created child:[/green] {name} "
        f"(DOB {dob_utc.date().isoformat()}, ID: {child_id})"
    )
    if photo_path:
        storage_path = f"children/{child_id}/profile.jpg"
        client.upload_file(storage_path, photo_path)
        console.print(f"[green]Photo uploaded:[/green] {storage_path}")
        console.print("[dim]Waiting for photoUrl update...[/dim]")
        try:
            client.poll_doc_field(
                f"children/{child_id}", "photoUrl", storage_path,
                timeout_s=15, interval_s=3,
            )
            console.print(f"[green]photoUrl set.[/green]")
        except TimeoutError:
            console.print("[yellow]photoUrl not yet set — trigger may still be running.[/yellow]")


def _format_dob(dob_raw: object) -> str:
    if isinstance(dob_raw, datetime):
        return dob_raw.strftime("%Y-%m-%d")
    if isinstance(dob_raw, str):
        return dob_raw[:10]
    return "—"


def _format_euros(cents: int) -> str:
    return f"\u20ac{cents / 100:.2f}"


def _make_child_table(title: str) -> Table:
    table = Table(title=title)
    table.add_column("ID", overflow="fold")
    table.add_column("Name")
    table.add_column("DOB")
    table.add_column("Photo", overflow="fold")
    table.add_column("Parents", overflow="fold")
    table.add_column("Balance", justify="right")
    return table


def _child_row(
    child_id: str,
    child: dict,
    emails: dict[str, str] | None = None,
) -> tuple[str, ...]:
    parents = child.get("parentUids") or []
    emails = emails or {}
    rendered = [_format_parent(u, emails) for u in parents]
    return (
        child_id,
        child.get("name", "?"),
        _format_dob(child.get("dateOfBirth")),
        child.get("photoUrl") or "—",
        ", ".join(rendered) if rendered else "—",
        _format_euros(child.get("balance", 0)),
    )


def _child_table(
    title: str,
    child_id: str,
    child: dict,
    emails: dict[str, str] | None = None,
) -> Table:
    table = _make_child_table(title)
    table.add_row(*_child_row(child_id, child, emails))
    return table


@children_group.command("update")
@click.option("--child-id", required=True, help="Child document ID.")
@click.option("--name", default=None, help="New display name.")
@click.option(
    "--dob",
    "dob",
    default=None,
    type=click.DateTime(["%Y-%m-%d"]),
    help="New date of birth (YYYY-MM-DD). Must stay a valid date.",
)
@click.option(
    "--photo",
    "photo_path",
    default=None,
    type=click.Path(exists=True),
    help="Path to new profile photo (uploaded to Storage).",
)
@click.option(
    "--clear-photo",
    is_flag=True,
    default=False,
    help="Remove the profile photo (set photoUrl to null).",
)
@click.pass_context
def update_child(
    ctx: click.Context,
    child_id: str,
    name: str | None,
    dob: datetime | None,
    photo_path: str | None,
    clear_photo: bool,
) -> None:
    """Update mutable fields on a child (name, dateOfBirth, photo)."""
    if name is None and dob is None and photo_path is None and not clear_photo:
        raise click.UsageError("Pass at least one of --name, --dob, --photo, --clear-photo.")
    if photo_path and clear_photo:
        raise click.UsageError("Cannot use --photo and --clear-photo together.")
    config: ProjectConfig = ctx.obj["config"]
    client = _get_client(ctx)
    before = client.get_doc(f"children/{child_id}")
    if not before:
        console.print(f"[red]Child {child_id} not found.[/red]")
        raise SystemExit(1)
    emails = _try_resolve_emails(config, before.get("parentUids") or [])
    console.print(_child_table("Before", child_id, before, emails))
    fields: dict = {}
    if name is not None:
        fields["name"] = name
    if dob is not None:
        fields["dateOfBirth"] = dob.replace(tzinfo=timezone.utc)
    if clear_photo:
        fields["photoUrl"] = None
    if fields:
        client.update_doc(f"children/{child_id}", fields)
    if clear_photo:
        console.print("[green]Photo cleared.[/green]")
    if photo_path:
        storage_path = f"children/{child_id}/profile.jpg"
        client.upload_file(storage_path, photo_path)
        console.print(f"[green]Photo uploaded:[/green] {storage_path}")
        console.print("[dim]Waiting for photoUrl update...[/dim]")
        try:
            after = client.poll_doc_field(
                f"children/{child_id}", "photoUrl", storage_path,
                timeout_s=15, interval_s=3,
            )
        except TimeoutError:
            after = client.get_doc(f"children/{child_id}") or {}
    else:
        after = client.get_doc(f"children/{child_id}") or {}
    console.print(_child_table("After", child_id, after, emails))


@children_group.command("delete")
@click.option("--child-id", required=True, help="Child document ID.")
@click.option(
    "--yes",
    is_flag=True,
    default=False,
    help="Skip the confirmation prompt (for scripted cleanup).",
)
@click.pass_context
def delete_child(ctx: click.Context, child_id: str, yes: bool) -> None:
    """Permanently delete a child and all of their subcollection data.

    The child doc deletion fires the ``onChildDelete`` Cloud Function,
    which cascades to:
      - subcollections (transactions, vaultTransactions, activities)
      - profile image at ``children/{id}/profile.jpg`` (Storage)
      - orphaned invites where ``childId == id``

    For co-parented children this deletes the shared record for ALL
    parents — there's no per-parent "leave" semantics in this CLI.
    """
    client = _get_client(ctx)
    child = client.get_doc(f"children/{child_id}")
    if not child:
        console.print(f"[red]Child {child_id} not found.[/red]")
        raise SystemExit(1)

    parents = child.get("parentUids") or []
    co_parents = [u for u in parents if u != client.uid]

    config: ProjectConfig = ctx.obj["config"]
    emails = _try_resolve_emails(config, co_parents) if co_parents else {}

    console.print("[bold red]About to permanently delete:[/bold red]")
    console.print(f"  Child ID: {child_id}")
    console.print(f"  Name:     {child.get('name', '—')}")
    console.print(f"  DOB:      {_format_dob(child.get('dateOfBirth'))}")
    console.print(f"  Balance:  {_format_euros(child.get('balance', 0))}")
    if co_parents:
        rendered = [_format_parent(u, emails) for u in co_parents]
        console.print(
            f"  [yellow]Co-parents (will lose access): "
            f"{', '.join(rendered)}[/yellow]"
        )

    if not yes:
        click.confirm(
            "Proceed with deletion?",
            default=False,
            abort=True,
        )

    client.delete_doc(f"children/{child_id}")
    console.print(
        f"[green]Deleted[/green] children/{child_id} "
        "(subcollections + photo + invites cascade via onChildDelete)"
    )


@children_group.command("list")
@click.pass_context
def list_children(ctx: click.Context) -> None:
    """List children for the current user.

    Parent UIDs are resolved to emails via the Admin SDK when it is
    usable (emulator, or ``GOOGLE_APPLICATION_CREDENTIALS`` set on
    dev/prod). Falls back to UIDs otherwise so the command keeps
    working for anyone without an SA key.
    """
    config: ProjectConfig = ctx.obj["config"]
    client = _get_client(ctx)
    children = client.query(
        "children", "parentUids", "ARRAY_CONTAINS", client.uid,
    )
    if not children:
        console.print("[dim]No children found.[/dim]")
        return
    all_uids: list[str] = []
    for child in children:
        all_uids.extend(child.get("parentUids") or [])
    emails = _try_resolve_emails(config, all_uids)
    table = _make_child_table("Children")
    for child in children:
        table.add_row(*_child_row(child.get("_id", "?"), child, emails))
    console.print(table)


@children_group.command("remove-parent")
@click.option("--child-id", required=True, help="Child document ID.")
@click.option(
    "--target-email",
    default=None,
    help=(
        "Email of the co-parent to remove. Resolved to a UID via the "
        "Admin SDK — requires emulator mode or "
        "GOOGLE_APPLICATION_CREDENTIALS on dev/prod."
    ),
)
@click.option(
    "--target-uid",
    default=None,
    help="UID of the co-parent to remove (bypasses Admin SDK lookup).",
)
@click.pass_context
def remove_parent(
    ctx: click.Context,
    child_id: str,
    target_email: str | None,
    target_uid: str | None,
) -> None:
    """Remove a co-parent from a child via removeParentFromChildren.

    Use this after an invite has already been accepted — revokeInvite
    refuses to erase the audit trail, so access is removed at the
    child level instead. The callable guards against orphaning (won't
    remove the last parent).
    """
    if bool(target_email) == bool(target_uid):
        raise click.UsageError(
            "Pass exactly one of --target-email or --target-uid.",
        )

    config: ProjectConfig = ctx.obj["config"]
    client = _get_client(ctx)

    if target_email:
        sa_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        if not config.emulator and not sa_path:
            raise click.UsageError(
                "--target-email requires GOOGLE_APPLICATION_CREDENTIALS "
                "on dev/prod. Pass --target-uid instead, or set the env "
                "var.",
            )
        from ..admin import AdminClient
        admin = AdminClient(config.project_id, sa_path)
        rec = admin.get_user_by_email(target_email)
        if rec is None:
            console.print(
                f"[red]No Firebase Auth user found for {target_email}[/red]"
            )
            raise SystemExit(1)
        target_uid = rec.uid

    assert target_uid is not None
    result = client.call_function(
        "removeParentFromChildren",
        {"targetUid": target_uid, "childIds": [child_id]},
    )
    removed = result.get("removedFrom") or []
    skipped = result.get("skipped") or []
    target_label = target_email or target_uid
    if child_id in removed:
        console.print(
            f"[green]Removed[/green] {target_label} from children/{child_id}."
        )
        return
    # Per-child skips surface as a structured reason from the callable.
    reason = next(
        (s.get("reason") for s in skipped if s.get("childId") == child_id),
        "UNKNOWN",
    )
    console.print(
        f"[yellow]Not removed[/yellow] (reason: {reason}). "
        "See removeParentFromChildren docs for what each reason means."
    )
    raise SystemExit(1)
