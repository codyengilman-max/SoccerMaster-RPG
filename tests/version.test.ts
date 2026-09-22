import { describe, expect, it } from "vitest";
import { APP_NAME, APP_VERSION, BUILD_ID, BUILD_SHA } from "../src/app/version";

describe("scaffold", () => {
  it("exposes the app identity", () => {
    expect(APP_NAME).toBe("SoccerMaster RPG");
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("carries the commit it was built from so a deployed bundle can be matched to a reviewed SHA", () => {
    expect(BUILD_SHA).toMatch(/^([0-9a-f]{40}|dev|unknown)$/);
    expect(BUILD_ID).toBe(BUILD_SHA.slice(0, 7));
  });
});
