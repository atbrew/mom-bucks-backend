"""
Mom Bucks CLI entrypoint.

Usage:
    mb --help
    mb --project dev create-child --name Sam
    mb smoke-test
"""

from __future__ import annotations

import os

import click

from .client import AuthError, FirestoreError, get_project_config
from .commands.auth import auth_group
from .commands.children import children_group
from .commands.transactions import transactions_group
from .commands.activities import activities_group
from .commands.invites import invites_group
from .commands.smoke_test import smoke_test


class MbGroup(click.Group):
    """Click group that converts our domain errors into
    ``click.ClickException`` so they render as a single-line error
    message instead of a Python traceback. Admin SDK errors
    (``ValueError`` from input validation, ``FirebaseError`` from the
    backend) are translated to ``AuthError`` at the SDK boundary in
    ``admin.py``, so the catch list here stays narrow — any other
    ``Exception`` is a real bug and SHOULD surface as a traceback."""

    def invoke(self, ctx: click.Context):
        try:
            return super().invoke(ctx)
        except (AuthError, FirestoreError) as e:
            raise click.ClickException(str(e)) from e


@click.group(cls=MbGroup)
@click.option(
    "--project",
    type=click.Choice(["dev", "prod", "emu"]),
    default="dev",
    show_default=True,
    help=(
        "Firebase project alias. `emu` routes every endpoint — Auth, "
        "Firestore, callables, Storage — to the local emulator suite "
        "(boot via ./scripts/start-emulators.sh)."
    ),
)
@click.pass_context
def main(ctx: click.Context, project: str) -> None:
    """Mom Bucks — Firebase backend CLI."""
    ctx.ensure_object(dict)
    ctx.obj["project_alias"] = project
    config = get_project_config(project)
    ctx.obj["config"] = config
    # When targeting the emulator, publish the env vars firebase-admin
    # honours so the Admin SDK surface (admin.py) routes to the local
    # suite too — the REST client (client.py) uses the config object
    # directly, but the Admin SDK reads these env vars at first call.
    # `setdefault` so an explicit override from the caller still wins.
    if config.emulator:
        assert config.hosts is not None
        os.environ.setdefault("FIREBASE_AUTH_EMULATOR_HOST", config.hosts["auth"])
        os.environ.setdefault("FIRESTORE_EMULATOR_HOST", config.hosts["firestore"])
        os.environ.setdefault(
            "FIREBASE_STORAGE_EMULATOR_HOST", config.hosts["storage"],
        )


main.add_command(auth_group)
main.add_command(children_group)
main.add_command(transactions_group)
main.add_command(activities_group)
main.add_command(invites_group)
main.add_command(smoke_test)
