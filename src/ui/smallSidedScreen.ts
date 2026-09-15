import { attachPointer, type PointerAdapter } from "../gesture/pointer";
import type { Vec2 } from "../sim/geometry";
import {
  ACTIVITY_LABEL,
  AREA,
  BEAT_LINE_X,
  CONCEPT_LABEL,
  GOAL,
  USER_ID,
  commit,
  createDrill,
  current,
  hasGoal,
  isKeeper,
  liveAnchor,
  me,
  readDraw,
  readTap,
  step,
  summarize,
  windowLimitMs,
  windowProgress,
  type Activity,
  type DrillState,
  type Names,
  type Option,
  type RepRecord,
  type Summary,
} from "../training/smallSided";
import { escapeHtml, q } from "./html";

export interface SmallSidedScreenOptions {
  activity: Activity;
  seed: number;
  reps?: number;
  names: Names;
  coachName: string;
  /** < 1 when the player arrived tired. */
  windowScale?: number;
  onDone(summary: Summary): void;
  onQuit(): void;
}

interface Handle {
  destroy(): void;
}

const PAD = 1.5;
const DECISION_LABEL: Record<RepRecord["decision"], string> = { strong: "Strong read", acceptable: "Fair read", weak: "Weak read", timeout: "Too late" };
const OUTCOME_LABEL = { success: "It worked", partial: "Half worked", failure: "Lost it" } as const;
const CUES: Record<Activity, string[]> = {
  "1v1": ["Which side is the defender leaning?", "Are they rushing in or waiting?", "Draw your carry or shot — or hold"],
  "2v2": ["Is the pass lane open?", "Is your teammate marked tight or loose?", "Draw a pass, a carry or a shot"],
  "3v2": ["Who is free?", "Play early while you have numbers", "Draw the ball to the free player"],
  rondo: ["Who is the presser closing?", "Play away from the pressure", "Is the split lane open — or is a body in it?"],
  transition: ["You've just won it — where is the runner?", "Is the last defender set, or still retreating?", "Release early, or drive before they recover"],
};

/**
 * Team-training activity screen (1v1 / 2v2 / 3v2). Same input model as the match: the window opens
 * in slow motion, the player draws toward an option (or selects then taps), the module grades the
 * decision, execution and outcome separately, and the screen only shows what it says.
 */
