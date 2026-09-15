import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

describe("PWA shell", () => {
  it("manifest is valid, standalone, and every icon it lists exists", () => {
    const manifest = JSON.parse(read("public/manifest.webmanifest")) as {
      name: string;
      short_name: string;
      start_url: string;
      display: string;
      theme_color: string;
      background_color: string;
      icons: { src: string; sizes: string; type: string; purpose?: string }[];
    };
    expect(manifest.name).toBe("SoccerMaster RPG");
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
    for (const icon of manifest.icons) expect(existsSync(join(ROOT, "public", icon.src))).toBe(true);
    expect(manifest.icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable")).toBe(true);
    expect(manifest.icons.some((i) => i.sizes === "192x192")).toBe(true);
  });

  it("index.html links the manifest, icons and mobile app metadata", () => {
    const html = read("index.html");
    expect(html).toMatch(/<link rel="manifest" href="\/manifest.webmanifest"/);
    expect(html).toMatch(/<link rel="apple-touch-icon"/);
    expect(html).toMatch(/name="theme-color"/);
    expect(html).toMatch(/viewport-fit=cover/);
    expect(existsSync(join(ROOT, "public/icons/apple-touch-icon.png"))).toBe(true);
  });

  it("service worker template precaches, cleans old caches, and never intercepts cross-origin or non-GET", () => {
    const sw = read("pwa/sw.js");
    expect(sw).toContain("__PRECACHE__");
    expect(sw).toContain("__VERSION__");
    expect(sw).toMatch(/addEventListener\("install"/);
    expect(sw).toMatch(/addEventListener\("activate"/);
    expect(sw).toMatch(/addEventListener\("fetch"/);
    expect(sw).toMatch(/caches\.delete/);
    expect(sw).toMatch(/req\.method !== "GET"\) return/);
    expect(sw).toMatch(/!sameOrigin\(url\)\) return/);
    // parses as a script once the placeholders are filled
    const filled = sw.replace("__VERSION__", "test").replace("__PRECACHE__", '["/"]');
    expect(() => new Function(filled)).not.toThrow();
  });

  it("registration is gated to production builds so dev and tests never install a worker", () => {
    const src = read("src/pwa/register.ts");
    expect(src).toMatch(/import\.meta\.env\.PROD/);
    expect(src).toMatch(/"serviceWorker" in navigator/);
    expect(read("src/main.ts")).toMatch(/registerServiceWorker\(\)/);
  });
});
