import { attachPointer, type PointerAdapter } from "../gesture/pointer";
import { createCommentary, routineLine, scorelineLine } from "../match/commentary";
import { formatRealTime, totalRealMs } from "../match/pace";
import {
  cancel,
  frame,
  liveAnchor,
  previewGesture,
  releaseGesture,
  select,
  setAccessible,
  tapTarget,
  windowProgress,
  windowRemaining,
  type MatchRuntime,
  type MomentClosed,
} from "../match/runtime";
import { createCamera, follow, frameFor, resize, setInsets, toField, type Camera } from "../render/camera";
import { createProbe, formatSummary, type ProbeSummary } from "../perf/probe";
import { render } from "../render/pitch";
import { ballDisplayPos, ballHeightM, createPresentation, deriveVisuals } from "../render/presentation";
import { spriteAssets, type SpriteSet } from "../render/sprites";
import type { Vec2 } from "../sim/geometry";
import type { MatchEvent } from "../sim/types";
import { coverageReport } from "../tactics/coverage";
import type { MomentRecord } from "../tactics/moments";
import { feedbackFor } from "../tactics/session";

/**
 * The match screen: canvas + HUD + option panel. DOM for anything the user must read (spec §21
 * "clear typography and touch controls"), canvas for the moving picture. All soccer decisions live
 * in the runtime; this file only maps frames and pointer paths to it and draws what it says.
 */

export interface MatchScreenHandle {
  /** Rolling frame-time summary for the last ~300 frames (docs/PERFORMANCE.md). */
  perf(): ProbeSummary;
  destroy(): void;
}

const MAX_FRAME_MS = 100;
const TICKER_LINES = 3;
const TICK_MS = 50;
const TRAIL_LENGTH = 18;

export interface MatchScreenOptions {
  /** Label of the button under the full-time summary. */
  exitLabel?: string;
}

