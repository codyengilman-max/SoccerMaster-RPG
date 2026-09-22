# SoccerMaster RPG — Implementation Plan

Source of requirements: `spec/SOCCERMASTER_RPG_STANDALONE_V1_1.md` (the "spec"). Section numbers below
refer to it. Anything the spec leaves open is tracked in `spec/OPEN_QUESTIONS.md` with a proposed
default; nothing here is taken from an earlier project.

## 1. Technology proposal (spec §22)

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) | One language for simulation, story rules and UI; types are the module boundary contract. |
| Build / dev | Vite | Static output in `dist/`, fast local dev, no server component. |
| Tests | Vitest | Same toolchain; deterministic unit tests for simulation, rules and saves. |
| Rendering | HTML Canvas 2D for the pitch and slow-motion scenes; DOM for menus, dialogue, hub, calendar | Canvas gives frame-level control for moving slow motion and gesture preview; DOM keeps text readable and accessible. |
| Input | Pointer Events (touch + mouse + pen) | Single code path for the drawing controls and the tap-based accessible alternative. |
| Persistence | `localStorage` behind a `SaveStore` interface, versioned JSON | Offline, no account needed for the first milestone; the interface allows a later cloud store. |
| PWA | Manifest + service worker (added once the shell is stable) | Installable on phones; offline play. |
| Runtime deps | none | Everything above is a build-time dependency; the shipped app is plain ES modules. |

Runtime Node: 20 (`.node-version` is committed so Cloudflare Pages picks it up).

**Cloudflare Pages fit.** The project is a fully static site. Pages settings:

```
Build command:     npm run build
Build output dir:  dist
Root directory:    /
Node version:      from .node-version (20)
```

Every branch push produces a preview URL; `main` is production. No Workers, KV or Functions are
required for the first milestone. If optional AI dialogue (§20) is ever enabled, it will be a
Pages Function that proxies a provider with the authored-fallback path staying client-side, so the
prototype stays playable without it (§20, acceptance 16).

Versions are pinned to releases at least a week old at the time of adding.

## 2. Module structure (spec §22)

```
src/
  sim/          Soccer simulation. Pure functions over an immutable-ish MatchState. No DOM.
                 geometry, players, ball, possession, pressure/space, movement, actions,
                 restarts, offside, rules profiles, fatigue, seeded RNG.
  tactics/      Recognition + option generation + grading. Reads sim state, never mutates it.
                 catalog loader (content in /content, not code), triggers, options, decision
                 quality, execution grading, coverage/difficulty metrics.
  gesture/      Pointer-path capture → intent (target point, direction, power) → supported sim
                 action. Cancel gesture, accessible tap alternative. No knowledge of grading.
  render/       Canvas pitch renderer, camera, slow-motion clock, preview overlay. Reads state
                 only; performs no soccer reasoning.
  match/        Match runtime: real-time loop, moment director (slow-mo entry/exit, decision
                 windows, expiry, cancellation, unavailable-action handling), event log with
                 stable IDs, MatchReport output.
  calendar/     Day/slot model, week advancement, attendance, conflicts, leagues, tournaments,
                 eligibility, standings, result ingestion (idempotent by event ID).
  roster/       Clubs, squads, roster identities, capacity, tryouts, offers, transfers.
  story/        Scenes, choices (eligibility / immediate / delayed / repair / expiry), facts,
                 promises, character knowledge, consequence queue, authored fallback dialogue.
  ai/           Optional dialogue provider interface + stale/duplicate rejection. Off by default.
  save/         Versioned save schema, migrations, SaveStore interface, localStorage store.
  ui/           Screens: start, campaign select, player creation, position select, hub, calendar,
                 training, match, postgame, dialogue. DOM + the render module.
content/
  catalog/      Tactical situations (JSON), one file per role, with review status.
  story/        Authored scenes and characters (JSON/TS data).
  rules/        Age/competition rules profiles with source citations.
tests/          Vitest suites mirroring src/, plus acceptance/ for spec §24 checks.
```

Dependency direction: `ui → match/calendar/story/save → tactics → sim`. `render` and `gesture`
depend only on `sim` types. Nothing depends on `ui`.

## 3. Key design decisions that need stating up front

### 3.0 Corrected official-match model (spec §9–§14, approved after the match-system audit, PR #18)

