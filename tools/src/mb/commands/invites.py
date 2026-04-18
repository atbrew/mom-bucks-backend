"""Invite commands: send, accept, inbox, sent, revoke.

All mutations go through callables because rules set
``allow write: if false`` on /invites (callables stamp caller uid,
normalise email case, denormalise names, and enforce expiry). The CLI
is just a thin shell around those callables plus two scoped list
queries (inbox / sent) that rules permit for the caller.
"""

from __future__ import annotations

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
        raise click.UsageError("Use --email and --password on the parent group.")
    token_data = sign_in(config, email, password)
    return FirestoreClient(config, token_data["idToken"], token_data["localId"])


@click.group("invites")
@click.option("--email", envvar="MB_EMAIL", required=True, help="User email.")
@click.option("--password", envvar="MB_PASSWORD", required=True, help="User password.")
@click.pass_context
def invites_group(ctx: click.Context, email: str, password: str) -> None:
    """Invite management."""
    ctx.obj["email"] = email
    ctx.obj["password"] = password


@invites_group.command("send")
@click.option("--child-id", required=True, help="Child document ID.")
@click.option(
    "--email",
    "invitee_email",
    required=True,
    help="Email of the person to invite.",
)
@click.pass_context
def send_invite(ctx: click.Context, child_id: str, invitee_email: str) -> None:
    """Send a co-parenting invite via the sendInvite callable.

    Note: the group-level ``--email`` (caller's login) is consumed by
    the ``invites`` group before this subcommand runs, so ``--email``
    here refers to the INVITEE's email. Click disambiguates by
    position: ``mb invites --email me ... send --email them ...``.
    """
    client = _get_client(ctx)
    result = client.call_function("sendInvite", {
        "childId": child_id,
        "invitedEmail": invitee_email,
    })
    token = result.get("token", "?")
    console.print(f"[green]Invite sent:[/green] token={token}")
    console.print(f"  Child: {child_id}")
    console.print(f"  Invitee: {invitee_email}")


@invites_group.command("accept")
@click.option("--token", required=True, help="Invite token (document ID).")
@click.pass_context
def accept_invite(ctx: click.Context, token: str) -> None:
    """Accept a co-parenting invite via the acceptInvite callable."""
    client = _get_client(ctx)
    result = client.call_function("acceptInvite", {"token": token})
    child_id = result.get("childId", "?")
    console.print(f"[green]Invite accepted![/green] Now co-parenting child: {child_id}")


@invites_group.command("inbox")
@click.pass_context
def inbox(ctx: click.Context) -> None:
    """List invites addressed to you (by your Auth email, case-insensitive)."""
    client = _get_client(ctx)
    caller_email = ctx.obj["email"].lower()
    invites = client.query("invites", "invitedEmail", "EQUAL", caller_email)
    if not invites:
        console.print("[yellow]No invites in your inbox.[/yellow]")
        return
    table = Table(title=f"Inbox ({caller_email})")
    table.add_column("Token")
    table.add_column("Child")
    table.add_column("From")
    for inv in invites:
        table.add_row(
            inv.get("_id", "?"),
            inv.get("childName") or inv.get("childId", "?"),
            inv.get("invitedByDisplayName") or inv.get("invitedByUid", "?"),
        )
    console.print(table)


@invites_group.command("sent")
@click.pass_context
def sent(ctx: click.Context) -> None:
    """List invites you have sent (pending or accepted)."""
    client = _get_client(ctx)
    invites = client.query("invites", "invitedByUid", "EQUAL", client.uid)
    if not invites:
        console.print("[yellow]You have not sent any invites.[/yellow]")
        return
    table = Table(title="Sent invites")
    table.add_column("Token")
    table.add_column("Child")
    table.add_column("To")
    table.add_column("Status")
    for inv in invites:
        status = "accepted" if inv.get("acceptedByUid") else "pending"
        table.add_row(
            inv.get("_id", "?"),
            inv.get("childName") or inv.get("childId", "?"),
            inv.get("invitedEmail", "?"),
            status,
        )
    console.print(table)


@invites_group.command("revoke")
@click.option("--token", required=True, help="Invite token to revoke.")
@click.pass_context
def revoke(ctx: click.Context, token: str) -> None:
    """Revoke an unaccepted invite you sent, via the revokeInvite callable."""
    client = _get_client(ctx)
    client.call_function("revokeInvite", {"token": token})
    console.print(f"[green]Invite revoked:[/green] {token}")
