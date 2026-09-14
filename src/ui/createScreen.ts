import type { CampaignKind, Foot, Month, PlayerProfile } from "../campaign/campaign";
import { ROLE_LABEL, ROLE_NUMBERS, type RoleNumber } from "../sim/types";
import { escapeHtml, q } from "./html";

/** Appearance presets (OPEN_QUESTIONS #4): placeholder labels until art direction lands. */
export const APPEARANCE_PRESETS: readonly string[] = ["Short dark hair", "Curly hair", "Long hair, tied back", "Buzz cut", "Braids", "Glasses, short hair"];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export interface CreateResult {
  kind: CampaignKind;
  player: PlayerProfile;
}

export interface CreateHandlers {
  onCreate(r: CreateResult): void;
  onBack(): void;
}

const kindLabel = (k: CampaignKind): string => (k === "boys" ? "Boys' campaign" : "Girls' campaign");

/** Campaign choice → player creation → locked position (spec §3 steps 2–4), in one scrolling form. */
export function mountCreateScreen(root: HTMLElement, h: CreateHandlers): void {
  root.className = "";
  let kind: CampaignKind | null = null;
  let position: RoleNumber | null = null;
  let appearance = 0;

  root.innerHTML = `
    <section class="start create">
      <h1>Your player</h1>
      <form class="card" novalidate>
        <h2>1 · Campaign</h2>
        <div class="segmented kinds">
          ${(["boys", "girls"] as CampaignKind[]).map((k) => `<button type="button" class="seg" data-kind="${k}" aria-pressed="false">${kindLabel(k)}</button>`).join("")}
        </div>
        <p class="muted small">The friend, family and school scenes differ between campaigns; soccer ability does not.</p>

        <h2>2 · Who you are</h2>
        <label class="field">Name<input name="name" type="text" maxlength="24" autocomplete="off" placeholder="First name" required /></label>
        <div class="field">
          <span>Look</span>
          <div class="presets">
            ${APPEARANCE_PRESETS.map((p, i) => `<button type="button" class="preset" data-i="${i}" aria-pressed="${i === 0}"><i class="avatar a${i}"></i><span>${escapeHtml(p)}</span></button>`).join("")}
          </div>
        </div>
        <div class="row">
          <label class="field">Stronger foot
            <select name="foot"><option value="right">Right</option><option value="left">Left</option></select>
          </label>
          <label class="field">Birth month
            <select name="month">${MONTHS.map((m, i) => `<option value="${i + 1}"${i === 5 ? " selected" : ""}>${m}</option>`).join("")}</select>
          </label>
        </div>

        <h2>3 · Position</h2>
        <p class="muted small">1-3-2-3. Your position stays locked for a whole match — you never switch to a teammate.</p>
        <div class="roles">
          ${ROLE_NUMBERS.map((n) => `<button type="button" class="role" data-role="${n}" aria-pressed="false"><b>${n}</b><span>${ROLE_LABEL[n]}</span></button>`).join("")}
        </div>

        <p class="error" hidden></p>
        <div class="actions">
          <button type="button" class="link back">Back</button>
          <button type="submit" class="primary go">Begin the story</button>
        </div>
      </form>
    </section>`;

  const form = q<HTMLFormElement>(root, "form");
  const err = q<HTMLParagraphElement>(root, ".error");
  const nameInput = q<HTMLInputElement>(root, "input[name=name]");

  const pressGroup = (sel: string, isOn: (b: HTMLButtonElement) => boolean): void => {
    for (const b of root.querySelectorAll<HTMLButtonElement>(sel)) b.setAttribute("aria-pressed", String(isOn(b)));
  };
  for (const b of root.querySelectorAll<HTMLButtonElement>("button.seg")) {
    b.addEventListener("click", () => {
      kind = b.dataset["kind"] as CampaignKind;
      pressGroup("button.seg", (x) => x === b);
    });
  }
  for (const b of root.querySelectorAll<HTMLButtonElement>("button.preset")) {
    b.addEventListener("click", () => {
      appearance = Number(b.dataset["i"]);
      pressGroup("button.preset", (x) => x === b);
    });
  }
  for (const b of root.querySelectorAll<HTMLButtonElement>("button.role")) {
    b.addEventListener("click", () => {
      position = Number(b.dataset["role"]) as RoleNumber;
      pressGroup("button.role", (x) => x === b);
    });
  }
  q<HTMLButtonElement>(root, "button.back").addEventListener("click", h.onBack);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    const problems: string[] = [];
    if (!kind) problems.push("pick a campaign");
    if (!name) problems.push("enter a name");
    if (!position) problems.push("pick a position");
    if (problems.length) {
      err.textContent = `To begin: ${problems.join(", ")}.`;
      err.hidden = false;
      return;
    }
    const foot = q<HTMLSelectElement>(root, "select[name=foot]").value as Foot;
    const birthMonth = Number(q<HTMLSelectElement>(root, "select[name=month]").value) as Month;
    h.onCreate({ kind: kind!, player: { name, appearance, foot, birthMonth, position: position! } });
  });
}
