import { CONTINUATIONS, MINIGAME_TITLE, type AccessibilitySettings, type Continuation, type MinigameResult } from "../minigame/contract";
import { atCheckpoint, exit, input as machineInput, pause, resume, start, tick, type MinigameSession } from "../minigame/machine";
import { gameLogic, type AnyGameLogic } from "../minigame/registry";
import { escapeHtml, q } from "./html";
import { LOCATION_LABEL } from "./sceneScreen";
import { GAME_VIEWS, type GameView, type PadFrame, type ViewHost } from "./minigame/views";

export interface MinigameScreenOptions {
  session: MinigameSession<unknown, unknown>;
  /** Display names for participant ids. */
  names: Record<string, string>;
  /** The whole session is saved here whenever it is safe (round boundary, pause, tab hidden). */
  onCheckpoint(session: MinigameSession<unknown, unknown>): void;
  /** The session is resolved or abandoned and the player has read the result. */
  onDone(session: MinigameSession<unknown, unknown>): void;
  /** Accessibility settings changed on the start screen (persist them). */
  onAccessibility?(a: AccessibilitySettings): void;
}

interface Handle {
  destroy(): void;
}

const MAX_DT_MS = 100;
const PAD_DEADZONE = 0.35;

const CONTINUATION_TEXT: Record<Continuation, string> = {
  success: "Strong result",
  partial: "Got somewhere",
  failure: "Didn't come off",
  timeout: "Out of time",
  voluntary_exit: "Left early",
};

const continuationOf = (r: MinigameResult): Continuation => (r.exitReason === "completed" ? r.outcomeTier : r.exitReason);

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * The shared Story Engine minigame shell (v2 §5): one HUD, one pause/leave/settings surface, one
 * result card, one input router (touch, keyboard, gamepad) for every game. The game itself is a
 * `GameView` painting the machine's state and turning gestures into typed inputs; every state
 * change goes through the machine so a save is always a replayable snapshot.
 */