/** `onExit` is called once the user leaves the full-time summary; the runtime holds the finished state and records. */
export function mountMatchScreen(root: HTMLElement, runtime: MatchRuntime, onExit: (runtime: MatchRuntime) => void, opts: MatchScreenOptions = {}): MatchScreenHandle {
  root.classList.add("in-match");
  const params = new URLSearchParams(location.search);
  const debug = params.has("debug");
  root.innerHTML = `
    <section class="match${debug ? " debug" : ""}">
      <div class="stage">
        <canvas class="pitch" aria-label="match view"></canvas>
        <header class="hud">
          <div class="score"><span class="team home">${escapeHtml(runtime.state.home.shortName)}</span><b class="num">0 – 0</b><span class="team away">${escapeHtml(runtime.state.away.shortName)}</span></div>
          <div class="clock"><span class="time">00:00</span><span class="half">1st</span></div>
          <div class="speed" aria-live="polite"><span class="rate">live</span><span class="real" title="real time played">0:00</span></div>
        </header>
        <div class="window" hidden><div class="bar"></div><span class="left"></span></div>
        <div class="banner" hidden></div>
        <div class="perf" hidden></div>
        <div class="dock">
          <section class="panel">
            <div class="moment" hidden>
              <div class="title"></div>
              <ul class="cues"></ul>
              <div class="options" role="group" aria-label="tactical options"></div>
              <div class="hint" hidden></div>
            </div>
            <div class="feedback" hidden></div>
            <ul class="ticker" aria-live="polite"></ul>
          </section>
          <footer class="controls">
            <button type="button" class="toggle accessible" aria-pressed="false" title="Choose targets by tapping instead of drawing">Tap targets</button>
            <button type="button" class="toggle fast" aria-pressed="false" title="Fast-forward routine play">Fast play</button>
            <button type="button" class="toggle pause" aria-pressed="false">Pause</button>
            <span class="provisional" title="Tactical content is provisional and not coach-reviewed"${debug ? "" : " hidden"}>provisional</span>
          </footer>
        </div>
      </div>
    </section>`;

  const q = <T extends Element>(sel: string): T => {
    const el = root.querySelector<T>(sel);
    if (!el) throw new Error(`missing ${sel}`);
    return el;
  };
  const canvas = q<HTMLCanvasElement>("canvas.pitch");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  const stage = q<HTMLDivElement>(".stage");
  const scoreEl = q<HTMLElement>(".score .num");
  const timeEl = q<HTMLElement>(".clock .time");
  const halfEl = q<HTMLElement>(".clock .half");
  const speedEl = q<HTMLElement>(".speed");
  const rateEl = q<HTMLElement>(".speed .rate");
  const realEl = q<HTMLElement>(".speed .real");
  const perfEl = q<HTMLElement>(".perf");
  const probe = createProbe();
  const showPerf = params.has("perf");
  perfEl.hidden = !showPerf;
  const windowEl = q<HTMLDivElement>(".window");
  const windowBar = q<HTMLDivElement>(".window .bar");
  const windowLeft = q<HTMLSpanElement>(".window .left");
  const bannerEl = q<HTMLDivElement>(".banner");
  const momentEl = q<HTMLDivElement>(".moment");
  const titleEl = q<HTMLDivElement>(".moment .title");
  const cuesEl = q<HTMLUListElement>(".moment .cues");
  const optionsEl = q<HTMLDivElement>(".moment .options");
  const hintEl = q<HTMLDivElement>(".moment .hint");
  const feedbackEl = q<HTMLDivElement>(".feedback");
  const tickerEl = q<HTMLUListElement>(".ticker");
  const accessibleBtn = q<HTMLButtonElement>(".toggle.accessible");
  const fastBtn = q<HTMLButtonElement>(".toggle.fast");
  const pauseBtn = q<HTMLButtonElement>(".toggle.pause");
  const hudEl = q<HTMLElement>(".hud");
  const dockEl = q<HTMLElement>(".dock");
  const matchEl = q<HTMLElement>(".match");

  const cam: Camera = createCamera(runtime.state.rules, 300, 200);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  /** Canvas fills the stage; the HUD and the bottom dock overlay it and are declared as camera insets. */
  const fit = (): void => {
    const w = Math.max(1, stage.clientWidth);
    const h = Math.max(1, stage.clientHeight);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    resize(cam, w, h);
    setInsets(cam, hudEl.offsetHeight, dockEl.offsetHeight);
  };
  fit();
  const ro = new ResizeObserver(fit);
  ro.observe(stage);
  ro.observe(dockEl);
  ro.observe(hudEl);

  // sprites load in the background; frames paint procedural figures until (or unless) they arrive
  let sprites: SpriteSet | null = null;
  let disposed = false;
  void spriteAssets().then((set) => {
    if (!disposed) sprites = set;
  });
  const presentation = createPresentation();
  const startedAt = performance.now();

  const optionAnchors = new Map<string, Vec2>();
  const trail: Vec2[] = [];
  const commentary = createCommentary();
  let slow = 0;
  let fastMix = 0;
  let shownRecords = new WeakSet<MomentRecord>();
  let bannerTimer = 0;
  let feedbackTimer = 0;
  const pendingTicker: string[] = [];

  const showBanner = (text: string, ms = 1800): void => {
    bannerEl.textContent = text;
    bannerEl.hidden = false;
    window.clearTimeout(bannerTimer);
    bannerTimer = window.setTimeout(() => (bannerEl.hidden = true), ms);
  };

  const renderOptions = (): void => {
    const w = runtime.active;
    if (!w) {
      momentEl.hidden = true;
      windowEl.hidden = true;
      return;
    }
    momentEl.hidden = false;
    windowEl.hidden = false;
    titleEl.textContent = `${w.moment.title}${w.moment.major ? " — big moment" : ""}`;
    cuesEl.innerHTML = w.moment.cues.map((c) => `<li>${escapeHtml(c)}</li>`).join("");
    optionsEl.innerHTML = "";
    for (const o of w.moment.options) {
      const b = document.createElement("button");
      b.className = `option${w.selected?.id === o.id ? " selected" : ""}`;
      b.type = "button";
      b.textContent = o.label;
      b.dataset["id"] = o.id;
      b.setAttribute("aria-pressed", String(w.selected?.id === o.id));
      b.addEventListener("click", () => onSelect(o.id));
      optionsEl.appendChild(b);
    }
    if (w.stage === "drawing") {
      hintEl.hidden = false;
      hintEl.innerHTML = `Draw from your player toward where it should go. Release to commit; drag back to the start or touch with a second finger to cancel. <button type="button" class="cancel">Back</button>`;
    } else if (w.stage === "targeting") {
      hintEl.hidden = false;
      hintEl.innerHTML = `Tap the target on the pitch. <button type="button" class="cancel">Back</button>`;
    } else {
      hintEl.hidden = true;
      hintEl.innerHTML = "";
    }
    hintEl.querySelector<HTMLButtonElement>("button.cancel")?.addEventListener("click", () => {
      cancel(runtime);
      renderOptions();
    });
  };

  const onSelect = (id: string): void => {
    const closed = select(runtime, id);
    if (closed) onClosed(closed);
    renderOptions();
  };

  const onClosed = (c: MomentClosed): void => {
    optionAnchors.clear();
    const d = c.result.decision;
    const label =
      c.reason === "committed"
        ? `${c.record.moment.options.find((o) => o.id === d.chosenOptionId)?.label ?? "Committed"} · read: ${d.band}`
        : c.reason === "timeout"
          ? "Window closed — played on"
          : c.reason === "play_stopped"
            ? "Play stopped"
            : "That option was gone — played on";
    showBanner(label);
    renderOptions();
  };

  const showFeedback = (rec: MomentRecord): void => {
    const lines = feedbackFor(runtime.session, rec);
    feedbackEl.innerHTML = `<b>${escapeHtml(rec.moment.title)}</b><ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`;
    feedbackEl.hidden = false;
    window.clearTimeout(feedbackTimer);
    feedbackTimer = window.setTimeout(() => (feedbackEl.hidden = true), 7000);
  };

  const pushTicker = (text: string): void => {
    pendingTicker.push(`${fmtClock(runtime.state.clock.timeMs)} ${text}`);
  };
  /** One DOM update per frame however many events fast-forward produced. */
  const flushTicker = (): void => {
    if (pendingTicker.length === 0) return;
    const lines = pendingTicker.splice(Math.max(0, pendingTicker.length - TICKER_LINES));
    pendingTicker.length = 0;
    const frag = document.createDocumentFragment();
    for (const text of lines) {
      const li = document.createElement("li");
      li.textContent = text;
      frag.prepend(li);
    }
    tickerEl.prepend(frag);
    while (tickerEl.children.length > TICKER_LINES) tickerEl.lastElementChild?.remove();
  };

  const fieldOf = (client: Vec2): Vec2 => toField(cam, client);
  const pointer: PointerAdapter = attachPointer(
    canvas,
    fieldOf,
    {
      onPreview: (pts) => {
        previewGesture(runtime, pts);
      },
      onRelease: (pts) => {
        const closed = releaseGesture(runtime, pts);
        if (closed) onClosed(closed);
        else renderOptions();
      },
      onTap: (pt) => {
        const closed = tapTarget(runtime, pt);
        if (closed) onClosed(closed);
      },
      onCancel: () => {
        if (runtime.active?.stage === "drawing") {
          cancel(runtime);
          renderOptions();
        }
      },
    },
  );

  accessibleBtn.addEventListener("click", () => {
    setAccessible(runtime, !runtime.accessible);
    accessibleBtn.setAttribute("aria-pressed", String(runtime.accessible));
    renderOptions();
  });
  fastBtn.addEventListener("click", () => {
    runtime.fast = !runtime.fast;
    fastBtn.setAttribute("aria-pressed", String(runtime.fast));
  });
  pauseBtn.addEventListener("click", () => {
    runtime.paused = !runtime.paused;
    pauseBtn.setAttribute("aria-pressed", String(runtime.paused));
    pauseBtn.textContent = runtime.paused ? "Resume" : "Pause";
  });
  /** Keyboard: digits pick options, Space pauses, F toggles fast play, Escape backs out of a drawing. */
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) return;
    if (ev.key === " " && !(ev.target instanceof HTMLButtonElement)) {
      ev.preventDefault();
      pauseBtn.click();
    } else if (ev.key === "f" || ev.key === "F") {
      fastBtn.click();
    } else if (ev.key === "Escape" && runtime.active && runtime.active.stage !== "reading") {
      cancel(runtime);
      renderOptions();
    } else if (/^[1-9]$/.test(ev.key) && runtime.active?.stage === "reading") {
      const o = runtime.active.moment.options[Number(ev.key) - 1];
      if (o) onSelect(o.id);
    }
  };
  document.addEventListener("keydown", onKey);
  const onVisibility = (): void => {
    if (document.hidden) last = 0;
  };
  document.addEventListener("visibilitychange", onVisibility);

  let last = 0;
  let raf = 0;
  let perfFrames = 0;
  let finishedShown = false;

  const loop = (now: number): void => {
    raf = requestAnimationFrame(loop);
    const dt = last === 0 ? 16 : Math.min(MAX_FRAME_MS, now - last);
    last = now;

    const t0 = performance.now();
    const res = frame(runtime, dt);
    const t1 = performance.now();
    if (res.opened) {
      showBanner(res.opened.major ? "Big moment" : "Read the field", 1200);
      renderOptions();
    }
    if (res.closed) onClosed(res.closed);
    for (const e of res.events) {
      const text = describeEvent(runtime, e);
      if (text) pushTicker(text);
      if (e.type === "half_time") showBanner(`Half time · ${scorelineLine(runtime.state)}`, 2400);
      if (e.type === "goal") showBanner(`GOAL · ${runtime.state.home.shortName} ${runtime.state.score.home} – ${runtime.state.score.away} ${runtime.state.away.shortName}`, 2200);
    }
    if (runtime.pace.phase === "routine" && res.ticks > 0) {
      const line = routineLine(commentary, runtime.state);
      if (line) pushTicker(line);
    }
    flushTicker();
    for (const rec of runtime.session.records) {
      if (rec.outcome && !shownRecords.has(rec)) {
        shownRecords.add(rec);
        showFeedback(rec);
      }
    }

    // presentation
    const st = runtime.state;
    scoreEl.textContent = `${st.score.home} – ${st.score.away}`;
    timeEl.textContent = fmtClock(st.clock.timeMs);
    halfEl.textContent = st.phase.kind === "half_time" ? "HT" : st.phase.kind === "full_time" ? "FT" : st.clock.half === 1 ? "1st" : "2nd";
    const scale = runtime.clock.scale;
    const phase = runtime.pace.phase;
    rateEl.textContent = phase === "window" ? "slow motion" : phase === "aftermath" ? "live" : phase === "halftime" ? "half time" : scale >= 1.5 ? `▶▶ ×${Math.round(scale)}` : "live";
    speedEl.classList.toggle("slow", phase === "window");
    speedEl.classList.toggle("fast", phase === "routine" && scale >= 1.5);
    realEl.textContent = formatRealTime(totalRealMs(runtime.pace));

    const w = runtime.active;
    slow += ((w ? 1 : 0) - slow) * 0.15;
    fastMix += ((phase === "routine" && scale >= 1.5 ? Math.min(1, scale / 12) : 0) - fastMix) * 0.2;
    if (res.ticks > 0) {
      trail.push({ ...st.ball.pos });
      if (trail.length > TRAIL_LENGTH) trail.shift();
    }
    optionAnchors.clear();
    if (w) {
      for (const o of w.moment.options) {
        const a = liveAnchor(runtime, o);
        if (a && o.drawn) optionAnchors.set(o.id, a);
      }
      windowBar.style.transform = `scaleX(${1 - windowProgress(runtime)})`;
      windowLeft.textContent = `${windowRemaining(runtime).toFixed(1)} s`;
      windowEl.classList.toggle("urgent", windowProgress(runtime) > 0.7);
    }
    const me = st.controlled ? st.players.find((p) => p.id === st.controlled!.playerId) : null;
    follow(cam, st.rules, frameFor(st.rules, cam, st.ball.pos, me?.pos ?? null, !!w, w?.moment.major ?? false), w ? 0.12 : 0.08);

    const visuals = deriveVisuals(presentation, st, cam, res.ticks * TICK_MS, Math.max(0.05, scale), runtime.clock.carryMs);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render(ctx, cam, st, {
      controlledId: st.controlled?.playerId ?? null,
      window: w,
      optionAnchors,
      slow,
      fast: fastMix,
      trail,
      major: w?.moment.major ?? false,
      visuals,
      sprites,
      ballPos: ballDisplayPos(st, runtime.clock.carryMs, visuals),
      ballHeightM: ballHeightM(st),
      timeS: (now - startedAt) / 1000,
      debug,
    });
    probe.sample({ frameMs: dt, simMs: t1 - t0, renderMs: performance.now() - t1, ticks: res.ticks });
    if (showPerf && ++perfFrames % 30 === 0) perfEl.textContent = formatSummary(probe.summary());

    if (res.finished && !finishedShown) {
      finishedShown = true;
      showSummary();
    }
  };
  raf = requestAnimationFrame(loop);

  const showSummary = (): void => {
    const rep = coverageReport(runtime.session.records, runtime.session.pacing);
    const st = runtime.state;
    const rows = runtime.session.records
      .map((r) => {
        const chosen = r.moment.options.find((o) => o.id === r.decision.chosenOptionId)?.label ?? "—";
        return `<tr><td>${fmtClock(r.moment.timeMs)}</td><td>${escapeHtml(r.moment.title)}</td><td>${escapeHtml(chosen)}</td><td>${r.decision.band}</td><td>${r.execution?.band ?? "—"}</td><td>${r.outcome?.result ?? "—"}</td></tr>`;
      })
      .join("");
    const pace = runtime.pace;
    const summary = document.createElement("section");
    summary.className = "summary";
    summary.innerHTML = `
      <h2>Full time · ${st.home.shortName} ${st.score.home} – ${st.score.away} ${st.away.shortName}</h2>
      <p class="realtime">Played in <b>${formatRealTime(totalRealMs(pace))}</b> real time · decisions ${formatRealTime(pace.realMs.window)} · live replay ${formatRealTime(pace.realMs.aftermath)} · fast-forward ${formatRealTime(pace.realMs.routine)}</p>
      <p class="muted">${rep.total} tactical moments (${rep.onBall} with the ball) · easy ${rep.byDifficulty.easy} / medium ${rep.byDifficulty.medium} / hard ${rep.byDifficulty.hard}</p>
      <p class="muted">Reads: strong ${rep.decisions.strong} · acceptable ${rep.decisions.acceptable} · weak ${rep.decisions.weak} · timed out ${rep.decisions.timeout} · unavailable ${rep.decisions.intent_unavailable}</p>
      ${rep.shortfalls.length ? `<p class="muted">Coverage shortfalls: ${escapeHtml(rep.shortfalls.join("; "))}</p>` : ""}
      <div class="table-wrap"><table><thead><tr><th>Time</th><th>Situation</th><th>Choice</th><th>Read</th><th>Execution</th><th>Outcome</th></tr></thead><tbody>${rows}</tbody></table></div>
      <button type="button" class="primary exit">${escapeHtml(opts.exitLabel ?? "Back to start")}</button>`;
    summary.querySelector<HTMLButtonElement>("button.exit")?.addEventListener("click", () => {
      handle.destroy();
      onExit(runtime);
    });
    matchEl.classList.add("finished");
    matchEl.appendChild(summary);
    summary.querySelector<HTMLElement>("h2")?.focus();
  };

  const handle: MatchScreenHandle = {
    perf: () => probe.summary(),
    destroy() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      pointer.detach();
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(bannerTimer);
      window.clearTimeout(feedbackTimer);
      shownRecords = new WeakSet();
      root.classList.remove("in-match");
      root.innerHTML = "";
    },
  };
  return handle;
}

function fmtClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

function describeEvent(rt: MatchRuntime, e: MatchEvent): string | null {
  const name = (id: string): string => rt.state.players.find((p) => p.id === id)?.name ?? id;
  switch (e.type) {
    case "goal":
      return `GOAL — ${name(e.scorer)}${e.assist ? ` (assist ${name(e.assist)})` : ""}`;
    case "shot":
      return `${name(e.player)} shoots${e.onTarget ? " — on target" : " — wide"}`;
    case "save":
      return `${name(e.keeper)} saves from ${name(e.shooter)}`;
    case "interception":
      return `${name(e.player)} intercepts`;
    case "tackle":
      return e.won ? `${name(e.player)} wins the tackle on ${name(e.victim)}` : `${name(e.player)} misses the tackle`;
    case "offside":
      return `${name(e.player)} offside`;
    case "out_of_play":
      return `${e.restart.replace("_", " ")} to ${e.side === "home" ? rt.state.home.shortName : rt.state.away.shortName}`;
    case "half_time":
      return "Half time";
    case "full_time":
      return `Full time ${e.home}–${e.away}`;
    case "kickoff":
      return "Kick-off";
    default:
      return null;
  }
}
