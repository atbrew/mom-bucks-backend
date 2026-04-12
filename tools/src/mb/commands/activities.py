"""Activity commands: create-activity, list-activities, claim-activity."""

from __future__ import annotations

import click
from rich.console import Console
from rich.table import Table

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


@click.group("activities")
@click.option("--email", envvar="MB_EMAIL", required=True, help="User email.")
@click.option("--password", envvar="MB_PASSWORD", required=True, help="User password.")
@click.pass_context
def activities_group(ctx: click.Context, email: str, password: str) -> None:
    """Activity management."""
    ctx.obj["email"] = email
    ctx.obj["password"] = password


@activities_group.command("create")
@click.option("--child-id", required=True, help="Child document ID.")
@click.option("--title", required=True, help="Activity title.")
@click.option("--reward", required=True, type=float, help="Reward in euros.")
@click.option(
    "--type", "activity_type", default="BOUNTY_RECURRING",
    type=click.Choice(["ALLOWANCE", "BOUNTY_RECURRING", "INTEREST"]),
    help="Activity type.",
)
@click.pass_context
def create_activity(
    ctx: click.Context,
    child_id: str,
    title: str,
    reward: float,
    activity_type: str,
) -> None:
    """Create an activity for a child."""
    client = _get_client(ctx)
    reward_cents = round(reward * 100)
    activity_id = client.create_doc(f"children/{child_id}/activities", {
        "title": title,
        "reward": reward_cents,
        "type": activity_type,
        "status": "LOCKED",
        "dueDate": make_timestamp(),
        "claimedAt": None,
        "createdAt": make_timestamp(),
    })
    console.print(
        f"[green]Created activity:[/green] {title} "
        f"(\u20ac{reward:.2f}) → {activity_id}"
    )


@activities_group.command("list")
@click.option("--child-id", required=True, help="Child document ID.")
@click.pass_context
def list_activities(ctx: click.Context, child_id: str) -> None:
    """List activities for a child."""
    client = _get_client(ctx)
    activities = client.list_collection(f"children/{child_id}/activities")
    if not activities:
        console.print("[dim]No activities found.[/dim]")
        return
    table = Table(title="Activities")
    table.add_column("ID")
    table.add_column("Title")
    table.add_column("Reward")
    table.add_column("Status")
    for act in activities:
        reward_cents = act.get("reward", 0)
        table.add_row(
            act.get("_id", "?"),
            act.get("title", "?"),
            f"\u20ac{reward_cents / 100:.2f}",
            act.get("status", "?"),
        )
    console.print(table)


@activities_group.command("claim")
@click.option("--child-id", required=True, help="Child document ID.")
@click.option("--activity-id", required=True, help="Activity document ID.")
@click.pass_context
def claim_activity(ctx: click.Context, child_id: str, activity_id: str) -> None:
    """Claim an activity (set status to READY and mark claimed)."""
    client = _get_client(ctx)
    client.update_doc(f"children/{child_id}/activities/{activity_id}", {
        "status": "READY",
        "claimedAt": make_timestamp(),
    })
    console.print(f"[green]Claimed activity:[/green] {activity_id}")
