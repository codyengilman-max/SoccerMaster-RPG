import { attachPointer, type PointerAdapter } from "../gesture/pointer";
import { paintBall, paintFigure, paintShadow, paintSurround, paintTurf, paintVignette, type Kit } from "../render/figures";
import type { Vec2 } from "../sim/geometry";
import {
  AREA,
  GATES,
  RECEIVE_POINT,
  SERVER_POINT,
  commitGate,
  createDrill,
  current,
  readDraw,
  readTap,
  step,
  summarize,
  windowLimitMs,
  windowProgress,
  type DrillState,
  type DrillSummary,
  type GateId,
  type RepRecord,
} from "../training/firstTouch";
import { escapeHtml, q } from "./html";

export interface DrillScreenOptions {
  seed: number;
  reps?: number;
  coachName: string;
  /** Called once the user leaves the summary. */
  onDone(summary: DrillSummary): void;
}

interface Handle {
  destroy(): void;
}

const PAD = 1.2;
const REP_LABEL: Record<RepRecord["decision"], string> = { strong: "Sharp read", acceptable: "Fair read", weak: "Into the pressure", timeout: "Too late" };
const OUTCOME_LABEL = { through: "Through the gate", wide: "Wide of the gate", intercepted: "Defender got it" } as const;

/**
 * Receive-and-go: the coach plays the ball; a defender closes; the first touch goes through the
 * gate away from pressure. Draw the touch from the receive point (or tap a gate). The decision
 * window runs in tactical slow motion like a match moment, so the input model is the same.
 */
