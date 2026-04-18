"""
Firebase REST client — client-auth path.

All reads, writes, and callable invocations go through the Firebase
REST APIs with an ID token obtained via email/password sign-in. This
exercises the same auth + security rules path that the Android app
uses, so a passing smoke test proves the full stack is working.

Admin SDK is deliberately NOT used here. See admin.py for the narrow
Admin SDK surface (user creation + cleanup only).
"""

from __future__ import annotations

import os
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import requests


# Firestore autoid alphabet — matches the official SDK: 20 chars from
# [A-Za-z0-9]. Used when we pre-generate a document ID client-side so we
# can POST to the commit endpoint (which requires an absolute doc name)
# instead of the collection-create endpoint.
_AUTOID_ALPHABET = (
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "abcdefghijklmnopqrstuvwxyz"
    "0123456789"
)


def _generate_doc_id() -> str:
    """Generate a 20-char Firestore-style document ID."""
    return "".join(secrets.choice(_AUTOID_ALPHABET) for _ in range(20))


# ─── Project configuration ─────────────────────────────────────────

PROJECTS = {
    "dev": {
        "project_id": "mom-bucks-dev-b3772",
        "api_key_env": "FIREBASE_WEB_API_KEY_DEV",
        "region": "us-central1",
    },
    "prod": {
        "project_id": "mom-bucks-prod-81096",
        "api_key_env": "FIREBASE_WEB_API_KEY_PROD",
        "region": "us-central1",
    },
    # `emu` routes every endpoint — Auth, Firestore, callables, Storage
    # — to the local Firebase emulator suite. Ports must mirror
    # firebase.json → emulators. No API key or service account is
    # required: the Auth emulator accepts any key, and the Admin SDK
    # skips credential validation when FIREBASE_*_EMULATOR_HOST env
    # vars are set (wired up in cli.py). Uses the dev project id so
    # any accidental Admin-SDK call that bypasses the emulator lands
    # in dev, never prod.
    "emu": {
        "project_id": "mom-bucks-dev-b3772",
        "api_key_env": None,
        "region": "us-central1",
        "emulator": True,
        "hosts": {
            "auth": "localhost:9099",
            "firestore": "localhost:8080",
            "functions": "localhost:5005",
            "storage": "localhost:9199",
        },
    },
}


@dataclass
class ProjectConfig:
    project_id: str
    api_key: str
    api_key_env: str | None
    region: str
    emulator: bool = False
    hosts: dict | None = None

    def require_api_key(self) -> str:
        """Return the API key, raising if not set."""
        if self.emulator:
            # Auth emulator accepts any non-empty key — only the URL
            # routing matters, not the value.
            return "fake-emulator-key"
        if not self.api_key:
            raise RuntimeError(
                f"Environment variable {self.api_key_env} is not set. "
                f"Set it to the Firebase Web API key."
            )
        return self.api_key

    @property
    def auth_url_base(self) -> str:
        """Base URL for Firebase Auth REST calls (without trailing
        path). The emulator hosts the real API path under its own
        origin, so both prod and emulator share the `/v1/accounts:*`
        suffix used at call sites."""
        if self.emulator:
            assert self.hosts is not None
            return (
                f"http://{self.hosts['auth']}"
                "/identitytoolkit.googleapis.com/v1"
            )
        return "https://identitytoolkit.googleapis.com/v1"

    @property
    def firestore_url(self) -> str:
        if self.emulator:
            assert self.hosts is not None
            return (
                f"http://{self.hosts['firestore']}/v1/projects/"
                f"{self.project_id}/databases/(default)/documents"
            )
        return (
            f"https://firestore.googleapis.com/v1/projects/"
            f"{self.project_id}/databases/(default)/documents"
        )

    @property
    def functions_url(self) -> str:
        if self.emulator:
            # Emulator callable URL shape differs from prod:
            # http://host/{project}/{region}/{name} vs
            # https://{region}-{project}.cloudfunctions.net/{name}
            assert self.hosts is not None
            return (
                f"http://{self.hosts['functions']}"
                f"/{self.project_id}/{self.region}"
            )
        return (
            f"https://{self.region}-{self.project_id}.cloudfunctions.net"
        )

    @property
    def storage_url_base(self) -> str:
        """Base URL for Firebase Storage object operations
        (without the `/v0/b/...` suffix)."""
        if self.emulator:
            assert self.hosts is not None
            return f"http://{self.hosts['storage']}"
        return "https://firebasestorage.googleapis.com"


