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
  fixtureTitle,
  fixturesFor,
  playerClubId,
  type CampaignState,
  type PendingActivity,
} from "../campaign/campaign";
import { chooseHobby, hobbyView } from "../campaign/hobbies";
import { seasonPhase, seasonSummary, tournamentViews, type SeasonPhase, type TournamentView } from "../campaign/season";
import { acceptOffer, declineOffer, tryoutsView, type ClubTryoutView, type TryoutPhase, type TryoutsView } from "../campaign/tryouts";
import { currentCommitment, fatigue, inRegularWeek, skipToNextEvent, slotActions, takeAction, weekView, type ActionId } from "../campaign/week";
import { ROLE_LABEL } from "../sim/types";
import { CENTRAL_QUESTION } from "../story/arc";
import { openRepairs, openingStatus, personName, takeQueuedScene, takeRepair } from "../story/flow";
import { TRACKS, TRACK_INFO, unlockViews, type Grant, type Requirement } from "../story/progression";
import { JUGGLING_FACTS, JUGGLING_MILESTONES } from "../training/record";
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

const PHASE_LABEL: Record<SeasonPhase, string> = {
  preseason: "Preseason",
  fall: "Fall league",
  winter: "Winter break",
  spring: "Spring league",
  postseason: "Season over",
};

const TOURNAMENT_STATUS: Record<TournamentView["status"], string> = {
  entered: "entered",
  skipped: "entered — you're not going",
  window: "registration open",
  upcoming: "not yet open",
  closed: "closed",
  blocked: "not eligible",
};

const OUTCOME_LABEL = {
  champions: "Champions",
  runners_up: "Runners-up",
  placement_won: "Won the placement game",
  placement_lost: "Lost the placement game",
  in_progress: "In progress",
  not_entered: "",
} as const;

const TRYOUT_PHASE_TEXT: Record<TryoutPhase, string> = {
  before: "Every club in the valley holds tryouts in May. Invitations, if any, come once your pathway is known.",
  invited: "You have been invited. An invitation is a day in May, not a place on a roster.",
  week: "Tryout week. Pick two sessions on the day; a club can only judge what it sees.",
  day: "Tryout day. Two sessions, five clubs — choose from the board below.",
  offers: "The clubs have decided. Accept one offer before the deadline, or none.",
  decided: "Next season is settled.",
  unattached: "No roster has your name on it for August.",
};

const OFFER_TEXT = { open: "offer open", accepted: "accepted", declined: "declined", expired: "lapsed" } as const;

const PROMISE_TEXT = { open: "promised", delivered: "kept", broken: "broken" } as const;

