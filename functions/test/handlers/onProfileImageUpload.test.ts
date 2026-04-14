import { describe, expect, it, vi } from "vitest";

// Mock the storage trigger registration so importing the module
// doesn't require FIREBASE_CONFIG at test time.
vi.mock("firebase-functions/v2/storage", () => ({
  onObjectFinalized: () => () => {},
}));

import { parseProfilePath } from "../../src/handlers/onProfileImageUpload";

describe("parseProfilePath", () => {
  it("parses a user profile path", () => {
    expect(parseProfilePath("users/abc123/profile.jpg")).toEqual({
      collection: "users",
      docId: "abc123",
      storagePath: "users/abc123/profile.jpg",
    });
  });

  it("parses a child profile path", () => {
    expect(parseProfilePath("children/xyz789/profile.jpg")).toEqual({
      collection: "children",
      docId: "xyz789",
      storagePath: "children/xyz789/profile.jpg",
    });
  });

  it("returns null for unrelated paths", () => {
    expect(parseProfilePath("other/abc/profile.jpg")).toBeNull();
    expect(parseProfilePath("children/abc/photo.png")).toBeNull();
    expect(parseProfilePath("children/abc/nested/profile.jpg")).toBeNull();
    expect(parseProfilePath("")).toBeNull();
  });

  it("returns null for paths without a doc ID", () => {
    expect(parseProfilePath("users//profile.jpg")).toBeNull();
  });
});
