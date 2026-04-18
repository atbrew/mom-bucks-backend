"""Auth commands: create, list, update, delete, login.

Mirrors the children command surface (create / list / update / delete)
for parity. `update` merges the old `set-photo` behaviour with name
changes; `--photo` and `--clear-photo` are mutually exclusive.

`login` is unique to auth (no children equivalent) — it's a quick
credential check that prints the current profile.
"""

from __future__ import annotations

import os

import click
from rich.console import Console
from rich.table import Table

from firebase_admin._auth_utils import EmailAlreadyExistsError

from ..admin import AdminClient
from ..client import FirestoreClient, ProjectConfig, sign_in

console = Console()


def _user_table(title: str, uid: str, email: str, user_doc: dict | None) -> Table:
    table = Table(title=title)
    table.add_column("UID", overflow="fold")
    table.add_column("Name")
    table.add_column("Email")
    table.add_column("Photo", overflow="fold")
    name = (user_doc or {}).get("displayName", "—")
    photo = (user_doc or {}).get("photoUrl") or "—"
    table.add_row(uid, name, email, photo)
    return table


def _sign_in_client(config: ProjectConfig, email: str, password: str) -> FirestoreClient:
    """Sign in and return a FirestoreClient.

    AuthError is allowed to propagate so the CLI-wide MbGroup handler
    in cli.py renders it as a clean Click error. Catching it here
    would create two divergent error paths (sys.exit vs ClickException)
    and lose that uniformity.
    """
    token_data = sign_in(config, email, password)
    return FirestoreClient(config, token_data["idToken"], token_data["localId"])


@click.group("auth")
def auth_group() -> None:
    """Account management."""


@auth_group.command("create")
@click.option("--email", required=True, help="User email.")
@click.option("--password", required=True, help="User password.")
@click.option("--name", required=True, help="Display name.")
@click.option(
    "--photo",
    "photo_path",
    default=None,
    type=click.Path(exists=True),
    help="Path to profile photo (uploaded to Storage).",
)
@click.pass_context
def create_account(
    ctx: click.Context,
    email: str,
    password: str,
    name: str,
    photo_path: str | None,
) -> None:
    """Create a new Firebase Auth user and sign in."""
    config: ProjectConfig = ctx.obj["config"]
    sa_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    admin = AdminClient(config.project_id, sa_path)
    try:
        try:
            uid = admin.create_user(email, password, name)
        except EmailAlreadyExistsError:
            console.print(
                f"[yellow]User {email} already exists.[/yellow]\n"
                f"  Run: uv run mb auth login --email {email} --password ..."
            )
            raise SystemExit(1)
        console.print(f"[green]Created user:[/green] {uid}")
        # The onUserCreated Cloud Function creates a skeleton users/{uid}
        # doc. We then sign in and write the displayName ourselves —
        # the blocking trigger's event.data can't be trusted to include
        # displayName for Admin-SDK-created users.
        client = _sign_in_client(config, email, password)
        console.print("[dim]Waiting for user doc...[/dim]")
        try:
            client.poll_doc_field(
                f"users/{uid}", "email", email,
                timeout_s=15, interval_s=3,
            )
        except TimeoutError:
            pass
        client.update_doc(f"users/{uid}", {"displayName": name})
        user_doc = client.get_doc(f"users/{uid}")
        if photo_path:
            storage_path = f"users/{uid}/profile.jpg"
            client.upload_file(storage_path, photo_path)
            console.print(f"[green]Photo uploaded:[/green] {storage_path}")
            console.print("[dim]Waiting for photoUrl update...[/dim]")
            try:
                user_doc = client.poll_doc_field(
                    f"users/{uid}", "photoUrl", storage_path,
                    timeout_s=15, interval_s=3,
                )
            except TimeoutError:
                user_doc = client.get_doc(f"users/{uid}")
        console.print(_user_table("Account", uid, email, user_doc))
    finally:
        admin.close()