The canonical match experience is answer-only: the engine simulates the whole match, routine play
is skipped, and the user gets 12–18 meaningful direct-involvement moments (first-touch decisions
for outfield roles; distribution / claim / sweep / 1v1 / positioning / communication decisions
for the keeper), each a cinematic lead-in, a freeze, a 15-second multiple-choice answer, automatic
execution and brief feedback, in 5–7 real minutes (4–8 acceptable). It lands in two stacked PRs:

- **PR A — soccer logic and answer catalog.** `switch_play` and the lay-off / recycle answers are
  offered wherever the engine has the route (`tools/authorCatalog.ts` →
  `content/catalog/provisional-u11.json`); the contextual second-9 read (`secondNineRead`,
  `SECOND_NINE` in `src/sim/ai.ts`) drives both the AI wingers' off-ball movement and the
  `narrow_inside` answer; `src/tactics/exclusions.ts` lists the only documented omissions of an
  engine-best option; `tests/tactics/answerSet.test.ts` proves every displayed answer instantiates
  in its state and that the engine's highest-scoring on-ball option is never omitted without a
  documented exclusion; `tests/tactics/secondNine.test.ts` proves narrowing is contextual and never
  pulls both wingers inside.
- **PR B — cinematic decision match (this state of the repo).** The runtime, moment director, timer,
  answer-only screen, automatic execution, skipping, intelligence report and re-baselined pace proof
  described in 3.1–3.2 below.

### 3.1 Match time: skipped routine play, lead-in, freeze, answer, consequence (§9, §12)

- The simulation advances in fixed ticks (`dt = 50 ms` simulated). The runtime
  (`src/match/runtime.ts`) is a phase machine driven by real-time frames:
  `routine → lead_in → question → timer → resolving → feedback → routine …`, with `halftime` and
  `finished`. Nothing is jumped over: **routine** play is simulated tick by tick at `SKIP_SCALE`
  (×180, at most `MAX_SKIP_TICKS_PER_FRAME` = 120 ticks per frame) with the match clock visible, so
  the score, the clock and the event ledger are exactly those of the full simulation; the player just
  does not watch it.
- **Lead-in**: when a direct involvement is recognised on the current tick, the last `LEAD_IN_MS`
  (3 s; `LEAD_IN_MIN_MS` 2 s) of authoritative ticks are replayed at real speed from the position
  history so the ball's travel, teammate and defender movement, pressure and space are seen before
  the freeze. The authoritative state does not advance during the replay; `skipLeadIn` (reduced
  motion) jumps straight to the freeze.
- **Question**: the field is frozen at the involvement tick (first controlled contact for outfield
  roles; the keeper's intervention point). The title, cues and 3–6 answers are instantiated from that
  frozen state. The 15-second timer (`ANSWER_MS`) waits for `ready()`, which the screen calls once the
  answers are painted and any read-aloud has finished; pause stops it; answering ends it.
- **Answer**: `answer(optionId)` re-instantiates the option's intent against the frozen state, issues
  exactly that command, and closes the moment with one record. If the intent cannot be instantiated
  the record says `intent_unavailable` and the engine acts — nothing is silently swapped.
- **Timeout**: the record's decision band is `timeout` with no quality; the engine picks and executes
  the character's action, `execution.actor` is `engine`, and the feedback says no choice was committed
  in time. A single timeout carries no extra penalty; the story may remember repeated hesitation.
- **Resolving** plays the consequence at real speed until the outcome window has closed from recorded
  events; **feedback** is `FEEDBACK_MS` (3 s) of factual lines; **half time** is a 2.5 s beat.
  Training drills keep their own slow-motion and drawn execution (`DRILL_SLOW_SCALE`); official
  matches have no drawing, aiming, timing or power input of any kind.
- Real elapsed time per phase is measured by the runtime (`realMs`) and shown at full time;
  `npm run pace -- 3 all all` proves 12–18 moments and the 4–8 minute band for every role and player
  model (a quick answerer may finish under 4:00; no waiting is added to stretch a match).
- Direct-involvement pacing (`DIRECT_PACING`, `GK_DIRECT_PACING` in `src/tactics/recognition.ts`)
  takes outfield on-ball moments as they appear up to 18 with a 45 s gap, and gives the keeper its
  authentic distribution / claim / sweep / 1v1 / positioning decisions instead of fabricated touches.

### 3.2 One moment, three records (§10, §11, §13)

`TacticalMoment { id, entryId, role, playerId, cues, options[], difficulty, read }` plus one
`MomentRecord { moment, decision, execution, outcome }` (see `src/tactics/moments.ts`).
Selecting the answer is the whole moment. `decision.quality` is fixed at commit by scoring the
option set against the frozen field (`grading.rescoreAtCommit`); `execution.quality` comes from the
engine's own resolution of the command (ability, pressure, fatigue, difficulty — the sim's kick
error once the pass/shot event exists) and names its `actor` (`user`-selected or `engine`-selected);
`outcome` is read from the event stream in a short window after commit (`grading.resolveOutcome`).
A good read that the character fumbles lowers execution, never decision quality; a poor read that
comes off is still a poor read.

