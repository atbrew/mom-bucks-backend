"""Transaction commands: add-transaction, get-balance."""

from __future__ import annotations

from datetime import datetime

import click
from rich.console import Console
from rich.table import Table

from ..client import FirestoreClient, FirestoreError, ProjectConfig, sign_in

console = Console()


def _get_client(ctx: click.Context) -> FirestoreClient:
    config: ProjectConfig = ctx.obj["config"]
    email = ctx.obj.get("email")
    password = ctx.obj.get("password")
    if not email or not password:
        raise click.UsageError("Use --email and --password on the parent group.")
    token_data = sign_in(config, email, password)
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
    before = client.get_doc(f"children/{child_id}")
    if not before:
        console.print(f"[red]Child {child_id} not found.[/red]")
        raise SystemExit(1)
    balance_before = before.get("balance", 0)
    amount_cents = round(amount * 100)
    try:
        txn_id = client.create_doc_with_server_time(
            f"children/{child_id}/transactions",
            {
                "amount": amount_cents,
                "type": txn_type,
                "description": description,
                "createdByUid": client.uid,
            },
            server_time_fields=["createdAt"],
        )
    except FirestoreError as e:
        console.print(f"[red]Transaction failed:[/red] {e}")
        raise SystemExit(1)
    console.print(
        f"[green]Created {txn_type}:[/green] \u20ac{amount:.2f} "
        f"({amount_cents} cents) \u2192 {txn_id}"
    )
    expected = balance_before + (amount_cents if txn_type == "LODGE" else -amount_cents)
    try:
        after = client.poll_doc_field(
            f"children/{child_id}", "balance", expected,
            timeout_s=10, interval_s=2,
        )
        balance_after = after["balance"]
    except TimeoutError:
        after_doc = client.get_doc(f"children/{child_id}")
        balance_after = (after_doc or {}).get("balance", balance_before)
    console.print(
        f"  Balance: \u20ac{balance_before / 100:.2f} \u2192 "
        f"\u20ac{balance_after / 100:.2f}"
    )


@transactions_group.command("revert")
@click.option("--child-id", required=True, help="Child document ID.")
@click.option("--txn-id", required=True, help="Transaction ID to revert.")
@click.pass_context
def revert_transaction(ctx: click.Context, child_id: str, txn_id: str) -> None:
    """Revert a transaction via the revertTransaction callable."""
    client = _get_client(ctx)
    before = client.get_doc(f"children/{child_id}")
    if not before:
        console.print(f"[red]Child {child_id} not found.[/red]")
        raise SystemExit(1)
    balance_before = before.get("balance", 0)
    try:
        result = client.call_function(
            "revertTransaction",
            {"childId": child_id, "txnId": txn_id},
        )
    except Exception as e:
        console.print(f"[red]Revert failed:[/red] {e}")
        raise SystemExit(1)
    revert_txn_id = result.get("revertTxnId", "?")
    console.print(f"[green]Reverted:[/green] {txn_id} \u2192 {revert_txn_id}")
    original = client.get_doc(f"children/{child_id}/transactions/{txn_id}")
    if original and isinstance(original.get("amount"), (int, float)):
        original_type = original.get("type", "")
        amount_cents = original["amount"]
        inverse_type = "WITHDRAW" if original_type == "LODGE" else "LODGE"
        expected = balance_before + (amount_cents if inverse_type == "LODGE" else -amount_cents)
        try:
            after = client.poll_doc_field(
                f"children/{child_id}", "balance", expected,
                timeout_s=10, interval_s=2,
            )
            balance_after = after["balance"]
        except TimeoutError:
            after_doc = client.get_doc(f"children/{child_id}")
            balance_after = (after_doc or {}).get("balance", balance_before)
    else:
        import time
        time.sleep(3)
        after_doc = client.get_doc(f"children/{child_id}")
        balance_after = (after_doc or {}).get("balance", balance_before)
    console.print(
        f"  Balance: \u20ac{balance_before / 100:.2f} \u2192 "
        f"\u20ac{balance_after / 100:.2f}"
    )


@transactions_group.command("list")
@click.option("--child-id", required=True, help="Child document ID.")
@click.pass_context
def list_transactions(ctx: click.Context, child_id: str) -> None:
    """List transactions for a child."""
    client = _get_client(ctx)
    txns = client.list_collection(f"children/{child_id}/transactions")
    if not txns:
        console.print("[dim]No transactions found.[/dim]")
        return
    table = Table(title="Transactions")
    table.add_column("ID", overflow="fold")
    table.add_column("Type")
    table.add_column("Amount", justify="right")
    table.add_column("Description")
    table.add_column("Created")
    for txn in txns:
        amount_cents = txn.get("amount", 0)
        created = txn.get("createdAt")
        if isinstance(created, datetime):
            created_display = created.strftime("%Y-%m-%d %H:%M")
        elif isinstance(created, str):
            created_display = created[:16]
        else:
            created_display = "—"
        table.add_row(
            txn.get("_id", "?"),
            txn.get("type", "?"),
            f"\u20ac{amount_cents / 100:.2f}",
            txn.get("description", ""),
            created_display,
        )
    console.print(table)


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
