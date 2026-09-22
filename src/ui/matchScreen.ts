import { scorelineLine } from "../match/commentary";
import { intelligenceReport, type IntelligenceReport, type MomentRef } from "../match/intelligence";
import { formatRealTime } from "../match/pace";
import {
  answer,
  continueNow,
  frame,
  leadInProgress,
  questionFor,
  questionOpen,
  ready,
  serializeRuntime,
  skipLeadIn,
  timerProgress,
  timerRemaining,
  totalRealMs,
  viewState,
  type MatchRuntime,
  type RuntimePhase,
  type RuntimeSave,
} from "../match/runtime";
import { createCamera, follow, frameFor, resize, setInsets, type Camera } from "../render/camera";
import { createProbe, formatSummary, type ProbeSummary } from "../perf/probe";
import { PULSE_LIFE_S, render, type GroundPulse, type PulseTone } from "../render/pitch";
import { ballDisplayPos, ballHeightM, createPresentation, deriveVisuals } from "../render/presentation";
import { spriteAssets, type SpriteSet } from "../render/sprites";
import type { Vec2 } from "../sim/geometry";
import type { MatchEvent } from "../sim/types";
import type { MomentRecord, OutcomeResult, TacticalMoment } from "../tactics/moments";

/**
 * The official-match screen (spec §9–§13). Canvas for the picture, DOM for everything the player must
 * read. The only gameplay input is choosing one of the displayed answers — by tap, number key,
 * arrow/Enter, or gamepad. No aiming, drawing, timing or manual execution exists here; the runtime
 * executes the chosen command itself. The timer starts only after the question and answers are painted
 * and (when enabled) read aloud; pausing stops it.
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
/** Frames the answers must have been painted before the timer may start (two vsyncs). */
const PAINT_FRAMES = 2;
const READ_ALOUD_KEY = "soccermaster.match.readaloud";
/** Fallback per-character reading time when speech synthesis cannot report completion. */
const READ_MS_PER_CHAR = 55;
const PAD_CONFIRM = 0;
const PAD_PAUSE = 9;

/** Whole seconds left on the answer timer as shown next to the bar; an ellipsis until the timer is armed. */
export function timerLabel(runtime: MatchRuntime): string {
  return runtime.phase === "timer" ? `${Math.ceil(timerRemaining(runtime))} s` : "…";
}

export interface MatchScreenOptions {
  /** Label of the button under the full-time summary. */
  exitLabel?: string;
  /** A coaching lesson carried into the match: its cue is shown on the listed catalog entries. Information only. */
  lesson?: { entryIds: readonly string[]; cue: string };
  /** When given, a "Save and leave" control stores the match mid-flight and leaves the screen. */
  onSave?: (save: RuntimeSave) => void;
  /** Called with the serialized match at every safe point (frozen question, closed moment, half time, page hide) so a plain reload resumes where it was. */
  onCheckpoint?: (save: RuntimeSave) => void;
}