Lifecycle (`src/tactics/session.ts`): `observe` → `recognize` forms a moment from a live
eligible state and suspends the controlled player's AI (`engine.suspendDecisions`); the runtime
freezes; `commit(session, state, optionId)` re-instantiates the intent (`intents.instantiateIntent`),
grades, and issues one command; `timeout` lets the engine choose and is recorded as `timeout`; an
intent the frozen state cannot produce is recorded as `intent_unavailable`. Pacing
(`recognition.allowance`) keeps the completed match inside 12–18 direct involvements and
`coverage.coverageReport` lists shortfalls. `src/match/intelligence.ts` turns the records into the
post-match soccer-intelligence report (overall decision grade, six recognition categories with
strongest/weakest, good reads that failed in execution, poor reads with favourable outcomes, and one
Coach Code teaching point).

### 3.3 Catalog as content (§16)

Situations live in `content/catalog/*.json`, validated against a schema at test time. The
engine reads triggers (`{ all, any }` conditions over `features.FieldRead`) and option
templates; it does not hard-code situations. Each entry has
`review.status: "provisional" | "reviewed" | "approved"`; the UI shows a small "provisional"
marker while any provisional content is active. The first milestone ships a small provisional
set only, authored in `tools/authorCatalog.ts` (`npm run catalog:build`) and validated by
`catalog.validateCatalog` at test time, including each entry's own positive/negative states.

### 3.4 Story consequences (§20)

Every consequential choice is data: `{ id, eligibility, immediate[], delayed[], repair[], expires }`.
Effects are applied through one reducer with an idempotency key `(choiceId, saveRevision)`.
Dialogue text — authored or AI — never carries effects; it only references approved facts.

The U11 arc (`src/story/arc.ts`) is planned, not scripted: each milestone scene declares the
evidence it needs (`season_phase`, `league_matches_played`, `result_streak`, `fall_position`,
facts earlier scenes set) and the planner queues the first eligible one on its weekday, one per
week. Story therefore reacts to what the simulation produced and can never decide a result, a
grade or a roster position. Optional scenes are offered from the hub at a location (lunch spot,
car, park) and repeat after a cooldown; consequential choices carry `delayed` effects with an
`unless` premise and `repair` options with a `withinDays` window, all applied by the reducer.

Progression (`src/story/progression.ts`) reads `content/rules/progression-u11.json`: seven tracks
moved by verified activity, and unlock rules that grant a conversation, an activity, support or an
opportunity when named track or relationship thresholds hold. Relationships never move tracks;
tracks never move relationships. The hub renders every rule with its requirements and the
player's current values, so nothing is implied only through dialogue.

### 3.5 Result ingestion (§17)

`MatchReport` carries `eventId`. `calendar.ingestResult` rejects unknown fixtures, role
mismatches and previously-seen `eventId`s, and separates league from tournament records.
Qualification is computed from the standings snapshot at the registration cutoff date, stored
with the decision.

## 4. Milestone breakdown (first playable, spec §23)

Each item is one PR unless noted. Order chosen so every PR is runnable and tested.

