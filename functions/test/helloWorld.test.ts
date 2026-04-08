import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub firebase-admin before the helloWorld module is loaded. The handler
// calls initializeApp() at module load and getFirestore() inside the
// request handler — both need to be noops in unit tests so we don't need
// a real emulator running. The real Firestore plumbing is exercised by
// the post-deploy smoke test documented in issue #8.
//
// Spies live inside `vi.hoisted(...)` because `vi.mock(...)` is hoisted
// above `const` declarations at runtime — referencing a plain `const`
// spy from the mock factory would throw "cannot access before
// initialization".

const { setSpy, docSpy, collectionSpy, getFirestoreMock } = vi.hoisted(() => {
  const setSpy = vi.fn().mockResolvedValue(undefined);
  const docSpy = vi.fn().mockReturnValue({ set: setSpy });
  const collectionSpy = vi.fn().mockReturnValue({ doc: docSpy });
  const getFirestoreMock = vi
    .fn()
    .mockReturnValue({ collection: collectionSpy });
  return { setSpy, docSpy, collectionSpy, getFirestoreMock };
});

vi.mock("firebase-admin/app", () => ({
  initializeApp: vi.fn(),
  getApps: vi.fn().mockReturnValue([]),
}));

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: getFirestoreMock,
  FieldValue: {
    serverTimestamp: vi.fn().mockReturnValue("__SERVER_TIMESTAMP__"),
  },
}));

// Importing AFTER the mocks so the module picks them up.
import { helloWorld } from "../src/helloWorld";

// firebase-functions/v2 onCall returns a CallableFunction; its internal
// `.run()` accepts a CallableRequest shape. We invoke it via the `.run`
// property so we can pass a fake auth + data payload without spinning up
// the Functions emulator.
type Runnable = {
  run: (req: {
    data: unknown;
    auth: { uid: string } | null;
    rawRequest: unknown;
    acceptsStreaming: boolean;
  }) => unknown | Promise<unknown>;
};

function runHandler(auth: { uid: string } | null): Promise<unknown> {
  const runnable = helloWorld as unknown as Runnable;
  return Promise.resolve(
    runnable.run({
      data: {},
      auth,
      rawRequest: {},
      acceptsStreaming: false,
    }),
  );
}

describe("helloWorld callable", () => {
  beforeEach(() => {
    setSpy.mockClear();
    docSpy.mockClear();
    collectionSpy.mockClear();
    getFirestoreMock.mockClear();
  });

  it("returns ok payload with ISO timestamp and runtime", async () => {
    const res = (await runHandler({ uid: "alice" })) as {
      ok: boolean;
      ts: string;
      runtime: string;
      project: string;
    };

    expect(res.ok).toBe(true);
    expect(res.runtime).toBe("node20");
    expect(typeof res.ts).toBe("string");
    expect(() => new Date(res.ts).toISOString()).not.toThrow();
    expect(typeof res.project).toBe("string");
  });

  it("writes a hello/{docId} record via the Admin SDK", async () => {
    await runHandler({ uid: "alice" });

    expect(collectionSpy).toHaveBeenCalledWith("hello");
    expect(docSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledTimes(1);
    const written = setSpy.mock.calls[0][0] as {
      calledAt: unknown;
      callerUid: string | null;
    };
    expect(written.calledAt).toBe("__SERVER_TIMESTAMP__");
    expect(written.callerUid).toBe("alice");
  });

  it("records null callerUid when the request is unauthenticated", async () => {
    await runHandler(null);

    const written = setSpy.mock.calls[0][0] as { callerUid: string | null };
    expect(written.callerUid).toBeNull();
  });
});
