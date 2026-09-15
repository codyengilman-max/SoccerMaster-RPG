import type { Session } from "../app/session";
import { formatDay } from "../calendar/date";
import { PLAYER_ID } from "../campaign/campaign";
import { chooseInScene, continueScene, personName, viewScene, type SceneView } from "../story/flow";
import type { Line, LocationId, Scene } from "../story/scenes";
import { escapeHtml, q } from "./html";

export const LOCATION_LABEL: Record<LocationId, string> = {
  home: "Home",
  car: "In the car",
  school: "School",
  lunch_spot: "Lunch spot",
  training_field: "FC Batavia training field",
  park: "The park",
  tournament_hotel: "Tournament hotel",
  pitch: "Match pitch",
};

export interface SceneHandlers {
  /** The current scene finished (the campaign's `scene` already points at the next one, or null). */
  onNext(): void;
  /** The scene's lines are done and its playable activity should run. */
  onActivity(scene: Scene): void;
}

/**
 * One authored scene: lines reveal one tap at a time, then the eligible choices (or the activity /
 * continue control). Every mutation goes through story/flow; the screen autosaves after each.
 */
export function mountSceneScreen(root: HTMLElement, session: Session, h: SceneHandlers): void {
  const c = session.campaign;
  const view = viewScene(c, session.scenes);
  if (!view) {
    h.onNext();
    return;
  }
  root.className = "in-scene";
  root.innerHTML = `
    <section class="scene tone-${view.scene.tone}">
      <header class="scene-head">
        <div class="where"><span class="loc">${escapeHtml(LOCATION_LABEL[view.scene.location])}</span><span class="day">${formatDay(c.day)}</span></div>
        <h2>${escapeHtml(view.scene.title)}</h2>
      </header>
      <div class="dialogue" role="log" aria-live="polite"></div>
      <div class="scene-actions"></div>
    </section>`;
  const log = q<HTMLDivElement>(root, ".dialogue");
  const actions = q<HTMLDivElement>(root, ".scene-actions");
  const nameOf = (id: string): string => personName(c, id);

  const addLine = (l: Line): void => {
    const el = document.createElement("p");
    el.className = l.speaker === null ? "line narration" : `line said ${l.speaker === PLAYER_ID ? "me" : ""}`;
    el.innerHTML = l.speaker === null ? escapeHtml(l.text) : `<b>${escapeHtml(nameOf(l.speaker))}</b>${escapeHtml(l.text)}`;
    log.appendChild(el);
    el.scrollIntoView({ block: "end", behavior: "smooth" });
  };

  /** Reveal `lines` one per tap, then call `done`. */
  const reveal = (lines: readonly Line[], done: () => void): void => {
    let i = 0;
    const next = (): void => {
      if (i < lines.length) {
        addLine(lines[i++]!);
        if (i < lines.length) return;
      }
      log.onclick = null;
      done();
    };
    actions.innerHTML = lines.length > 1 ? `<button type="button" class="secondary tap">Tap to continue</button>` : "";
    actions.querySelector("button.tap")?.addEventListener("click", next);
    log.onclick = next;
    next();
  };

  const showEnd = (v: SceneView): void => {
    if (v.choices.length) {
      actions.innerHTML = `<div class="choices">${v.choices.map((ch) => `<button type="button" class="choice" data-id="${ch.id}">${escapeHtml(ch.label)}</button>`).join("")}</div>`;
      for (const b of actions.querySelectorAll<HTMLButtonElement>("button.choice")) {
        b.addEventListener("click", () => {
          const r = chooseInScene(c, session.scenes, b.dataset["id"]!);
          if (!r.ok) {
            actions.innerHTML = `<p class="muted">That option is no longer available (${r.reason}).</p>`;
            return;
          }
          session.save();
          const me = document.createElement("p");
          me.className = "line said me";
          me.innerHTML = `<b>${escapeHtml(c.player.name)}</b>${escapeHtml(b.textContent ?? "")}`;
          log.appendChild(me);
          reveal(r.response, () => {
            actions.innerHTML = `<button type="button" class="primary next">Continue</button>`;
            q<HTMLButtonElement>(actions, "button.next").addEventListener("click", h.onNext);
          });
        });
      }
      return;
    }
    if (v.scene.activity) {
      actions.innerHTML = `<button type="button" class="primary next">Start · ${escapeHtml(v.scene.title)}</button>`;
      q<HTMLButtonElement>(actions, "button.next").addEventListener("click", () => h.onActivity(v.scene));
      return;
    }
    actions.innerHTML = `<button type="button" class="primary next">Continue</button>`;
    q<HTMLButtonElement>(actions, "button.next").addEventListener("click", () => {
      continueScene(c, session.scenes);
      session.save();
      h.onNext();
    });
  };

  reveal(view.lines, () => showEnd(view));
}
