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

### 3.1 Match time and moving slow motion (§9, §12)

- The simulation advances in fixed ticks (`dt = 50 ms` simulated). Presentation runs at a
  time scale: `1.0` normal, up to `4.0` for routine passages (accelerated but every event is
  still surfaced in the timeline), and `0.12` inside a tactical moment.
- Inside a moment the same tick function runs at the slow scale: defenders step, teammates
  move, the ball travels. There is no frozen snapshot with decorative animation.
- **Decision window**: opens when the moment triggers, expires after `W` simulated seconds
  (proposal: 2.5 s simulated ≈ 20 s real at 0.12; harder reads get shorter windows). Expiry
  applies the role's "continue" default (keep shape / carry safely / hold) and is recorded as a
  `timed_out` decision, graded against the alternatives at the moment of expiry.
- **Commit**: the chosen option plus the gesture intent are evaluated against the state at
  release time, not trigger time. If the intended action has become unavailable (receiver
  marked out, lane closed, ball already lost), the runtime resolves the nearest supported
  action, records `intent_unavailable`, and grades decision quality against what was available
  when the moment opened — the player is not penalised for the world moving.
- **Cancel**: dragging back onto the origin marker or a two-finger tap cancels a preview; the
  window keeps running.
- **Accessible alternative**: tap an option, then tap a target (teammate / space / goal zone);
  the window is extended by a fixed factor (proposal ×1.5) when this mode is on. Time pressure
  still exists.

### 3.2 One moment, three records (§10, §11, §13)

`TacticalMoment { id, entryId, role, playerId, cues, options[], difficulty, read }` plus one
`MomentRecord { moment, decision, execution, outcome }` (see `src/tactics/moments.ts`).
Choice and drawing are one moment. `decision.quality` is fixed at commit by re-scoring the
option set against the *current* field (`grading.rescoreAtCommit`); `execution.quality` comes
from gesture accuracy, pressure and fatigue, replaced by the sim's own kick error once the
pass/shot event exists; `outcome` is read from the event stream in a short window after commit
(`grading.resolveOutcome`). A shaky line can lower execution, never decision quality.

Lifecycle (`src/tactics/session.ts`): `observe` → `recognize` forms a moment from a live
eligible state and suspends the controlled player's AI (`engine.suspendDecisions`); the user
chooses (and draws) while the sim keeps moving; `commit` re-instantiates the intent
(`intents.instantiateIntent`), grades, and issues one command with the gesture accuracy;
`timeout` applies a role default and is recorded as `timeout`; an intent the field has taken
away is recorded as `intent_unavailable`. Pacing (`recognition.allowance`) spreads moments over
the match — on-ball ones are taken whenever they appear, up to the band; off-ball/defending/
transition ones are metered — and `coverage.coverageReport` lists shortfalls.

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

## 5. Verification approach

- Unit tests per module; property-style tests for simulation invariants (18 players, ball on
  field or in a restart state, no teleporting: per-tick displacement ≤ speed × dt).
- Seeded headless matches as fixtures; a coverage tool that reports moments per role, on/off-ball
  mix and difficulty spread against the 18–25 / 10–14 targets, recording shortfalls instead of
  fabricating moments.
- Acceptance checks §24 each map to a named test or a documented manual procedure in
  `tests/acceptance/`.
- Soccer plausibility of provisional content is explicitly flagged for coaching review; tests do
  not claim it.
