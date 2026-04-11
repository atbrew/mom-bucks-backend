"""
Admin SDK surface — user creation and cleanup only.

The Admin SDK bypasses security rules, which makes it unsuitable for
smoke-testing the deployed backend. It is used here for exactly two
things that the client SDK cannot do:

  1. Creating test users (Firebase Auth createUser).
  2. Cleaning up test data after a smoke test, even when assertions
     fail (the try/finally guarantee).

All other operations go through the REST client (client.py) so they
exercise the real auth + rules path.
"""

from __future__ import annotations

import firebase_admin
from firebase_admin import auth, credentials, firestore
from rich.console import Console

console = Console()

# ─── Cleanup tracker ───────────────────────────────────────────────


class CleanupTracker:
    """Accumulates resources to delete during cleanup."""

    def __init__(self):
        self.users: list[str] = []
        self.docs: list[str] = []

    def add_user(self, uid: str) -> None:
        self.users.append(uid)

    def add_doc(self, path: str) -> None:
        self.docs.append(path)


# ─── Admin client ──────────────────────────────────────────────────


class AdminClient:
    """Thin wrapper around firebase-admin for test lifecycle."""

    def __init__(self, project_id: str, credentials_path: str | None = None):
        self.project_id = project_id
        cred = (
            credentials.Certificate(credentials_path)
            if credentials_path
            else credentials.ApplicationDefault()
        )
        self.app = firebase_admin.initialize_app(
            cred,
            {"projectId": project_id},
            name=f"mb-admin-{project_id}",
        )
        self.db = firestore.client(self.app)
        self.tracker = CleanupTracker()

    def create_user(
        self,
        email: str,
        password: str,
        display_name: str,
    ) -> str:
        """Create a Firebase Auth user. Returns the UID."""
        user = auth.create_user(
            email=email,
            password=password,
            display_name=display_name,
            app=self.app,
        )
        self.tracker.add_user(user.uid)
        return user.uid

    def track_doc(self, path: str) -> None:
        """Register a Firestore document path for cleanup."""
        self.tracker.add_doc(path)

    def cleanup(self) -> None:
        """Delete all tracked resources. Logs failures but does not raise."""
        for path in self.tracker.docs:
            try:
                self.db.document(path).delete()
            except Exception as e:
                console.print(f"[yellow]Cleanup: failed to delete doc {path}: {e}[/yellow]")

        for uid in self.tracker.users:
            try:
                auth.delete_user(uid, app=self.app)
            except Exception as e:
                console.print(f"[yellow]Cleanup: failed to delete user {uid}: {e}[/yellow]")

        console.print(
            f"[dim]Cleaned up {len(self.tracker.docs)} docs, "
            f"{len(self.tracker.users)} users[/dim]"
        )

    def close(self) -> None:
        """Delete the Firebase app instance."""
        try:
            firebase_admin.delete_app(self.app)
        except Exception:
            pass
