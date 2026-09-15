import { escapeHtml } from "../ui/html";

/**
 * Last line of defence for the single-page shell. An uncaught error inside a screen (a render
 * frame, an input handler, a scene lookup) would otherwise leave whatever was on screen dead with
 * no control that still works. This replaces the screen with a way out: back to the start screen
 * (saves are untouched) or a hard reload that also drops the offline cache.
 */
export interface RecoveryHandlers {
  onRestart: () => void;
}

let installed = false;
let showing = false;

export function installRecovery(root: HTMLElement, h: RecoveryHandlers): void {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (e) => show(root, h, e.error instanceof Error ? e.error : new Error(String(e.message))));
  window.addEventListener("unhandledrejection", (e) => {
    const reason: unknown = e.reason;
    show(root, h, reason instanceof Error ? reason : new Error(String(reason)));
  });
}

async function hardReload(): Promise<void> {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } finally {
    window.location.reload();
  }
}

function show(root: HTMLElement, h: RecoveryHandlers, err: Error): void {
  if (showing) return;
  showing = true;
  console.error(err);
  root.innerHTML = `
    <section class="screen recovery">
      <div class="card">
        <h1>Something went wrong</h1>
        <p>The game hit an error and stopped this screen. Your saved campaign is safe.</p>
        <pre>${escapeHtml(err.message)}</pre>
        <div class="actions">
          <button class="primary restart" type="button">Back to start</button>
          <button class="link reload" type="button">Reload the game</button>
        </div>
      </div>
    </section>`;
  root.querySelector<HTMLButtonElement>("button.restart")!.addEventListener("click", () => {
    showing = false;
    h.onRestart();
  });
  root.querySelector<HTMLButtonElement>("button.reload")!.addEventListener("click", () => {
    void hardReload();
  });
}