export function mountMinigameScreen(root: HTMLElement, opts: MinigameScreenOptions): Handle {
  const session = opts.session;
  const cfg = session.config;
  const logic: AnyGameLogic | undefined = gameLogic(cfg.gameId);
  const makeView = GAME_VIEWS[cfg.gameId];
  if (!logic || !makeView) throw new Error(`minigame ${cfg.gameId} has no view`);
  const title = MINIGAME_TITLE[cfg.gameId];
  const a11yClass = (): string => `${cfg.accessibility.reducedMotion ? " reduced-motion" : ""}${cfg.accessibility.highContrast ? " high-contrast" : ""}`;

  root.className = "in-minigame";
  root.innerHTML = `
    <section class="minigame game-${cfg.gameId}${a11yClass()}">
      <header class="mg-hud">
        <div class="mg-title"><b>${escapeHtml(title)}</b><span class="mg-sub">${escapeHtml(LOCATION_LABEL[cfg.locationId])} · ${escapeHtml(cfg.ruleVariant.replace(/_/g, " "))}</span></div>
        <div class="mg-status" aria-live="polite"></div>
        <div class="mg-timer" aria-label="time played">0:00</div>
        <button type="button" class="mg-pause" aria-label="Pause">Pause</button>
      </header>
      <div class="mg-stage"></div>
      <div class="mg-prompt" aria-live="polite"></div>
      <div class="mg-actions"></div>
      <div class="mg-overlay" role="dialog" aria-modal="true" hidden></div>
    </section>`;

  const section = q<HTMLElement>(root, "section.minigame");
  const stage = q<HTMLDivElement>(root, ".mg-stage");
  const statusEl = q<HTMLDivElement>(root, ".mg-status");
  const timerEl = q<HTMLDivElement>(root, ".mg-timer");
  const promptEl = q<HTMLDivElement>(root, ".mg-prompt");
  const actionsEl = q<HTMLDivElement>(root, ".mg-actions");
  const overlay = q<HTMLDivElement>(root, ".mg-overlay");
  const pauseBtn = q<HTMLButtonElement>(root, ".mg-pause");

  let destroyed = false;
  let raf = 0;
  let last = 0;
  let lastCheckpoint: string | null = session.lastCheckpoint;
  let doneShown = false;
  const padHeld: boolean[] = [];

  const host: ViewHost = {
    session,
    logic,
    names: opts.names,
    get reducedMotion() {
      return cfg.accessibility.reducedMotion;
    },
    send(i: unknown) {
      if (session.phase !== "active") return;
      const res = machineInput(session, logic, i, Date.now());
      if (res.ok) afterStep();
    },
    prompt(text: string) {
      promptEl.textContent = text;
    },
    status(text: string) {
      statusEl.textContent = text;
    },
    actions(buttons: { id: string; label: string; key?: string; primary?: boolean }[], onPick: (id: string) => void) {
      const html = buttons
        .map((b) => `<button type="button" class="mg-action${b.primary ? " primary" : ""}" data-id="${escapeHtml(b.id)}">${escapeHtml(b.label)}${b.key ? `<kbd>${escapeHtml(b.key)}</kbd>` : ""}</button>`)
        .join("");
      if (actionsEl.dataset["sig"] === html) return;
      actionsEl.dataset["sig"] = html;
      actionsEl.innerHTML = html;
      for (const b of actionsEl.querySelectorAll<HTMLButtonElement>("button.mg-action")) {
        b.addEventListener("click", (e) => {
          e.preventDefault();
          onPick(b.dataset["id"]!);
        });
      }
    },
  };

  const view: GameView = makeView(host);
  view.mount(stage);

  const refreshHud = (): void => {
    timerEl.textContent = mmss(session.elapsedMs);
    pauseBtn.textContent = session.phase === "paused" ? "Resume" : "Pause";
    pauseBtn.disabled = session.phase !== "active" && session.phase !== "paused";
  };

  const checkpointIfDue = (force = false): void => {
    if (!atCheckpoint(session, logic)) return;
    const label = logic.checkpoint(session.game) ?? `phase:${session.phase}`;
    if (!force && label === lastCheckpoint) return;
    lastCheckpoint = label;
    session.lastCheckpoint = label;
    opts.onCheckpoint(session);
  };

  const afterStep = (): void => {
    if (session.phase === "resolved" || session.phase === "abandoned") {
      if (!doneShown) {
        doneShown = true;
        opts.onCheckpoint(session);
        showResult();
      }
      return;
    }
    checkpointIfDue();
  };

  // ------------------------------------------------------------- overlays

  const a11yForm = (): string => {
    const a = cfg.accessibility;
    return `
      <fieldset class="mg-a11y">
        <legend>Make it easier to play</legend>
        <label><input type="checkbox" name="reducedMotion" ${a.reducedMotion ? "checked" : ""}> Reduce motion</label>
        <label><input type="checkbox" name="highContrast" ${a.highContrast ? "checked" : ""}> High contrast</label>
        <label><input type="checkbox" name="assist" ${a.assist ? "checked" : ""}> ${escapeHtml(view.assistLabel)}</label>
        <label>Timers <select name="timerScale">
          <option value="1" ${a.timerScale === 1 ? "selected" : ""}>Normal</option>
          <option value="1.5" ${a.timerScale === 1.5 ? "selected" : ""}>Slower (×1.5)</option>
          <option value="2" ${a.timerScale === 2 ? "selected" : ""}>Slowest (×2)</option>
        </select></label>
      </fieldset>`;
  };

  const readA11y = (form: HTMLElement, allowTimers: boolean): void => {
    const cb = (name: string): boolean => form.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.checked ?? false;
    cfg.accessibility.reducedMotion = cb("reducedMotion");
    cfg.accessibility.highContrast = cb("highContrast");
    if (allowTimers) {
      cfg.accessibility.assist = cb("assist");
      const ts = Number(form.querySelector<HTMLSelectElement>('select[name="timerScale"]')?.value ?? "1");
      cfg.accessibility.timerScale = ts === 2 ? 2 : ts === 1.5 ? 1.5 : 1;
    }
    section.className = `minigame game-${cfg.gameId}${a11yClass()}`;
    opts.onAccessibility?.({ ...cfg.accessibility });
  };

  const showOverlay = (html: string): void => {
    overlay.innerHTML = `<div class="mg-card">${html}</div>`;
    overlay.hidden = false;
    overlay.querySelector<HTMLButtonElement>("button.primary")?.focus();
  };
  const hideOverlay = (): void => {
    overlay.hidden = true;
    overlay.innerHTML = "";
  };

  const showStart = (): void => {
    const who = cfg.participantIds.slice(1).map((id) => opts.names[id] ?? id);
    showOverlay(`
      <h2>${escapeHtml(title)}</h2>
      <p class="mg-with">With ${escapeHtml(who.join(", "))}</p>
      <ul class="mg-howto">${view.howTo.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>
      ${a11yForm()}
      <div class="mg-card-actions">
        <button type="button" class="primary mg-start">Start</button>
        <button type="button" class="link mg-back">Not now</button>
      </div>`);
    q<HTMLButtonElement>(overlay, "button.mg-start").addEventListener("click", () => {
      readA11y(overlay, true);
      start(session);
      hideOverlay();
      last = 0;
      checkpointIfDue(true);
      refreshHud();
      stage.focus();
    });
    q<HTMLButtonElement>(overlay, "button.mg-back").addEventListener("click", () => {
      // Leaving before the first serve is not a voluntary exit: nothing has happened yet.
      destroy();
      opts.onDone(session);
    });
  };

  const showPaused = (restored: boolean): void => {
    showOverlay(`
      <h2>${restored ? "Welcome back" : "Paused"}</h2>
      <p class="mg-with">${restored ? "Picking up where you left off." : `${escapeHtml(title)} · ${mmss(session.elapsedMs)} played`}</p>
      ${a11yForm()}
      <div class="mg-card-actions">
        <button type="button" class="primary mg-resume">${restored ? "Continue" : "Resume"}</button>
        <button type="button" class="secondary mg-leave">Leave the game</button>
      </div>`);
    overlay.querySelector<HTMLSelectElement>('select[name="timerScale"]')?.setAttribute("disabled", "");
    overlay.querySelector<HTMLInputElement>('input[name="assist"]')?.setAttribute("disabled", "");
    q<HTMLButtonElement>(overlay, "button.mg-resume").addEventListener("click", () => {
      readA11y(overlay, false);
      resume(session);
      hideOverlay();
      last = 0;
      refreshHud();
      stage.focus();
    });
    q<HTMLButtonElement>(overlay, "button.mg-leave").addEventListener("click", showLeaveConfirm);
  };

  const showLeaveConfirm = (): void => {
    showOverlay(`
      <h2>Leave now?</h2>
      <p>${escapeHtml(view.leaveWarning)}</p>
      <div class="mg-card-actions">
        <button type="button" class="secondary mg-stay">Stay</button>
        <button type="button" class="primary danger mg-confirm-leave">Leave</button>
      </div>`);
    q<HTMLButtonElement>(overlay, "button.mg-stay").addEventListener("click", () => showPaused(false));
    q<HTMLButtonElement>(overlay, "button.mg-confirm-leave").addEventListener("click", () => {
      if (exit(session, logic, Date.now()).ok) afterStep();
      else showPaused(false);
    });
  };

  const showResult = (): void => {
    const r = session.result;
    if (!r) return;
    const cont = continuationOf(r);
    const idx = CONTINUATIONS.indexOf(cont);
    showOverlay(`
      <h2>${escapeHtml(CONTINUATION_TEXT[cont])}</h2>
      <p class="mg-with">${escapeHtml(title)} · ${mmss(session.elapsedMs)} played · ${r.verifiedActions.length} recorded actions</p>
      <div class="mg-result">${view.resultHtml(r)}</div>
      <p class="mg-ledger">Written to your story · outcome ${idx >= 0 ? escapeHtml(cont.replace(/_/g, " ")) : ""}</p>
      <div class="mg-card-actions"><button type="button" class="primary mg-continue">Continue</button></div>`);
    q<HTMLButtonElement>(overlay, "button.mg-continue").addEventListener("click", () => {
      destroy();
      opts.onDone(session);
    });
  };

  // ------------------------------------------------------------- input

  const togglePause = (): void => {
    if (session.phase === "active") {
      pause(session);
      checkpointIfDue(true);
      refreshHud();
      showPaused(false);
    } else if (session.phase === "paused" && !overlay.hidden) {
      const btn = overlay.querySelector<HTMLButtonElement>("button.mg-resume");
      btn?.click();
    }
  };
  pauseBtn.addEventListener("click", togglePause);

  const onKey = (e: KeyboardEvent): void => {
    if (destroyed) return;
    if (e.code === "Escape" || (e.key.toLowerCase() === "p" && !e.metaKey && !e.ctrlKey)) {
      if (session.phase === "active" || session.phase === "paused") {
        e.preventDefault();
        togglePause();
      }
      return;
    }
    if (!overlay.hidden) return;
    if (session.phase !== "active") return;
    if (view.onKey(e)) e.preventDefault();
  };
  window.addEventListener("keydown", onKey);
  const onKeyUp = (e: KeyboardEvent): void => {
    if (destroyed || !view.onKeyUp) return;
    view.onKeyUp(e);
  };
  window.addEventListener("keyup", onKeyUp);

  const onHidden = (): void => {
    if (destroyed) return;
    if (document.visibilityState === "hidden" && session.phase === "active") {
      pause(session);
      checkpointIfDue(true);
      refreshHud();
      showPaused(false);
    }
  };
  document.addEventListener("visibilitychange", onHidden);
  const onPageHide = (): void => {
    if (destroyed) return;
    if (session.phase === "active") pause(session);
    checkpointIfDue(true);
  };
  window.addEventListener("pagehide", onPageHide);

  const readPad = (): PadFrame | null => {
    const pads = typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];
    const pad = [...pads].find((p) => p && p.connected);
    if (!pad) return null;
    const pressed: number[] = [];
    pad.buttons.forEach((b, i) => {
      const held = b.pressed;
      if (held && !padHeld[i]) pressed.push(i);
      padHeld[i] = held;
    });
    const ax = pad.axes[0] ?? 0;
    const ay = pad.axes[1] ?? 0;
    const dpadX = (pad.buttons[15]?.pressed ? 1 : 0) - (pad.buttons[14]?.pressed ? 1 : 0);
    const dpadY = (pad.buttons[13]?.pressed ? 1 : 0) - (pad.buttons[12]?.pressed ? 1 : 0);
    const x = Math.abs(ax) > PAD_DEADZONE ? ax : dpadX;
    const y = Math.abs(ay) > PAD_DEADZONE ? ay : dpadY;
    return { x, y, pressed, held: pad.buttons.map((b) => b.pressed) };
  };

  // ------------------------------------------------------------- loop

  const frame = (now: number): void => {
    if (destroyed) return;
    raf = requestAnimationFrame(frame);
    const dt = last ? Math.min(MAX_DT_MS, now - last) : 0;
    last = now;
    const pad = readPad();
    if (pad && pad.pressed.includes(9) && (session.phase === "active" || session.phase === "paused")) togglePause();
    if (session.phase === "active" && dt > 0) {
      if (pad) view.onPad(pad, dt);
      view.beforeTick?.(dt);
      const r = tick(session, logic, dt, Date.now());
      if (r.ok) afterStep();
    }
    view.render(dt);
    refreshHud();
  };

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    cancelAnimationFrame(raf);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("keyup", onKeyUp);
    document.removeEventListener("visibilitychange", onHidden);
    window.removeEventListener("pagehide", onPageHide);
    view.destroy();
  };

  // A restored session arrives paused (machine.restore); a fresh one at `start`.
  if (session.phase === "start") showStart();
  else if (session.phase === "paused") showPaused(session.events.some((e) => e.type === "paused" && e.detail === "restored"));
  else if (session.phase === "resolved" || session.phase === "abandoned") {
    doneShown = true;
    showResult();
  }
  refreshHud();
  raf = requestAnimationFrame(frame);
  return { destroy };
}
