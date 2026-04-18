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

from contextlib import contextmanager

import firebase_admin
import firebase_admin.exceptions
from firebase_admin import auth, credentials, firestore
from rich.console import Console

from .client import AuthError

console = Console()


@contextmanager
def _translate_admin_errors():
    """Translate Admin SDK validation/runtime errors into ``AuthError``.

    The Admin SDK signals input validation (e.g. malformed email) by
    raising a bare ``ValueError`` and backend errors by raising
    ``firebase_admin.exceptions.FirebaseError``. We narrow both into
    ``AuthError`` at the SDK boundary so the CLI's top-level handler
    can render a clean one-line error instead of a Python traceback,
    without having to swallow ``ValueError`` globally (which would also
    mask genuine logic bugs in command code).
    """
    try:
        yield
    except (ValueError, firebase_admin.exceptions.FirebaseError) as e:
        raise AuthError(str(e)) from e

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
        with _translate_admin_errors():
            user = auth.create_user(
                email=email,
                password=password,
                display_name=display_name,
                app=self.app,
            )
        self.tracker.add_user(user.uid)
        return user.uid

    def list_users(self) -> list:
        """Iterate all Firebase Auth users, yielding UserRecord objects.

        Handles pagination via ``iterate_all()`` so callers get a flat
        list without dealing with page tokens.
        """
        with _translate_admin_errors():
            return list(auth.list_users(app=self.app).iterate_all())

    def get_user_by_email(self, email: str):
        """Look up a user by email. Returns UserRecord or None."""
        # UserNotFoundError is a normal-path signal (caller distinguishes
        # "missing" from "error"), so it must be caught BEFORE the
        # FirebaseError translation in _translate_admin_errors picks it up.
        try:
            with _translate_admin_errors():
                return auth.get_user_by_email(email, app=self.app)
        except AuthError as e:
            if isinstance(e.__cause__, auth.UserNotFoundError):
                return None
            raise

    def delete_user(self, uid: str) -> None:
        """Delete a Firebase Auth user. Raises on Admin SDK errors."""
        with _translate_admin_errors():
            auth.delete_user(uid, app=self.app)

    def children_of(self, uid: str) -> list[tuple[str, list[str]]]:
        """Return ``(child_id, parent_uids)`` for every child doc that
        lists ``uid`` in ``parentUids``.

        Uses the Admin SDK (bypasses security rules) so it works even
        for a user whose account is being torn down.
        """
        from google.cloud.firestore_v1.base_query import FieldFilter
        q = self.db.collection("children").where(
            filter=FieldFilter("parentUids", "array_contains", uid),
        )
        result: list[tuple[str, list[str]]] = []
        for doc in q.stream():
            data = doc.to_dict() or {}
            result.append((doc.id, list(data.get("parentUids", []))))
        return result

    def recursive_delete_child(self, child_id: str) -> None:
        """Recursively delete ``children/{child_id}`` and every
        subcollection beneath it (transactions, activities, …).

        Storage cleanup (``children/{child_id}/profile.jpg``) is
        handled server-side by the ``onChildDelete`` Cloud Function
        trigger (best-effort).
        """
        with _translate_admin_errors():
            self.db.recursive_delete(self.db.document(f"children/{child_id}"))

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
