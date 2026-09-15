import {
  ACCESSIBLE_WINDOW_FACTOR,
  ballHeight,
  createJuggle,
  currentRun,
  runsLeft,
  startRun,
  step,
  summarize,
  touch,
  touchesInRun,
  windows,
  type JuggleState,
  type JuggleSummary,
  type Touch,
} from "../training/juggling";
import { escapeHtml, q } from "./html";

export interface JugglingScreenOptions {
  seed: number;
  /** Personal best so far, for the HUD. */
  previousBest: number;
  onDone(summary: JuggleSummary): void;
  onQuit(): void;
}

interface Handle {
  destroy(): void;
}

const QUALITY_TEXT: Record<Touch["quality"], string> = { perfect: "Clean", good: "Good", loose: "Loose — it's drifting", drop: "Dropped" };
const MAX_DT_MS = 100;

/**
 * Juggling in the yard: side view, the ball rises and falls; tap (or press Space) when it comes back
 * to the foot. The foot-height band shows the timing window; it narrows as the ball drifts. A solo
 * hobby with verified touches (spec §8) — no tactical grading.
 */
export function mountJugglingScreen(root: HTMLElement, opts: JugglingScreenOptions): Handle {
  root.className = "in-match";
  const s: JuggleState = createJuggle(opts.seed);
  root.innerHTML = `
    <section class="match drill juggling">
      <header class="hud">
        <div class="score"><span class="team">Juggling</span> <b class="num">0</b></div>
        <div class="clock"><span class="best">Best today 0 · record ${opts.previousBest}</span></div>
        <span class="speed">Run 1 / ${s.runsMax}</span>
      </header>
      <div class="stage" tabindex="0" aria-label="juggling area — tap or press Space to touch the ball">
        <canvas aria-hidden="true"></canvas>
        <div class="banner" hidden></div>
      </div>
      <div class="panel">
        <div class="moment">
          <div class="title">Keep it up</div>
          <ul class="cues"><li>Tap when the ball drops back into the band at your foot</li><li>Clean touches keep it straight; loose ones make it drift and the band shrinks</li><li>Three runs — your best one counts</li></ul>
        </div>
        <div class="feedback" hidden></div>
      </div>
      <div class="controls">
        <button type="button" class="toggle accessible" aria-pressed="false">Wider timing</button>
        <button type="button" class="link quit">Go inside</button>
        <span class="provisional">the yard · on your own</span>
      </div>
    </section>`;

  const stage = q<HTMLDivElement>(root, ".stage");
  const canvas = q<HTMLCanvasElement>(root, "canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  const numEl = q<HTMLElement>(root, ".score .num");
  const bestEl = q<HTMLSpanElement>(root, ".best");
  const runEl = q<HTMLSpanElement>(root, ".speed");
  const bannerEl = q<HTMLDivElement>(root, ".banner");
  const feedbackEl = q<HTMLDivElement>(root, ".feedback");
  const accessibleBtn = q<HTMLButtonElement>(root, ".toggle.accessible");
  const quitBtn = q<HTMLButtonElement>(root, "button.quit");

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const fit = (): void => {
    const w = Math.max(1, stage.clientWidth);
    const h = Math.max(1, stage.clientHeight);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  };
  fit();
  const ro = new ResizeObserver(fit);
  ro.observe(stage);

  let bannerTimer = 0;
  let feedbackTimer = 0;
  let finished = false;
  let lastTouchAt = 0;
  let lastQuality: Touch["quality"] | null = null;

  const showBanner = (text: string, ms = 1200): void => {
    bannerEl.textContent = text;
    bannerEl.hidden = false;
    window.clearTimeout(bannerTimer);
    bannerTimer = window.setTimeout(() => (bannerEl.hidden = true), ms);
  };
  const bestToday = (): number => Math.max(0, ...s.runs.map(touchesInRun));
  const refreshHud = (): void => {
    numEl.textContent = String(touchesInRun(currentRun(s)));
    bestEl.textContent = `Best today ${bestToday()} · record ${Math.max(opts.previousBest, bestToday())}`;
    const n = Math.min(s.runsMax, s.runs.length + (s.phase === "ready" || s.phase === "between" ? 1 : 0));
    runEl.textContent = `Run ${Math.max(1, n)} / ${s.runsMax}`;
  };

  const act = (): void => {
    if (finished) return;
    if (s.phase === "ready") {
      if (startRun(s)) showBanner("Go", 500);
      refreshHud();
      return;
    }
    if (s.phase === "between") return;
    const t = touch(s);
    if (!t) return;
    lastTouchAt = performance.now();
    lastQuality = t.quality;
    feedbackEl.innerHTML = `<b>${escapeHtml(QUALITY_TEXT[t.quality])}</b>${t.quality === "drop" ? ` — ${touchesInRun(currentRun(s))} touch${touchesInRun(currentRun(s)) === 1 ? "" : "es"}` : t.quality === "loose" ? (t.error < 0 ? " (early)" : " (late)") : ""}`;
    feedbackEl.hidden = false;
    window.clearTimeout(feedbackTimer);
    feedbackTimer = window.setTimeout(() => (feedbackEl.hidden = true), 900);
    if (currentRun(s)?.ended === "cap") showBanner(`${s.cap}! You stop yourself, grinning.`, 1800);
    else if (t.quality === "drop" && s.phase !== "done") showBanner(runsLeft(s) > 0 ? "Dropped — tap to go again" : "Dropped", 1500);
    refreshHud();
  };

  const onPointer = (e: PointerEvent): void => {
    e.preventDefault();
    act();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.code === "Space" || e.code === "Enter") {
      e.preventDefault();
      act();
    }
  };
  stage.addEventListener("pointerdown", onPointer);
  stage.addEventListener("keydown", onKey);
  accessibleBtn.addEventListener("click", () => {
    const on = s.windowScale === 1;
    s.windowScale = on ? ACCESSIBLE_WINDOW_FACTOR : 1;
    accessibleBtn.setAttribute("aria-pressed", String(on));
  });
  quitBtn.addEventListener("click", () => {
    handle.destroy();
    opts.onQuit();
  });

  let raf = 0;
  let last = 0;
  const loop = (now: number): void => {
    raf = requestAnimationFrame(loop);
    const dt = last ? Math.min(MAX_DT_MS, now - last) : 0;
    last = now;
    const before = touchesInRun(currentRun(s));
    const phaseBefore = s.phase;
    step(s, dt);
    if (phaseBefore === "air" && s.phase !== "air" && currentRun(s)?.ended === "drop" && touchesInRun(currentRun(s)) === before) {
      lastQuality = "drop";
      lastTouchAt = now;
      showBanner(runsLeft(s) > 0 ? `Dropped after ${before} — tap to go again` : `Dropped after ${before}`, 1500);
      refreshHud();
    }
    if (s.phase === "done") finish();
    draw(now);
  };

  const draw = (now: number): void => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    ctx.fillStyle = "#1f3b5c";
    ctx.fillRect(0, 0, w, h);
    const ground = h * 0.86;
    ctx.fillStyle = "#357a40";
    ctx.fillRect(0, ground, w, h - ground);
    // fence
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 2;
    for (let x = 12; x < w; x += 26) {
      ctx.beginPath();
      ctx.moveTo(x, ground);
      ctx.lineTo(x, ground - h * 0.18);
      ctx.stroke();
    }
    // player: simple figure at centre-left
    const px = w * 0.5;
    const footY = ground - 6;
    ctx.strokeStyle = "#e8f1ff";
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(px, footY - h * 0.42);
    ctx.lineTo(px, footY - h * 0.2);
    ctx.moveTo(px, footY - h * 0.2);
    ctx.lineTo(px - w * 0.04, footY);
    ctx.moveTo(px, footY - h * 0.2);
    ctx.lineTo(px + w * 0.05, footY - h * 0.03);
    ctx.stroke();
    ctx.fillStyle = "#e8f1ff";
    ctx.beginPath();
    ctx.arc(px, footY - h * 0.47, h * 0.045, 0, Math.PI * 2);
    ctx.fill();
    // timing band at the foot: height in flight terms → good window as a band of ball travel
    const apex = ground - h * 0.68;
    const foot = footY - h * 0.03;
    const wins = windows(s);
    const bandHalf = s.phase === "air" ? Math.min(h * 0.2, ((foot - apex) * 2 * wins.good) / s.flightMs) : h * 0.05;
    ctx.fillStyle = s.phase === "air" ? "rgba(125,230,255,0.2)" : "rgba(125,230,255,0.08)";
    ctx.fillRect(px - w * 0.18, foot - bandHalf, w * 0.36, bandHalf * 2);
    ctx.strokeStyle = "rgba(125,230,255,0.6)";
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px - w * 0.18, foot);
    ctx.lineTo(px + w * 0.18, foot);
    ctx.stroke();
    ctx.setLineDash([]);
    // ball
    const hgt = ballHeight(s);
    const bx = px + w * 0.06 + s.driftSide * s.drift * w * 0.14;
    const by = foot - hgt * (foot - apex);
    const r = Math.max(7, h * 0.03);
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#06101f";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // touch flash
    if (lastQuality && now - lastTouchAt < 350) {
      const a = 1 - (now - lastTouchAt) / 350;
      ctx.strokeStyle = lastQuality === "perfect" ? `rgba(125,230,255,${a})` : lastQuality === "good" ? `rgba(180,255,180,${a})` : lastQuality === "loose" ? `rgba(255,184,92,${a})` : `rgba(255,100,100,${a})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(bx, foot, r * (1.5 + (1 - a) * 2), 0, Math.PI * 2);
      ctx.stroke();
    }
    if (s.phase === "ready" && s.runs.length > 0) {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.font = `${Math.max(14, h * 0.04)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(`Run ${s.runs.length + 1} of ${s.runsMax} — tap to start`, w / 2, h * 0.16);
    }
  };

  const finish = (): void => {
    if (finished) return;
    finished = true;
    const sum = summarize(s);
    const record = sum.best > opts.previousBest;
    const summary = document.createElement("section");
    summary.className = "summary";
    summary.innerHTML = `
      <h2>Best run: ${sum.best}${record && opts.previousBest > 0 ? " — new record" : sum.capped ? " — you stopped yourself" : ""}</h2>
      <p class="muted">Runs: ${sum.runs.join(", ")}. ${sum.perfect} clean, ${sum.good} good, ${sum.loose} loose touches.</p>
      <p class="muted small">${sum.best >= 5 ? "That counts: the ball stayed up on screen." : "Keep at it — five in a row is where it starts to count."}</p>
      <button type="button" class="primary exit">Go inside</button>`;
    q<HTMLButtonElement>(summary, "button.exit").addEventListener("click", () => {
      handle.destroy();
      opts.onDone(sum);
    });
    stage.appendChild(summary);
  };

  refreshHud();
  stage.focus();
  raf = requestAnimationFrame(loop);
  const handle: Handle = {
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      stage.removeEventListener("pointerdown", onPointer);
      stage.removeEventListener("keydown", onKey);
      window.clearTimeout(bannerTimer);
      window.clearTimeout(feedbackTimer);
      root.className = "";
    },
  };
  return handle;
}
