import { attachPointer, type PointerAdapter } from "../gesture/pointer";
import { paintBall, paintSideView, paintStandingFigure } from "../render/figures";
import type { Vec2 } from "../sim/geometry";
import {
  ATTEMPTS_EACH,
  BALL_SPOT,
  FRAME,
  VIEW,
  createChallenge,
  friendShoots,
  readAim,
  readTapAim,
  shoot,
  summarize,
  type Attempt,
  type ChallengeState,
  type ChallengeSummary,
} from "../training/crossbar";
import { escapeHtml, q } from "./html";

export interface CrossbarScreenOptions {
  seed: number;
  friendName: string;
  onDone(summary: ChallengeSummary): void;
}

interface Handle {
  destroy(): void;
}

const RESULT_TEXT: Record<Attempt["result"], string> = { bar: "CROSSBAR!", over: "Over", under: "Under — that's a goal, not the bar", wide: "Wide" };
const FLIGHT_MS = 700;
const FRIEND_DELAY_MS = 900;

/**
 * Crossbar challenge with the friend: front view of a small goal; draw upward from the ball to
 * where you want it to go (or tap). Turns alternate; the friend's attempts come from the same
 * seeded generator. No tactical grading — this is a game between friends (spec §7).
 */
export function mountCrossbarScreen(root: HTMLElement, opts: CrossbarScreenOptions): Handle {
  root.className = "in-match";
  const s: ChallengeState = createChallenge(opts.seed, opts.friendName);
  root.innerHTML = `
    <section class="match drill crossbar">
      <header class="hud">
        <div class="score"><span class="team home">You</span> <b class="num">0 – 0</b> <span class="team away">${escapeHtml(opts.friendName)}</span></div>
        <div class="clock"><span class="turn">Your shot</span></div>
        <span class="speed">1 / ${ATTEMPTS_EACH}</span>
      </header>
      <div class="stage">
        <canvas aria-label="goal frame"></canvas>
        <div class="banner" hidden></div>
      </div>
      <div class="panel">
        <div class="moment">
          <div class="title">Hit the bar</div>
          <ul class="cues"><li>Draw up from the ball to where you want it to land</li><li>Straighter drawings are more precise</li><li>Or turn on tap targets and tap the bar</li></ul>
        </div>
        <div class="feedback" hidden></div>
      </div>
      <div class="controls">
        <button type="button" class="toggle accessible" aria-pressed="false">Tap targets</button>
        <span class="provisional">${escapeHtml(opts.friendName)} · after school</span>
      </div>
    </section>`;

  const stage = q<HTMLDivElement>(root, ".stage");
  const canvas = q<HTMLCanvasElement>(root, "canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  const scoreEl = q<HTMLElement>(root, ".score .num");
  const turnEl = q<HTMLSpanElement>(root, ".turn");
  const countEl = q<HTMLSpanElement>(root, ".speed");
  const bannerEl = q<HTMLDivElement>(root, ".banner");
  const feedbackEl = q<HTMLDivElement>(root, ".feedback");
  const accessibleBtn = q<HTMLButtonElement>(root, ".toggle.accessible");

  let scale = 40;
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
    scale = Math.min(w / VIEW.width, h / VIEW.height) * 0.92;
    ox = (w - VIEW.width * scale) / 2;
    oy = (h + VIEW.height * scale) / 2;
  };
  fit();
  const ro = new ResizeObserver(fit);
  ro.observe(stage);
  // y grows upward in view metres
  const toScreen = (p: Vec2): Vec2 => ({ x: ox + p.x * scale, y: oy - p.y * scale });
  const toView = (p: Vec2): Vec2 => ({ x: (p.x - ox) / scale, y: (oy - p.y) / scale });

  let preview: Vec2[] = [];
  let accessible = false;
  let flight: { from: Vec2; to: Vec2; start: number; attempt: Attempt } | null = null;
  let friendTimer = 0;
  let bannerTimer = 0;
  let feedbackTimer = 0;
  let finished = false;

  const showBanner = (text: string, ms = 1300): void => {
    bannerEl.textContent = text;
    bannerEl.hidden = false;
    window.clearTimeout(bannerTimer);
    bannerTimer = window.setTimeout(() => (bannerEl.hidden = true), ms);
  };
  const hits = (who: Attempt["shooter"]): number => s.attempts.filter((a) => a.shooter === who && a.result === "bar").length;
  const taken = (who: Attempt["shooter"]): number => s.attempts.filter((a) => a.shooter === who).length;
  const refreshHud = (): void => {
    scoreEl.textContent = `${hits("you")} – ${hits("friend")}`;
    turnEl.textContent = s.turn === "you" ? "Your shot" : s.turn === "friend" ? `${opts.friendName}'s shot` : "Done";
    const n = s.turn === "friend" ? taken("friend") + 1 : Math.min(ATTEMPTS_EACH, taken("you") + 1);
    countEl.textContent = `${n} / ${ATTEMPTS_EACH}`;
  };

  const launch = (attempt: Attempt): void => {
    flight = { from: BALL_SPOT, to: attempt.landing, start: performance.now(), attempt };
  };
  const afterFlight = (attempt: Attempt): void => {
    const who = attempt.shooter === "you" ? "You" : opts.friendName;
    feedbackEl.innerHTML = `<b>${escapeHtml(who)}</b> — ${escapeHtml(RESULT_TEXT[attempt.result])}`;
    feedbackEl.hidden = false;
    window.clearTimeout(feedbackTimer);
    feedbackTimer = window.setTimeout(() => (feedbackEl.hidden = true), 1800);
    if (attempt.result === "bar") showBanner(attempt.shooter === "you" ? "CROSSBAR!" : `${opts.friendName} hits it!`);
    refreshHud();
    if (s.turn === null) {
      window.setTimeout(finish, 600);
    } else if (s.turn === "friend") {
      friendTimer = window.setTimeout(() => {
        const a = friendShoots(s);
        if (a) launch(a);
      }, FRIEND_DELAY_MS);
    }
  };

  const tryShoot = (read: { aim: Vec2; precision: number } | null): void => {
    if (s.turn !== "you" || flight) {
      showBanner(s.turn === "friend" ? `${opts.friendName}'s turn` : "Wait for the ball");
      return;
    }
    if (!read) {
      showBanner("Draw upward from the ball");
      return;
    }
    const a = shoot(s, read.aim, read.precision);
    if (a) launch(a);
  };
  const pointer: PointerAdapter = attachPointer(canvas, toView, {
    onPreview: (pts) => (preview = [...pts]),
    onRelease: (pts) => {
      preview = [];
      tryShoot(readAim(pts));
    },
    onTap: (p) => {
      preview = [];
      if (!accessible) {
        showBanner("Draw your shot (or turn on tap targets)");
        return;
      }
      tryShoot(readTapAim(p));
    },
    onCancel: () => (preview = []),
  });
  accessibleBtn.addEventListener("click", () => {
    accessible = !accessible;
    accessibleBtn.setAttribute("aria-pressed", String(accessible));
  });

  let raf = 0;
  const loop = (now: number): void => {
    raf = requestAnimationFrame(loop);
    if (flight && now - flight.start >= FLIGHT_MS) {
      const a = flight.attempt;
      flight = null;
      afterFlight(a);
    }
    draw(now);
  };

  const draw = (now: number): void => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const ground = toScreen({ x: 0, y: 0 }).y;
    paintSideView(ctx, w, h, ground);
    // frame
    const left = (VIEW.width - FRAME.width) / 2;
    const p1 = toScreen({ x: left, y: 0 });
    const p2 = toScreen({ x: left, y: FRAME.height });
    const p3 = toScreen({ x: left + FRAME.width, y: FRAME.height });
    const p4 = toScreen({ x: left + FRAME.width, y: 0 });
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = Math.max(4, FRAME.barThickness * scale);
    ctx.lineCap = "square";
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.lineTo(p4.x, p4.y);
    ctx.stroke();
    // net
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 12; i++) {
      const x = p1.x + ((p4.x - p1.x) * i) / 12;
      ctx.beginPath();
      ctx.moveTo(x, p2.y);
      ctx.lineTo(x, p1.y);
      ctx.stroke();
    }
    for (let j = 1; j < 5; j++) {
      const y = p2.y + ((p1.y - p2.y) * j) / 5;
      ctx.beginPath();
      ctx.moveTo(p1.x, y);
      ctx.lineTo(p4.x, y);
      ctx.stroke();
    }
    // tap target hint on the bar
    if (accessible && s.turn === "you") {
      ctx.strokeStyle = "#7de6ff";
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 2;
      ctx.strokeRect(p2.x, p2.y - 8, p3.x - p2.x, 16);
      ctx.setLineDash([]);
    }
    // landing marks
    for (const a of s.attempts) {
      const p = toScreen(a.landing);
      ctx.fillStyle = a.shooter === "you" ? "rgba(47,211,255,0.75)" : "rgba(255,184,92,0.75)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, a.result === "bar" ? 6 : 4, 0, Math.PI * 2);
      ctx.fill();
    }
    // the two of you in the foreground, taking turns; the near leg swings as a shot leaves
    const swing = flight ? Math.max(0, Math.sin(Math.min(1, (now - flight.start) / 300) * Math.PI)) : 0;
    const shooter = flight ? flight.attempt.shooter : s.turn;
    paintStandingFigure(ctx, w * 0.2, h * 0.98, h * 0.26, "home", shooter === "you" ? swing : 0);
    paintStandingFigure(ctx, w * 0.8, h * 0.98, h * 0.26, "away", shooter === "friend" ? swing : 0);
    // ball
    let bp = toScreen(BALL_SPOT);
    if (flight) {
      const t = Math.min(1, (now - flight.start) / FLIGHT_MS);
      const from = toScreen(flight.from);
      const to = toScreen(flight.to);
      bp = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t - Math.sin(t * Math.PI) * scale * 0.6 };
    }
    paintBall(ctx, bp.x, bp.y, Math.max(5, scale * 0.11));
    // preview
    if (preview.length > 1) {
      ctx.strokeStyle = "#7de6ff";
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.beginPath();
      const p0 = toScreen(preview[0]!);
      ctx.moveTo(p0.x, p0.y);
      for (const p of preview.slice(1)) {
        const sp = toScreen(p);
        ctx.lineTo(sp.x, sp.y);
      }
      ctx.stroke();
    }
  };

  const finish = (): void => {
    if (finished) return;
    finished = true;
    const sum = summarize(s);
    const verdict = sum.winner === "you" ? "You win" : sum.winner === "friend" ? `${opts.friendName} wins` : "Draw";
    const summary = document.createElement("section");
    summary.className = "summary";
    summary.innerHTML = `
      <h2>${escapeHtml(verdict)} · ${sum.yourHits} – ${sum.friendHits}</h2>
      <p class="muted">${sum.yourHits ? `You hit the bar ${sum.yourHits} time${sum.yourHits === 1 ? "" : "s"}.` : `Closest miss: ${sum.closest.toFixed(2)} m from the bar.`}</p>
      <p class="muted small">Just a game between friends — nothing here counts as training evidence.</p>
      <button type="button" class="primary exit">Head home</button>`;
    q<HTMLButtonElement>(summary, "button.exit").addEventListener("click", () => {
      handle.destroy();
      opts.onDone(sum);
    });
    stage.appendChild(summary);
  };

  refreshHud();
  raf = requestAnimationFrame(loop);
  const handle: Handle = {
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      pointer.detach();
      window.clearTimeout(friendTimer);
      window.clearTimeout(bannerTimer);
      window.clearTimeout(feedbackTimer);
      root.className = "";
    },
  };
  return handle;
}