const GRANT_LABEL: Record<Grant, string> = { conversation: "conversation", activity: "activity", support: "support", opportunity: "opportunity" };

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
  const upcoming = fixturesFor(c, club)
    .filter((f) => !f.result && f.day >= c.day)
    .slice(0, 3);
  const leagueId = currentLeagueId(c);
  const table = leagueId ? standings(c.competitions, leagueId, c.day) : [];
  const paths = eligibilityPreview(c);
  const week = weekView(c);
  const last = c.reports.at(-1);
  const phase = seasonPhase(c);
  const season = seasonSummary(c);
  const tournaments = tournamentViews(c);
  const now = currentCommitment(c);
  const canSkip = !now || now.kind === "school";
  const unlocks = unlockViews(c.progression);
  const repairs = openRepairs(c, session.scenes);
  const tryouts = tryoutsView(c);
  const showTryouts = tryouts.phase !== "before" || phase === "postseason";
  const people = Object.entries(c.progression.relationships).filter(([id]) => id !== "player");
  const life = hobbyView(c);
  const jugglingBest = typeof c.story.facts[JUGGLING_FACTS.best] === "number" ? (c.story.facts[JUGGLING_FACTS.best] as number) : 0;
  const jugglingNext = JUGGLING_MILESTONES.find((m) => m.touches > jugglingBest);
  const reqLabel = (q: Requirement): string => (q.track ? TRACK_INFO[q.track].label : personName(c, q.personId));
  const oppOf = (f: { homeClubId: string; awayClubId: string }): string => clubNameOf(c, f.homeClubId === club ? f.awayClubId : f.homeClubId);

  root.innerHTML = `
    <section class="start hub">
      <h1>${escapeHtml(c.player.name)}</h1>
      <p>${c.kind === "boys" ? "Boys'" : "Girls'"} campaign · ${ROLE_LABEL[c.player.position]} · ${escapeHtml(clubName)} · ${PHASE_LABEL[phase]}</p>
      <div class="card now">
        <h2>${formatDay(c.day)} · ${SLOT_LABEL[c.slot]}</h2>
        <p class="muted small">Energy: ${energyText(tired)}${c.story.pending.length ? ` · ${c.story.pending.length} consequence${c.story.pending.length === 1 ? "" : "s"} still to land` : ""}</p>
        <div class="choices">
          ${actions.map((a) => `<button type="button" class="choice action" data-id="${a.id}"${a.clubId ?? a.hobbyId ? ` data-ref="${escapeHtml(a.clubId ?? a.hobbyId ?? "")}"` : ""}><b>${fill(a.label)}</b>${a.detail ? `<span class="muted small"> — ${fill(a.detail)}</span>` : ""}</button>`).join("")}
          ${canSkip ? `<button type="button" class="choice skip-ahead"><b>Let the days pass</b><span class="muted small"> — until the next training, match or moment</span></button>` : ""}
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
        ${last ? `<p class="muted small">Last: ${escapeHtml(last.home.name)} ${last.score.home} – ${last.score.away} ${escapeHtml(last.away.name)}</p>` : ""}
      </div>
      <div class="card progress">
        <h3>Progress</h3>
        <p class="muted small question">${escapeHtml(CENTRAL_QUESTION)}</p>
        <ul class="tracks">
          ${TRACKS.map((t) => `<li><span class="track-label">${escapeHtml(TRACK_INFO[t].label)}</span><span class="bar" role="img" aria-label="${c.progression.tracks[t]} of 100"><span class="fill" style="width:${c.progression.tracks[t]}%"></span></span><span class="track-value">${c.progression.tracks[t]}</span></li>`).join("")}
        </ul>
        ${people.length ? `<p class="muted small">People: ${people.map(([id, v]) => `${escapeHtml(personName(c, id))} ${v > 0 ? "+" : ""}${v}`).join(" · ")}</p>` : ""}
        <h4>Unlocks</h4>
        <ul class="facts unlocks">
          ${unlocks
            .map(
              (u) =>
                `<li class="${u.unlocked ? "unlocked" : "locked"}"><b>${u.unlocked ? "Open" : "Locked"} · ${escapeHtml(u.rule.title)}</b> <span class="muted small">(${GRANT_LABEL[u.rule.grants]})</span><br><span class="small">${escapeHtml(u.rule.opens)}</span><br><span class="muted small">Needs ${u.requirements
                  .map((r) => `${escapeHtml(reqLabel(r.requirement))} ${r.value}/${r.requirement.min}${r.met ? " ✓" : ""}`)
                  .join(", ")}</span></li>`,
            )
            .join("")}
        </ul>
        ${
          repairs.length
            ? `<h4>Things you could still put right</h4><div class="choices">${repairs
                .map((r, i) => `<button type="button" class="choice repair" data-i="${i}"><b>${escapeHtml(r.label)}</b><span class="muted small"> — until ${formatDay(r.untilDay)}</span></button>`)
                .join("")}</div>`
            : ""
        }
      </div>
      <div class="card life">
        <h3>Away from the pitch</h3>
        <p class="muted small">Energy ${tired}/10 · rest takes 3 off, a quiet hobby 1, sleep 1; training adds 2, a match 3. Tired legs (7+) mean slower reads at training.</p>
        <p><b>Juggling</b> · ${jugglingBest ? `record ${jugglingBest}` : "no record yet"}${jugglingNext ? ` <span class="muted small">· next moment at ${jugglingNext.touches}</span>` : ""}</p>
        <p><b>Hobby</b> · ${
          life.hobby
            ? `${escapeHtml(life.hobby.label)} · ${life.sessions} session${life.sessions === 1 ? "" : "s"}${life.next ? ` <span class="muted small">· next moment at ${life.next.sessions}</span>` : ""}`
            : `<span class="muted">none yet — try one in a free afternoon or evening</span>`
        }</p>
        ${
          life.hobby && life.others.length
            ? `<details class="small"><summary class="muted">Change hobby (milestones start over)</summary><div class="choices">${life.others
                .map((h) => `<button type="button" class="choice hobby-switch" data-hobby="${escapeHtml(h.id)}"><b>${escapeHtml(h.label)}</b><span class="muted small"> — ${escapeHtml(h.detail)}</span></button>`)
                .join("")}</div></details>`
            : ""
        }
      </div>
      ${showTryouts ? tryoutsCard(c, tryouts) : ""}
      <div class="card season">
        <h3>Season</h3>
        <p class="muted small">League record ${season.record.won}-${season.record.drawn}-${season.record.lost}${season.fall ? ` · fall ${ordinal(season.fall.position)} of ${season.fall.of}` : ""}${season.spring ? ` · spring ${ordinal(season.spring.position)} of ${season.spring.of}` : ""}${season.trophies ? ` · ${season.trophies} troph${season.trophies === 1 ? "y" : "ies"}` : ""}</p>
        ${
          upcoming.length
            ? `<ul class="facts fixtures">${upcoming
                .map(
                  (f) =>
                    `<li><b>${escapeHtml(fixtureTitle(c, f))}</b> v ${escapeHtml(oppOf(f))} · ${formatDay(f.day)} (${f.homeClubId === club ? "home" : "away"})${
                      f.movedFromDay !== undefined ? `<span class="muted small"> — moved from ${formatDay(f.movedFromDay)} for a tournament</span>` : ""
                    }</li>`,
                )
                .join("")}</ul>`
            : `<p class="muted small">No fixtures left this season.</p>`
        }
        <h4>Tournaments</h4>
        <ul class="facts tournaments">
          ${tournaments
            .map((v) => {
              const s = v.summary;
              const line = s && s.played ? ` · ${s.won}-${s.drawn}-${s.lost}${s.outcome !== "in_progress" ? ` · ${OUTCOME_LABEL[s.outcome]}` : ""}` : "";
              const why = v.reasons.length ? ` <span class="muted small">(${escapeHtml(v.reasons.join("; "))})</span>` : "";
              return `<li class="t-${v.status}"><b>${escapeHtml(v.tournament.name)}</b> · ${formatDay(v.tournament.day)} · ${TOURNAMENT_STATUS[v.status]}${line}${why}</li>`;
            })
            .join("")}
        </ul>
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
      const r = takeAction(c, b.dataset["id"] as ActionId, b.dataset["ref"]);
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
  for (const b of root.querySelectorAll<HTMLButtonElement>("button.hobby-switch")) {
    b.addEventListener("click", () => {
      chooseHobby(c, b.dataset["hobby"] ?? "");
      session.save();
      mountHubScreen(root, session, h);
    });
  }
  for (const b of root.querySelectorAll<HTMLButtonElement>("button.repair")) {
    b.addEventListener("click", () => {
      const r = repairs[Number(b.dataset["i"])];
      if (r) takeRepair(c, session.scenes, r.choice.id, r.repair.id);
      session.save();
      mountHubScreen(root, session, h);
    });
  }
  for (const b of root.querySelectorAll<HTMLButtonElement>("button.offer")) {
    b.addEventListener("click", () => {
      const clubId = b.dataset["club"] ?? "";
      const r = b.dataset["decision"] === "accept" ? acceptOffer(c, clubId) : declineOffer(c, clubId);
      session.save();
      if (!r.ok) window.alert(`That offer can't be ${b.dataset["decision"] === "accept" ? "accepted" : "declined"} (${r.reason}).`);
      mountHubScreen(root, session, h);
    });
  }
  root.querySelector<HTMLButtonElement>("button.skip-ahead")?.addEventListener("click", () => {
    skipToNextEvent(c);
    session.save();
    if (c.scene) {
      h.onScene();
      return;
    }
    mountHubScreen(root, session, h);
  });
  root.querySelector<HTMLButtonElement>("button.exit")?.addEventListener("click", h.onExit);
}