export function mountDrillScreen(root: HTMLElement, opts: DrillScreenOptions): Handle {
  root.className = "in-match";
  const d: DrillState = createDrill(opts.seed, opts.reps ?? 6, false);
  root.innerHTML = `
    <section class="match drill">
      <header class="hud">
        <div class="score"><span class="team">Receive and go</span></div>
        <div class="clock"><span class="rep">Rep 1 / ${d.reps}</span></div>
        <span class="speed">normal</span>
      </header>
      <div class="stage">
        <canvas></canvas>
        <div class="window" hidden><div class="bar"></div><span class="left"></span></div>
        <div class="banner" hidden></div>
      </div>
      <div class="panel">
        <div class="moment">
          <div class="title">Look before it arrives</div>
          <ul class="cues"><li>Where is the defender coming from?</li><li>Draw your first touch from the ball through the open gate</li><li>Or tap a gate</li></ul>
        </div>
        <div class="feedback" hidden></div>
      </div>
      <div class="controls">
        <button type="button" class="toggle accessible" aria-pressed="false">Longer windows</button>
        <span class="provisional">${escapeHtml(opts.coachName)} · intro drill</span>
      </div>
    </section>`;

  const stage = q<HTMLDivElement>(root, ".stage");
  const canvas = q<HTMLCanvasElement>(root, "canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  const repEl = q<HTMLSpanElement>(root, ".rep");
  const speedEl = q<HTMLSpanElement>(root, ".speed");
  const windowEl = q<HTMLDivElement>(root, ".window");
  const windowBar = q<HTMLDivElement>(root, ".window .bar");
  const windowLeft = q<HTMLSpanElement>(root, ".window .left");
  const bannerEl = q<HTMLDivElement>(root, ".banner");
  const feedbackEl = q<HTMLDivElement>(root, ".feedback");
  const accessibleBtn = q<HTMLButtonElement>(root, ".toggle.accessible");

  // ---- camera: whole area fits the stage, letterboxed
  let scale = 20;
  let ox = 0;
  let oy = 0;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const fit = (): void => {
    const w = Math.max(1, stage.clientWidth);
    const h = Math.max(1, stage.clientHeight);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    scale = Math.min(w / (AREA.length + PAD * 2), h / (AREA.width + PAD * 2));
    ox = (w - AREA.length * scale) / 2;
    oy = (h - AREA.width * scale) / 2;
  };
  fit();
  const ro = new ResizeObserver(fit);
  ro.observe(stage);
  const toScreen = (p: Vec2): Vec2 => ({ x: ox + p.x * scale, y: oy + p.y * scale });
  const toField = (s: Vec2): Vec2 => ({ x: (s.x - ox) / scale, y: (s.y - oy) / scale });

  // ---- input
  let preview: Vec2[] = [];
  let previewGate: GateId | null = null;
  let bannerTimer = 0;
  const showBanner = (text: string, ms = 1400): void => {
    bannerEl.textContent = text;
    bannerEl.hidden = false;
    window.clearTimeout(bannerTimer);
    bannerTimer = window.setTimeout(() => (bannerEl.hidden = true), ms);
  };
  const commit = (read: ReturnType<typeof readDraw>, via: "draw" | "tap"): void => {
    if (d.phase !== "window") {
      showBanner(d.phase === "serve" ? "Wait for the ball" : "Watch the touch");
      return;
    }
    if (!read.gate) {
      showBanner(via === "draw" ? "Draw toward a gate" : "Tap a gate");
      return;
    }
    commitGate(d, read.gate, read.accuracy);
  };
  const pointer: PointerAdapter = attachPointer(canvas, toField, {
    onPreview: (pts) => {
      preview = [...pts];
      previewGate = d.phase === "window" ? readDraw(pts).gate : null;
    },
    onRelease: (pts) => {
      preview = [];
      previewGate = null;
      commit(readDraw(pts), "draw");
    },
    onTap: (p) => {
      preview = [];
      previewGate = null;
      commit(readTap(p), "tap");
    },
    onCancel: () => {
      preview = [];
      previewGate = null;
      showBanner("Cancelled");
    },
  });
  accessibleBtn.addEventListener("click", () => {
    d.accessible = !d.accessible;
    accessibleBtn.setAttribute("aria-pressed", String(d.accessible));
  });

  // ---- feedback
  let feedbackTimer = 0;
  const showFeedback = (rec: RepRecord): void => {
    const parts = [`<li>Read: ${REP_LABEL[rec.decision]}${rec.decision !== "timeout" && rec.chosenGate !== rec.bestGate ? ` (open gate was ${rec.bestGate})` : ""}</li>`];
    if (rec.execution) parts.push(`<li>Touch: ${rec.execution}</li>`);
    if (rec.outcome) parts.push(`<li>Outcome: ${OUTCOME_LABEL[rec.outcome]}</li>`);
    feedbackEl.innerHTML = `<b>Rep ${rec.index + 1}</b><ul>${parts.join("")}</ul>`;
    feedbackEl.hidden = false;
    window.clearTimeout(feedbackTimer);
    feedbackTimer = window.setTimeout(() => (feedbackEl.hidden = true), 2600);
  };

  // ---- loop
  let raf = 0;
  let last = performance.now();
  let finished = false;
  let slow = 0;
  const loop = (now: number): void => {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(100, now - last);
    last = now;
    for (const ev of step(d, dt)) {
      if (ev.type === "window_open") showBanner("Look — then touch", 900);
      else if (ev.type === "timeout") showBanner("Too late — the ball arrived");
      else if (ev.type === "outcome") showFeedback(d.records[ev.rep]!);
      else if (ev.type === "done") finish();
    }
    const inWindow = d.phase === "window";
    slow += ((inWindow ? 1 : 0) - slow) * 0.2;
    repEl.textContent = `Rep ${Math.min(d.index + 1, d.reps)} / ${d.reps}`;
    speedEl.textContent = inWindow ? "slow motion" : "normal";
    speedEl.classList.toggle("slow", inWindow);
    windowEl.hidden = !inWindow;
    if (inWindow) {
      const p = windowProgress(d);
      windowBar.style.transform = `scaleX(${1 - p})`;
      windowLeft.textContent = `${((1 - p) * windowLimitMs(d) / 1000).toFixed(1)} s`;
      windowEl.classList.toggle("urgent", p > 0.7);
    }
    draw();
  };

  const draw = (): void => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = canvas.width / dpr;
    const hgt = canvas.height / dpr;
    paintSurround(ctx, w, hgt);
    const a = toScreen({ x: 0, y: 0 });
    const b = toScreen({ x: AREA.length, y: AREA.width });
    paintTurf(ctx, { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }, 8);
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 2;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    paintVignette(ctx, w, hgt, slow);
    // gates
    const rec = current(d);
    for (const g of GATES) {
      const p1 = toScreen(g.a);
      const p2 = toScreen(g.b);
      const isBest = rec && rec.outcome !== null && rec.bestGate === g.id;
      const isChosen = rec?.chosenGate === g.id && d.phase === "resolve";
      const isPreview = previewGate === g.id;
      ctx.strokeStyle = isPreview ? "#7de6ff" : isChosen ? "#ffb85c" : "rgba(255,255,255,0.85)";
      ctx.lineWidth = isPreview ? 5 : 3;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      for (const p of [p1, p2]) {
        ctx.fillStyle = isBest ? "#7de6ff" : "#ffb85c";
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fill();
      }
      const c = toScreen(g.center);
      ctx.fillStyle = "rgba(234,246,255,0.9)";
      ctx.font = `${Math.max(11, scale * 0.6)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(g.id, c.x, c.y - scale * 0.5);
    }
    // pressure arrow: defender's run
    if (d.phase === "window" || d.phase === "serve") {
      const from = toScreen(d.defender.pos);
      const to = toScreen(RECEIVE_POINT);
      ctx.strokeStyle = `rgba(255,122,89,${0.35 + 0.4 * slow})`;
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // people
    const r = Math.max(7, scale * 0.45);
    const people: Array<{ pos: Vec2; kit: Kit; label: string | null; controlled: boolean }> = [
      { pos: SERVER_POINT, kit: "neutral", label: "C", controlled: false },
      { pos: d.defender.pos, kit: "away", label: null, controlled: false },
      { pos: d.player, kit: "home", label: null, controlled: true },
    ];
    people.sort((p, q2) => p.pos.y - q2.pos.y);
    for (const who of people) {
      const sp = toScreen(who.pos);
      paintShadow(ctx, sp.x, sp.y, r);
    }
    for (const who of people) {
      const sp = toScreen(who.pos);
      paintFigure(ctx, sp.x, sp.y, r, { kit: who.kit, label: who.label, controlled: who.controlled, deciding: who.controlled && d.phase === "window" });
    }
    // ball
    const bp = toScreen(d.ball.pos);
    paintBall(ctx, bp.x, bp.y, Math.max(3, scale * 0.16));
    // preview
    if (preview.length > 1) {
      ctx.strokeStyle = previewGate ? "#7de6ff" : "rgba(234,246,255,0.5)";
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.beginPath();
      const p0 = toScreen(preview[0]!);
      ctx.moveTo(p0.x, p0.y);
      for (const p of preview.slice(1)) {
        const s = toScreen(p);
        ctx.lineTo(s.x, s.y);
      }
      ctx.stroke();
    }
  };


  const finish = (): void => {
    if (finished) return;
    finished = true;
    const s = summarize(d);
    const rows = d.records
      .map((r) => `<tr><td>${r.index + 1}</td><td>${r.chosenGate ?? "—"}</td><td>${r.bestGate}</td><td>${r.decision}</td><td>${r.execution ?? "—"}</td><td>${r.outcome ?? "—"}</td></tr>`)
      .join("");
    const summary = document.createElement("section");
    summary.className = "summary";
    summary.innerHTML = `
      <h2>Receive and go · ${s.outcomes.through} of ${s.reps} through</h2>
      <p class="muted">Reads: ${s.reads} (strong ${s.decisions.strong} · fair ${s.decisions.acceptable} · weak ${s.decisions.weak} · late ${s.decisions.timeout})</p>
      <p class="muted">Touch: ${s.touch} (clean ${s.executions.clean} · ok ${s.executions.ok} · loose ${s.executions.loose})</p>
      <div class="table-wrap"><table><thead><tr><th>Rep</th><th>Gate</th><th>Open</th><th>Read</th><th>Touch</th><th>Outcome</th></tr></thead><tbody>${rows}</tbody></table></div>
      <button type="button" class="primary exit">Back to ${escapeHtml(opts.coachName)}</button>`;
    q<HTMLButtonElement>(summary, "button.exit").addEventListener("click", () => {
      handle.destroy();
      opts.onDone(s);
    });
    stage.appendChild(summary);
  };

  raf = requestAnimationFrame(loop);
  const handle: Handle = {
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      pointer.detach();
      window.clearTimeout(bannerTimer);
      window.clearTimeout(feedbackTimer);
      root.className = "";
    },
  };
  return handle;
}
