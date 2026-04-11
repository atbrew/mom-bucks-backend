"""Auth commands: create-account, login."""

from __future__ import annotations

import os

import click
from rich.console import Console

from firebase_admin._auth_utils import EmailAlreadyExistsError

from ..admin import AdminClient
from ..client import AuthError, ProjectConfig, sign_in

console = Console()


@click.group("auth")
def auth_group() -> None:
    """Account management."""


@auth_group.command("create-account")
@click.option("--email", required=True, help="User email.")
@click.option("--password", required=True, help="User password.")
@click.option("--name", required=True, help="Display name.")
@click.pass_context
def create_account(ctx: click.Context, email: str, password: str, name: str) -> None:
    """Create a new Firebase Auth user and sign in."""
    config: ProjectConfig = ctx.obj["config"]
    sa_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    admin = AdminClient(config.project_id, sa_path)
    try:
        try:
            uid = admin.create_user(email, password, name)
        except EmailAlreadyExistsError:
            console.print(
                f"[yellow]User {email} already exists.[/yellow]\n"
                f"  Run: uv run mb auth login --email {email} --password ..."
            )
            raise SystemExit(1)
        console.print(f"[green]Created user:[/green] {uid}")

        token_data = sign_in(config.require_api_key(), email, password)
        console.print(f"[green]Signed in.[/green] ID token (first 40 chars): {token_data['idToken'][:40]}...")
        console.print(f"UID: {token_data['localId']}")
    finally:
        admin.close()


@auth_group.command("login")
@click.option("--email", required=True, help="User email.")
@click.option("--password", required=True, help="User password.")
@click.pass_context
def login(ctx: click.Context, email: str, password: str) -> None:
    """Sign in and print the ID token."""
    config: ProjectConfig = ctx.obj["config"]
    try:
        token_data = sign_in(config.require_api_key(), email, password)
    except AuthError as e:
        console.print(f"[red]{e}[/red]")
        raise SystemExit(1)
    console.print(f"[green]Signed in as:[/green] {token_data['localId']}")
    console.print(f"ID token: {token_data['idToken']}")