/** Season-end tryouts (spec §18): every club's places, evidence, invitation, promise and offer, and the accept/decline decision. */
function tryoutsCard(c: CampaignState, v: TryoutsView): string {
  const deciding = v.phase === "offers";
  const row = (k: ClubTryoutView): string => {
    const places = k.places === null ? "places set in tryout week" : `${k.places} of ${k.capacity} places open${k.reserved ? ` (${k.reserved} returning)` : ""}`;
    const flags = [k.home ? "your club" : null, k.invited ? "invited you" : null, k.session ? (k.session.played ? `${k.session.activity} session played` : `${k.session.activity} session on the day`) : "no session — decides on your season"].filter((x): x is string => x !== null);
    const reqs = k.requirements.map((r) => `${escapeHtml(r.label)} ${r.value === null ? "—" : r.value}/${r.min}${r.met ? " ✓" : ""}`).join(", ");
    const promise = k.promise ? `<br><span class="small">${escapeHtml(personName(c, k.promise.by))} ${PROMISE_TEXT[k.promise.status]}: “${escapeHtml(k.promise.text)}”${k.promise.keptBy === "next_season" && k.promise.status === "open" ? " (about next season — not an offer)" : ""}</span>` : "";
    const offer = k.offer ? `<b>${OFFER_TEXT[k.offer.status]}</b>${k.offer.status === "open" ? ` · answer by ${formatDay(k.offer.expiresDay)}` : ""}` : v.phase === "offers" || v.phase === "decided" || v.phase === "unattached" ? "no offer" : k.eligible ? "meets every requirement so far" : "not yet";
    const buttons =
      deciding && k.offer?.status === "open"
        ? `<div class="choices"><button type="button" class="choice offer" data-club="${escapeHtml(k.clubId)}" data-decision="accept"><b>${k.home ? "Stay at" : "Join"} ${escapeHtml(k.name)}</b></button><button type="button" class="choice offer" data-club="${escapeHtml(k.clubId)}" data-decision="decline"><b>Turn ${escapeHtml(k.name)} down</b></button></div>`
        : "";
    return `<li class="${k.chosen ? "chosen" : ""}"><b>${escapeHtml(k.name)}</b> <span class="muted small">— ${escapeHtml(k.attraction)}</span><br><span class="small">${places} · ${flags.join(" · ")}</span><br><span class="muted small">Needs ${reqs || "nothing beyond a place"}</span>${promise}<br><span class="small">${offer}</span>${buttons}</li>`;
  };
  return `
      <div class="card tryouts">
        <h3>Tryouts · ${v.dayLabel}</h3>
        <p class="muted small">${TRYOUT_PHASE_TEXT[v.phase]}${v.phase === "day" ? ` ${v.sessionsLeft} session${v.sessionsLeft === 1 ? "" : "s"} left.` : ""}${v.deadline !== null && deciding ? ` Deadline ${formatDay(v.deadline)}.` : ""}</p>
        ${v.decided ? `<p><b>Next season: ${escapeHtml(v.decided.name)}</b>${v.decided.moved ? " — you're moving." : " — you're staying."}</p>` : ""}
        ${v.friend ? `<p class="small">${escapeHtml(v.friend.name)} will be at ${escapeHtml(v.friend.clubName)}${v.friend.apart ? " — a different club from you. Friends don't change club with you." : " — with you."}</p>` : ""}
        <ul class="facts clubs">${v.clubs.map(row).join("")}</ul>
        ${deciding ? `<p class="muted small">Doing nothing is a decision too: open offers lapse after the deadline.</p>` : ""}
      </div>`;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
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
  if (t === "Team training") return "Train";
  if (t === "League match") return "League";
  if (t === "League match (moved)") return "League*";
  const g = /· (G\d+)$/.exec(t);
  return g ? `Cup ${g[1]}` : t;
}