export function mountSmallSidedScreen(root: HTMLElement, opts: SmallSidedScreenOptions): Handle {
  root.className = "in-match";
  const d: DrillState = createDrill(opts.activity, opts.seed, { reps: opts.reps ?? 5, names: opts.names, windowScale: opts.windowScale ?? 1 });
  root.innerHTML = `
    <section class="match drill">
      <header class="hud">
        <div class="score"><span class="team">${escapeHtml(ACTIVITY_LABEL[opts.activity])}</span></div>
        <div class="clock"><span class="rep">Rep 1 / ${d.reps}</span></div>
        <span class="speed">normal</span>
      </header>
      <div class="stage">
        <canvas aria-label="training area"></canvas>
        <div class="window" hidden><div class="bar"></div><span class="left"></span></div>
        <div class="banner" hidden></div>
      </div>
      <div class="panel">
        <div class="moment">
          <div class="title">${escapeHtml(opts.coachName)}: look, then play</div>
          <ul class="cues">${CUES[opts.activity].map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>
          <div class="options" role="group" aria-label="options" hidden></div>
        </div>
        <div class="feedback" hidden></div>
      </div>
      <div class="controls">
        <button type="button" class="toggle accessible" aria-pressed="false">Tap targets</button>
        <button type="button" class="link quit">Leave training</button>
        <span class="provisional">${(opts.windowScale ?? 1) < 1 ? "tired · shorter windows" : "team training"}</span>
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
  const optionsEl = q<HTMLDivElement>(root, ".options");
  const feedbackEl = q<HTMLDivElement>(root, ".feedback");
  const accessibleBtn = q<HTMLButtonElement>(root, ".toggle.accessible");
  const quitBtn = q<HTMLButtonElement>(root, "button.quit");

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
  let previewOption: Option | null = null;
  let selected: Option | null = null;
  let bannerTimer = 0;
  let accessible = false;
  const showBanner = (text: string, ms = 1400): void => {
    bannerEl.textContent = text;
    bannerEl.hidden = false;
    window.clearTimeout(bannerTimer);
    bannerTimer = window.setTimeout(() => (bannerEl.hidden = true), ms);
  };
  const doCommit = (read: ReturnType<typeof readDraw>, via: "draw" | "tap"): void => {
    if (d.phase !== "window") {
      showBanner(d.phase === "resolve" ? "Watch it play out" : "Wait for the window");
      return;
    }
    if (!read.option) {
      showBanner(via === "draw" ? "Draw toward a teammate, the space or the goal" : "Tap a target");
      return;
    }
    commit(d, read.option.id, read.accuracy);
    selected = null;
    renderOptions();
  };
  const pointer: PointerAdapter = attachPointer(canvas, toField, {
    onPreview: (pts) => {
      preview = [...pts];
      previewOption = d.phase === "window" ? readDraw(d, pts, selected).option : null;
    },
    onRelease: (pts) => {
      preview = [];
      previewOption = null;
      doCommit(readDraw(d, pts, selected), "draw");
    },
    onTap: (p) => {
      preview = [];
      previewOption = null;
      if (!accessible && !selected) {
        showBanner("Draw your play (or turn on tap targets)");
        return;
      }
      doCommit(readTap(d, p, selected), "tap");
    },
    onCancel: () => {
      preview = [];
      previewOption = null;
    },
  });
  accessibleBtn.addEventListener("click", () => {
    accessible = !accessible;
    d.accessible = accessible;
    accessibleBtn.setAttribute("aria-pressed", String(accessible));
    renderOptions();
  });
  quitBtn.addEventListener("click", () => {
    if (finished) return;
    if (!window.confirm("Leave training now? It will count as missed.")) return;
    handle.destroy();
    opts.onQuit();
  });

  const renderOptions = (): void => {
    if (d.phase !== "window") {
      optionsEl.hidden = true;
      optionsEl.innerHTML = "";
      return;
    }
    optionsEl.hidden = false;
    optionsEl.innerHTML = d.options
      .map((o) => `<button type="button" class="option${selected?.id === o.id ? " selected" : ""}" data-id="${o.id}">${escapeHtml(o.label)}</button>`)
      .join("");
    for (const b of optionsEl.querySelectorAll<HTMLButtonElement>("button.option")) {
      b.addEventListener("click", () => {
        const o = d.options.find((x) => x.id === b.dataset["id"]) ?? null;
        if (!o) return;
        if (o.kind === "hold") {
          commit(d, o.id, 1);
          selected = null;
          renderOptions();
          return;
        }
        selected = selected?.id === o.id ? null : o;
        renderOptions();
        showBanner(selected ? (accessible ? `${selected.label}: tap where` : `${selected.label}: draw it`) : "Selection cleared", 1200);
      });
    }
  };

  // ---- feedback
  let feedbackTimer = 0;
  const showFeedback = (rec: RepRecord): void => {
    const chosen = rec.options.find((o) => o.id === rec.chosenId)?.label ?? "—";
    const best = rec.options.find((o) => o.id === rec.bestId)?.label ?? "—";
    const parts = [`<li>Read: ${DECISION_LABEL[rec.decision]}${rec.chosenId !== rec.bestId ? ` — best was <i>${escapeHtml(best)}</i>` : ""}</li>`];
    if (rec.decision !== "timeout") parts.push(`<li>Choice: ${escapeHtml(chosen)}</li>`);
    if (rec.execution) parts.push(`<li>Execution: ${rec.execution}</li>`);
    if (rec.outcome) parts.push(`<li>Outcome: ${OUTCOME_LABEL[rec.outcome]}${rec.note ? ` — ${escapeHtml(rec.note)}` : ""}</li>`);
    if (rec.missedConcept) parts.push(`<li>Lesson: ${escapeHtml(CONCEPT_LABEL[rec.missedConcept])}</li>`);
    feedbackEl.innerHTML = `<b>Rep ${rec.index + 1}</b><ul>${parts.join("")}</ul>`;
    feedbackEl.hidden = false;
    window.clearTimeout(feedbackTimer);
    feedbackTimer = window.setTimeout(() => (feedbackEl.hidden = true), 3200);
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
      if (ev.type === "window_open") {
        showBanner("Look — then play", 900);
        renderOptions();
      } else if (ev.type === "timeout") {
        showBanner("Too late — they closed you down");
        renderOptions();
      } else if (ev.type === "outcome") showFeedback(d.records[ev.rep]!);
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
      windowLeft.textContent = `${(((1 - p) * windowLimitMs(d)) / 1000).toFixed(1)} s`;
      windowEl.classList.toggle("urgent", p > 0.7);
    }
    draw();
  };

  const draw = (): void => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = canvas.width / dpr;
    const hgt = canvas.height / dpr;
    ctx.fillStyle = "#2e6b37";
    ctx.fillRect(0, 0, w, hgt);
    const a = toScreen({ x: 0, y: 0 });
    const b = toScreen({ x: AREA.length, y: AREA.width });
    ctx.fillStyle = "#357a40";
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 2;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    if (hasGoal(d.activity)) {
      // beat line + goal
      const bl1 = toScreen({ x: BEAT_LINE_X, y: 0 });
      const bl2 = toScreen({ x: BEAT_LINE_X, y: AREA.width });
      ctx.setLineDash([8, 8]);
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.beginPath();
      ctx.moveTo(bl1.x, bl1.y);
      ctx.lineTo(bl2.x, bl2.y);
      ctx.stroke();
      ctx.setLineDash([]);
      const g1 = toScreen({ x: GOAL.center.x, y: GOAL.center.y - GOAL.halfWidth });
      const g2 = toScreen({ x: GOAL.center.x, y: GOAL.center.y + GOAL.halfWidth });
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(g1.x, g1.y);
      ctx.lineTo(g2.x, g2.y);
      ctx.stroke();
    } else {
      // rondo square
      const s1 = toScreen({ x: 10, y: AREA.width / 2 - 5 });
      const s2 = toScreen({ x: 20, y: AREA.width / 2 + 5 });
      ctx.setLineDash([8, 8]);
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.lineWidth = 2;
      ctx.strokeRect(s1.x, s1.y, s2.x - s1.x, s2.y - s1.y);
      ctx.setLineDash([]);
    }
    if (slow > 0.02) {
      const g = ctx.createRadialGradient(w / 2, hgt / 2, Math.min(w, hgt) * 0.35, w / 2, hgt / 2, Math.max(w, hgt) * 0.75);
      g.addColorStop(0, "rgba(6,16,31,0)");
      g.addColorStop(1, `rgba(6,16,31,${0.55 * slow})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, hgt);
    }
    // option anchors during the window
    const m = me(d);
    if (d.phase === "window") {
      for (const o of d.options) {
        const anchor = liveAnchor(d, o);
        if (!anchor) continue;
        const p = toScreen(anchor);
        const hot = previewOption?.id === o.id || selected?.id === o.id;
        ctx.strokeStyle = hot ? "#7de6ff" : "rgba(234,246,255,0.55)";
        ctx.lineWidth = hot ? 3 : 1.5;
        ctx.setLineDash(hot ? [] : [4, 4]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(8, scale * 0.9), 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        if (accessible || hot) {
          ctx.fillStyle = "rgba(234,246,255,0.9)";
          ctx.font = `${Math.max(11, scale * 0.55)}px system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.fillText(o.label, p.x, p.y - Math.max(10, scale * 1.1));
        }
      }
    }
    // after the rep: the best option, so the lesson is visible
    const rec = current(d);
    if (rec && d.phase === "resolve" && rec.chosenId !== rec.bestId) {
      const best = rec.options.find((o) => o.id === rec.bestId);
      if (best?.anchor) {
        const p = toScreen(best.anchor);
        ctx.strokeStyle = "rgba(125,230,255,0.8)";
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 5]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(8, scale * 0.9), 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // people
    for (const act of d.actors) {
      if (act.id === USER_ID) continue;
      const color = isKeeper(act) ? "#ffd34d" : act.team === "def" ? "#ff7a59" : "#eaf6ff";
      const label = isKeeper(act) ? "GK" : act.team === "att" ? initials(act.name) : "";
      dot(toScreen(act.pos), scale * 0.5, color, label);
    }
    dot(toScreen(m.pos), scale * 0.5, "#2fd3ff", "");
    // ball
    const bp = toScreen(d.ball.pos);
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(bp.x, bp.y, Math.max(3, scale * 0.18), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#06101f";
    ctx.lineWidth = 1;
    ctx.stroke();
    // preview
    if (preview.length > 1) {
      ctx.strokeStyle = previewOption ? "#7de6ff" : "rgba(234,246,255,0.5)";
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

  const initials = (name: string): string =>
    name
      .split(/\s+/)
      .map((w) => w[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase();

  const dot = (p: Vec2, r: number, color: string, label: string): void => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(6, r), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(6,16,31,0.8)";
    ctx.lineWidth = 2;
    ctx.stroke();
    if (label) {
      ctx.fillStyle = "#06101f";
      ctx.font = `bold ${Math.max(9, r * 0.8)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, p.x, p.y);
      ctx.textBaseline = "alphabetic";
    }
  };

  const finish = (): void => {
    if (finished) return;
    finished = true;
    const s = summarize(d);
    const rows = d.records
      .map((r) => {
        const chosen = r.options.find((o) => o.id === r.chosenId)?.label ?? "—";
        const best = r.options.find((o) => o.id === r.bestId)?.label ?? "—";
        return `<tr><td>${r.index + 1}</td><td>${escapeHtml(chosen)}</td><td>${escapeHtml(best)}</td><td>${r.decision}</td><td>${r.execution ?? "—"}</td><td>${r.outcome ?? "—"}</td></tr>`;
      })
      .join("");
    const summary = document.createElement("section");
    summary.className = "summary";
    summary.innerHTML = `
      <h2>${escapeHtml(ACTIVITY_LABEL[opts.activity])} · ${s.outcomes.success} of ${s.reps} worked</h2>
      <p class="muted">Reads: ${s.reads} (strong ${s.decisions.strong} · fair ${s.decisions.acceptable} · weak ${s.decisions.weak} · late ${s.decisions.timeout})</p>
      <p class="muted">Execution: ${s.touch} (clean ${s.executions.clean} · ok ${s.executions.ok} · loose ${s.executions.loose})</p>
      ${s.goodReadFailed ? `<p class="muted">${s.goodReadFailed} good read${s.goodReadFailed === 1 ? "" : "s"} didn't come off — the decision was still right.</p>` : ""}
      ${s.poorReadSucceeded ? `<p class="muted">${s.poorReadSucceeded} poor read${s.poorReadSucceeded === 1 ? "" : "s"} got away with it.</p>` : ""}
      ${s.lesson ? `<p><b>${escapeHtml(opts.coachName)}:</b> work on ${escapeHtml(CONCEPT_LABEL[s.lesson])}.</p>` : ""}
      <div class="table-wrap"><table><thead><tr><th>Rep</th><th>Choice</th><th>Best</th><th>Read</th><th>Execution</th><th>Outcome</th></tr></thead><tbody>${rows}</tbody></table></div>
      <button type="button" class="primary exit">Finish training</button>`;
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
