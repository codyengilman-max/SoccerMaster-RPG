import type { MinigameResult } from "../../minigame/contract";
import { GP_TIMING, topicById, type GpInput, type GpState, type Strength } from "../../minigame/groupPresentation";
import { escapeHtml } from "../html";
import type { GameView, ViewHost } from "./views";

const STRENGTH_TEXT: Record<Strength, string> = {
  explaining: "good at explaining",
  reading: "good at reading aloud",
  numbers: "good with numbers",
};

const GRADE_TEXT: Record<string, string> = {
  A: "Excellent",
  B: "Good",
  C: "Getting there",
  D: "Needs work",
};

/**
 * Group Presentation as a classroom board: assign who does which part, put the visual cards in
 * order, rehearse the hand-overs, then deliver it live from cue cards. Everything is DOM so it
 * reads on a phone and works with a screen reader; the shell's action row carries the big buttons
 * (1 / 2 / 3, or gamepad X / A / B) so touch and keyboard share one path.
 */
export function presentationView(host: ViewHost): GameView {
  const el = document.createElement("div");
  el.className = "gp-board";
  el.tabIndex = 0;
  el.setAttribute("aria-label", "Group presentation");
  let sig = "";
  let selectedCard = 0;

  const state = (): GpState => host.session.game as GpState;
  const topic = () => topicById(state().topicId)!;
  const me = (): string => host.session.config.participantIds[0]!;
  const name = (id: string): string => (id === me() ? "You" : (host.names[id] ?? id).split(" ")[0]!);
  const send = (i: GpInput): void => host.send(i);
  const scale = (): number => host.session.config.accessibility.timerScale;

  const render = (): void => {
    const s = state();
    const t = topic();
    const key = signature(s);
    if (key !== sig) {
      sig = key;
      el.innerHTML = board(s);
      wire(s);
      actions(s);
    }
    // timers every frame
    const bar = el.querySelector<HTMLElement>(".gp-bar > i");
    if (bar) {
      let used = 0;
      if (s.phase === "rehearsal" && s.rehearsal.windowOpen) used = s.delivery.stepMs / (GP_TIMING.handoffWindowMs * scale());
      else if (s.phase === "delivery" && !s.delivery.intro && s.delivery.limitMs > 0) used = s.delivery.stepMs / s.delivery.limitMs;
      const frac = 1 - Math.max(0, Math.min(1, used));
      bar.style.width = `${frac * 100}%`;
      bar.classList.toggle("low", frac < 0.3);
    }
    if (s.phase === "rehearsal") {
      const cueBtn = el.querySelector<HTMLElement>(".gp-handoff-cue");
      cueBtn?.classList.toggle("open", s.rehearsal.windowOpen);
    }
    host.status(statusText(s, t.title));
  };

  const signature = (s: GpState): string => {
    switch (s.phase) {
      case "assign":
        return `assign:${JSON.stringify(s.assignments)}`;
      case "order":
        return `order:${s.cards.join(",")}:${selectedCard}`;
      case "rehearsal":
        return `rehearsal:${s.rehearsal.index}:${s.rehearsal.results.join("")}`;
      case "delivery": {
        const d = s.delivery;
        const step = d.steps[d.index];
        const extra = step?.kind === "partner" ? `${step.intervention}:${step.recovered}` : step?.kind === "cue" ? `${step.answered}` : "";
        return `delivery:${d.index}:${d.intro}:${extra}`;
      }
      case "feedback":
        return "feedback";
    }
  };

  const statusText = (s: GpState, title: string): string => {
    switch (s.phase) {
      case "assign":
        return `${title} · 1/4 Plan`;
      case "order":
        return `${title} · 2/4 Cards`;
      case "rehearsal":
        return `${title} · 3/4 Rehearse ${Math.min(s.rehearsal.index + 1, s.rehearsal.total)}/${s.rehearsal.total}`;
      case "delivery":
        return `${title} · 4/4 Live ${Math.min(s.delivery.index + 1, s.delivery.steps.length)}/${s.delivery.steps.length}`;
      case "feedback":
        return `${title} · Graded`;
    }
  };

  const board = (s: GpState): string => {
    const t = topic();
    switch (s.phase) {
      case "assign":
        return `
          <h3>${escapeHtml(t.title)}</h3>
          <p class="gp-lead">Who does which part? Everyone should speak, and each part goes best to the person who's strongest at it.</p>
          <ul class="gp-members">${s.members.map((m) => `<li><b>${escapeHtml(name(m.id))}</b> — ${STRENGTH_TEXT[m.strength]}</li>`).join("")}</ul>
          <ol class="gp-sections">${t.sections
            .map(
              (sec) => `<li>
                <div class="gp-sec-title">${escapeHtml(sec.title)} <small>needs someone ${STRENGTH_TEXT[sec.needs]}</small></div>
                <div class="gp-seg" role="radiogroup" aria-label="${escapeHtml(sec.title)}">${s.members
                  .map((m) => `<button type="button" role="radio" aria-checked="${s.assignments[sec.id] === m.id}" class="${s.assignments[sec.id] === m.id ? "on" : ""}" data-sec="${sec.id}" data-who="${escapeHtml(m.id)}">${escapeHtml(name(m.id))}</button>`)
                  .join("")}</div>
              </li>`
            )
            .join("")}</ol>`;
      case "order":
        return `
          <h3>Visual cards</h3>
          <p class="gp-lead">Put the cards in the order you'll show them. Tap a card, then move it up or down.</p>
          <ol class="gp-cards">${s.cards
            .map((id, i) => {
              const card = t.cards.find((c) => c.id === id)!;
              return `<li class="${i === selectedCard ? "sel" : ""}" data-i="${i}"><button type="button" class="gp-card" data-i="${i}" aria-pressed="${i === selectedCard}">${escapeHtml(card.text)}</button>
                <span class="gp-card-move"><button type="button" data-move="up" data-i="${i}" aria-label="move up" ${i === 0 ? "disabled" : ""}>▲</button><button type="button" data-move="down" data-i="${i}" aria-label="move down" ${i === s.cards.length - 1 ? "disabled" : ""}>▼</button></span></li>`;
            })
            .join("")}</ol>`;
      case "rehearsal": {
        const r = s.rehearsal;
        const speakerOrder = t.sections.map((sec) => s.assignments[sec.id] ?? me());
        const from = speakerOrder[Math.min(r.index, speakerOrder.length - 1)] ?? me();
        const to = speakerOrder[Math.min(r.index + 1, speakerOrder.length - 1)] ?? me();
        return `
          <h3>Rehearsal — hand-over ${Math.min(r.index + 1, r.total)} of ${r.total}</h3>
          <p class="gp-lead">${escapeHtml(name(from))} ${from === me() ? "finish" : "finishes"} a part… when the light goes green, hand over to ${escapeHtml(name(to))} — not before, not late.</p>
          <div class="gp-handoff-cue" aria-live="polite"><span>Hand over</span></div>
          <div class="gp-bar"><i></i></div>
          <p class="gp-results">${r.results.map((q) => `<span class="q-${q}">${q}</span>`).join(" ")}</p>`;
      }
      case "delivery": {
        const d = s.delivery;
        const step = d.steps[d.index];
        if (!step) return "";
        const sec = t.sections.find((x) => x.id === step.sectionId);
        if (d.intro) {
          return `<h3>${escapeHtml(sec?.title ?? "")}</h3><p class="gp-lead gp-intro">${step.kind === "cue" ? "Your part. Your cue card is coming up." : `${escapeHtml(name(step.personId))} is up.`}</p>`;
        }
        if (step.kind === "cue") {
          return `
            <h3>${escapeHtml(sec?.title ?? "")}</h3>
            <div class="gp-cue"><small>Cue card</small><p>${escapeHtml(step.prompt)}</p></div>
            <div class="gp-bar"><i></i></div>
            <p class="gp-lead">Pick your answer with the buttons below.</p>`;
        }
        if (step.freezes && step.intervention === null) {
          return `
            <h3>${escapeHtml(sec?.title ?? "")}</h3>
            <p class="gp-lead gp-freeze">${escapeHtml(name(step.personId))} has stopped mid-sentence and is staring at the floor.</p>
            <div class="gp-bar"><i></i></div>
            <p class="gp-lead">What do you do?</p>`;
        }
        return `
          <h3>${escapeHtml(sec?.title ?? "")}</h3>
          <p class="gp-lead">${escapeHtml(name(step.personId))} ${step.intervention === "takeover" ? "steps back while you finish the part." : step.intervention === "prompt" ? "picks the thread back up after your whisper." : step.intervention === "wait" ? (step.recovered ? "finds the words again." : "trails off. The class waits.") : "is speaking."}</p>
          <div class="gp-bar"><i></i></div>`;
      }
      case "feedback": {
        const g = s.grades;
        return `<h3>Graded</h3>${g ? gradesHtml(g) : ""}`;
      }
    }
  };

  const wire = (s: GpState): void => {
    if (s.phase === "assign") {
      for (const b of el.querySelectorAll<HTMLButtonElement>(".gp-seg button")) {
        b.addEventListener("click", () => send({ type: "assign", sectionId: b.dataset["sec"]!, personId: b.dataset["who"]! }));
      }
    } else if (s.phase === "order") {
      for (const b of el.querySelectorAll<HTMLButtonElement>("button.gp-card")) {
        b.addEventListener("click", () => {
          selectedCard = Number(b.dataset["i"]);
          sig = "";
        });
      }
      for (const b of el.querySelectorAll<HTMLButtonElement>("button[data-move]")) {
        b.addEventListener("click", () => {
          const i = Number(b.dataset["i"]);
          const j = b.dataset["move"] === "up" ? i - 1 : i + 1;
          selectedCard = j;
          send({ type: "swap", a: i, b: j });
        });
      }
    } else if (s.phase === "rehearsal") {
      el.querySelector<HTMLElement>(".gp-handoff-cue")?.addEventListener("click", () => send({ type: "handoff" }));
    }
  };

  const pick = (id: string): void => {
    const s = state();
    if (id === "confirm") send({ type: "confirm" });
    else if (id === "handoff") send({ type: "handoff" });
    else if (id.startsWith("answer:")) send({ type: "answer", option: Number(id.slice(7)) });
    else if (id === "prompt" || id === "takeover" || id === "wait") send({ type: "intervene", how: id });
    else if (id === "up" || id === "down") {
      const j = id === "up" ? selectedCard - 1 : selectedCard + 1;
      if (j >= 0 && j < s.cards.length) {
        send({ type: "swap", a: selectedCard, b: j });
        selectedCard = j;
      }
    }
  };

  const actions = (s: GpState): void => {
    switch (s.phase) {
      case "assign": {
        const ready = Object.values(s.assignments).every((v) => v !== null);
        host.actions(ready ? [{ id: "confirm", label: "That's the plan", key: "Enter", primary: true }] : [], pick);
        host.prompt(ready ? "Happy with the split? Confirm to move on to the cards." : "Give every part to someone.");
        return;
      }
      case "order":
        host.actions(
          [
            { id: "up", label: "Move up", key: "↑" },
            { id: "down", label: "Move down", key: "↓" },
            { id: "confirm", label: "Cards ready", key: "Enter", primary: true },
          ],
          pick
        );
        host.prompt("Order the cards so the story of the pizza makes sense from first to last.");
        return;
      case "rehearsal":
        host.actions([{ id: "handoff", label: "Hand over", key: "Space", primary: true }], pick);
        host.prompt("Watch the light. Hand over the moment it turns green.");
        return;
      case "delivery": {
        const step = s.delivery.steps[s.delivery.index];
        if (!step || s.delivery.intro) {
          host.actions([], pick);
          host.prompt("");
          return;
        }
        if (step.kind === "cue" && step.answered === null) {
          host.actions(
            step.options.map((o, i) => ({ id: `answer:${i}`, label: o, key: String(i + 1) })),
            pick
          );
          host.prompt("Answer from your cue card before the class loses the thread.");
          return;
        }
        if (step.kind === "partner" && step.freezes && step.intervention === null) {
          host.actions(
            [
              { id: "prompt", label: "Whisper the next line", key: "1", primary: true },
              { id: "takeover", label: "Take over the part", key: "2" },
              { id: "wait", label: "Give them a second", key: "3" },
            ],
            pick
          );
          host.prompt(`${name(step.personId)} needs something from you.`);
          return;
        }
        host.actions([], pick);
        host.prompt("");
        return;
      }
      case "feedback":
        host.actions([], pick);
        host.prompt("Your teacher has written the grades on the board.");
        return;
    }
  };

  const gradesHtml = (g: { accuracy: string; clarity: string; teamwork: string }): string => `
    <dl class="mg-stats gp-grades">
      <div><dt>Accuracy</dt><dd><b class="grade-${g.accuracy}">${g.accuracy}</b> ${GRADE_TEXT[g.accuracy] ?? ""}</dd></div>
      <div><dt>Clarity</dt><dd><b class="grade-${g.clarity}">${g.clarity}</b> ${GRADE_TEXT[g.clarity] ?? ""}</dd></div>
      <div><dt>Teamwork</dt><dd><b class="grade-${g.teamwork}">${g.teamwork}</b> ${GRADE_TEXT[g.teamwork] ?? ""}</dd></div>
    </dl>`;

  const slot = (i: 0 | 1 | 2): void => {
    const s = state();
    if (s.phase === "rehearsal") {
      if (i === 1) send({ type: "handoff" });
      return;
    }
    if (s.phase === "delivery" && !s.delivery.intro) {
      const step = s.delivery.steps[s.delivery.index];
      if (!step) return;
      if (step.kind === "cue") send({ type: "answer", option: i });
      else if (step.freezes && step.intervention === null) send({ type: "intervene", how: (["prompt", "takeover", "wait"] as const)[i] });
    }
  };

  return {
    howTo: [
      "Plan: give each part to the classmate who's strongest at it — and keep one for yourself.",
      "Cards: put the visual cards in the order you'll show them.",
      "Rehearse: hand over to the next speaker the moment the light goes green.",
      "Live: answer your cue cards (1 / 2 / 3), and decide what to do if a partner freezes.",
      "Your teacher grades accuracy, clarity and teamwork separately.",
    ],
    assistLabel: "Longer answer time and clearer cue cards",
    leaveWarning: "Walking out of the presentation leaves your partners to finish alone. The teacher grades what was delivered so far.",

    mount(stage) {
      stage.appendChild(el);
      render();
    },

    render() {
      render();
    },

    onKey(e) {
      const s = state();
      switch (e.code) {
        case "Enter":
        case "NumpadEnter":
          if (s.phase === "assign" || s.phase === "order") send({ type: "confirm" });
          else slot(1);
          return true;
        case "Space":
          slot(1);
          return true;
        case "Digit1":
        case "KeyJ":
          slot(0);
          return true;
        case "Digit2":
        case "KeyK":
          slot(1);
          return true;
        case "Digit3":
        case "KeyL":
          slot(2);
          return true;
        case "ArrowUp":
          if (s.phase === "order") {
            if (e.shiftKey) pick("up");
            else selectedCard = Math.max(0, selectedCard - 1);
            sig = "";
            return true;
          }
          return false;
        case "ArrowDown":
          if (s.phase === "order") {
            if (e.shiftKey) pick("down");
            else selectedCard = Math.min(s.cards.length - 1, selectedCard + 1);
            sig = "";
            return true;
          }
          return false;
      }
      return false;
    },

    onPad(pad) {
      const s = state();
      for (const b of pad.pressed) {
        if (b === 2) slot(0);
        else if (b === 0) {
          if (s.phase === "assign" || s.phase === "order") send({ type: "confirm" });
          else slot(1);
        } else if (b === 1) slot(2);
        else if (b === 12 && s.phase === "order") {
          selectedCard = Math.max(0, selectedCard - 1);
          sig = "";
        } else if (b === 13 && s.phase === "order") {
          selectedCard = Math.min(s.cards.length - 1, selectedCard + 1);
          sig = "";
        } else if (b === 4 && s.phase === "order") pick("up");
        else if (b === 5 && s.phase === "order") pick("down");
      }
    },

    resultHtml(r: MinigameResult) {
      const sm = r.summary;
      const str = (k: string): string => (typeof sm[k] === "string" ? (sm[k] as string) : "");
      const g = { accuracy: str("accuracy"), clarity: str("clarity"), teamwork: str("teamwork") };
      const cues = typeof sm["correctCues"] === "number" && typeof sm["totalCues"] === "number" ? `${sm["correctCues"]}/${sm["totalCues"]} cue cards right.` : "";
      return `${g.accuracy ? gradesHtml(g) : ""}<p class="mg-note">${r.exitReason === "timeout" ? "The bell went before you finished. " : r.exitReason === "voluntary_exit" ? "You left before the end. " : ""}${cues}</p>`;
    },

    destroy() {
      el.remove();
    },
  };
}
