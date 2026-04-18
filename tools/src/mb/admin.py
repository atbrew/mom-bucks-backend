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

import os
from contextlib import contextmanager

import firebase_admin
import firebase_admin.exceptions
import google.auth.credentials
from firebase_admin import auth, credentials, firestore
from rich.console import Console

from .client import AuthError

console = Console()


class _EmulatorCredential(credentials.Base):
    """No-op credential for emulator use.

    ``ApplicationDefault()`` would need real gcloud ADC or a service
    account file — neither is necessary when every Google API call is
    going to the local emulator (which skips token validation). Using
    an anonymous credential here lets ``firebase_admin.initialize_app``
    succeed without any auth setup. Prod/dev paths are unaffected:
    this class is only picked when ``FIREBASE_AUTH_EMULATOR_HOST`` is
    set, and any accidental call to a real Google endpoint would fail
    loudly with a 401, not silently hit prod with valid creds.
    """

    def get_credential(self) -> google.auth.credentials.Credentials:
        return google.auth.credentials.AnonymousCredentials()


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
        if credentials_path:
            cred: credentials.Base = credentials.Certificate(credentials_path)
        elif os.environ.get("FIREBASE_AUTH_EMULATOR_HOST"):
            # Emulator mode — skip ADC entirely. See _EmulatorCredential.
            cred = _EmulatorCredential()
        else:
            cred = credentials.ApplicationDefault()
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
        """Look up a user by email. Returns UserRecord or None.

        ``UserNotFoundError`` is a normal-path signal (caller wants to
        distinguish "missing" from "error"), so it's handled first and
        independently of ``_translate_admin_errors`` — other SDK errors
        still translate to ``AuthError`` for the CLI-wide handler.
        """
        try:
            return auth.get_user_by_email(email, app=self.app)
        except auth.UserNotFoundError:
            return None
        except (ValueError, firebase_admin.exceptions.FirebaseError) as e:
            raise AuthError(str(e)) from e

    def delete_user(self, uid: str) -> None:
        """Delete a Firebase Auth user. Raises on Admin SDK errors."""
        with _translate_admin_errors():
            auth.delete_user(uid, app=self.app)

    def get_emails_by_uid(self, uids: list[str]) -> dict[str, str]:
        """Resolve a batch of UIDs to emails via the Admin SDK.

        Returns `{uid: email}` for every uid that resolves and skips
        the rest — missing records and users without an email address
        both drop silently, because this is a display-layer helper
        (``children list`` / co-parent warnings) not an identity
        operation. Anything that matters for correctness should NOT
        key off this.
        """
        if not uids:
            return {}
        # Deduplicate while preserving order (stable output for the
        # table rendering layer).
        seen: set[str] = set()
        ordered: list[str] = []
        for u in uids:
            if u not in seen:
                seen.add(u)
                ordered.append(u)
        out: dict[str, str] = {}
        for uid in ordered:
            try:
                rec = auth.get_user(uid, app=self.app)
            except auth.UserNotFoundError:
                continue
            except (ValueError, firebase_admin.exceptions.FirebaseError):
                continue
            if rec.email:
                out[uid] = rec.email
        return out

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
        """Delete all tracked resources. Logs failures but does not raise.

        Deliberately uses bare ``except Exception`` rather than
        ``_translate_admin_errors`` — best-effort cleanup must never
        surface an error that masks the test failure it's cleaning up
        after. The CLI-wide ``AuthError`` handler is bypassed here on
        purpose.
        """
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
