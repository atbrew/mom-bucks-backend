/**
 * onChildDelete — cascade cleanup tests.
 *
 * The handler is a Firestore trigger, so full integration testing
 * runs against the emulator (see contract tests). These unit tests
 * verify the cascade behaviour by mocking Firestore and Storage:
 *
 *   1. Subcollection docs (transactions, vaultTransactions, activities)
 *      are enqueued for deletion via BulkWriter.
 *   2. The child's profile image at `children/{childId}/profile.jpg`
 *      is deleted from Storage (best-effort).
 *   3. Storage failures don't crash the trigger.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────

// Mock the Firestore trigger registration so the module loads without
// FIREBASE_CONFIG.
vi.mock("firebase-functions/v2/firestore", () => ({
  onDocumentDeleted: (_opts: unknown, handler: unknown) => handler,
}));

vi.mock("firebase-functions", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Capture the mock instances so tests can assert on them.
const mockDelete = vi.fn();
const mockFlush = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockOnWriteError = vi.fn();

const mockBulkWriter = {
  delete: mockDelete,
  flush: mockFlush,
  close: mockClose,
  onWriteError: mockOnWriteError,
};

// Storage mock
const mockStorageDelete = vi.fn().mockResolvedValue(undefined);
const mockStorageFile = vi.fn().mockReturnValue({
  delete: mockStorageDelete,
});
const mockBucket = vi.fn().mockReturnValue({
  file: mockStorageFile,
});

// Build mock Firestore doc snapshots for subcollection queries.
function makeSnap(docPaths: string[]) {
  const docs = docPaths.map((p) => ({
    ref: { path: p },
  }));
  return {
    empty: docs.length === 0,
    size: docs.length,
    docs,
  };
}

// Mock query chain builder
function mockCollectionWithDocs(docPaths: string[]) {
  // First call returns docs, second returns empty (pagination end)
  let callCount = 0;
  return {
    orderBy: vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        get: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) return makeSnap(docPaths);
          return makeSnap([]);
        }),
      }),
    }),
  };
}

const subcollectionDocs: Record<string, string[]> = {
  "children/child-1/transactions": ["children/child-1/transactions/t1"],
  "children/child-1/vaultTransactions": ["children/child-1/vaultTransactions/v1"],
  "children/child-1/activities": [],
};

// Invite query mock — `collection("invites").where(...).get()`
const mockInviteWhereGet = vi.fn().mockResolvedValue({ empty: true, docs: [], size: 0 });
const mockInviteWhere = vi.fn().mockReturnValue({ get: mockInviteWhereGet });

// Invite BulkWriter (separate from subcollection BulkWriter)
const mockInviteBulkWriterDelete = vi.fn();
const mockInviteBulkWriterClose = vi.fn().mockResolvedValue(undefined);
const mockInviteBulkWriterOnWriteError = vi.fn();

// Track bulkWriter call count so we can return different instances
let bulkWriterCallCount = 0;

const mockCollection = vi.fn().mockImplementation((path: string) => {
  if (path === "invites") {
    return { where: mockInviteWhere };
  }
  return mockCollectionWithDocs(subcollectionDocs[path] ?? []);
});

vi.mock("../../src/admin", () => ({
  getFirestore: () => ({
    bulkWriter: () => {
      bulkWriterCallCount++;
      // First call is for subcollection cleanup, second for invites
      if (bulkWriterCallCount === 1) return mockBulkWriter;
      return {
        delete: mockInviteBulkWriterDelete,
        close: mockInviteBulkWriterClose,
        onWriteError: mockInviteBulkWriterOnWriteError,
      };
    },
    collection: mockCollection,
  }),
  getStorage: () => ({
    bucket: mockBucket,
  }),
}));

// ── Import handler (after mocks) ─────────────────────────────────────

// The module-level `onDocumentDeleted` mock returns the raw handler
// function, so `onChildDelete` IS the async handler.
import { onChildDelete } from "../../src/handlers/onChildDelete";

// ── Tests ────────────────────────────────────────────────────────────

describe("onChildDelete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bulkWriterCallCount = 0;
    // Reset subcollection fixture docs
    subcollectionDocs["children/child-1/transactions"] = ["children/child-1/transactions/t1"];
    subcollectionDocs["children/child-1/vaultTransactions"] = ["children/child-1/vaultTransactions/v1"];
    subcollectionDocs["children/child-1/activities"] = [];
  });

  const fakeEvent = {
    params: { childId: "child-1" },
  };

  it("deletes subcollection docs via BulkWriter", async () => {
    await (onChildDelete as (event: unknown) => Promise<void>)(fakeEvent);

    // Should query all three subcollections
    expect(mockCollection).toHaveBeenCalledWith("children/child-1/transactions");
    expect(mockCollection).toHaveBeenCalledWith("children/child-1/vaultTransactions");
    expect(mockCollection).toHaveBeenCalledWith("children/child-1/activities");

    // Should have enqueued deletes for the two non-empty subcollection docs
    expect(mockDelete).toHaveBeenCalledTimes(2);
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("deletes the child profile image from Storage", async () => {
    await (onChildDelete as (event: unknown) => Promise<void>)(fakeEvent);

    expect(mockStorageFile).toHaveBeenCalledWith("children/child-1/profile.jpg");
    expect(mockStorageDelete).toHaveBeenCalledWith({ ignoreNotFound: true });
  });

  it("survives Storage deletion failure without crashing", async () => {
    mockStorageDelete.mockRejectedValueOnce(new Error("Storage unavailable"));

    // Should not throw — best-effort cleanup
    await expect(
      (onChildDelete as (event: unknown) => Promise<void>)(fakeEvent),
    ).resolves.not.toThrow();

    // Subcollection cleanup should still have happened
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("deletes orphaned invites where childId matches", async () => {
    const fakeInviteDoc = { ref: { path: "invites/token1" } };
    mockInviteWhereGet.mockResolvedValueOnce({
      empty: false,
      docs: [fakeInviteDoc],
      size: 1,
    });

    await (onChildDelete as (event: unknown) => Promise<void>)(fakeEvent);

    expect(mockInviteWhere).toHaveBeenCalledWith("childId", "==", "child-1");
    expect(mockInviteBulkWriterDelete).toHaveBeenCalledWith(fakeInviteDoc.ref);
    expect(mockInviteBulkWriterClose).toHaveBeenCalled();
  });

  it("skips invite cleanup when no orphaned invites exist", async () => {
    mockInviteWhereGet.mockResolvedValueOnce({ empty: true, docs: [], size: 0 });

    await (onChildDelete as (event: unknown) => Promise<void>)(fakeEvent);

    expect(mockInviteBulkWriterDelete).not.toHaveBeenCalled();
  });

  it("survives invite cleanup failure without crashing", async () => {
    mockInviteWhereGet.mockRejectedValueOnce(new Error("Firestore unavailable"));

    await expect(
      (onChildDelete as (event: unknown) => Promise<void>)(fakeEvent),
    ).resolves.not.toThrow();

    // Subcollection + storage cleanup should still have happened
    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});
