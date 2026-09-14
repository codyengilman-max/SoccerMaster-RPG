import { describe, expect, it } from "vitest";
import { APP_NAME, APP_VERSION } from "../src/app/version";

describe("scaffold", () => {
  it("exposes the app identity", () => {
    expect(APP_NAME).toBe("SoccerMaster RPG");
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
