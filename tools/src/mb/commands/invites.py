"""Invite commands: send-invite, accept-invite."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

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
@click.option("--invitee-email", required=True, help="Email of the person to invite.")
@click.pass_context
def send_invite(ctx: click.Context, child_id: str, invitee_email: str) -> None:
    """Send a co-parenting invite."""
    client = _get_client(ctx)
    expires = datetime.now(timezone.utc) + timedelta(days=7)
    token = client.create_doc("invites", {
        "childId": child_id,
        "invitedByUid": client.uid,
        "invitedEmail": invitee_email,
        "expiresAt": make_timestamp(expires),
        "acceptedByUid": None,
        "acceptedAt": None,
    })
    console.print(f"[green]Invite created:[/green] token={token}")
    console.print(f"  Child: {child_id}")
    console.print(f"  Invitee: {invitee_email}")
    console.print(f"  Expires: {expires.isoformat()}")


@invites_group.command("accept")
@click.option("--token", required=True, help="Invite token (document ID).")
@click.pass_context
def accept_invite(ctx: click.Context, token: str) -> None:
    """Accept a co-parenting invite via the acceptInvite callable."""
    client = _get_client(ctx)
    result = client.call_function("acceptInvite", {"token": token})
    child_id = result.get("childId", "?")
    console.print(f"[green]Invite accepted![/green] Now co-parenting child: {child_id}")
