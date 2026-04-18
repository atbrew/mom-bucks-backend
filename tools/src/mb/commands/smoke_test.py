"""Smoke test: full create → transact → invite → accept → verify cycle."""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import click
from rich.console import Console

from ..admin import AdminClient
from ..client import FirestoreClient, ProjectConfig, sign_in

console = Console()


def _make_test_email(prefix: str = "smoke-test") -> str:
    tag = uuid.uuid4().hex[:8]
    return f"{prefix}-{tag}@test.example.com"


@click.command("smoke-test")
@click.pass_context
def smoke_test(ctx: click.Context) -> None:
    """Run end-to-end smoke test against the deployed backend."""
    config: ProjectConfig = ctx.obj["config"]
    alias = ctx.obj["project_alias"]

    sa_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    admin = AdminClient(config.project_id, sa_path)

    alice_email = _make_test_email("smoke-alice")
    bob_email = _make_test_email("smoke-bob")
    password = "SmokeTest1!"
    alice_name = f"Smoke Alice {uuid.uuid4().hex[:6]}"
    bob_name = f"Smoke Bob {uuid.uuid4().hex[:6]}"

    console.print(f"[bold]Smoke test → {alias} ({config.project_id})[/bold]")
    console.print(f"  Alice: {alice_email}")
    console.print(f"  Bob:   {bob_email}")

    try:
        # ── 1. Health check: helloWorld ──────────────────────────
        console.print("\n[bold]1/12[/bold] Calling helloWorld…")
        import requests
        resp = requests.get(f"{config.functions_url}/helloWorld")
        resp.raise_for_status()
        console.print(f"  [green]OK[/green] status={resp.status_code}")

        # ── 2. Create Alice (Admin SDK) ──────────────────────────
        console.print("\n[bold]2/12[/bold] Creating Alice…")
        alice_uid = admin.create_user(alice_email, password, alice_name)
        console.print(f"  [green]OK[/green] uid={alice_uid}")

        # ── 3. Sign in as Alice ──────────────────────────────────
        console.print("\n[bold]3/12[/bold] Signing in as Alice…")
        alice_token = sign_in(config,alice_email, password)
        alice_client = FirestoreClient(
            config, alice_token["idToken"], alice_uid,
        )
        console.print("  [green]OK[/green]")

        # ── 4. Create child ──────────────────────────────────────
        console.print("\n[bold]4/12[/bold] Creating child…")
        child_name = f"Smoke Child {uuid.uuid4().hex[:6]}"
        dob = datetime(2020, 1, 1, tzinfo=timezone.utc)
        child_id = alice_client.create_doc_with_server_time(
            "children",
            {
                "name": child_name,
                "parentUids": [alice_uid],
                "dateOfBirth": dob,
                "balance": 0,
                "vaultBalance": 0,
                "createdByUid": alice_uid,
                "version": 0,
                "lastTxnAt": None,
                "deletedAt": None,
                "activeCardId": None,
                "photoUrl": None,
            },
            server_time_fields=["createdAt"],
        )
        admin.track_doc(f"children/{child_id}")
        console.print(f"  [green]OK[/green] childId={child_id}")

        # ── 5. Create LODGE transaction ──────────────────────────
        console.print("\n[bold]5/12[/bold] Creating LODGE transaction (€5.00)…")
        txn_id = alice_client.create_doc_with_server_time(
            f"children/{child_id}/transactions",
            {
                "amount": 500,
                "type": "LODGE",
                "description": "Smoke test deposit",
                "createdByUid": alice_uid,
            },
            server_time_fields=["createdAt"],
        )
        admin.track_doc(f"children/{child_id}/transactions/{txn_id}")
        console.print(f"  [green]OK[/green] txnId={txn_id}")

        # ── 6. Poll until onTransactionCreate updates balance ────
        console.print("\n[bold]6/12[/bold] Polling child balance…")
        doc = alice_client.poll_doc_field(
            f"children/{child_id}", "balance", 500,
            timeout_s=15, interval_s=2,
        )
        assert doc["balance"] == 500, f"Expected 500, got {doc['balance']}"
        console.print("  [green]OK[/green] balance=500 (€5.00)")

        # ── 7. Create Bob (the invitee) ──────────────────────────
        console.print("\n[bold]7/12[/bold] Creating Bob…")
        bob_uid = admin.create_user(bob_email, password, bob_name)
        console.print(f"  [green]OK[/green] uid={bob_uid}")

        # ── 8. Alice sends Bob an invite (sendInvite callable) ───
        console.print("\n[bold]8/12[/bold] Alice calls sendInvite for Bob…")
        send_result = alice_client.call_function("sendInvite", {
            "childId": child_id,
            "invitedEmail": bob_email,
        })
        invite_token = send_result["token"]
        admin.track_doc(f"invites/{invite_token}")
        console.print(f"  [green]OK[/green] token={invite_token}")

        # ── 9. Bob signs in and lists his inbox ──────────────────
        console.print("\n[bold]9/12[/bold] Bob signs in + inbox list…")
        bob_token = sign_in(config,bob_email, password)
        bob_client = FirestoreClient(
            config, bob_token["idToken"], bob_uid,
        )
        inbox = bob_client.query(
            "invites", "invitedEmail", "EQUAL", bob_email.lower(),
        )
        assert any(inv["_id"] == invite_token for inv in inbox), (
            f"Invite {invite_token} missing from Bob's inbox: {inbox!r}"
        )
        inbox_hit = next(i for i in inbox if i["_id"] == invite_token)
        assert inbox_hit.get("childName") == child_name, (
            f"Expected denormalised childName={child_name!r}, "
            f"got {inbox_hit.get('childName')!r}"
        )
        console.print(
            f"  [green]OK[/green] found invite in inbox with "
            f"childName={inbox_hit['childName']!r}",
        )

        # ── 10. Bob accepts the invite (acceptInvite callable) ──
        console.print("\n[bold]10/12[/bold] Bob calls acceptInvite…")
        accept_result = bob_client.call_function(
            "acceptInvite", {"token": invite_token},
        )
        assert accept_result.get("childId") == child_id, (
            f"acceptInvite returned childId={accept_result.get('childId')!r}, "
            f"expected {child_id!r}"
        )
        console.print("  [green]OK[/green]")

        # ── 11. Verify parentUids now contains both users ───────
        console.print(
            "\n[bold]11/12[/bold] Verifying child.parentUids grew to both…",
        )
        child_after = bob_client.get_doc(f"children/{child_id}")
        assert child_after is not None, "Bob cannot read child after accept"
        parent_uids = set(child_after.get("parentUids", []))
        assert parent_uids == {alice_uid, bob_uid}, (
            f"Expected parentUids == {{alice, bob}}, got {parent_uids!r}"
        )
        console.print(
            "  [green]OK[/green] Bob can read child and parentUids "
            "contains both users",
        )

        # ── 12. Revoke cycle: send → revoke → verify gone ───────
        console.print("\n[bold]12/12[/bold] Revoke cycle…")
        other_email = _make_test_email("smoke-revokee")
        send_result2 = alice_client.call_function("sendInvite", {
            "childId": child_id,
            "invitedEmail": other_email,
        })
        revoke_token = send_result2["token"]
        admin.track_doc(f"invites/{revoke_token}")
        alice_client.call_function("revokeInvite", {"token": revoke_token})
        after = alice_client.get_doc(f"invites/{revoke_token}")
        assert after is None, (
            f"Expected revoked invite to be gone, got {after!r}"
        )
        console.print("  [green]OK[/green] invite revoked + absent")

        console.print("\n[bold green]✓ Smoke test passed![/bold green]")

    except Exception as e:
        console.print(f"\n[bold red]✗ Smoke test failed:[/bold red] {e}")
        raise SystemExit(1)

    finally:
        console.print("\n[dim]Cleaning up…[/dim]")
        admin.cleanup()
        admin.close()