def get_project_config(alias: str) -> ProjectConfig:
    info = PROJECTS[alias]
    api_key_env = info.get("api_key_env")
    api_key = os.environ.get(api_key_env, "") if api_key_env else ""
    return ProjectConfig(
        project_id=info["project_id"],
        api_key=api_key,
        api_key_env=api_key_env,
        region=info["region"],
        emulator=info.get("emulator", False),
        hosts=info.get("hosts"),
    )


# ─── Auth ───────────────────────────────────────────────────────────

class AuthError(RuntimeError):
    """Raised when Firebase Auth returns an error."""


class FirestoreError(RuntimeError):
    """Raised when a Firestore REST call returns an error, with the
    response body attached so rule-denial reasons are visible."""


def _check(resp: requests.Response, operation: str) -> None:
    """Raise ``FirestoreError`` on any 4xx/5xx response, including the
    status code and body so the CLI can render a useful one-line error
    instead of letting ``requests.HTTPError`` propagate as a traceback."""
    if resp.status_code >= 400:
        raise FirestoreError(
            f"{operation} failed ({resp.status_code}): {resp.text}"
        )


def sign_in(api_key: str | ProjectConfig, email: str, password: str) -> dict:
    """Sign in via Firebase Auth REST API, return the full response.

    Pass a ``ProjectConfig`` to route correctly for the emulator —
    the bare-string form hits prod Auth and is kept only for backwards
    compatibility with pre-emulator call sites.
    """
    if isinstance(api_key, ProjectConfig):
        base = api_key.auth_url_base
        api_key = api_key.require_api_key()
    else:
        base = "https://identitytoolkit.googleapis.com/v1"
    url = f"{base}/accounts:signInWithPassword?key={api_key}"
    resp = requests.post(url, json={
        "email": email,
        "password": password,
        "returnSecureToken": True,
    })
    if resp.status_code >= 400:
        try:
            code = resp.json().get("error", {}).get("message", "")
        except Exception:
            code = ""
        if code in ("INVALID_LOGIN_CREDENTIALS", "INVALID_PASSWORD",
                    "EMAIL_NOT_FOUND"):
            raise AuthError(f"Invalid email or password for {email}.")
        if code == "USER_DISABLED":
            raise AuthError(f"Account {email} is disabled.")
        if code.startswith("TOO_MANY_ATTEMPTS"):
            raise AuthError("Too many failed attempts. Try again later.")
        raise AuthError(f"Sign-in failed: {code or resp.text}")
    return resp.json()


# ─── Firestore value encoding ──────────────────────────────────────

def to_firestore_value(val: Any) -> dict:
    """Convert a Python value to a Firestore REST value object."""
    if val is None:
        return {"nullValue": None}
    if isinstance(val, bool):
        return {"booleanValue": val}
    if isinstance(val, int):
        return {"integerValue": str(val)}
    if isinstance(val, float):
        return {"doubleValue": val}
    if isinstance(val, str):
        return {"stringValue": val}
    if isinstance(val, datetime):
        return {"timestampValue": val.strftime("%Y-%m-%dT%H:%M:%S.%fZ")}
    if isinstance(val, list):
        return {
            "arrayValue": {
                "values": [to_firestore_value(v) for v in val],
            }
        }
    if isinstance(val, dict):
        return {
            "mapValue": {
                "fields": {
                    k: to_firestore_value(v) for k, v in val.items()
                },
            }
        }
    raise TypeError(f"Cannot convert {type(val)} to Firestore value")


def from_firestore_value(val: dict) -> Any:
    """Convert a Firestore REST value object to a Python value."""
    if "nullValue" in val:
        return None
    if "booleanValue" in val:
        return val["booleanValue"]
    if "integerValue" in val:
        return int(val["integerValue"])
    if "doubleValue" in val:
        return val["doubleValue"]
    if "stringValue" in val:
        return val["stringValue"]
    if "timestampValue" in val:
        raw = val["timestampValue"]
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if "arrayValue" in val:
        values = val["arrayValue"].get("values", [])
        return [from_firestore_value(v) for v in values]
    if "mapValue" in val:
        fields = val["mapValue"].get("fields", {})
        return {k: from_firestore_value(v) for k, v in fields.items()}
    return None