/** `onExit` is called once the user leaves the full-time summary; the runtime holds the finished state and records. */
export function mountMatchScreen(root: HTMLElement, runtime: MatchRuntime, onExit: (runtime: MatchRuntime) => void, opts: MatchScreenOptions = {}): MatchScreenHandle {
  root.classList.add("in-match");
  const params = new URLSearchParams(location.search);
  const debug = params.has("debug");
  const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  root.innerHTML = `
    <section class="match${debug ? " debug" : ""}">
      <div class="stage">
        <canvas class="pitch" aria-label="match view"></canvas>
        <header class="hud">
          <div class="score"><span class="team home">${escapeHtml(runtime.state.home.shortName)}</span><b class="num">0 – 0</b><span class="team away">${escapeHtml(runtime.state.away.shortName)}</span></div>
          <div class="clock"><span class="time">00:00</span><span class="half">1st</span></div>
          <div class="speed" aria-live="polite"><span class="rate">skipping</span><span class="real" title="real time played">0:00</span></div>
        </header>
        <div class="timer" role="timer" aria-live="off" hidden><div class="bar"></div><span class="left"></span></div>
        <div class="skip" aria-hidden="true" hidden><span>Skipping to your next involvement</span></div>
        <div class="banner" hidden></div>
        <div class="paused" hidden><b>Paused</b><span>The timer is stopped.</span></div>
        <div class="perf" hidden></div>
        <div class="dock">
          <section class="panel">
            <div class="moment" hidden>
              <div class="title"></div>
              <p class="question"></p>
              <ul class="cues"></ul>
              <div class="options" role="group" aria-label="answers"></div>
              <div class="hint"></div>
            </div>
            <div class="feedback" hidden></div>
            <ul class="ticker" aria-live="polite"></ul>
          </section>
          <footer class="controls">
            <button type="button" class="toggle readaloud" aria-pressed="false" title="Read each question and its answers aloud before the timer starts">Read aloud</button>
            <button type="button" class="toggle pause" aria-pressed="false">Pause</button>
            ${opts.onSave ? `<button type="button" class="toggle save">Save and leave</button>` : ""}
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
  const timerEl = q<HTMLDivElement>(".timer");
  const timerBar = q<HTMLDivElement>(".timer .bar");
  const timerLeft = q<HTMLSpanElement>(".timer .left");
  const skipEl = q<HTMLDivElement>(".skip");
  const bannerEl = q<HTMLDivElement>(".banner");
  const pausedEl = q<HTMLDivElement>(".paused");
  const momentEl = q<HTMLDivElement>(".moment");
  const titleEl = q<HTMLDivElement>(".moment .title");
  const questionEl = q<HTMLParagraphElement>(".moment .question");
  const cuesEl = q<HTMLUListElement>(".moment .cues");
  const optionsEl = q<HTMLDivElement>(".moment .options");
  const hintEl = q<HTMLDivElement>(".moment .hint");
  const feedbackEl = q<HTMLDivElement>(".feedback");
  const tickerEl = q<HTMLUListElement>(".ticker");
  const readAloudBtn = q<HTMLButtonElement>(".toggle.readaloud");
  const pauseBtn = q<HTMLButtonElement>(".toggle.pause");
  const saveBtn = root.querySelector<HTMLButtonElement>("button.save");
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
  /** Cosmetic ground pulses with the real time they started; pruned once they fade. */
  const pulses: { pos: Vec2; startedAt: number; tone: PulseTone }[] = [];
  let momentOpenedAt: number | null = null;
  const pulse = (pos: Vec2, tone: PulseTone): void => {
    if (reducedMotion) return;
    pulses.push({ pos: { ...pos }, startedAt: performance.now(), tone });
  };
  let slow = 0;
  let bannerTimer = 0;
  const pendingTicker: string[] = [];

  const showBanner = (text: string, ms = 1800): void => {
    bannerEl.textContent = text;
    bannerEl.hidden = false;
    window.clearTimeout(bannerTimer);
    bannerTimer = window.setTimeout(() => (bannerEl.hidden = true), ms);
  };

  // ------------------------------------------------------------- question / answers

  /** Moment whose question is currently painted; the timer is only armed once for it. */
  let shownMoment: TacticalMoment | null = null;
  let shownFeedback: MomentRecord | null = null;
  let paintFramesLeft = 0;
  let readAloud = localStorage.getItem(READ_ALOUD_KEY) === "1";
  let speaking: SpeechSynthesisUtterance | null = null;
  let speechFallback = 0;
  let highlightOptionId: string | null = null;
  let focusIndex = 0;
  readAloudBtn.setAttribute("aria-pressed", String(readAloud));

  const optionButtons = (): HTMLButtonElement[] => [...optionsEl.querySelectorAll<HTMLButtonElement>("button.option")];

  const setFocus = (i: number): void => {
    const buttons = optionButtons();
    if (buttons.length === 0) return;
    focusIndex = (i + buttons.length) % buttons.length;
    const b = buttons[focusIndex]!;
    b.focus({ preventScroll: true });
    highlightOptionId = b.dataset["id"] ?? null;
  };

  const renderQuestion = (moment: TacticalMoment): void => {
    momentEl.hidden = false;
    timerEl.hidden = false;
    titleEl.textContent = `${moment.title}${moment.major ? " — big moment" : ""}`;
    questionEl.textContent = questionFor(moment);
    cuesEl.innerHTML = moment.cues.map((c) => `<li>${escapeHtml(c)}</li>`).join("");
    if (opts.lesson && opts.lesson.entryIds.includes(moment.entryId)) cuesEl.innerHTML += `<li class="lesson">${escapeHtml(opts.lesson.cue)}</li>`;
    optionsEl.innerHTML = "";
    moment.options.forEach((o, i) => {
      const b = document.createElement("button");
      b.className = "option";
      b.type = "button";
      const key = document.createElement("span");
      key.className = "key";
      key.textContent = String(i + 1);
      key.setAttribute("aria-hidden", "true");
      b.append(key, document.createTextNode(o.label));
      b.dataset["id"] = o.id;
      b.setAttribute("aria-label", `Answer ${i + 1}: ${o.label}`);
      b.addEventListener("click", () => onAnswer(o.id));
      b.addEventListener("pointerenter", () => (highlightOptionId = o.id));
      b.addEventListener("pointerleave", () => (highlightOptionId = highlightOptionId === o.id ? null : highlightOptionId));
      b.addEventListener("focus", () => {
        highlightOptionId = o.id;
        focusIndex = i;
      });
      optionsEl.appendChild(b);
    });
    hintEl.textContent = readAloud ? "Reading the question aloud… the timer starts when it finishes." : "Pick one answer. Your player carries it out.";
    highlightOptionId = null;
    focusIndex = 0;
  };

  const hideQuestion = (): void => {
    momentEl.hidden = true;
    timerEl.hidden = true;
    optionsEl.innerHTML = "";
    highlightOptionId = null;
    stopSpeaking();
  };

  const stopSpeaking = (): void => {
    window.clearTimeout(speechFallback);
    speechFallback = 0;
    if (speaking && typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    speaking = null;
  };

  /** Read the question and answers, then arm the timer. Falls back to a length-based wait without speech. */
  const speakThenReady = (moment: TacticalMoment): void => {
    const text = [moment.title, questionFor(moment), ...moment.options.map((o, i) => `${i + 1}. ${o.label}`)].join(". ");
    const arm = (): void => {
      speaking = null;
      speechFallback = 0;
      if (!disposed && runtime.active?.moment === moment) {
        hintEl.textContent = "Pick one answer. Your player carries it out.";
        ready(runtime);
      }
    };
    if (typeof speechSynthesis === "undefined" || typeof SpeechSynthesisUtterance === "undefined") {
      speechFallback = window.setTimeout(arm, text.length * READ_MS_PER_CHAR);
      return;
    }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.onend = arm;
    u.onerror = arm;
    speaking = u;
    speechSynthesis.speak(u);
    // some engines never fire onend for cancelled/queued utterances; never leave the question un-timed
    speechFallback = window.setTimeout(arm, text.length * READ_MS_PER_CHAR + 2000);
  };

  const onAnswer = (id: string): void => {
    if (!questionOpen(runtime)) return;
    const chosen = runtime.active?.moment.options.find((o) => o.id === id);
    if (!answer(runtime, id)) return;
    hideQuestion();
    pulse(runtime.state.ball.pos, "commit");
    showBanner(chosen ? `${chosen.label}` : "Answer taken", 1500);
  };

  const onPhaseChange = (from: RuntimePhase, to: RuntimePhase): void => {
    const a = runtime.active;
    if (to === "lead_in" && a) {
      momentOpenedAt = performance.now();
      if (reducedMotion) {
        skipLeadIn(runtime);
        showBanner(a.moment.major ? "Big moment — frozen at your touch" : "Frozen at your touch", 1400);
        return;
      }
      showBanner(a.moment.major ? "Big moment — watch it develop" : "Watch the play develop", 1400);
    }
    if (to === "question" && a && shownMoment !== a.moment) {
      shownMoment = a.moment;
      renderQuestion(a.moment);
      paintFramesLeft = PAINT_FRAMES;
    }
    if (to === "resolving" && a?.reason && from !== "resolving") {
      if (a.reason === "timeout") {
        hideQuestion();
        const me = runtime.state.players.find((p) => p.id === a.moment.playerId)?.name ?? "Your player";
        showBanner(`Time's up — ${me} played on: ${a.result?.acted?.label ?? "the engine chose"}`, 2600);
      } else if (a.reason === "intent_unavailable") {
        hideQuestion();
        showBanner("That option was gone — played on", 2000);
      }
    }
    if (to === "feedback" && a?.record) showFeedback(a.record, a.feedback ?? []);
    if (from === "feedback" && to !== "feedback") feedbackEl.hidden = true;
    if (to === "halftime") showBanner(`Half time · ${scorelineLine(runtime.state)}`, 2400);
    if (to === "routine") shownMoment = null;
    if (to === "question" || to === "feedback" || to === "halftime") checkpoint();
  };

  const checkpoint = (): void => {
    if (!opts.onCheckpoint || runtime.phase === "finished") return;
    opts.onCheckpoint(serializeRuntime(runtime));
  };

  const showFeedback = (rec: MomentRecord, lines: string[]): void => {
    shownFeedback = rec;
    if (rec.outcome) pulse(runtime.state.ball.pos, outcomeTone(rec.outcome.result));
    const engine = rec.acted?.actor === "engine";
    const head = engine ? `${escapeHtml(rec.moment.title)} <span class="tag engine">engine played on</span>` : escapeHtml(rec.moment.title);
    feedbackEl.innerHTML = `<b>${head}</b><ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul><button type="button" class="continue">Continue</button>`;
    feedbackEl.hidden = false;
    feedbackEl.querySelector<HTMLButtonElement>("button.continue")?.addEventListener("click", () => {
      continueNow(runtime);
      feedbackEl.hidden = true;
    });
  };

  const pushTicker = (text: string): void => {
    pendingTicker.push(`${fmtClock(runtime.state.clock.timeMs)} ${text}`);
  };
  /** One DOM update per frame however many events skipping produced. */
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

  // ------------------------------------------------------------- controls

  const setPaused = (p: boolean): void => {
    if (runtime.phase === "finished") return;
    runtime.paused = p;
    pauseBtn.setAttribute("aria-pressed", String(p));
    pauseBtn.textContent = p ? "Resume" : "Pause";
    pausedEl.hidden = !p;
    if (typeof speechSynthesis !== "undefined" && speaking) p ? speechSynthesis.pause() : speechSynthesis.resume();
  };
  pauseBtn.addEventListener("click", () => setPaused(!runtime.paused));
  readAloudBtn.addEventListener("click", () => {
    readAloud = !readAloud;
    localStorage.setItem(READ_ALOUD_KEY, readAloud ? "1" : "0");
    readAloudBtn.setAttribute("aria-pressed", String(readAloud));
  });
  saveBtn?.addEventListener("click", () => {
    if (!opts.onSave) return;
    setPaused(true);
    const save = serializeRuntime(runtime);
    handle.destroy();
    opts.onSave(save);
  });

  /** Keyboard: digits answer, arrows move between answers, Enter/Space on a focused answer picks it, P pauses. */
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) return;
    if (ev.key === "p" || ev.key === "P") {
      pauseBtn.click();
    } else if (/^[1-9]$/.test(ev.key) && questionOpen(runtime)) {
      const o = runtime.active!.moment.options[Number(ev.key) - 1];
      if (o) onAnswer(o.id);
    } else if ((ev.key === "ArrowDown" || ev.key === "ArrowRight") && questionOpen(runtime)) {
      ev.preventDefault();
      setFocus(focusIndex + 1);
    } else if ((ev.key === "ArrowUp" || ev.key === "ArrowLeft") && questionOpen(runtime)) {
      ev.preventDefault();
      setFocus(focusIndex - 1);
    } else if (ev.key === "Enter" && runtime.phase === "feedback") {
      continueNow(runtime);
      feedbackEl.hidden = true;
    }
  };
  document.addEventListener("keydown", onKey);
  /** Backgrounded tab: the timer must not run while the player cannot see the question. */
  const onVisibility = (): void => {
    last = 0;
    if (document.hidden) {
      if (questionOpen(runtime)) setPaused(true);
      checkpoint();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", checkpoint);

  const padHeld: boolean[] = [];
  let padAxisHeld = false;
  const pollPad = (): void => {
    const pads = typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];
    const pad = [...pads].find((p) => p && p.connected);
    if (!pad) return;
    const pressed: number[] = [];
    pad.buttons.forEach((b, i) => {
      if (b.pressed && !padHeld[i]) pressed.push(i);
      padHeld[i] = b.pressed;
    });
    const ay = pad.axes[1] ?? 0;
    const dir = pad.buttons[13]?.pressed || ay > 0.6 ? 1 : pad.buttons[12]?.pressed || ay < -0.6 ? -1 : 0;
    if (dir !== 0 && !padAxisHeld && questionOpen(runtime)) setFocus(focusIndex + dir);
    padAxisHeld = dir !== 0;
    if (pressed.includes(PAD_PAUSE)) pauseBtn.click();
    if (pressed.includes(PAD_CONFIRM)) {
      if (questionOpen(runtime)) {
        const o = runtime.active!.moment.options[focusIndex];
        if (o) onAnswer(o.id);
      } else if (runtime.phase === "feedback") {
        continueNow(runtime);
        feedbackEl.hidden = true;
      }
    }
  };

  // ------------------------------------------------------------- loop

  let last = 0;
  let raf = 0;
  let perfFrames = 0;
  let finishedShown = false;
  let lastPhase: RuntimePhase = runtime.phase;

  const livePulses = (now: number): GroundPulse[] => {
    while (pulses.length > 0 && now - pulses[0]!.startedAt > PULSE_LIFE_S * 1000) pulses.shift();
    return pulses.map((p) => ({ pos: p.pos, age: (now - p.startedAt) / 1000, tone: p.tone }));
  };

  const rateLabel = (phase: RuntimePhase): string => {
    switch (phase) {
      case "routine":
        return "skipping";
      case "lead_in":
        return "live";
      case "question":
        return "frozen";
      case "timer":
        return "decide";
      case "resolving":
        return "live";
      case "feedback":
        return "review";
      case "halftime":
        return "half time";
      case "finished":
        return "full time";
    }
  };

  const loop = (now: number): void => {
    raf = requestAnimationFrame(loop);
    const dt = last === 0 ? 16 : Math.min(MAX_FRAME_MS, now - last);
    last = now;
    pollPad();

    const t0 = performance.now();
    const res = frame(runtime, dt);
    const t1 = performance.now();
    if (runtime.phase !== lastPhase) {
      const from = lastPhase;
      lastPhase = runtime.phase;
      onPhaseChange(from, runtime.phase);
    }
    // a moment that was restored mid-question or mid-feedback paints without a phase change
    if (runtime.phase === "question" && runtime.active && shownMoment !== runtime.active.moment) {
      shownMoment = runtime.active.moment;
      renderQuestion(runtime.active.moment);
      paintFramesLeft = PAINT_FRAMES;
    }
    if (runtime.phase === "feedback" && runtime.active?.record && shownFeedback !== runtime.active.record) {
      showFeedback(runtime.active.record, runtime.active.feedback ?? []);
    }
    if (runtime.phase === "question" && runtime.active && paintFramesLeft > 0 && !runtime.paused) {
      if (--paintFramesLeft === 0) {
        if (readAloud) speakThenReady(runtime.active.moment);
        else ready(runtime);
      }
    }
    for (const e of res.events) {
      const text = describeEvent(runtime, e);
      if (text && runtime.phase !== "routine") pushTicker(text);
      if (e.type === "goal") showBanner(`GOAL · ${runtime.state.home.shortName} ${runtime.state.score.home} – ${runtime.state.score.away} ${runtime.state.away.shortName}`, 2200);
    }
    flushTicker();

    // presentation
    const st = viewState(runtime);
    const live = runtime.state;
    scoreEl.textContent = `${live.score.home} – ${live.score.away}`;
    timeEl.textContent = fmtClock(live.clock.timeMs);
    halfEl.textContent = live.phase.kind === "half_time" ? "HT" : live.phase.kind === "full_time" ? "FT" : live.clock.half === 1 ? "1st" : "2nd";
    const phase = runtime.phase;
    rateEl.textContent = rateLabel(phase);
    speedEl.classList.toggle("slow", phase === "question" || phase === "timer");
    speedEl.classList.toggle("fast", phase === "routine");
    skipEl.hidden = phase !== "routine";
    realEl.textContent = formatRealTime(totalRealMs(runtime));

    const open = questionOpen(runtime);
    const a = runtime.active;
    slow += ((open ? 1 : 0) - slow) * 0.15;
    if (res.ticks > 0 && phase === "resolving" && !reducedMotion) {
      trail.push({ ...live.ball.pos });
      if (trail.length > TRAIL_LENGTH) trail.shift();
    } else if (phase !== "resolving") trail.length = 0;
    optionAnchors.clear();
    if (open && a) {
      for (const o of a.moment.options) if (o.anchor) optionAnchors.set(o.id, o.anchor);
      const progress = timerProgress(runtime);
      timerBar.style.transform = `scaleX(${1 - progress})`;
      timerLeft.textContent = timerLabel(runtime);
      timerEl.classList.toggle("urgent", progress > 0.7);
      timerEl.classList.toggle("armed", phase === "timer");
    }
    const me = st.controlled ? st.players.find((p) => p.id === st.controlled!.playerId) : null;
    const focused = phase === "lead_in" || open || phase === "resolving";
    follow(cam, st.rules, frameFor(st.rules, cam, st.ball.pos, me?.pos ?? null, focused, a?.moment.major ?? false), focused ? 0.12 : 0.3);

    const visuals = deriveVisuals(presentation, st, cam, phase === "lead_in" ? dt : res.ticks * TICK_MS, phase === "routine" ? 1 : Math.max(0.05, runtime.clock.scale), phase === "lead_in" ? 0 : runtime.clock.carryMs);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render(ctx, cam, st, {
      controlledId: st.controlled?.playerId ?? null,
      moment: open && a ? a.moment : null,
      optionAnchors,
      highlightOptionId: open ? highlightOptionId : null,
      showBadges: open,
      slow,
      fast: 0,
      trail,
      major: a?.moment.major ?? false,
      visuals,
      sprites,
      ballPos: phase === "lead_in" ? st.ball.pos : ballDisplayPos(st, runtime.clock.carryMs, visuals),
      ballHeightM: ballHeightM(st),
      timeS: (now - startedAt) / 1000,
      momentAge: open && momentOpenedAt !== null ? (now - momentOpenedAt) / 1000 : undefined,
      pulses: livePulses(now),
      debug,
    });
    if (phase === "lead_in") drawLeadIn(ctx, cam.width, leadInProgress(runtime));
    probe.sample({ frameMs: dt, simMs: t1 - t0, renderMs: performance.now() - t1, ticks: res.ticks });
    if (showPerf && ++perfFrames % 30 === 0) perfEl.textContent = formatSummary(probe.summary());

    if (res.finished && !finishedShown) {
      finishedShown = true;
      hideQuestion();
      feedbackEl.hidden = true;
      showSummary();
    }
  };
  raf = requestAnimationFrame(loop);

  // ------------------------------------------------------------- full time

  const showSummary = (): void => {
    const st = runtime.state;
    const rep = intelligenceReport(st, runtime.session.records);
    const summary = document.createElement("section");
    summary.className = "summary";
    summary.innerHTML = renderSummary(rep, runtime, opts.exitLabel ?? "Back to start");
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
      stopSpeaking();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", checkpoint);
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(bannerTimer);
      root.classList.remove("in-match");
      root.innerHTML = "";
    },
  };
  return handle;
}

