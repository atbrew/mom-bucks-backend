"""Transaction commands: add-transaction, get-balance."""

from __future__ import annotations

import click
from rich.console import Console

from ..client import FirestoreClient, ProjectConfig, make_timestamp, sign_in

console = Console()


def _get_client(ctx: click.Context) -> FirestoreClient:
    config: ProjectConfig = ctx.obj["config"]
    email = ctx.obj.get("email")
    password = ctx.obj.get("password")
    if not email or not password:
        raise click.UsageError("Use --email and --password on the parent group.")
    token_data = sign_in(config.require_api_key(), email, password)
    return FirestoreClient(config, token_data["idToken"], token_data["localId"])


@click.group("transactions")
@click.option("--email", envvar="MB_EMAIL", required=True, help="User email.")
@click.option("--password", envvar="MB_PASSWORD", required=True, help="User password.")
@click.pass_context
def transactions_group(ctx: click.Context, email: str, password: str) -> None:
    """Transaction management."""
    ctx.obj["email"] = email
    ctx.obj["password"] = password


@transactions_group.command("add")
@click.option("--child-id", required=True, help="Child document ID.")
@click.option("--amount", required=True, type=float, help="Amount in euros (e.g. 5.00).")
@click.option(
    "--type", "txn_type", required=True,
    type=click.Choice(["LODGE", "WITHDRAW"]),
    help="Transaction type.",
)
@click.option("--description", default="CLI transaction", help="Description.")
@click.pass_context
def add_transaction(
    ctx: click.Context,
    child_id: str,
    amount: float,
    txn_type: str,
    description: str,
) -> None:
    """Add a transaction to a child."""
    client = _get_client(ctx)
    amount_cents = round(amount * 100)
    txn_id = client.create_doc(f"children/{child_id}/transactions", {
        "amount": amount_cents,
        "type": txn_type,
        "description": description,
        "createdAt": make_timestamp(),
        "createdByUid": client.uid,
    })
    console.print(
        f"[green]Created {txn_type}:[/green] \u20ac{amount:.2f} "
        f"({amount_cents} cents) → {txn_id}"
    )


@transactions_group.command("balance")
@click.option("--child-id", required=True, help="Child document ID.")
@click.pass_context
def get_balance(ctx: click.Context, child_id: str) -> None:
    """Get a child's current balance."""
    client = _get_client(ctx)
    doc = client.get_doc(f"children/{child_id}")
    if not doc:
        console.print(f"[red]Child {child_id} not found.[/red]")
        raise SystemExit(1)
    balance = doc.get("balance", 0)
    vault = doc.get("vaultBalance", 0)
    console.print(f"[bold]{doc.get('name', '?')}[/bold]")
    console.print(f"  Balance:      \u20ac{balance / 100:.2f}")
    console.print(f"  Vault:        \u20ac{vault / 100:.2f}")
