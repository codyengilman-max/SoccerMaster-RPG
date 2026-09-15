/**
 * Installs the service worker built by vite.config.ts. Only in production builds: in `vite dev`
 * there is no `sw.js`, and a stale worker would mask source changes.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // offline shell is a convenience; the game runs without it
    });
  });
}