| # | PR | Contents | Acceptance checks touched |
|---|---|---|---|
| 1 | Spec + plan + scaffold | this document, spec, OPEN_QUESTIONS, Vite/TS/Vitest scaffold, CI | 1 |
| 2 | Sim core | field, rules profile, 18-player state, seeded RNG, movement, ball, possession, pressure/space, first touch, pass/carry/shoot/intercept, GK, restarts, offside, fatigue; headless full match | 4, 8 |
| 3 | Tactics | catalog schema + provisional set, triggers with negative tests, role-aware option generation, decision/execution/outcome records, coverage + difficulty report tool | 6, 7, 9, 10 |
| 4 | Match runtime + render + gesture | canvas renderer, camera, time scale, moment director, decision windows, drawing preview/commit/cancel, tap alternative, match screen, timeline | 2, 4, 5, 6, 8, 17, 18 |
| 5 | Campaign data model + saves | identities, roster, calendar slots, leagues/tournaments, eligibility, consequences queue, versioned save/load | 3, 11, 12, 13, 14 |
| 6 | Story: creation → opening | start screen, campaign select, player creation, position select, after-school kick-about, invitation, parent talk, Thursday visit, Coach Code intro activity, join talk | 3, 16 |
| 7 | Week one | hub, calendar, school scenes, 3 trainings (1v1, 2v2, 3v2), home assignment flow, optional friend activity, league match launch, postgame from `MatchReport`, calendar preview of tournament paths | 11, 15 |
| 8 | Acceptance + polish | acceptance test suite for §24, mobile performance measurement, PWA shell, visual review pass | 10, 15, 17, 18 |

Beyond the first playable (spec §17, §5):

