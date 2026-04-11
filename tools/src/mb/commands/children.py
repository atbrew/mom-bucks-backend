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
    table.add_column("ID")
    table.add_column("Name")
    table.add_column("Balance")
    for child in children:
        balance_cents = child.get("balance", 0)
        table.add_row(
            child.get("_id", "?"),
            child.get("name", "?"),
            f"\u20ac{balance_cents / 100:.2f}",
        )
    console.print(table)
