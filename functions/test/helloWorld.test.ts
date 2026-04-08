import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub firebase-admin before the helloWorld module is loaded. The handler
// calls initializeApp() at module load and getFirestore() inside the
// request handler — both need to be noops in unit tests so we don't need
// a real emulator running. The real Firestore plumbing is exercised by
// the post-deploy live curl smoke test documented in issue #8.
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

// firebase-functions/v2 onRequest returns an Express-shaped handler.
// We invoke it via the `__endpoint`-bypassing `.run` property when
// available, otherwise treat the export as the handler itself.
type RequestLike = {
  method: string;
  get: (header: string) => string | undefined;
};
type ResponseLike = {
  status: (code: number) => ResponseLike;
  json: (body: unknown) => ResponseLike;
};

function makeReq(overrides: Partial<RequestLike> = {}): RequestLike {
  return {
    method: "GET",
    get: () => undefined,
    ...overrides,
  };
}

function makeRes(): {
  res: ResponseLike;
  statusCode: () => number;
  body: () => unknown;
} {
  let statusCode = 0;
  let body: unknown = undefined;
  const res: ResponseLike = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(b: unknown) {
      body = b;
      return res;
    },
  };
  return { res, statusCode: () => statusCode, body: () => body };
}

async function runHandler(
  req: RequestLike,
  res: ResponseLike,
): Promise<void> {
  // firebase-functions/v2 onRequest exports the handler as a callable
  // Express-style function — invoking it directly is the supported way to
  // unit-test it.
  await (helloWorld as unknown as (r: RequestLike, s: ResponseLike) => Promise<void>)(
    req,
    res,
  );
}

describe("helloWorld HTTPS endpoint", () => {
  beforeEach(() => {
    setSpy.mockClear();
    docSpy.mockClear();
    collectionSpy.mockClear();
    getFirestoreMock.mockClear();
  });

  it("returns 200 with ok payload, ISO timestamp, and runtime tag", async () => {
    const { res, statusCode, body } = makeRes();
    await runHandler(makeReq(), res);

    expect(statusCode()).toBe(200);
    const payload = body() as {
      ok: boolean;
      ts: string;
      runtime: string;
      project: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.runtime).toBe("node22");
    expect(typeof payload.ts).toBe("string");
    expect(() => new Date(payload.ts).toISOString()).not.toThrow();
    expect(typeof payload.project).toBe("string");
  });

  it("writes a hello/{docId} record via the Admin SDK", async () => {
    const { res } = makeRes();
    await runHandler(
      makeReq({
        method: "POST",
        get: (h: string) => (h === "user-agent" ? "vitest" : undefined),
      }),
      res,
    );

    expect(collectionSpy).toHaveBeenCalledWith("hello");
    expect(docSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledTimes(1);
    const written = setSpy.mock.calls[0][0] as {
      calledAt: unknown;
      method: string;
      userAgent: string | null;
    };
    expect(written.calledAt).toBe("__SERVER_TIMESTAMP__");
    expect(written.method).toBe("POST");
    expect(written.userAgent).toBe("vitest");
  });

  it("records null userAgent when the header is missing", async () => {
    const { res } = makeRes();
    await runHandler(makeReq(), res);

    const written = setSpy.mock.calls[0][0] as { userAgent: string | null };
    expect(written.userAgent).toBeNull();
  });
});
