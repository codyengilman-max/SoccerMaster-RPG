import type { Session } from "../app/session";
import { formatDay } from "../calendar/date";
import { HOME_CLUB_ID, advanceDays, eligibilityPreview, playerClubId } from "../campaign/campaign";
import { ROLE_LABEL } from "../sim/types";
import { openingStatus, takeQueuedScene } from "../story/flow";
import { escapeHtml } from "./html";

export interface HubHandlers {
  /** A queued scene became current and should be shown. */
  onScene(): void;
  onExit(): void;
}

const STATUS_TEXT = {
  in_progress: "The opening is still underway.",
  joined: "You are on the FC Batavia U11 roster.",
  undecided: "You have not decided about FC Batavia yet.",
  declined: "You are not at a club right now.",
} as const;

/**
 * Where the campaign stands after the opening. The full weekly hub (trainings, friend activity,
 * fixtures) is the next milestone; this card shows the state that milestone will build on and
 * lets any due queued scene (e.g. the Sunday decision) play.
 */
export function mountHubScreen(root: HTMLElement, session: Session, h: HubHandlers): void {
  const c = session.campaign;
  if (takeQueuedScene(c, session.scenes)) {
    session.save();
    h.onScene();
    return;
  }
  root.className = "";
  const status = openingStatus(c);
  const club = playerClubId(c);
  const clubName = c.roster.clubs.find((k) => k.id === (club ?? HOME_CLUB_ID))?.name ?? "FC Batavia";
  const feeling = c.story.facts["first_feeling"];
  const reads = c.story.facts["intro_reads"];
  const touch = c.story.facts["intro_touch"];
  const pending = c.story.pending.length + c.story.queuedScenes.length;
  const attended = c.schedule.commitments.filter((k) => k.status === "attended").length;
  const paths = eligibilityPreview(c);
  const dueDays = [...c.story.pending.map((p) => p.dueDay), ...c.story.queuedScenes.map((s) => s.onDay ?? c.day)];
  const nextDue = dueDays.length ? Math.max(c.day + 1, Math.min(...dueDays)) : null;

  root.innerHTML = `
    <section class="start hub">
      <h1>${escapeHtml(c.player.name)}</h1>
      <p>${c.kind === "boys" ? "Boys'" : "Girls'"} campaign · ${ROLE_LABEL[c.player.position]} · ${formatDay(c.day)}</p>
      <div class="card">
        <h2>${escapeHtml(clubName)}</h2>
        <p>${STATUS_TEXT[status]}</p>
        <ul class="facts">
          ${feeling ? `<li>When the invitation came you felt: <b>${escapeHtml(String(feeling))}</b></li>` : ""}
          ${reads ? `<li>Coach saw your reads as <b>${escapeHtml(String(reads))}</b> and your touch as <b>${escapeHtml(String(touch))}</b></li>` : ""}
          <li>${pending} story consequence${pending === 1 ? "" : "s"} still to land</li>
          <li>${attended} commitment${attended === 1 ? "" : "s"} attended so far</li>
        </ul>
        ${
          paths.length
            ? `<h3>Tournament paths</h3><ul class="facts">${paths.map((p) => `<li><b>${escapeHtml(p.label)}</b>: ${p.eligible.length ? escapeHtml(p.eligible.join(", ")) : "nothing opens"}${p.blocked.length ? ` · blocked: ${p.blocked.map((b) => escapeHtml(b.tournamentId)).join(", ")}` : ""}</li>`).join("")}</ul>`
            : ""
        }
        <p class="muted small">Autosaved. The first regular week — three trainings, a friend activity and the opening league match — arrives in the next build.</p>
        <div class="actions">
          ${nextDue !== null ? `<button type="button" class="primary skip">Skip ahead to ${formatDay(nextDue)}</button>` : ""}
          <button type="button" class="${nextDue !== null ? "secondary" : "primary"} exit">Back to start</button>
        </div>
      </div>
    </section>`;
  root.querySelector<HTMLButtonElement>("button.exit")?.addEventListener("click", h.onExit);
  root.querySelector<HTMLButtonElement>("button.skip")?.addEventListener("click", () => {
    if (nextDue === null) return;
    advanceDays(c, nextDue - c.day);
    session.save();
    mountHubScreen(root, session, h);
  });
}
