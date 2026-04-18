"""
Mom Bucks CLI entrypoint.

Usage:
    mb --help
    mb --project dev create-child --name Sam
    mb smoke-test
"""

from __future__ import annotations

import click
import firebase_admin.exceptions

from .client import AuthError, FirestoreError, get_project_config
from .commands.auth import auth_group
from .commands.children import children_group
from .commands.transactions import transactions_group
from .commands.activities import activities_group
from .commands.invites import invites_group
from .commands.smoke_test import smoke_test


class MbGroup(click.Group):
    """Click group that converts our domain errors and Firebase Admin
    SDK errors into ``click.ClickException`` so they render as a
    single-line error message instead of a Python traceback."""

    def invoke(self, ctx: click.Context):
        try:
            return super().invoke(ctx)
        except (AuthError, FirestoreError) as e:
            raise click.ClickException(str(e)) from e
        except (firebase_admin.exceptions.FirebaseError, ValueError) as e:
            # Admin SDK input validation (e.g. malformed email) raises
            # bare ValueError; runtime backend errors raise FirebaseError.
            # Both are operator-actionable — render as a Click error
            # line rather than a traceback.
            raise click.ClickException(str(e)) from e


@click.group(cls=MbGroup)
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
