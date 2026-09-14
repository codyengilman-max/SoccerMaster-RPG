import type { Session } from "../app/session";
import { standings } from "../calendar/competitions";
import { formatDay } from "../calendar/date";
import { WEEKDAY_SLOTS, type Slot } from "../calendar/schedule";
import {
  FRIEND_ID,
  HOME_CLUB_ID,
  advanceDays,
  currentLeagueId,
  eligibilityPreview,
  fixturesFor,
  playerClubId,
  type CampaignState,
  type PendingActivity,
} from "../campaign/campaign";
import { fatigue, inRegularWeek, slotActions, takeAction, weekView, type ActionId } from "../campaign/week";
import { ROLE_LABEL } from "../sim/types";
import { openingStatus, takeQueuedScene } from "../story/flow";
import { escapeHtml } from "./html";

export interface HubHandlers {
  /** A queued scene became current and should be shown. */
  onScene(): void;
  /** A playable action was taken and is now `campaign.pending`. */
  onLaunch(p: PendingActivity): void;
  onExit(): void;
}

const STATUS_TEXT = {
  in_progress: "The opening is still underway.",
  joined: "You are on the FC Batavia U11 roster.",
  undecided: "You have not decided about FC Batavia yet.",
  declined: "You are not at a club right now.",
} as const;

const SLOT_LABEL: Record<Slot, string> = { morning: "Morning", school: "School", afternoon: "Afternoon", evening: "Evening" };
const SLOT_SHORT: Record<Slot, string> = { morning: "am", school: "sch", afternoon: "pm", evening: "eve" };

/**
 * The weekly hub (spec §7): the current slot's actions, the week at a glance, the next fixture,
 * the league table and the tournament-eligibility preview. Everything shown comes from the
 * campaign modules; nothing is decided here.
 */
