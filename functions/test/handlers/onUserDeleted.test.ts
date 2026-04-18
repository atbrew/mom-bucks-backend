/**
 * onUserDeleted — cascade cleanup tests.
 *
 * When a Firebase Auth user is deleted, the handler must:
 *   1. Delete `users/{uid}/profile.jpg` from Storage.
 *   2. Delete the `users/{uid}` Firestore doc.
 *   3. Cascade-delete sole-parent children (triggering onChildDelete),
 *      and remove uid from parentUids of co-parented children.
 *   4. Delete invites sent by this user (`invitedByUid == uid`).
 *
 * The pure decision logic is extracted into `buildUserCleanupPlan()`
 * so it's testable without mocking Firestore/Storage. The handler
 * itself is a thin orchestration layer.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────

// vi.hoisted runs before vi.mock hoisting, so the holder is available
// when the mock factory captures the onDelete handler.
const {
  holder,
  mockStorageDelete,
  mockStorageFile,
  mockBucket,
  mockBulkWriterDelete,
  mockBulkWriterClose,
  mockInviteWhereGet,
  mockInviteWhere,
  mockUserDocDelete,
  mockChildrenWhereGet,
  mockChildDelete,
  mockChildUpdate,
  mockArrayRemove,
  mockCollection,
} = vi.hoisted(() => {
  const _holder: { handler: ((user: unknown) => Promise<void>) | null } = {
    handler: null,
  };
  const _mockStorageDelete = vi.fn().mockResolvedValue(undefined);
  const _mockStorageFile = vi.fn().mockReturnValue({
    delete: _mockStorageDelete,
  });
  const _mockBucket = vi.fn().mockReturnValue({
    file: _mockStorageFile,
  });
  const _mockBulkWriterDelete = vi.fn();
  const _mockBulkWriterClose = vi.fn().mockResolvedValue(undefined);
  const _mockInviteWhereGet = vi.fn().mockResolvedValue({
    empty: true,
    docs: [],
    size: 0,
  });
  const _mockInviteWhere = vi
    .fn()
    .mockReturnValue({ get: _mockInviteWhereGet });
  const _mockUserDocDelete = vi.fn().mockResolvedValue(undefined);
  const _mockChildrenWhereGet = vi.fn().mockResolvedValue({
    empty: true,
    docs: [],
    size: 0,
  });
  const _mockChildrenWhere = vi
    .fn()
    .mockReturnValue({ get: _mockChildrenWhereGet });
  const _mockChildDelete = vi.fn().mockResolvedValue(undefined);
  const _mockChildUpdate = vi.fn().mockResolvedValue(undefined);
  const _mockArrayRemove = vi.fn((...args: unknown[]) => ({
    _sentinel: "arrayRemove",
    args,
  }));
  const _mockCollection = vi.fn().mockImplementation((path: string) => {
    if (path === "children") return { where: _mockChildrenWhere };
    return { where: _mockInviteWhere };
  });
  return {
    holder: _holder,
    mockStorageDelete: _mockStorageDelete,
    mockStorageFile: _mockStorageFile,
    mockBucket: _mockBucket,
    mockBulkWriterDelete: _mockBulkWriterDelete,
    mockBulkWriterClose: _mockBulkWriterClose,
    mockInviteWhereGet: _mockInviteWhereGet,
    mockInviteWhere: _mockInviteWhere,
    mockUserDocDelete: _mockUserDocDelete,
    mockChildrenWhereGet: _mockChildrenWhereGet,
    mockChildDelete: _mockChildDelete,
    mockChildUpdate: _mockChildUpdate,
    mockArrayRemove: _mockArrayRemove,
    mockCollection: _mockCollection,
  };
});

vi.mock("firebase-functions/v1", () => ({
  region: () => ({
    auth: {
      user: () => ({
        onDelete: (fn: (user: unknown) => Promise<void>) => {
          holder.handler = fn;
          return fn;
        },
      }),
    },
  }),
}));

vi.mock("firebase-functions", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../src/admin", () => ({
  getStorage: () => ({
    bucket: mockBucket,
  }),
  getFirestore: () => ({
    doc: () => ({ delete: mockUserDocDelete }),
    collection: mockCollection,
    bulkWriter: () => ({
      delete: mockBulkWriterDelete,
      close: mockBulkWriterClose,
      onWriteError: vi.fn(),
    }),
  }),
  FieldValue: { arrayRemove: mockArrayRemove },
}));

// ── Import after mocks ───────────────────────────────────────────────

// A named import evaluates the entire module, running the module-level
// `functions.region(...).auth.user().onDelete(fn)` call.  The mock for
// firebase-functions/v1 intercepts that call and stores `fn` in
// `holder.handler`, so tests can invoke it directly.
import { buildUserCleanupPlan } from "../../src/handlers/onUserDeleted";

// ── Pure logic tests ─────────────────────────────────────────────────

describe("buildUserCleanupPlan", () => {
  it("returns the profile image path for a valid uid", () => {
    const plan = buildUserCleanupPlan("abc123");
    expect(plan).toEqual({
      storagePath: "users/abc123/profile.jpg",
    });
  });

  it("returns null for an empty uid", () => {
    expect(buildUserCleanupPlan("")).toBeNull();
  });
});

// ── Handler tests ────────────────────────────────────────────────────

describe("onUserDeleted handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers an onDelete handler", () => {
    expect(holder.handler).not.toBeNull();
  });

  it("deletes the user profile image from Storage", async () => {
    await holder.handler!({ uid: "u1" });

    expect(mockStorageFile).toHaveBeenCalledWith("users/u1/profile.jpg");
    expect(mockStorageDelete).toHaveBeenCalledWith({ ignoreNotFound: true });
  });

  it("survives Storage deletion failure without crashing", async () => {
    mockStorageDelete.mockRejectedValueOnce(new Error("Storage unavailable"));

    // Should not throw — best-effort cleanup, same as onChildDelete
    await expect(holder.handler!({ uid: "u2" })).resolves.not.toThrow();
  });

  it("skips cleanup when event has no user data", async () => {
    await holder.handler!(null);

    expect(mockStorageFile).not.toHaveBeenCalled();
  });

  it("deletes the users/{uid} Firestore doc", async () => {
    await holder.handler!({ uid: "u1" });

    expect(mockUserDocDelete).toHaveBeenCalled();
  });

  it("survives user doc deletion failure without crashing", async () => {
    mockUserDocDelete.mockRejectedValueOnce(new Error("Firestore error"));

    await expect(holder.handler!({ uid: "u2" })).resolves.not.toThrow();
  });

  it("deletes sole-parent child docs so onChildDelete cascades", async () => {
    const childRef = {
      path: "children/child-1",
      delete: mockChildDelete,
      update: mockChildUpdate,
    };
    mockChildrenWhereGet.mockResolvedValueOnce({
      empty: false,
      size: 1,
      docs: [{ ref: childRef, data: () => ({ parentUids: ["u1"] }) }],
    });

    await holder.handler!({ uid: "u1" });

    expect(mockChildDelete).toHaveBeenCalled();
    expect(mockChildUpdate).not.toHaveBeenCalled();
  });

  it("removes uid from parentUids of co-parented children", async () => {
    const childRef = {
      path: "children/child-1",
      delete: mockChildDelete,
      update: mockChildUpdate,
    };
    mockChildrenWhereGet.mockResolvedValueOnce({
      empty: false,
      size: 1,
      docs: [
        { ref: childRef, data: () => ({ parentUids: ["u1", "u-other"] }) },
      ],
    });

    await holder.handler!({ uid: "u1" });

    expect(mockChildUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ parentUids: expect.anything() }),
    );
    expect(mockArrayRemove).toHaveBeenCalledWith("u1");
    expect(mockChildDelete).not.toHaveBeenCalled();
  });

  it("skips children cascade when user has no children", async () => {
    // Default: mockChildrenWhereGet returns empty
    await holder.handler!({ uid: "u1" });

    expect(mockChildDelete).not.toHaveBeenCalled();
    expect(mockChildUpdate).not.toHaveBeenCalled();
  });

  it("survives children cascade failure without crashing", async () => {
    mockChildrenWhereGet.mockRejectedValueOnce(
      new Error("Firestore unavailable"),
    );

    await expect(holder.handler!({ uid: "u3" })).resolves.not.toThrow();
  });

  it("deletes orphaned invites where invitedByUid matches", async () => {
    const fakeDoc = { ref: { path: "invites/token1" } };
    mockInviteWhereGet.mockResolvedValueOnce({
      empty: false,
      docs: [fakeDoc],
      size: 1,
    });

    await holder.handler!({ uid: "u3" });

    expect(mockInviteWhere).toHaveBeenCalledWith("invitedByUid", "==", "u3");
    expect(mockBulkWriterDelete).toHaveBeenCalledWith(fakeDoc.ref);
    expect(mockBulkWriterClose).toHaveBeenCalled();
  });

  it("skips invite cleanup when no orphaned invites exist", async () => {
    // Default: mockInviteWhereGet returns empty
    await holder.handler!({ uid: "u4" });

    expect(mockBulkWriterDelete).not.toHaveBeenCalled();
  });

  it("survives invite cleanup failure without crashing", async () => {
    mockInviteWhereGet.mockRejectedValueOnce(
      new Error("Firestore unavailable"),
    );

    await expect(holder.handler!({ uid: "u5" })).resolves.not.toThrow();
  });
});
