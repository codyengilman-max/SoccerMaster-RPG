import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

const ROOT_DIR = import.meta.dirname;

/** Emits `sw.js` from `pwa/sw.js` with the built asset list and a content hash baked in. */
function serviceWorker(): Plugin {
  const template = readFileSync(join(ROOT_DIR, "pwa", "sw.js"), "utf8");
  const publicFiles = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) publicFiles(p, out);
      else out.push("/" + relative(join(ROOT_DIR, "public"), p).split("\\").join("/"));
    }
    return out;
  };
  return {
    name: "soccermaster-service-worker",
    apply: "build",
    generateBundle(_opts, bundle) {
      const built = Object.keys(bundle)
        .filter((f) => !f.endsWith(".map"))
        .map((f) => "/" + f);
      const precache = ["/", "/index.html", ...built, ...publicFiles(join(ROOT_DIR, "public"))].filter((f, i, a) => a.indexOf(f) === i);
      const version = createHash("sha256").update(precache.join("\n")).digest("hex").slice(0, 12);
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: template.replace("__VERSION__", version).replace("__PRECACHE__", JSON.stringify(precache)),
      });
    },
  };
}

/** Commit the bundle was built from: Cloudflare Pages exposes it, a local build asks git. */
function buildSha(): string {
  const fromPages = process.env["CF_PAGES_COMMIT_SHA"];
  if (fromPages) return fromPages;
  try {
    return execSync("git rev-parse HEAD", { cwd: ROOT_DIR, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  plugins: [serviceWorker()],
  define: {
    __BUILD_SHA__: JSON.stringify(buildSha()),
  },
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // full-match headless runs (~2 s each) back several tactical tests
    testTimeout: 30_000,
  },
});
