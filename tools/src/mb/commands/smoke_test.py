"""Smoke test: full create → transact → verify → cleanup cycle."""

from __future__ import annotations

import os
import uuid

import click
from rich.console import Console

from ..admin import AdminClient
from ..client import FirestoreClient, ProjectConfig, make_timestamp, sign_in

console = Console()


def _make_test_email() -> str:
    tag = uuid.uuid4().hex[:8]
    return f"smoke-test-{tag}@test.example.com"


@click.command("smoke-test")
@click.pass_context
def smoke_test(ctx: click.Context) -> None:
    """Run end-to-end smoke test against the deployed backend."""
    config: ProjectConfig = ctx.obj["config"]
    alias = ctx.obj["project_alias"]

    sa_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    admin = AdminClient(config.project_id, sa_path)

    email = _make_test_email()
    password = "SmokeTest1!"
    display_name = f"Smoke Test {uuid.uuid4().hex[:6]}"

    console.print(f"[bold]Smoke test → {alias} ({config.project_id})[/bold]")
    console.print(f"  Test user: {email}")

    try:
        # ── 1. Health check: helloWorld ──────────────────────────
        console.print("\n[bold]1/7[/bold] Calling helloWorld…")
        import requests
        resp = requests.get(f"{config.functions_url}/helloWorld")
        resp.raise_for_status()
        console.print(f"  [green]OK[/green] status={resp.status_code}")

        # ── 2. Create test user (Admin SDK) ──────────────────────
        console.print("\n[bold]2/7[/bold] Creating test user…")
        uid = admin.create_user(email, password, display_name)
        console.print(f"  [green]OK[/green] uid={uid}")

        # ── 3. Sign in (REST) ────────────────────────────────────
        console.print("\n[bold]3/7[/bold] Signing in…")
        token_data = sign_in(config.require_api_key(), email, password)
        client = FirestoreClient(config, token_data["idToken"], uid)
        console.print(f"  [green]OK[/green] token={token_data['idToken'][:20]}…")

        # ── 4. Create child (Firestore REST → exercises rules) ───
        console.print("\n[bold]4/7[/bold] Creating child…")
        child_name = f"Smoke Child {uuid.uuid4().hex[:6]}"
        child_id = client.create_doc("children", {
            "name": child_name,
            "parentUids": [uid],
            "balance": 0,
            "vaultBalance": 0,
            "createdByUid": uid,
            "version": 0,
            "lastTxnAt": None,
            "deletedAt": None,
            "activeCardId": None,
            "photoUrl": None,
        })
        admin.track_doc(f"children/{child_id}")
        console.print(f"  [green]OK[/green] childId={child_id}")

        # ── 5. Create LODGE transaction ──────────────────────────
        console.print("\n[bold]5/7[/bold] Creating LODGE transaction (€5.00)…")
        txn_id = client.create_doc(f"children/{child_id}/transactions", {
            "amount": 500,
            "type": "LODGE",
            "description": "Smoke test deposit",
            "createdAt": make_timestamp(),
            "createdByUid": uid,
        })
        admin.track_doc(f"children/{child_id}/transactions/{txn_id}")
        console.print(f"  [green]OK[/green] txnId={txn_id}")

        # ── 6. Poll until onTransactionCreate updates balance ────
        console.print("\n[bold]6/7[/bold] Polling child balance…")
        doc = client.poll_doc_field(
            f"children/{child_id}",
            "balance",
            500,
            timeout_s=15,
            interval_s=2,
        )
        console.print(f"  [green]OK[/green] balance={doc['balance']}")

        # ── 7. Verify ───────────────────────────────────────────
        console.print("\n[bold]7/7[/bold] Verifying…")
        assert doc["balance"] == 500, f"Expected 500, got {doc['balance']}"
        console.print("  [green]OK[/green] balance matches expected €5.00")

        console.print("\n[bold green]✓ Smoke test passed![/bold green]")

    except Exception as e:
        console.print(f"\n[bold red]✗ Smoke test failed:[/bold red] {e}")
        raise SystemExit(1)

    finally:
        console.print("\n[dim]Cleaning up…[/dim]")
        admin.cleanup()
        admin.close()
