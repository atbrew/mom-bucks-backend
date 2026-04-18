/**
 * onUserDeleted — profile photo cascade tests.
 *
 * When a Firebase Auth user is deleted, the corresponding profile
 * image at `users/{uid}/profile.jpg` must be deleted from Storage.
 * This is the server-side complement to `onChildDelete`'s profile
 * image cleanup.
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
  mockWhereGet,
  mockWhere,
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
  const _mockWhereGet = vi.fn().mockResolvedValue({ empty: true, docs: [], size: 0 });
  const _mockWhere = vi.fn().mockReturnValue({ get: _mockWhereGet });
  return {
    holder: _holder,
    mockStorageDelete: _mockStorageDelete,
    mockStorageFile: _mockStorageFile,
    mockBucket: _mockBucket,
    mockBulkWriterDelete: _mockBulkWriterDelete,
    mockBulkWriterClose: _mockBulkWriterClose,
    mockWhereGet: _mockWhereGet,
    mockWhere: _mockWhere,
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
    collection: vi.fn().mockReturnValue({ where: mockWhere }),
    bulkWriter: vi.fn().mockReturnValue({
      delete: mockBulkWriterDelete,
      close: mockBulkWriterClose,
      onWriteError: vi.fn(),
    }),
  }),
}));

// ── Import after mocks ───────────────────────────────────────────────

// This import evaluates the module, exposes the pure helper, and
// triggers the mock chain that captures the registered handler.
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

  it("deletes orphaned invites where invitedByUid matches", async () => {
    const fakeDoc = { ref: { path: "invites/token1" } };
    mockWhereGet.mockResolvedValueOnce({
      empty: false,
      docs: [fakeDoc],
      size: 1,
    });

    await holder.handler!({ uid: "u3" });

    expect(mockWhere).toHaveBeenCalledWith("invitedByUid", "==", "u3");
    expect(mockBulkWriterDelete).toHaveBeenCalledWith(fakeDoc.ref);
    expect(mockBulkWriterClose).toHaveBeenCalled();
  });

  it("skips invite cleanup when no orphaned invites exist", async () => {
    mockWhereGet.mockResolvedValueOnce({ empty: true, docs: [], size: 0 });

    await holder.handler!({ uid: "u4" });

    expect(mockBulkWriterDelete).not.toHaveBeenCalled();
  });

  it("survives invite cleanup failure without crashing", async () => {
    mockWhereGet.mockRejectedValueOnce(new Error("Firestore unavailable"));

    await expect(holder.handler!({ uid: "u5" })).resolves.not.toThrow();
  });
});
