"""
Mom Bucks CLI entrypoint.

Usage:
    mb --help
    mb --project dev create-child --name Sam
    mb smoke-test
"""

from __future__ import annotations

import click

from .client import get_project_config
from .commands.auth import auth_group
from .commands.children import children_group
from .commands.transactions import transactions_group
from .commands.activities import activities_group
from .commands.invites import invites_group
from .commands.smoke_test import smoke_test


@click.group()
@click.option(
    "--project",
    type=click.Choice(["dev", "prod"]),
    default="dev",
    show_default=True,
    help="Firebase project alias.",
)
@click.pass_context
def main(ctx: click.Context, project: str) -> None:
    """Mom Bucks — Firebase backend CLI."""
    ctx.ensure_object(dict)
    ctx.obj["project_alias"] = project
    ctx.obj["config"] = get_project_config(project)


main.add_command(auth_group)
main.add_command(children_group)
main.add_command(transactions_group)
main.add_command(activities_group)
main.add_command(invites_group)
main.add_command(smoke_test)