@auth_group.command("list")
@click.pass_context
def list_users(ctx: click.Context) -> None:
    """List all Firebase Auth users in the project (admin-only)."""
    config: ProjectConfig = ctx.obj["config"]
    sa_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    admin = AdminClient(config.project_id, sa_path)
    try:
        users = admin.list_users()
        if not users:
            console.print("[dim]No users found.[/dim]")
            return
        rows = []
        for user in users:
            created = _ms_to_date(
                getattr(user.user_metadata, "creation_timestamp", None)
            )
            last_signin = _ms_to_date(
                getattr(user.user_metadata, "last_sign_in_timestamp", None)
            )
            rows.append((
                user.uid,
                user.display_name or "—",
                user.email or "—",
                created,
                last_signin,
                "yes" if user.disabled else "no",
            ))
        headers = ("UID", "Name", "Email", "Created", "Last Sign-in", "Disabled")
        widths = [
            max(len(h), *(len(r[i]) for r in rows))
            for i, h in enumerate(headers)
        ]
        # Table chrome adds ~ (2*cols)+cols+1 for padding + separators.
        needed = sum(widths) + 3 * len(widths) + 1
        wide = Console(width=max(needed, console.width))
        table = Table(title=f"Users ({config.project_id})")
        for h, w in zip(headers, widths):
            table.add_column(h, no_wrap=True, min_width=w)
        for row in rows:
            table.add_row(*row)
        wide.print(table)
    finally:
        admin.close()


def _ms_to_date(ms: int | None) -> str:
    """Format an epoch-millisecond timestamp as YYYY-MM-DD, or — if None."""
    if not ms:
        return "—"
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime(
        "%Y-%m-%d",
    )


@auth_group.command("update")
@click.option("--email", required=True, help="User email.")
@click.option("--password", required=True, help="User password.")
@click.option("--name", default=None, help="New display name.")
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
def update_account(
    ctx: click.Context,
    email: str,
    password: str,
    name: str | None,
    photo_path: str | None,
    clear_photo: bool,
) -> None:
    """Update mutable fields on the signed-in account (name, photo)."""
    if name is None and photo_path is None and not clear_photo:
        raise click.UsageError(
            "Pass at least one of --name, --photo, --clear-photo."
        )
    if photo_path and clear_photo:
        raise click.UsageError("Cannot use --photo and --clear-photo together.")
    config: ProjectConfig = ctx.obj["config"]
    client = _sign_in_client(config, email, password)
    before = client.get_doc(f"users/{client.uid}")
    console.print(_user_table("Before", client.uid, email, before))
    fields: dict = {}
    if name is not None:
        fields["displayName"] = name
    if clear_photo:
        fields["photoUrl"] = None
    if fields:
        client.update_doc(f"users/{client.uid}", fields)
    if clear_photo:
        console.print("[green]Photo cleared.[/green]")
    if photo_path:
        storage_path = f"users/{client.uid}/profile.jpg"
        client.upload_file(storage_path, photo_path)
        console.print(f"[green]Photo uploaded:[/green] {storage_path}")
        console.print("[dim]Waiting for photoUrl update...[/dim]")
        try:
            after = client.poll_doc_field(
                f"users/{client.uid}", "photoUrl", storage_path,
                timeout_s=15, interval_s=3,
            )
        except TimeoutError:
            after = client.get_doc(f"users/{client.uid}") or {}
    else:
        after = client.get_doc(f"users/{client.uid}") or {}
    console.print(_user_table("After", client.uid, email, after))


