import { describe, it, expect } from "vitest";
import { SDK_PLACEHOLDER } from "../src/index.js";

describe("sdk placeholder", () => {
  it("exists so CI has something to run before Phase 8", () => {
    expect(SDK_PLACEHOLDER).toBe(true);
  });
});