| # | PR | Contents | Acceptance checks touched |
|---|---|---|---|
| 9 | U11 season + tournament weekends | home-and-away fall/spring leagues with reserve dates, deterministic off-screen results, missed-match consequences, cutoff-window registration, three-game Sat/Sun tournament weekends with guest clubs, league-clash rescheduling, family attendance choice and hotel/common-area scenes, tournament results kept out of league tables, season phases and season-end review, hub season/fixture/tournament cards, "let the days pass", save v3, `npm run smoke:season` | 11, 12, 13, 14 |
| 10 | U11 story arc + explicit progression | `content/story/arc-u11.json`: the season's central question, twelve milestone scenes the arc planner queues (at most one a week) from evidence the world already holds (league matches played, result streak, season phase, fall finish, the striker's rumour), optional lunch / family-car / park scenes offered from the hub with cooldowns, boys'/girls' authored differences via cast-role aliases; `content/rules/progression-u11.json`: track sources and unlock rules with grants and thresholds, `unlockViews` for the hub's progress card, `unlock.*` announcement scenes; park first-touch sessions as a friend-led verified activity; repairs offered from the hub within their window; `npm run story:tones` | 3, 11, 16 |
| 11 | Season-end tryouts + first transfer | `content/rules/tryouts-u11.json`: the authored mid-May tryout Saturday, the five non-guest destination clubs plus the home club, each with an explicit U12 roster capacity and reserved returning places, evidence-gated invitations (`invitesWhen`) and offers (`requires`), recruiter promises with stated semantics (`offer` = an offer delivers it, `next_season` = it stays open); `src/campaign/tryouts.ts`: invitations issued when the pathway unlock is reached, tryout week planned after the season review (next-season rosters, cancelled trainings, two optional sessions on the day), playable 1v1/2v2/3v2 sessions as the only source of session evidence, deterministic offers the day after, `acceptOffer`/`declineOffer`/`expireOffers` through roster mechanics (`joinRoster` refuses a full roster), the friend's placement, broken promises through the reducer; hub Tryouts card (club, attraction, places/capacity, every requirement with value, invitation, session, promise, offer, deadline, accept/decline, chosen club, friend together/apart); `content/story/tryouts-u11.json` shared + boys/girls scenes; save v4; `npm run smoke:season` runs through the transfer | 3, 11, 12, 13 |
| 12 | Small-sided activities + hobbies | `src/training/smallSided.ts`: two more programme activities — a 4v2 rondo (support / pressure / timing: pass to the free player, switch through the middle when the gap is there, hold and reset under pressure) and a 2v2 transition drill (transition / space: the ball has just been won — go forward if the space is open, secure it if not) — same decision / execution / outcome records, cues and rondo rendering in the small-sided screen, five-activity weekly rotation; `src/training/juggling.ts` + `src/ui/jugglingScreen.ts`: a deterministic tap-timing juggling minigame (seeded flight times, perfect / good / loose / drop bands, drift that narrows the window until a clean touch settles it, three runs, the best run counts, accessible wider window), a solo once-a-day free-slot activity whose touches are verified evidence with a personal best, session count and 10 / 25 / 50 moments; `content/rules/hobbies-u11.json` + `src/campaign/hobbies.ts`: four optional hobbies (drawing, reading, guitar, games) picked in-game from a free afternoon or evening, once a day, each with a fatigue effect, a wellbeing effect, every-n side effects (reading helps school, late gaming costs it) and 3rd / 7th-session moments, switchable with the current hobby's count restarting; `content/story/hobbies-u11.json` shared scenes; hub Life card (fatigue, juggling record and next milestone, hobby and next moment, switch); all state in existing story facts so saves stay v4 | 11, 15, 16 |
| 13 | Stabilization: match pace, loading/freeze recovery, visual pass | `src/match/pace.ts` pace director (7-minute real-time budget, adaptive fast-forward up to ×32, 0.3 slow-motion windows, live aftermath, half-time beat), `RuntimeClock.realElapsedMs`, `src/match/commentary.ts` deterministic routine commentary, match HUD speed/phase badge + real clock + full-time real-time summary, `tools/paceBench.ts` / `npm run pace` and `tests/match/pace.test.ts`; `src/app/recovery.ts` global error screen (back to start keeps the save; reload drops the offline cache), `index.html` boot watchdog with retry, service worker caches only successful shells, `tests/story/links.test.ts` (every `next` / choice `next` / `queue_scene` link resolves — found and authored the two missing `u11.trial_review` / `u11.school_check_in` follow-ups), airborne ball shadow negative-radius fix; `src/render/figures.ts` shared procedural art (lit turf, side-view sunset scenes, kit-coloured figures with shadows, lit ball with trails, standing figures for juggling/crossbar), navy-and-cyan glass theme, screen transitions, HUD overflow fixes — all under the `npm run perf` budget | 9, 21, 24 |
| 14 | Goalkeeper moment calibration | position-specific keeper situations and intents, per-role pace proof (see OPEN_QUESTIONS #10) | 9, 10 |
| 15 | Graphics baseline | full-viewport responsive stage, original directional sprites with fallback, sub-tick interpolation, environment/ball depth, golden-moment shell, appearance portraits, paint-op budget (`docs/ASSETS.md`, `docs/VISUAL_REVIEW.md`) | 17, 18, 21 |
| 16 | Story Engine v2 — Phase 1 | `docs/STORY_ENGINE.md`. Shared minigame contract and lifecycle (`src/minigame/contract.ts`, `machine.ts`, `registry.ts`: start / active / paused / resolved / abandoned, success / partial / failure / timeout / voluntary exit, JSON snapshot/restore, input-log replay); World Cup Knockout (`worldCupKnockout.ts`: call, first touch away from pressure, finish away from the blocker, strikes, other players' turns, five variants); Group Presentation (`groupPresentation.ts` + `content/school/presentations-u11.json`: assign / order / rehearse / deliver / feedback, accuracy · clarity · teamwork graded separately, partner rescue vs takeover); story ledger (`src/story/ledger.ts`) with `minigame_engine` and `soccer_engine` entries; relationship memory (`src/story/memory.ts`: trust / respect / loyalty / jealousy / dependence / competitive tension, remembered events with observer, belief, decay); scene `minigame` launch specs with five continuations (`src/story/episode.ts`, `episodes.ts`); Coach Code's `scan_before_receive` lesson read from the match report (`src/story/lesson.ts`); Episode One (`content/story/episode1-u11.json`, both campaigns) with the rival classmate, teacher and five classmates in `cast.json`; shared minigame screen (touch / keyboard / gamepad, pause, checkpoint save, a11y overlay) + WCK canvas view + presentation DOM view; save v5 | 3, 11, 16 |

## 5. Verification approach

- Unit tests per module; property-style tests for simulation invariants (18 players, ball on
  field or in a restart state, no teleporting: per-tick displacement ≤ speed × dt).
- Seeded headless matches as fixtures; a coverage tool that reports moments per role, on/off-ball
  mix and difficulty spread against the moment target (12–18 direct-involvement moments, §3.0),
  recording shortfalls instead of fabricating moments.
- Answer-set integrity (spec §16): `tests/tactics/answerSet.test.ts` replays seeded matches for
  all nine roles and fails on any displayed answer that does not instantiate in its state, on any
  engine-best on-ball option missing from the answers without a `DOCUMENTED_EXCLUSIONS` entry, on
  a `switch_play` answer without a matching engine switch route, and on a `narrow_inside` answer
  without the second-9 read being on.
- Acceptance checks §24 each map to a named test or a documented manual procedure in
  `tests/acceptance/`.
- Soccer plausibility of provisional content is explicitly flagged for coaching review; tests do
  not claim it.
