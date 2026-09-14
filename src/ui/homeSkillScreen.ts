import type { CampaignState } from "../campaign/campaign";
import type { Effect } from "../story/consequences";
import { assignmentById, practised, report, revisit, selfReportedMinutes, stageOf, watchDemonstration, type Assignment, type Stage } from "../training/homeSkill";
import { escapeHtml, q } from "./html";

export interface HomeSkillScreenOptions {
  campaign: CampaignState;
  assignmentId: string;
  coachName: string;
  /** The player finished this session; `effects` are the stage effects already applied to the campaign. */
  onDone(effects: Effect[]): void;
  onBack(): void;
}

const MINUTE_CHOICES = [10, 20, 30] as const;

/**
 * Home skill work (spec §8): watch → practise away from the screen → report → revisit. One slot
 * runs the current stage. The demonstration is an approved slot the owner fills; when no link has
 * been supplied the screen says so instead of inventing one. Practice minutes are the player's own
 * claim and are shown as such.
 */
export function mountHomeSkillScreen(root: HTMLElement, opts: HomeSkillScreenOptions): void {
  const a = assignmentById(opts.assignmentId);
  if (!a) throw new Error(`unknown assignment ${opts.assignmentId}`);
  const c = opts.campaign;
  root.className = "in-scene";
  const stage = stageOf(c, a.id);
  const minutes = selfReportedMinutes(c, a.skill);

  root.innerHTML = `
    <section class="scene home">
      <header class="scene-head">
        <div class="where"><span class="loc">Home</span><span class="day">${escapeHtml(STAGE_LABEL[stage])}</span></div>
        <h2>${escapeHtml(a.title)}</h2>
      </header>
      <div class="dialogue">${body(a, stage, minutes, opts.coachName)}</div>
      <div class="scene-actions">
        <div class="choices"></div>
        <button type="button" class="link back">Not now</button>
      </div>
    </section>`;

  const choices = q<HTMLDivElement>(root, ".choices");
  const finish = (effects: Effect[]): void => {
    root.className = "";
    opts.onDone(effects);
  };
  const button = (label: string, cls = "choice"): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    choices.appendChild(b);
    return b;
  };

  switch (stage) {
    case "watch": {
      const label = a.demonstration.url && a.demonstration.approved ? "I've watched it" : "I've read what to look for";
      button(label).addEventListener("click", () => finish(watchDemonstration(c, a.id)));
      break;
    }
    case "practise": {
      for (const m of MINUTE_CHOICES) {
        button(`I practised about ${m} minutes`).addEventListener("click", () => finish(practised(c, a.id, m)));
      }
      break;
    }
    case "report": {
      for (const o of a.observations) {
        button(o.text).addEventListener("click", () => finish(report(c, a.id, o.id)));
      }
      break;
    }
    case "revisit": {
      button("Read the learning point", "choice").addEventListener("click", () => {
        const r = revisit(c, a.id);
        if (!r) return finish([]);
        q<HTMLDivElement>(root, ".dialogue").insertAdjacentHTML("beforeend", `<p class="line said"><b>${escapeHtml(opts.coachName)}</b>${escapeHtml(r.text)}</p>`);
        choices.innerHTML = "";
        button("Done", "choice").addEventListener("click", () => finish(r.effects));
      });
      break;
    }
    case "done":
      button("Done").addEventListener("click", () => finish([]));
      break;
  }
  q<HTMLButtonElement>(root, "button.back").addEventListener("click", () => {
    root.className = "";
    opts.onBack();
  });
}

const STAGE_LABEL: Record<Stage, string> = {
  watch: "1 · Watch",
  practise: "2 · Practise",
  report: "3 · Report",
  revisit: "4 · Revisit",
  done: "Complete",
};

function body(a: Assignment, stage: Stage, minutes: number, coach: string): string {
  const list = (items: readonly string[]): string => `<ul class="facts">${items.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>`;
  switch (stage) {
    case "watch":
      return `
        <p class="line narration">${escapeHtml(coach)} set this for home. First, watch how it's done.</p>
        ${
          a.demonstration.url && a.demonstration.approved
            ? `<p class="line"><a href="${escapeHtml(a.demonstration.url)}" target="_blank" rel="noopener">${escapeHtml(a.demonstration.title)}</a></p>`
            : `<p class="line muted">No approved demonstration has been supplied for this assignment yet, so there is nothing to watch here. Read what to look for instead.</p>`
        }
        <p class="line"><b>Watch for</b></p>${list(a.watchFor)}`;
    case "practise":
      return `
        <p class="line narration">Put the screen down and go practise. Come back when you're done.</p>
        <p class="line"><b>Practise</b></p>${list(a.practise)}
        <p class="line muted small">Minutes you report are your own account. They are kept apart from what the coach sees at training.${minutes ? ` So far you've reported ${minutes} minutes of ${a.skill.replace("_", " ")}.` : ""}</p>`;
    case "report":
      return `
        <p class="line narration">What did you notice while you practised?</p>
        <p class="line muted small">Pick the one that's true. Only you know.</p>`;
    case "revisit":
      return `<p class="line narration">Revisit the point of the assignment before the next training.</p>`;
    case "done":
      return `<p class="line narration">This assignment is complete.</p>`;
  }
}