/** Thin progress line under the HUD while the lead-in replays. */
function drawLeadIn(ctx: CanvasRenderingContext2D, width: number, progress: number): void {
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.fillRect(0, 0, width, 3);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillRect(0, 0, width * Math.min(1, Math.max(0, progress)), 3);
  ctx.restore();
}

export function renderSummary(rep: IntelligenceReport, runtime: MatchRuntime, exitLabel: string): string {
  const st = runtime.state;
  const pct = (x: number | null): string => (x === null ? "—" : `${Math.round(x * 100)}%`);
  const bandText = (b: string | null): string => b ?? "not graded";
  const rows = runtime.session.records
    .map((r) => {
      const chosen = r.decision.chosenOptionId ? r.moment.options.find((o) => o.id === r.decision.chosenOptionId)?.label ?? "—" : r.acted ? `<span class="tag engine">engine</span> ${escapeHtml(r.acted.label)}` : "—";
      const best = r.moment.options.find((o) => o.id === r.decision.bestOptionId)?.label ?? "—";
      return `<tr><td>${fmtClock(r.moment.timeMs)}</td><td>${escapeHtml(r.moment.title)}</td><td>${r.decision.chosenOptionId ? escapeHtml(chosen) : chosen}</td><td>${escapeHtml(best)}</td><td>${r.decision.band.replace("_", " ")}</td><td>${r.execution?.band ?? "—"}</td><td>${r.outcome?.result ?? "—"}</td></tr>`;
    })
    .join("");
  const cat = (c: IntelligenceReport["categories"][number]): string =>
    `<li><span class="name">${escapeHtml(c.label)}</span><span class="val">${c.graded ? `${bandText(c.band)} · ${pct(c.quality)} · best ${c.best}/${c.graded}` : c.moments ? "no graded answers" : "did not arise"}</span></li>`;
  const refs = (list: MomentRef[], empty: string): string =>
    list.length
      ? `<ul class="refs">${list.map((m) => `<li>${fmtClock(m.timeMs)} ${escapeHtml(m.title)} — ${escapeHtml(m.chosen)} (read ${m.decision}${m.execution ? `, execution ${m.execution}` : ""}${m.outcome ? `, outcome ${m.outcome}` : ""})${m.summary ? `<br><span class="muted">${escapeHtml(m.summary)}</span>` : ""}</li>`).join("")}</ul>`
      : `<p class="muted">${empty}</p>`;
  const forMe = rep.result.forControlled;
  const verdict = forMe === "win" ? "Win" : forMe === "loss" ? "Loss" : forMe === "draw" ? "Draw" : "Full time";
  return `
    <h2 tabindex="-1">${verdict} · ${escapeHtml(st.home.shortName)} ${rep.result.score.home} – ${rep.result.score.away} ${escapeHtml(st.away.shortName)}</h2>
    <p class="realtime">${rep.result.verified ? "Verified full-time result" : "Match not completed"} · ${rep.result.goalsInLedger} goal${rep.result.goalsInLedger === 1 ? "" : "s"} in the match record · played in <b>${formatRealTime(totalRealMs(runtime))}</b> real time</p>
    <div class="grades">
      <div class="grade overall"><span class="label">Overall decision grade</span><b>${bandText(rep.overall.band)}</b><span class="muted">${pct(rep.overall.quality)} · ${rep.answered} of ${rep.moments} moments answered${rep.timeouts ? ` · ${rep.timeouts} timed out (engine played on)` : ""}</span></div>
      <div class="grade"><span class="label">Strongest</span><b>${rep.strongest ? escapeHtml(rep.strongest.label) : "—"}</b><span class="muted">${rep.strongest ? `${bandText(rep.strongest.band)} · ${pct(rep.strongest.quality)}` : "needs two graded moments"}</span></div>
      <div class="grade"><span class="label">Weakest</span><b>${rep.weakest ? escapeHtml(rep.weakest.label) : "—"}</b><span class="muted">${rep.weakest ? `${bandText(rep.weakest.band)} · ${pct(rep.weakest.quality)}` : "needs two graded categories"}</span></div>
    </div>
    <ul class="categories">${rep.categories.map(cat).join("")}</ul>
    <h3>Right idea, didn't come off</h3>
    ${refs(rep.correctButFailed, "None — every best-option answer was carried out and held up.")}
    <h3>Got away with it</h3>
    ${refs(rep.poorButFavorable, "None — no weak read was rescued by the play that followed.")}
    <p class="coach">${escapeHtml(rep.teachingPoint)}</p>
    <div class="table-wrap"><table><thead><tr><th>Time</th><th>Situation</th><th>Your answer</th><th>Best available</th><th>Decision</th><th>Execution</th><th>Outcome</th></tr></thead><tbody>${rows}</tbody></table></div>
    <button type="button" class="primary exit">${escapeHtml(exitLabel)}</button>`;
}

function outcomeTone(result: OutcomeResult): PulseTone {
  return result === "success" ? "good" : result === "failure" ? "poor" : "neutral";
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
