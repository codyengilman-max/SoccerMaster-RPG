import { APP_NAME, APP_VERSION } from "../app/version";
import { formatDay } from "../calendar/date";
import type { SaveSummary } from "../save/save";
import { escapeHtml } from "./html";

export interface StartHandlers {
  onContinue(): void;
  onNew(): void;
  onQuickMatch(): void;
}

/** Campaign-first start screen (spec §3 step 1). Quick match stays as a secondary debug entry. */
export function mountStartScreen(root: HTMLElement, saved: SaveSummary | null, h: StartHandlers): void {
  root.className = "";
  root.innerHTML = `
    <section class="start">
      <h1>${APP_NAME}</h1>
      <p>Build ${APP_VERSION} — U11 opening.</p>
      <div class="card menu">
        ${
          saved
            ? `<button type="button" class="primary big continue">Continue<span class="sub">${escapeHtml(saved.playerName)} · ${saved.kind === "boys" ? "Boys'" : "Girls'"} campaign · ${formatDay(saved.day)}</span></button>`
            : ""
        }
        <button type="button" class="${saved ? "secondary" : "primary"} big new">${saved ? "New campaign" : "Start a campaign"}<span class="sub">Create your player and begin the U11 story</span></button>
        <button type="button" class="link quick">Quick match (debug)</button>
        <p class="muted small">Story, cast and tactical content are proposals, not yet owner-reviewed.</p>
      </div>
    </section>`;
  root.querySelector<HTMLButtonElement>("button.continue")?.addEventListener("click", h.onContinue);
  root.querySelector<HTMLButtonElement>("button.new")?.addEventListener("click", () => {
    if (saved && !window.confirm("Start a new campaign? The current autosave will be replaced.")) return;
    h.onNew();
  });
  root.querySelector<HTMLButtonElement>("button.quick")?.addEventListener("click", h.onQuickMatch);
}