def from_firestore_doc(doc: dict) -> dict:
    """Extract fields from a Firestore REST document response."""
    fields = doc.get("fields", {})
    return {k: from_firestore_value(v) for k, v in fields.items()}


# ─── Firestore client ──────────────────────────────────────────────

class FirestoreClient:
    """Firestore REST client authenticated with an ID token."""

    def __init__(self, config: ProjectConfig, id_token: str, uid: str):
        self.config = config
        self.id_token = id_token
        self.uid = uid

    @property
    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.id_token}"}

    def get_doc(self, path: str) -> dict | None:
        """Read a document. Returns decoded fields or None if not found.

        Returns None on 404 (missing) and 403 (permission denied —
        Firestore returns 403 when rules reference resource.data on a
        non-existent doc, so it's indistinguishable from "not found").
        """
        url = f"{self.config.firestore_url}/{path}"
        resp = requests.get(url, headers=self._headers)
        if resp.status_code in (403, 404):
            return None
        _check(resp, f"get_doc {path}")
        return from_firestore_doc(resp.json())

    def create_doc(
        self,
        collection: str,
        fields: dict[str, Any],
        doc_id: str | None = None,
    ) -> str:
        """Create a document. Returns the document ID."""
        url = f"{self.config.firestore_url}/{collection}"
        body = {
            "fields": {k: to_firestore_value(v) for k, v in fields.items()}
        }
        params = {}
        if doc_id:
            params["documentId"] = doc_id
        resp = requests.post(
            url, headers=self._headers, json=body, params=params,
        )
        _check(resp, f"create_doc {collection}")
        # Document name is like "projects/.../documents/children/abc123"
        name = resp.json()["name"]
        return name.split("/")[-1]

    def create_doc_with_server_time(
        self,
        collection_path: str,
        fields: dict[str, Any],
        server_time_fields: list[str],
        doc_id: str | None = None,
    ) -> str:
        """Create a document via the commit endpoint with DocumentTransforms.

        Fields listed in ``server_time_fields`` are stamped by Firestore
        itself with ``request.time``. This is the only REST path that can
        satisfy security rules of the form
        ``request.resource.data.createdAt == request.time`` — the plain
        ``createDocument`` endpoint has no sentinel support.

        Pass the server-time field names in ``server_time_fields`` and
        omit them from ``fields``. A doc ID is generated client-side if
        not provided (commit requires an absolute document name).
        Returns the document ID.
        """
        if doc_id is None:
            doc_id = _generate_doc_id()
        full_path = f"{collection_path}/{doc_id}"
        doc_name = (
            f"projects/{self.config.project_id}"
            f"/databases/(default)/documents/{full_path}"
        )
        body = {
            "writes": [
                {
                    "update": {
                        "name": doc_name,
                        "fields": {
                            k: to_firestore_value(v)
                            for k, v in fields.items()
                        },
                    },
                    "updateTransforms": [
                        {
                            "fieldPath": f,
                            "setToServerValue": "REQUEST_TIME",
                        }
                        for f in server_time_fields
                    ],
                }
            ]
        }
        url = f"{self.config.firestore_url}:commit"
        resp = requests.post(url, headers=self._headers, json=body)
        if resp.status_code >= 400:
            raise FirestoreError(
                f"commit failed ({resp.status_code}) for "
                f"{full_path}: {resp.text}"
            )
        return doc_id

    def update_doc(self, path: str, fields: dict[str, Any]) -> None:
        """Update specific fields on a document."""
        url = f"{self.config.firestore_url}/{path}"
        body = {
            "fields": {k: to_firestore_value(v) for k, v in fields.items()}
        }
        params = [("updateMask.fieldPaths", k) for k in fields]
        resp = requests.patch(
            url, headers=self._headers, json=body, params=params,
        )
        _check(resp, f"update_doc {path}")

    def delete_doc(self, path: str) -> None:
        """Delete a document."""
        url = f"{self.config.firestore_url}/{path}"
        resp = requests.delete(url, headers=self._headers)
        if resp.status_code == 404:
            return
        _check(resp, f"delete_doc {path}")

    def list_collection(self, path: str) -> list[dict]:
        """List all documents in a collection. Returns decoded docs."""
        url = f"{self.config.firestore_url}/{path}"
        resp = requests.get(url, headers=self._headers)
        _check(resp, f"list_collection {path}")
        results = []
        for doc in resp.json().get("documents", []):
            doc_id = doc["name"].split("/")[-1]
            fields = from_firestore_doc(doc)
            fields["_id"] = doc_id
            results.append(fields)
        return results

    def query(
        self,
        collection: str,
        field: str,
        op: str,
        value: Any,
    ) -> list[dict]:
        """Run a structured query. Returns a list of decoded documents."""
        url = f"{self.config.firestore_url}:runQuery"
        body = {
            "structuredQuery": {
                "from": [{"collectionId": collection}],
                "where": {
                    "fieldFilter": {
                        "field": {"fieldPath": field},
                        "op": op,
                        "value": to_firestore_value(value),
                    }
                },
            }
        }
        resp = requests.post(url, headers=self._headers, json=body)
        _check(resp, f"query {collection}")
        results = []
        for item in resp.json():
            doc = item.get("document")
            if doc:
                doc_id = doc["name"].split("/")[-1]
                fields = from_firestore_doc(doc)
                fields["_id"] = doc_id
                results.append(fields)
        return results

    def call_function(self, name: str, data: dict) -> dict:
        """Invoke a callable Cloud Function."""
        url = f"{self.config.functions_url}/{name}"
        resp = requests.post(
            url,
            headers={
                **self._headers,
                "Content-Type": "application/json",
            },
            json={"data": data},
        )
        _check(resp, f"call_function {name}")
        return resp.json().get("result", {})

    def call_http_function(self, name: str) -> dict:
        """Invoke an HTTP Cloud Function (GET)."""
        url = f"{self.config.functions_url}/{name}"
        resp = requests.get(url, headers=self._headers)
        _check(resp, f"call_http_function {name}")
        return resp.json()

    def upload_file(self, storage_path: str, local_path: str) -> str:
        """Upload a file to Firebase Storage. Returns the storage path."""
        # Firebase Storage REST API uses the Cloud Storage JSON API.
        # Pass the object name via `params` so requests handles URL
        # encoding for us — the previous `.replace("/", "%2F")` only
        # escaped slashes, so any future path containing spaces, `#`,
        # `%`, `?`, etc. would have broken the upload URL.
        import mimetypes
        bucket = f"{self.config.project_id}.firebasestorage.app"
        url = f"{self.config.storage_url_base}/v0/b/{bucket}/o"
        content_type = mimetypes.guess_type(local_path)[0] or "image/jpeg"
        with open(local_path, "rb") as f:
            data = f.read()
        resp = requests.post(
            url,
            params={"uploadType": "media", "name": storage_path},
            headers={
                **self._headers,
                "Content-Type": content_type,
            },
            data=data,
        )
        if resp.status_code >= 400:
            raise FirestoreError(
                f"Upload failed ({resp.status_code}) for "
                f"{storage_path}: {resp.text}"
            )
        return storage_path

    def poll_doc_field(
        self,
        path: str,
        field: str,
        expected: Any,
        timeout_s: float = 10,
        interval_s: float = 2,
    ) -> dict:
        """Poll a document until a field matches the expected value."""
        deadline = time.time() + timeout_s
        last_value = None
        while time.time() < deadline:
            doc = self.get_doc(path)
            if doc and doc.get(field) == expected:
                return doc
            last_value = doc.get(field) if doc else None
            time.sleep(interval_s)
        raise TimeoutError(
            f"Timed out waiting for {path}.{field} == {expected!r} "
            f"(last value: {last_value!r})"
        )


def make_timestamp(dt: datetime | None = None) -> str:
    """Create an ISO 8601 timestamp string for Firestore REST."""
    if dt is None:
        dt = datetime.now(timezone.utc)
    return dt.isoformat()