@auth_group.command("delete")
@click.option("--email", required=True, help="Email of the account to delete.")
@click.option(
    "--yes",
    is_flag=True,
    default=False,
    help="Skip the confirmation prompt (for scripted cleanup).",
)
@click.pass_context
def delete_account(ctx: click.Context, email: str, yes: bool) -> None:
    """Permanently delete a Firebase Auth user, their users/{uid}
    doc, and cascade-delete any children where they are the SOLE
    parent.

    DEV ONLY. Hard-refuses against --project prod: use the Firebase
    console for prod account removal.

    Cascade rules:
      - Sole parent  → child (and all subcollections) is deleted.
      - Co-parented  → child is left intact; the operator is shown
        which children survived and which other UIDs parent them.

    Storage cleanup is handled server-side: ``onChildDelete`` deletes
    ``children/{id}/profile.jpg`` and ``onUserDeleted`` deletes
    ``users/{uid}/profile.jpg`` (both best-effort).
    """
    alias = ctx.obj["project_alias"]
    if alias not in ("dev", "emu"):
        raise click.UsageError(
            f"auth delete is only available against --project dev or emu "
            f"(got {alias!r}). Use the Firebase console for prod."
        )
    config: ProjectConfig = ctx.obj["config"]
    sa_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    admin = AdminClient(config.project_id, sa_path)
    try:
        user = admin.get_user_by_email(email)
        if user is None:
            console.print(
                f"[yellow]No Firebase Auth user found for "
                f"{email}[/yellow]"
            )
            raise SystemExit(1)

        # Partition children by whether this user is the only parent.
        # Sole-parent children cascade; co-parented children survive
        # (deleting shared state on a teardown is too dangerous — the
        # other parent may be a real user).
        children = admin.children_of(user.uid)
        sole_parent = [(cid, pu) for cid, pu in children if len(pu) == 1]
        co_parented = [(cid, pu) for cid, pu in children if len(pu) > 1]

        console.print("[bold red]About to permanently delete:[/bold red]")
        console.print(f"  UID:     {user.uid}")
        console.print(f"  Email:   {user.email}")
        console.print(f"  Name:    {user.display_name or '—'}")
        console.print(f"  Project: {config.project_id} (dev)")
        if sole_parent:
            console.print(
                f"  [red]Children to DELETE "
                f"(sole parent): {len(sole_parent)}[/red]"
            )
            for cid, _ in sole_parent:
                console.print(f"    - children/{cid}")
        if co_parented:
            # Resolve other-parent UIDs to emails so the operator sees
            # who the surviving co-parents actually are — UIDs alone
            # aren't enough to tell whether the right access is being
            # preserved. Admin is already available here, so there's
            # no extra permission surface to worry about.
            all_other_uids = [
                u for _, parents in co_parented
                for u in parents if u != user.uid
            ]
            other_emails = admin.get_emails_by_uid(all_other_uids)
            console.print(
                f"  [yellow]Children left INTACT "
                f"(co-parented): {len(co_parented)}[/yellow]"
            )
            for cid, parents in co_parented:
                others = [u for u in parents if u != user.uid]
                rendered = [other_emails.get(u, u) for u in others]
                console.print(
                    f"    - children/{cid} "
                    f"(co-parents: {', '.join(rendered) or '—'})"
                )
        if not children:
            console.print("  Children: none")

        if not yes:
            click.confirm(
                "Proceed with deletion?",
                default=False,
                abort=True,
            )

        # 1. Sole-parent children first (recursive: doc + subcollections).
        for cid, _ in sole_parent:
            admin.recursive_delete_child(cid)
            console.print(
                f"[green]Deleted[/green] children/{cid} "
                f"(+ subcollections)"
            )

        # 2. users/{uid} doc. Deliberately before auth deletion: if
        # this fails, `email → uid` is still resolvable for a retry.
        try:
            admin.db.document(f"users/{user.uid}").delete()
            console.print(f"[green]Deleted[/green] users/{user.uid}")
        except Exception as e:
            console.print(
                f"[yellow]Could not delete users/{user.uid}: {e}[/yellow]"
            )

        # 3. Auth user last — this is the point of no return for
        # re-identifying the account by email.
        admin.delete_user(user.uid)
        console.print(f"[green]Deleted[/green] auth user {user.uid}")
    finally:
        admin.close()


@auth_group.command("login")
@click.option("--email", required=True, help="User email.")
@click.option("--password", required=True, help="User password.")
@click.pass_context
def login(ctx: click.Context, email: str, password: str) -> None:
    """Sign in and show account profile."""
    config: ProjectConfig = ctx.obj["config"]
    client = _sign_in_client(config, email, password)
    user_doc = client.get_doc(f"users/{client.uid}")
    console.print(_user_table("Account", client.uid, email, user_doc))