export function mountHubScreen(root: HTMLElement, session: Session, h: HubHandlers): void {
  const c = session.campaign;
  if (takeQueuedScene(c, session.scenes)) {
    session.save();
    h.onScene();
    return;
  }
  if (c.pending) {
    h.onLaunch(c.pending);
    return;
  }
  root.className = "";
  if (!inRegularWeek(c)) {
    mountPreWeek(root, session, h);
    return;
  }

  const club = playerClubId(c)!;
  const clubName = clubNameOf(c, club);
  const actions = slotActions(c);
  const friend = c.roster.people.find((p) => p.id === FRIEND_ID)?.name ?? "your friend";
  const parent = c.roster.people.find((p) => p.id === "parent")?.name ?? "your parent";
  const fill = (s: string): string => escapeHtml(s.replace("{friend}", friend).replace("{parent}", parent));
  const tired = fatigue(c);
  const next = fixturesFor(c, club).find((f) => !f.result && f.day >= c.day);
  const leagueId = currentLeagueId(c);
  const table = leagueId ? standings(c.competitions, leagueId, c.day) : [];
  const paths = eligibilityPreview(c);
  const week = weekView(c);
  const last = c.reports.at(-1);

  root.innerHTML = `
    <section class="start hub">
      <h1>${escapeHtml(c.player.name)}</h1>
      <p>${c.kind === "boys" ? "Boys'" : "Girls'"} campaign · ${ROLE_LABEL[c.player.position]} · ${escapeHtml(clubName)}</p>
      <div class="card now">
        <h2>${formatDay(c.day)} · ${SLOT_LABEL[c.slot]}</h2>
        <p class="muted small">Energy: ${energyText(tired)}${c.story.pending.length ? ` · ${c.story.pending.length} consequence${c.story.pending.length === 1 ? "" : "s"} still to land` : ""}</p>
        <div class="choices">
          ${actions.map((a) => `<button type="button" class="choice action" data-id="${a.id}"><b>${fill(a.label)}</b>${a.detail ? `<span class="muted small"> — ${fill(a.detail)}</span>` : ""}</button>`).join("")}
        </div>
      </div>
      <div class="card">
        <h3>This week</h3>
        <div class="table-wrap"><table class="week"><tbody>
          ${week
            .map(
              (d) => `<tr class="${d.day === c.day ? "today" : d.day < c.day ? "past" : ""}"><th>${d.weekday}</th>${WEEKDAY_SLOTS.map((slot) => {
                const s = d.slots.find((x) => x.slot === slot);
                if (!s) return `<td class="off"></td>`;
                return `<td class="${s.current ? "current" : ""} ${s.past ? "past" : ""} ${s.commitment?.status ?? ""}">${s.commitment ? escapeHtml(shortTitle(s.commitment.title)) : `<span class="muted">${SLOT_SHORT[s.slot]}</span>`}</td>`;
              }).join("")}</tr>`,
            )
            .join("")}
        </tbody></table></div>
        ${next ? `<p class="muted small">Next: ${next.kind === "league" ? "league" : next.kind} v ${escapeHtml(clubNameOf(c, next.homeClubId === club ? next.awayClubId : next.homeClubId))} · ${formatDay(next.day)} (${next.homeClubId === club ? "home" : "away"})</p>` : ""}
        ${last ? `<p class="muted small">Last: ${escapeHtml(last.home.name)} ${last.score.home} – ${last.score.away} ${escapeHtml(last.away.name)}</p>` : ""}
      </div>
      ${
        table.length
          ? `<div class="card"><h3>League</h3><div class="table-wrap"><table><thead><tr><th></th><th>P</th><th>W</th><th>D</th><th>L</th><th>Pts</th></tr></thead><tbody>${table
              .map((r) => `<tr class="${r.clubId === club ? "me" : ""}"><td>${escapeHtml(clubNameOf(c, r.clubId))}</td><td>${r.played}</td><td>${r.won}</td><td>${r.drawn}</td><td>${r.lost}</td><td>${r.points}</td></tr>`)
              .join("")}</tbody></table></div></div>`
          : ""
      }
      ${
        paths.length
          ? `<div class="card"><h3>Tournament paths</h3><ul class="facts">${paths
              .map((p) => `<li><b>${escapeHtml(p.label)}</b>: ${p.eligible.length ? escapeHtml(p.eligible.join(", ")) : "nothing opens"}${p.blocked.length ? ` · blocked: ${p.blocked.map((b) => escapeHtml(b.tournamentId)).join(", ")}` : ""}</li>`)
              .join("")}</ul></div>`
          : ""
      }
      <div class="actions"><button type="button" class="link exit">Save and exit</button></div>
    </section>`;

  for (const b of root.querySelectorAll<HTMLButtonElement>("button.action")) {
    b.addEventListener("click", () => {
      const r = takeAction(c, b.dataset["id"] as ActionId);
      session.save();
      if (!r.ok) {
        mountHubScreen(root, session, h);
        return;
      }
      if (r.launch) {
        h.onLaunch(r.launch);
        return;
      }
      if (r.ended.scene) {
        h.onScene();
        return;
      }
      mountHubScreen(root, session, h);
    });
  }
  root.querySelector<HTMLButtonElement>("button.exit")?.addEventListener("click", h.onExit);
}

/** Before the club is joined (or if it was declined): the opening's state and a way to reach the next due scene. */
function mountPreWeek(root: HTMLElement, session: Session, h: HubHandlers): void {
  const c = session.campaign;
  const status = openingStatus(c);
  const club = playerClubId(c);
  const clubName = clubNameOf(c, club ?? HOME_CLUB_ID);
  const feeling = c.story.facts["first_feeling"];
  const reads = c.story.facts["intro_reads"];
  const touch = c.story.facts["intro_touch"];
  const pending = c.story.pending.length + c.story.queuedScenes.length;
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
        </ul>
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

export const clubNameOf = (c: CampaignState, id: string): string => c.roster.clubs.find((k) => k.id === id)?.name ?? id;

function energyText(f: number): string {
  return f >= 7 ? "tired — reads will be slower" : f >= 4 ? "a bit heavy-legged" : "fresh";
}

function shortTitle(t: string): string {
  return t === "Team training" ? "Train" : t === "League match" ? "League" : t;
}
