import type { MinigameResult } from "../../minigame/contract";
import { WCK_TIMING, WCK_VARIANTS, type Dir3, type TouchDir, type WckInput, type WckState, type WckVariant } from "../../minigame/worldCupKnockout";
import { paintBall, paintFigure, paintTurf, paintVignette, type Kit } from "../../render/figures";
import { escapeHtml } from "../html";
import type { GameView, PadFrame, ViewHost } from "./views";

/**
 * World Cup Knockout, seen from a high camera over a corner of the playground: the goal along the
 * top, the server at the bottom, attackers spread across a chalked box. Drag (or hold the arrows /
 * stick) to move into the chalk circle where the next serve lands, tap to call for it, and use the
 * three big buttons for the first touch and the strike. Everything the buttons do is a typed
 * `WckInput`; the view never touches the state itself.
 */
export function wckView(host: ViewHost): GameView {
  const canvas = document.createElement("canvas");
  canvas.className = "mg-canvas";
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", "World Cup Knockout playground");
  let ctx: CanvasRenderingContext2D | null = null;
  let stageEl: HTMLElement | null = null;
  let w = 0;
  let h = 0;
  let dpr = 1;
  let ro: ResizeObserver | null = null;

  const state = (): WckState => host.session.game as WckState;
  const variant = (): WckVariant => (host.session.config.ruleVariant in WCK_VARIANTS ? (host.session.config.ruleVariant as WckVariant) : "classic");
  const first = (id: string): string => (host.names[id] ?? id).split(" ")[0]!;
  const me = (): string => host.session.config.participantIds[0]!;

  // keyboard movement state
  const keys = new Set<string>();
  let moveAcc = 0;
  let foot: "strong" | "weak" = "strong";
  let lastPhaseKey = "";
  let flash = 0;

  // pointer
  let pointer: { id: number; x: number; y: number; t: number; moved: boolean } | null = null;
  let moveToAcc = 0;

  // geometry: area metres → canvas px
  const pad = { top: 0.16, bottom: 0.1, side: 0.06 };
  const box = (): { x: number; y: number; w: number; h: number; s: number } => {
    const s = state();
    const availW = w * (1 - pad.side * 2);
    const availH = h * (1 - pad.top - pad.bottom);
    const scale = Math.min(availW / s.area.w, availH / s.area.d);
    const bw = s.area.w * scale;
    const bh = s.area.d * scale;
    return { x: (w - bw) / 2, y: h * pad.top + (availH - bh) / 2, w: bw, h: bh, s: scale };
  };
  const toPx = (mx: number, my: number): { x: number; y: number } => {
    const b = box();
    return { x: b.x + mx * b.s, y: b.y + my * b.s };
  };
  const toM = (px: number, py: number): { x: number; y: number } => {
    const b = box();
    return { x: (px - b.x) / b.s, y: (py - b.y) / b.s };
  };

  const resize = (): void => {
    if (!stageEl) return;
    const r = stageEl.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = Math.max(200, Math.floor(r.width));
    h = Math.max(200, Math.floor(r.height));
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  };

  // ------------------------------------------------------------- input

  const touchDirs: { id: TouchDir; label: string; key: string }[] = [
    { id: "left", label: "Touch left", key: "J" },
    { id: "forward", label: "Touch forward", key: "K" },
    { id: "right", label: "Touch right", key: "L" },
  ];
  const shootDirs: { id: Dir3; label: string; key: string }[] = [
    { id: "left", label: "Shoot left", key: "J" },
    { id: "center", label: "Shoot centre", key: "K" },
    { id: "right", label: "Shoot right", key: "L" },
  ];

  const send = (i: WckInput): void => host.send(i);

  const pick = (id: string): void => {
    if (id === "call") send({ type: "call" });
    else if (id === "foot") foot = foot === "strong" ? "weak" : "strong";
    else if (id.startsWith("touch:")) send({ type: "touch", dir: id.slice(6) as TouchDir });
    else if (id.startsWith("shoot:")) send({ type: "shoot", dir: id.slice(6) as Dir3, foot });
    lastPhaseKey = "";
  };

  const triad = (slot: 0 | 1 | 2): void => {
    const s = state();
    const r = s.round;
    if (s.phase === "serve_wait") {
      if (slot === 1) send({ type: "call" });
      return;
    }
    if ((s.phase === "incoming" || s.phase === "possession") && r.touch === null) send({ type: "touch", dir: touchDirs[slot]!.id });
    else if (s.phase === "possession" && !r.shot) send({ type: "shoot", dir: shootDirs[slot]!.id, foot });
  };

  const refreshActions = (): void => {
    const s = state();
    const p = s.attackers[0]!;
    const out = p.outRound !== null;
    const weakFoot = WCK_VARIANTS[variant()].weakFoot;
    const key = `${s.phase}:${s.round.touch === null}:${s.round.shot === null}:${out}:${foot}:${s.round.n}:${s.round.targetId ?? ""}`;
    if (key === lastPhaseKey) return;
    lastPhaseKey = key;
    if (s.phase === "finished") {
      host.actions([], pick);
      host.prompt("Knockout over.");
      return;
    }
    if (out && s.phase !== "other_end") {
      host.actions([], pick);
      host.prompt(s.phase === "other_play" ? `You're out — ${first(s.round.targetId ?? "")} is up.` : "You're out — the rest of the knockout plays on.");
      return;
    }
    if (s.phase === "serve_wait") {
      host.actions([{ id: "call", label: "Call for it", key: "Space", primary: true }], pick);
      host.prompt(s.round.called ? "You called — it's coming to your feet. Check where the pressure is." : "Get to the chalk circle, or call for the ball and it comes to you.");
    } else if ((s.phase === "incoming" || s.phase === "possession") && s.round.touch === null) {
      host.actions(
        touchDirs.map((d) => ({ id: `touch:${d.id}`, label: d.label, key: d.key, primary: d.id === "forward" })),
        pick
      );
      host.prompt(`Ball coming — pressure from your ${s.round.pressure === "forward" ? "front" : s.round.pressure}. Open your first touch away from it.`);
    } else if (s.phase === "possession" && !s.round.shot) {
      const btns = shootDirs.map((d) => ({ id: `shoot:${d.id}`, label: d.label, key: d.key, primary: d.id !== s.round.blocker && d.id !== "center" }));
      if (weakFoot) btns.push({ id: "foot", label: `Foot: ${foot}`, key: "F", primary: false });
      host.actions(btns, pick);
      host.prompt(weakFoot ? `Weak-foot round: switch to your ${foot === "weak" ? "weak (set)" : "weak"} foot, wait for the ball to set, then pick the open side.` : "Wait for the ball to set, then strike to the side the blocker isn't on.");
    } else if (s.phase === "other_play") {
      host.actions([], pick);
      host.prompt(`${first(s.round.targetId ?? "")} is up.`);
    } else if (s.phase === "other_end") {
      host.actions([], pick);
      const l = s.round.last;
      if (l) host.prompt(l.result === "goal" ? `${first(l.id)} scored.` : `${first(l.id)} — strike (${l.why.replace(/_/g, " ")}).`);
    } else if (s.phase === "round_end") {
      host.actions([], pick);
      const r = s.round;
      const who = r.targetId === me() ? "You" : first(r.targetId ?? "");
      host.prompt(r.result === "goal" ? `${who} scored.` : `${who} — strike (${(r.why ?? "").replace(/_/g, " ")}).`);
    }
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (host.session.phase !== "active") return;
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    pointer = { id: e.pointerId, x: e.clientX - rect.left, y: e.clientY - rect.top, t: performance.now(), moved: false };
    e.preventDefault();
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (!pointer || e.pointerId !== pointer.id) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (Math.hypot(x - pointer.x, y - pointer.y) > 8) pointer.moved = true;
    if (pointer.moved) {
      const now = performance.now();
      if (now - moveToAcc >= 50) {
        moveToAcc = now;
        const m = toM(x, y);
        send({ type: "move_to", x: m.x, y: m.y });
      }
    }
  };
  const onPointerUp = (e: PointerEvent): void => {
    if (!pointer || e.pointerId !== pointer.id) return;
    const tap = !pointer.moved && performance.now() - pointer.t < 400;
    pointer = null;
    if (tap && state().phase === "serve_wait") send({ type: "call" });
  };

  // ------------------------------------------------------------- paint

  const kitOf = (id: string, i: number): Kit => (id === me() ? "home" : id.startsWith("rival") ? "away" : i % 2 ? "neutral" : "keeper");

  const paint = (): void => {
    if (!ctx) return;
    const s = state();
    const b = box();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // playground: tarmac edge + turf box
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#0a1a33");
    sky.addColorStop(1, "#0f2b4f");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    paintTurf(ctx, { x: b.x - b.s * 0.8, y: b.y - b.s * 1.4, w: b.w + b.s * 1.6, h: b.h + b.s * 2.2 }, 6);
    // chalk box
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = Math.max(1.5, b.s * 0.08);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    // goal along the top
    const gw = Math.min(b.w * 0.42, b.s * 5);
    const gx = b.x + (b.w - gw) / 2;
    const gy = b.y - b.s * 0.9;
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(gx, gy, gw, b.s * 0.9);
    ctx.strokeStyle = "#f4f9ff";
    ctx.lineWidth = Math.max(2, b.s * 0.12);
    ctx.beginPath();
    ctx.moveTo(gx, b.y);
    ctx.lineTo(gx, gy);
    ctx.lineTo(gx + gw, gy);
    ctx.lineTo(gx + gw, b.y);
    ctx.stroke();
    // net
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      const x = gx + (gw * i) / 8;
      ctx.beginPath();
      ctx.moveTo(x, gy);
      ctx.lineTo(x, b.y);
      ctx.stroke();
    }
    // landing circle
    const land = toPx(s.round.landing.x, s.round.landing.y);
    if (s.phase === "serve_wait" || s.phase === "incoming") {
      ctx.setLineDash([b.s * 0.25, b.s * 0.2]);
      ctx.strokeStyle = "rgba(125,230,255,0.9)";
      ctx.lineWidth = Math.max(1.5, b.s * 0.08);
      ctx.beginPath();
      ctx.arc(land.x, land.y, b.s * 1.1, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // blocker on the goal line
    const bx = s.round.blocker === "left" ? gx + gw * 0.2 : s.round.blocker === "right" ? gx + gw * 0.8 : gx + gw * 0.5;
    paintFigure(ctx, bx, b.y + b.s * 0.35, b.s * 0.42, { kit: "neutral", label: "B", outline: true });
    // shadow defender
    if (s.defender) {
      const d = toPx(s.defender.x, s.defender.y);
      paintFigure(ctx, d.x, d.y, b.s * 0.42, { kit: "away", label: "D", outline: true });
    }
    // server bottom-left
    const server = { x: b.x + b.s * 0.6, y: b.y + b.h + b.s * 0.9 };
    paintFigure(ctx, server.x, server.y, b.s * 0.42, { kit: "neutral", label: "S" });
    // attackers
    const p = s.attackers[0]!;
    s.attackers.forEach((a, i) => {
      if (a.outRound !== null) return;
      const pos = toPx(a.x, a.y);
      const isMe = a.id === me();
      paintFigure(ctx!, pos.x, pos.y, b.s * 0.45, {
        kit: kitOf(a.id, i),
        label: isMe ? null : first(a.id).slice(0, 2).toUpperCase(),
        controlled: isMe,
        deciding: isMe && s.phase === "possession",
      });
      if (!isMe) {
        ctx!.fillStyle = "rgba(255,255,255,0.9)";
        ctx!.font = `${Math.max(10, b.s * 0.5)}px system-ui, sans-serif`;
        ctx!.textAlign = "center";
        ctx!.fillText(`${first(a.id)} ${"●".repeat(a.strikes)}${"○".repeat(Math.max(0, s.strikesToOut - a.strikes))}`, pos.x, pos.y + b.s * 1.1);
      }
    });
    // pressure chaser next to the receiver
    const pp = toPx(p.x, p.y);
    if (p.outRound === null && (s.phase === "incoming" || s.phase === "possession") && s.round.touch === null) {
      const off = s.round.pressure === "left" ? { x: -1.6, y: 0 } : s.round.pressure === "right" ? { x: 1.6, y: 0 } : { x: 0, y: -1.6 };
      const cp = toPx(p.x + off.x, p.y + off.y);
      paintFigure(ctx, cp.x, cp.y, b.s * 0.4, { kit: "away", label: "!", lean: { x: -off.x, y: -off.y } });
    }
    // possession clock ring
    if (s.phase === "possession" && p.outRound === null) {
      const total = WCK_VARIANTS[variant()].clockMs * host.session.config.accessibility.timerScale;
      const frac = Math.max(0, s.clockMs / total);
      ctx.strokeStyle = frac < 0.3 ? "#ff7a5c" : "#7de6ff";
      ctx.lineWidth = Math.max(2, b.s * 0.14);
      ctx.beginPath();
      ctx.arc(pp.x, pp.y, b.s * 0.95, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
      ctx.stroke();
    }
    // ball
    const ball = ballPos(s, server, land);
    if (ball) {
      if (ball.set) {
        const glow = ctx.createRadialGradient(ball.x, ball.y, 0, ball.x, ball.y, b.s * 0.9);
        glow.addColorStop(0, "rgba(120,255,170,0.45)");
        glow.addColorStop(1, "rgba(120,255,170,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(ball.x - b.s, ball.y - b.s, b.s * 2, b.s * 2);
      }
      paintBall(ctx, ball.x, ball.y, Math.max(3, b.s * 0.22), ball.lift);
    }
    // round flash
    if (flash > 0 && !host.reducedMotion) {
      ctx.fillStyle = `rgba(125,230,255,${0.25 * flash})`;
      ctx.fillRect(0, 0, w, h);
    }
    paintVignette(ctx, w, h, 0.35);
    // paused / not started veil
    if (host.session.phase !== "active") {
      ctx.fillStyle = "rgba(5,12,28,0.45)";
      ctx.fillRect(0, 0, w, h);
    }
  };

  const ballPos = (s: WckState, server: { x: number; y: number }, land: { x: number; y: number }): { x: number; y: number; lift: number; set: boolean } | null => {
    const p = s.attackers[0]!;
    const target = s.attackers.find((a) => a.id === s.round.targetId);
    const b = box();
    switch (s.phase) {
      case "serve_wait":
        return { x: server.x + b.s * 0.5, y: server.y, lift: 0, set: false };
      case "incoming": {
        const t = 1 - Math.max(0, s.phaseMs) / WCK_TIMING.incomingMs;
        return { x: server.x + (land.x - server.x) * t, y: server.y + (land.y - server.y) * t, lift: Math.sin(t * Math.PI) * b.s * 1.2, set: false };
      }
      case "other_play": {
        if (!target) return null;
        const t = 1 - Math.max(0, s.phaseMs) / WCK_TIMING.otherPlayMs;
        const to = toPx(target.x, target.y);
        const k = Math.min(1, t * 1.6);
        return { x: server.x + (to.x - server.x) * k, y: server.y + (to.y - server.y) * k, lift: Math.sin(k * Math.PI) * b.s * 1.0, set: false };
      }
      case "possession": {
        const r = s.round;
        const since = r.touchAtMs === null ? 0 : s.elapsedMs - r.touchAtMs;
        const set = r.touch !== null && since >= WCK_TIMING.setFrom && since <= WCK_TIMING.setTo;
        const off = r.touch === null ? { x: 0, y: 0 } : r.touch === "weak" ? { x: 0.6, y: 0.3 } : { x: 0, y: -0.7 };
        const pos = toPx(p.x + off.x, p.y + off.y);
        return { x: pos.x, y: pos.y, lift: 0, set };
      }
      case "round_end":
      case "other_end": {
        const r = s.round;
        const mine = s.phase === "round_end";
        const who = (mine ? p : s.attackers.find((a) => a.id === r.last?.id)) ?? p;
        const from = toPx(who.x, who.y);
        const t = 1 - Math.max(0, s.phaseMs) / (mine ? WCK_TIMING.roundEndMs : WCK_TIMING.otherEndMs);
        const dir = mine ? r.shot?.dir : r.last?.result === "goal" ? "center" : "right";
        const result = mine ? r.result : r.last?.result;
        const why = mine ? r.why : r.last?.why;
        const gx = dir === "left" ? 0.3 : dir === "right" ? 0.7 : 0.5;
        const goal = { x: b.x + b.w * (0.29 + gx * 0.42), y: b.y - b.s * 0.45 };
        const wide = { x: b.x + (dir === "left" ? -b.s * 0.8 : b.w + b.s * 0.8), y: b.y - b.s * 0.3 };
        const dest = result === "goal" ? goal : why === "clock" || why === "dispossessed" || why === "wrong_foot" ? from : wide;
        const k = Math.min(1, t * 1.8);
        return { x: from.x + (dest.x - from.x) * k, y: from.y + (dest.y - from.y) * k, lift: Math.sin(k * Math.PI) * b.s * 0.5, set: false };
      }
      default:
        return null;
    }
  };

  let lastRound = -1;
  let lastResult: string | null = null;

  return {
    howTo: [
      "Everyone in gets one ball a round. The chalk circle shows where yours will drop — get there, or call and it comes to your feet.",
      "Drag (or hold the arrows / left stick) to move. Tap the pitch, Space or A to call for the ball.",
      "First touch: open it away from the pressure that's coming (J / K / L or the three buttons).",
      "Strike when the ball is set — glowing green — to the side the blocker isn't guarding.",
      "Three strikes and you're out; the last one standing wins.",
    ],
    assistLabel: "Wider shooting window",
    leaveWarning: "Walking off mid-game counts as leaving. The others will remember it, and the round is recorded as it stands.",

    mount(stage) {
      stageEl = stage;
      stage.appendChild(canvas);
      ctx = canvas.getContext("2d");
      resize();
      ro = new ResizeObserver(resize);
      ro.observe(stage);
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerUp);
      canvas.style.touchAction = "none";
      refreshActions();
      host.status("Round 1");
    },

    beforeTick(dt) {
      if (!keys.size) return;
      moveAcc += dt;
      while (moveAcc >= 50) {
        moveAcc -= 50;
        const dx = (keys.has("ArrowRight") || keys.has("KeyD") ? 1 : 0) - (keys.has("ArrowLeft") || keys.has("KeyA") ? 1 : 0);
        const dy = (keys.has("ArrowDown") || keys.has("KeyS") ? 1 : 0) - (keys.has("ArrowUp") || keys.has("KeyW") ? 1 : 0);
        if (dx || dy) send({ type: "move", dx, dy });
      }
    },

    render(dt) {
      const s = state();
      if (s.round.n !== lastRound) {
        lastRound = s.round.n;
        flash = 0;
      }
      const res = s.round.result ? `${s.round.n}:${s.round.result}` : null;
      if (res !== lastResult) {
        lastResult = res;
        if (res) flash = 1;
      }
      flash = Math.max(0, flash - dt / 600);
      const p = s.attackers[0]!;
      const live = s.attackers.filter((a) => a.outRound === null).length;
      host.status(`Round ${s.round.n} · ${live} in · you ${"●".repeat(p.strikes)}${"○".repeat(Math.max(0, s.strikesToOut - p.strikes))}${p.goals ? ` · ${p.goals} goal${p.goals > 1 ? "s" : ""}` : ""}`);
      refreshActions();
      paint();
    },

    onKey(e) {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "KeyW", "KeyA", "KeyS", "KeyD"].includes(e.code)) {
        keys.add(e.code);
        return true;
      }
      switch (e.code) {
        case "Space":
        case "Enter":
          triad(1);
          return true;
        case "KeyJ":
          triad(0);
          return true;
        case "KeyK":
          triad(1);
          return true;
        case "KeyL":
          triad(2);
          return true;
        case "KeyF":
          foot = foot === "strong" ? "weak" : "strong";
          lastPhaseKey = "";
          return true;
      }
      return false;
    },

    onKeyUp(e) {
      keys.delete(e.code);
    },

    onPad(pad, dt) {
      if (Math.abs(pad.x) > 0.01 || Math.abs(pad.y) > 0.01) {
        moveAcc += dt;
        while (moveAcc >= 50) {
          moveAcc -= 50;
          send({ type: "move", dx: pad.x, dy: pad.y });
        }
      }
      for (const b of pad.pressed) {
        if (b === 2) triad(0);
        else if (b === 0) triad(1);
        else if (b === 1) triad(2);
        else if (b === 3) {
          foot = foot === "strong" ? "weak" : "strong";
          lastPhaseKey = "";
        }
      }
    },

    resultHtml(r: MinigameResult) {
      const sm = r.summary;
      const num = (k: string): number => (typeof sm[k] === "number" ? (sm[k] as number) : 0);
      const winner = typeof sm["winner"] === "string" && sm["winner"] ? first(sm["winner"] as string) : null;
      const place = num("place");
      const ordinal = place === 1 ? "1st" : place === 2 ? "2nd" : place === 3 ? "3rd" : `${place}th`;
      return `
        <dl class="mg-stats">
          <div><dt>Finished</dt><dd>${ordinal} of ${num("players")}</dd></div>
          <div><dt>Rounds</dt><dd>${num("rounds")}</dd></div>
          <div><dt>Goals</dt><dd>${num("goals")}</dd></div>
          <div><dt>Strikes</dt><dd>${num("strikes")}</dd></div>
          <div><dt>Composed touches</dt><dd>${num("strongTouches")}</dd></div>
          <div><dt>Called for it</dt><dd>${num("calls")}</dd></div>
        </dl>
        ${winner ? `<p class="mg-note">${winner === first(me()) ? "You were the last one standing." : `${escapeHtml(winner)} was the last one standing.`}</p>` : sm["finished"] === false ? `<p class="mg-note">The knockout was still going when you left.</p>` : ""}`;
    },

    destroy() {
      ro?.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.remove();
    },
  };
}
