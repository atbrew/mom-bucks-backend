"""Activity commands: create, edit, delete, claim, list.

Every mutation goes through a Cloud Functions callable. The CLI is a
"dumb terminal": schedule parsing + reward formatting happen here, but
the business logic (validation, transactional writes, nextClaimAt
advance) lives in `functions/src/handlers/*.ts`.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import click
from rich.console import Console
from rich.table import Table

from ..client import FirestoreClient, ProjectConfig, sign_in

console = Console()


# ─── Schedule shorthand ────────────────────────────────────────────

_DOW_MAP = {
    "sun": 0, "mon": 1, "tue": 2, "wed": 3,
    "thu": 4, "fri": 5, "sat": 6,
}
_REV_DOW_MAP = {v: k for k, v in _DOW_MAP.items()}


def parse_schedule(shorthand: str) -> dict[str, Any]:
    """Parse `daily`, `weekly:sat`, or `monthly:15` into the Schedule
    shape the callables expect.

    Matches the TypeScript `parseSchedule` validator contract in
    `functions/src/lib/schedule.ts` — keys and value ranges are
    validated server-side, so the CLI only has to map the shorthand
    to the structured form without its own validation layer.
    """
    raw = shorthand.strip().lower()
    if raw == "daily":
        return {"kind": "DAILY"}
    if raw.startswith("weekly:"):
        day = raw.split(":", 1)[1]
        if day not in _DOW_MAP:
            raise click.UsageError(
                f"Unknown weekday '{day}'. Expected one of: "
                f"{', '.join(sorted(_DOW_MAP))}."
            )
        return {"kind": "WEEKLY", "dayOfWeek": _DOW_MAP[day]}
    if raw.startswith("monthly:"):
        day_str = raw.split(":", 1)[1]
        try:
            day = int(day_str)
        except ValueError as e:
            raise click.UsageError(
                f"Expected an integer day-of-month, got '{day_str}'."
            ) from e
        if day < 1 or day > 31:
            raise click.UsageError(
                f"dayOfMonth must be between 1 and 31, got {day}."
            )
        return {"kind": "MONTHLY", "dayOfMonth": day}
    raise click.UsageError(
        f"Unrecognised schedule '{shorthand}'. "
        "Expected 'daily', 'weekly:<day>', or 'monthly:<N>'."
    )


# ─── Auth helpers ──────────────────────────────────────────────────

def _get_client(ctx: click.Context) -> FirestoreClient:
    config: ProjectConfig = ctx.obj["config"]
    email = ctx.obj.get("email")
    password = ctx.obj.get("password")
    if not email or not password:
        raise click.UsageError("Use --email and --password on the parent group.")
    token_data = sign_in(config, email, password)
    return FirestoreClient(config, token_data["idToken"], token_data["localId"])


# ─── Group + subcommands ───────────────────────────────────────────

@click.group("activities")
@click.option("--email", envvar="MB_EMAIL", required=True, help="User email.")
@click.option("--password", envvar="MB_PASSWORD", required=True, help="User password.")
@click.pass_context
def activities_group(ctx: click.Context, email: str, password: str) -> None:
    """Activity management (calls the activity callables)."""
    ctx.obj["email"] = email
    ctx.obj["password"] = password


@activities_group.command("create")
@click.option("--child-id", required=True, help="Child document ID.")
@click.option("--title", required=True, help="Activity title.")
@click.option("--reward", required=True, type=float, help="Reward in euros.")
@click.option(
    "--type", "activity_type", required=True,
    type=click.Choice(["allowance", "chore"], case_sensitive=False),
    help="Activity type. 'allowance' is unique per child.",
)
@click.option(
    "--schedule", "schedule_str", required=True,
    help="Schedule shorthand: 'daily', 'weekly:sat', 'monthly:15'.",
)
@click.pass_context
def create_activity(
    ctx: click.Context,
    child_id: str,
    title: str,
    reward: float,
    activity_type: str,
    schedule_str: str,
) -> None:
    """Create an activity for a child (calls createActivity)."""
    client = _get_client(ctx)
    reward_cents = round(reward * 100)
    schedule = parse_schedule(schedule_str)
    result = client.call_function("createActivity", {
        "childId": child_id,
        "title": title,
        "reward": reward_cents,
        "type": activity_type.upper(),
        "schedule": schedule,
    })
    activity_id = result.get("activityId", "?")
    console.print(
        f"[green]Created activity:[/green] {title} "
        f"(\u20ac{reward:.2f}, {activity_type.upper()}, {schedule_str}) "
        f"→ {activity_id}"
    )


@activities_group.command("edit")
@click.option("--child-id", required=True, help="Child document ID.")
@click.option("--activity-id", required=True, help="Activity document ID.")
@click.option("--title", default=None, help="New title.")
@click.option("--reward", default=None, type=float, help="New reward in euros.")
@click.option(
    "--schedule", "schedule_str", default=None,
    help="New schedule: 'daily', 'weekly:sat', 'monthly:15'.",
)
@click.pass_context
def edit_activity(
    ctx: click.Context,
    child_id: str,
    activity_id: str,
    title: str | None,
    reward: float | None,
    schedule_str: str | None,
) -> None:
    """Edit an activity (calls updateActivity). `type` is immutable."""
    if title is None and reward is None and schedule_str is None:
        raise click.UsageError(
            "At least one of --title, --reward, --schedule is required."
        )
    client = _get_client(ctx)
    patch: dict[str, Any] = {}
    if title is not None:
        patch["title"] = title
    if reward is not None:
        patch["reward"] = round(reward * 100)
    if schedule_str is not None:
        patch["schedule"] = parse_schedule(schedule_str)
    client.call_function("updateActivity", {
        "childId": child_id,
        "activityId": activity_id,
        "patch": patch,
    })
    console.print(
        f"[green]Updated activity:[/green] {activity_id} "
        f"({', '.join(patch.keys())})"
    )


@activities_group.command("delete")
@click.option("--child-id", required=True, help="Child document ID.")
@click.option("--activity-id", required=True, help="Activity document ID.")
@click.pass_context
def delete_activity(
    ctx: click.Context,
    child_id: str,
    activity_id: str,
) -> None:
    """Delete an activity (calls deleteActivity)."""
    client = _get_client(ctx)
    client.call_function("deleteActivity", {
        "childId": child_id,
        "activityId": activity_id,
    })
    console.print(f"[green]Deleted activity:[/green] {activity_id}")


@activities_group.command("claim")
@click.option("--child-id", required=True, help="Child document ID.")
@click.option("--activity-id", required=True, help="Activity document ID.")
@click.pass_context
def claim_activity(ctx: click.Context, child_id: str, activity_id: str) -> None:
    """Claim an activity (calls claimActivity; writes LODGE + advances clock)."""
    client = _get_client(ctx)
    result = client.call_function("claimActivity", {
        "childId": child_id,
        "activityId": activity_id,
    })
    amount = int(result.get("amount", 0))
    new_balance = int(result.get("newBalance", 0))
    next_at = result.get("nextClaimAt", "?")
    console.print(
        f"[green]Claimed:[/green] +\u20ac{amount / 100:.2f} "
        f"→ balance \u20ac{new_balance / 100:.2f}; "
        f"next claim at {next_at}"
    )


def _format_schedule(schedule: dict[str, Any] | None) -> str:
    """Render a Schedule map back into shorthand for the table view."""
    if not schedule:
        return "?"
    kind = schedule.get("kind")
    if kind == "DAILY":
        return "daily"
    if kind == "WEEKLY":
        dow = schedule.get("dayOfWeek")
        return f"weekly:{_REV_DOW_MAP.get(dow, dow)}"
    if kind == "MONTHLY":
        return f"monthly:{schedule.get('dayOfMonth')}"
    return str(schedule)


@activities_group.command("list")
@click.option("--child-id", required=True, help="Child document ID.")
@click.pass_context
def list_activities(ctx: click.Context, child_id: str) -> None:
    """List activities for a child (Admin-SDK-free; REST read)."""
    client = _get_client(ctx)
    activities = client.list_collection(f"children/{child_id}/activities")
    if not activities:
        console.print("[dim]No activities found.[/dim]")
        return
    now = datetime.now(timezone.utc)
    table = Table(title="Activities")
    table.add_column("ID")
    table.add_column("Title")
    table.add_column("Type")
    table.add_column("Reward")
    table.add_column("Schedule")
    table.add_column("Next claim at (UTC)")
    table.add_column("Claimable?")
    for act in activities:
        reward_cents = int(act.get("reward", 0) or 0)
        next_at = act.get("nextClaimAt")
        if isinstance(next_at, datetime):
            claimable = "yes" if next_at <= now else "no"
            next_str = next_at.isoformat()
        else:
            claimable = "?"
            next_str = "?"
        table.add_row(
            act.get("_id", "?"),
            act.get("title", "?"),
            act.get("type", "?"),
            f"\u20ac{reward_cents / 100:.2f}",
            _format_schedule(act.get("schedule")),
            next_str,
            claimable,
        )
    console.print(table)
