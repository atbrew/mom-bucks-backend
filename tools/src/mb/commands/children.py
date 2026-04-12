"""Children commands: create-child, list-children."""

from __future__ import annotations

from datetime import datetime, timezone

import click
from rich.console import Console
from rich.table import Table

from ..client import FirestoreClient, ProjectConfig, sign_in

console = Console()


def _get_client(ctx: click.Context) -> FirestoreClient:
    config: ProjectConfig = ctx.obj["config"]
    email = ctx.obj.get("email")
    password = ctx.obj.get("password")
    if not email or not password:
        raise click.UsageError(
            "Use --email and --password on the parent group, or set "
            "MB_EMAIL and MB_PASSWORD environment variables."
        )
    token_data = sign_in(config.require_api_key(), email, password)
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
@click.pass_context
def create_child(ctx: click.Context, name: str, dob: datetime) -> None:
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
@click.pass_context
def update_child(
    ctx: click.Context,
    child_id: str,
    name: str | None,
    dob: datetime | None,
) -> None:
    """Update mutable fields on a child (name, dateOfBirth)."""
    if name is None and dob is None:
        raise click.UsageError("Pass at least one of --name, --dob.")
    client = _get_client(ctx)
    fields: dict = {}
    if name is not None:
        fields["name"] = name
    if dob is not None:
        fields["dateOfBirth"] = dob.replace(tzinfo=timezone.utc)
    client.update_doc(f"children/{child_id}", fields)
    parts = []
    if name is not None:
        parts.append(f"name={name}")
    if dob is not None:
        parts.append(f"dob={dob.date().isoformat()}")
    console.print(
        f"[green]Updated child {child_id}:[/green] " + ", ".join(parts)
    )


@children_group.command("list")
@click.pass_context
def list_children(ctx: click.Context) -> None:
    """List children for the current user."""
    client = _get_client(ctx)
    children = client.query(
        "children", "parentUids", "ARRAY_CONTAINS", client.uid,
    )
    if not children:
        console.print("[dim]No children found.[/dim]")
        return
    table = Table(title="Children")
    table.add_column("ID", overflow="fold")
    table.add_column("Name")
    table.add_column("DOB")
    table.add_column("Photo", overflow="fold")
    table.add_column("Parents", overflow="fold")
    table.add_column("Balance", justify="right")
    for child in children:
        balance_cents = child.get("balance", 0)
        dob_raw = child.get("dateOfBirth")
        if isinstance(dob_raw, datetime):
            dob_display = dob_raw.strftime("%Y-%m-%d")
        elif isinstance(dob_raw, str):
            dob_display = dob_raw[:10]
        else:
            dob_display = "—"
        photo = child.get("photoUrl") or "—"
        parents = child.get("parentUids") or []
        parents_display = ", ".join(parents) if parents else "—"
        table.add_row(
            child.get("_id", "?"),
            child.get("name", "?"),
            dob_display,
            photo,
            parents_display,
            f"\u20ac{balance_cents / 100:.2f}",
        )
    console.print(table)
