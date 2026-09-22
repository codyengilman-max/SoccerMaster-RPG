# Match-System Audit: from continuous control to answer-only on-ball moments

Status: **audit only — no implementation performed.** This document maps the existing match
architecture, names the exact soccer-logic sources, records every continuous-control and
manual-execution assumption, proposes the corrected flow, contracts, file plan, risks and tests,
and lists the decisions the owner must approve before any code changes.

All facts below were read from the repository at the SHA in §0 or measured with a throwaway
headless harness kept outside the repository (`~/audit/sampleMoments.ts`, seed 11, Node 20).
Nothing in the previous SoccerMaster repository was consulted.

---

## 0. Repository status at audit time

| Item | Value |
| --- | --- |
| Current branch | `devin/1790020840-story-engine-p1` |
| Current HEAD | `3f74891d3cf376737130e73598d5c74313cbebfd` |
| Uncommitted changes | none (`git status --short` empty) |
| Active PR on this branch | #17 Story Engine v2 Phase 1 — open, CI green at `3f74891` |
| Graphics overhaul | **complete and awaiting review**: PR #16, head `f08a736e7c828d81401a430e5badbe04081430ec`, open, CI green; nothing on it is in progress |
| Stabilization baseline | `1f3f240d47f99c98ac7849a534fc34af7a5d25cb` (PR #15 head) — ancestor of `f08a736` and `3f74891` |
| `integration/pr1-11` | `3f74891` (= PRs #1–#13, #15, #16, #17) |
| Base for the corrected match-system branch | **`3f74891d3cf376737130e73598d5c74313cbebfd`** — the newest head that already contains the graphics work and the story-engine match hooks (`activeLessonCue`, `completeMatch`, ledger). Branching from `f08a736` would force a later merge with #17's `main.ts`/`campaign/match.ts` changes; branching from `main` is excluded (scaffold only). |

Stacking convention (owner instruction): the corrected match PR would be stacked on
`devin/1790020840-story-engine-p1`, not on `integration/pr1-11`.

---

## 1. Existing match architecture map

```
                 ┌──────────────────────── presentation ────────────────────────┐
                 │ src/ui/matchScreen.ts   src/render/{pitch,figures,sprites,    │
                 │ (HUD, options, pointer)  camera,environment,presentation}.ts  │
                 │ src/match/commentary.ts                                       │
                 └───────────────▲──────────────────────────▲───────────────────┘
                                 │ frame()/select()/gesture │ read-only state
┌────────────── real-time runtime ───────────────┐          │
│ src/match/runtime.ts  (frame loop, windows,    │──────────┘
│   pause, fast, timeout, gesture → commit)      │
│ src/match/pace.ts     (routine/window/aftermath│
│   /halftime scales, 6–8 min budget)            │
│ src/match/clock.ts    (real ms → whole ticks)  │
└───────────────▲────────────────────────────────┘
                │ observe()/commit()/timeout()/abandon()
┌────────────── tactical layer ──────────────────┐
│ src/tactics/session.ts   (suspend AI → wait → commit → grade → outcome)
│ src/tactics/recognition.ts (catalog trigger + pacing allowance + option build)
│ src/tactics/features.ts  (readField → FieldRead)
│ src/tactics/intents.ts   (Intent → concrete PlayerCommand + feasibility)
│ src/tactics/grading.ts   (decision / execution / outcome records)
│ src/tactics/moments.ts   (types), catalog.ts (loader), coverage.ts
│ content/catalog/provisional-u11.json (63 entries, all "provisional")
└───────────────▲────────────────────────────────┘
                │ tick()/issueCommand()/suspendDecisions()/resumeDecisions()
┌────────────── deterministic simulation ────────┐
│ src/sim/engine.ts   (createMatch, tick, restarts, offside, goals, full time, events)
│ src/sim/ai.ts       (evaluateOnBall/decideOnBall/decideOffBall — the AI "brain")
│ src/sim/actions.ts  (kick, firstTouch, saveChance — execution physics + error model)
│ src/sim/perception.ts (pressureAt, spaceAt, laneReport, arrivalTime, shotWindow…)
│ src/sim/formation.ts (BASE_1323 9v9, shapePoint), rules.ts, squad.ts, rng.ts, types.ts
└────────────────────────────────────────────────┘
                │ events / records
┌────────────── campaign boundary ───────────────┐
│ src/match/report.ts      (MatchReport from records + events only)
│ src/campaign/match.ts    (campaignMatchConfig, reportFromRuntime, completeMatch)
│ src/main.ts              (creates runtime, mounts screen, `pending.kind === "match"`)
│ src/save/save.ts, src/app/session.ts, src/app/recovery.ts
└────────────────────────────────────────────────┘
```

---

## 2. Exact soccer-logic source files

| Requested item | Where it lives today | Notes |
| --- | --- | --- |
| SoccerMaster soccer-logic contract | `spec/SOCCERMASTER_RPG_STANDALONE_V1_1.md` §9–§16, §21–§24; `docs/IMPLEMENTATION_PLAN.md`; `content/catalog/provisional-u11.json` (`cues`, `actions[].consequences`, `commonErrors`) | There is **no single "contract" module**. The methodology is spread across spec prose, catalog coefficients and code comments (see §3 contradictions). |
| 9v9 formation and position responsibilities | `src/sim/formation.ts` (`BASE_1323`, `shapePoint`), `src/sim/rules.ts` + `content/rules/u11-9v9.json`, `src/sim/squad.ts`, `src/sim/types.ts` (`RoleNumber`, `RoleId`) | Role responsibilities beyond shape live in the catalog triggers (`byRole`) and in `decideOffBall`. |
| Movement libraries | `src/sim/ai.ts` (`decideOffBall`, run/support/press/cover targets), `src/sim/formation.ts` (`shapePoint` compress/expand), `src/tactics/intents.ts` (`run_behind`, `overlap`, `support_underneath`, `hold_width`, `press`, `delay`, `drop`, `cover`, `track_runner`, `screen_lane`) | Movement is target-point based; no animation library. |
| Pass / carry / first-touch / shooting options | `src/sim/ai.ts` `evaluateOnBall()` (pass, switch, carry, shoot, hold candidates) and `src/tactics/intents.ts` `instantiateIntent()` (through_gap, recycle, switch_play, attack_space, draw_defender, shoot, hold_ball, first_touch_forward/safe, keeper_distribute_short/long) | `evaluateOnBall` is the AI's option generator; `instantiateIntent` is the player-facing option generator. Both call the same perception primitives. |
| HGA / Decision Utility calculations | **No symbol named HGA or Decision Utility exists.** Closest equivalents: `readField()` (`src/tactics/features.ts`) → `FieldRead`; `scoreAction()` (`src/tactics/recognition.ts`: `base + 0.8·feasibility + Σ conditional adds`); option scores in `evaluateOnBall()`; `feasibility` from `instantiateIntent()`; `difficultyOf()` (clarity/pressure/alternatives). | Reported as a gap rather than filled from outside sources. |
| Pressure calculation | `src/sim/perception.ts` `pressureAt(pos, opps)` (sum of inverse-distance terms), surfaced as `FieldRead.pressure`, `carrierPressure`, `pressureAtEnd` in carry options | |
| Pitch control | `src/sim/perception.ts` `spaceAt()`, `arrivalTime()`, `laneReport()` (lane margin in seconds), `interceptPoint()`; `FieldRead.spaceAhead/spaceNear/spaceFar/spaceBehindLine/openLanes/progressiveLanes` | No Voronoi/pitch-control grid; arrival-time margins are the control model. |
| Decision grading | `src/tactics/grading.ts` `gradeDecision()` → `DecisionRecord` (chosen vs best score, band, explanation) | Grades against the option scores frozen in the moment. |
| Execution resolution | `src/sim/actions.ts` `kick()` (error = f(skill, pressure, fatigue, distance, **intentAccuracy**)), `firstTouch()`, `saveChance()`; `src/sim/engine.ts` `executeOnBall()`; `src/tactics/grading.ts` `gradeExecution()` (+ `kickAfter()`) | `intentAccuracy` and `committed.accuracy` are the manual-execution hooks. |
| Outcome continuity | `src/tactics/grading.ts` `resolveOutcome()` reads the **event ledger** in a window (default 80 ticks = 4 s) after the commit; `src/tactics/session.ts` `observe()` settles open outcomes each tick; `src/match/report.ts` builds the report only from records + events | Nothing outside the engine writes match facts. |
| Position locking | `MatchConfig.controlled` → `MatchState.controlled: { side, playerId }` (`src/sim/types.ts`); set by `src/campaign/match.ts` `campaignMatchConfig()` (`PLAYER_ID`) and by the quick-match role picker in `src/main.ts`; consumed by `recognize()` | The lock is a data field; nothing can change it mid-match today. |
| Match event ledger | `MatchState.events: MatchEvent[]` (`src/sim/types.ts`), ids `${matchId}:${tick}:${eventSeq}` from `src/sim/engine.ts` `emit()`; runtime `eventCursor` slices new events per frame | 16 event types; no "moment" event type yet. |
| Score and clock simulation | `src/sim/engine.ts` `tick()` (50 ms fixed, `Clock.tick/timeMs/half/halfTimeS`, `score`, half-time and full-time transitions, `restartTimer`); real-time mapping in `src/match/clock.ts` and `src/match/pace.ts` | Simulated clock is exact by construction; only the real-time mapping is variable. |
| Existing match UI | `src/ui/matchScreen.ts` (HUD, options list, Fast/Pause/Tap-targets toggles, gesture hints, pointer adapter, commentary, full-time card); `src/render/*` (pitch, sprites, camera, environment, presentation adapter); `src/gesture/{gesture,pointer}.ts` | |
| Pause / resume | `MatchRuntime.paused` + `setPaused()` in `src/match/runtime.ts`; Space key + Pause toggle in `matchScreen.ts`; `visibilitychange` resets the frame delta | Pause freezes the frame loop only; sim state is untouched. |
| Save | **No mid-match save exists.** `CampaignState.pending = { kind: "match", fixtureId }` (`src/campaign/*`, `src/save/save.ts`) records only that a match is due; on reload `src/main.ts` `case "match"` rebuilds the runtime from `campaignMatchConfig()` and the match restarts from kick-off with the same seed. Earlier answers are lost. | Minigames have checkpoint saves (`src/minigame/*`); matches do not. |

---

## 3. Source contradictions (reported, not resolved)

1. **Moment count and interaction model.** `spec/SOCCERMASTER_RPG_STANDALONE_V1_1.md` §9 says "18–25 meaningful tactical decision moments … the match remains continuous … players continue moving slowly … the user draws the intended execution." `DEFAULT_PACING.total = [18, 25]`, `onBall = [10, 14]` in `src/tactics/recognition.ts` implements that. The owner's new definition is **12–18 playable on-ball moments, answer-only**. The spec (§9–§14, §21, §24 checks) must be revised in the implementation PR; this audit does not edit it.
2. **Execution grading input.** Spec §13 and `gradeExecution()` allow pointer precision (`committed.accuracy`) to influence execution; `kick()` mixes `intentAccuracy` into the error model. The new definition forbids any manual execution input.
3. **Methodology item 3 (spare player on the far side) vs the catalog.** `evaluateOnBall()` computes a switch candidate (`bestSwitchScore` was 2.11 for CM at 55'03 and 1.44–1.48 for ST at 0'00/35'18 in seed 11), but `CM_TRANS_01`, `ST_ON_01`, `ST_ON_02`, `ST_TRANS_01`, `RW_ON_01`, `LW_ON_01` do not offer `switch_play`, so the engine's best idea can be **absent from the answer list**. In the CM 55'03 state the offered "Play through the gap" resolved to a pass to the **goalkeeper** (progress 0.08), i.e. the label and the concrete pass disagree.
4. **Methodology item 4 (opposite winger narrows / second 9) is not modelled anywhere.** No intent, catalog action, `decideOffBall` branch or `FieldRead` feature encodes it. `hold_width` is the only far-winger behaviour. This is a content/engine gap, not a contradiction to pick a side on.
5. **First-touch vs decision are separate moments.** `*_RECV_01` entries fire on `receiving === 1` with exactly two options (forward/safe touch); the pass/carry/shoot decision is a different entry that fires on `hasBall === 1` one or two seconds later. The new flow ("receives or makes first contact → freeze → one question") presumes a single moment. Empirically the receive entry consumes the on-ball allowance and the real decision is then rejected as `too_soon` (see §14) — for LB, LW and RW the on-ball moments are 11–14 of 14 first-touch questions.
6. **Pace budget.** PR #13 fixed a 6–8 real-minute match (`targetRealMs: 7 * 60_000`, `withinBand`) with slow-motion windows of 2–3 simulated seconds. A fixed real 15 s answer timer × 12–18 moments alone is 3–4.5 real minutes before lead-ins and consequences; the 6–8 minute band may or may not survive (owner question §15 Q17).
7. **Kick-off moment.** `recognize()` accepts a moment at 0'00 for the kick-off taker (ST seed 11: `ST_ON_02` at 0'00 with the ball at the centre spot). Whether a kick-off touch is a "meaningful on-ball moment" is an owner call (Q14).

---

## 4. Current player-facing match flow

1. `src/main.ts` creates `createRuntime(cfg, catalog, { pacing })` with `cfg.controlled` locked to the player's role and mounts `matchScreen`.
2. Every animation frame `frame(runtime, dt)` asks `paceScale()` for a speed (routine ×3–×32, window ×0.3, aftermath ×1, half-time), converts real ms to whole 50 ms ticks (`advanceClock`), and per tick: `checkWindow()` (timeout / play stopped) → `observe(session)` (recognise) → `tick(state)`.
3. When `recognize()` returns a moment, `session.ts` calls `suspendDecisions(state, playerId)`; the engine keeps the selected player **carrying toward their current target** while `state.awaiting === playerId` (`engine.ts`: "keep carrying toward the current target while the decision is pending"). The clock keeps running at ×0.3; the window is 2.0–3.0 simulated seconds (`WINDOW_SECONDS`), ×1.5 in accessible mode.
4. The screen lists 2–5 options. Number keys or taps `select()`. Non-drawn intents commit immediately. Drawn intents (`TacticalOption.drawn`) move to stage `drawing`; the user draws a stroke on the canvas (`attachPointer` → `previewGesture`/`releaseGesture`) or, with "Tap targets" on, stage `targeting` and taps a point (`tapTarget`). `gestureAccuracy()`/`tapAccuracy()` yield 0..1 which becomes `commit(…, accuracy)` → `issueCommand(…, accuracy)` → `kick(…, intentAccuracy)`.
5. If the window expires, `timeout()` issues the deterministic AI choice (`continuationDefault`: `decideOnBall` if on the ball, else `hold_position`) with accuracy 1. If play stops, `abandon()`.
6. `close()` sets `NORMAL_SCALE` and `beginAftermath()` (real-speed consequence), `resolveOutcome()` settles from the event ledger within 80 ticks, records go to `session.records`.
7. Off-ball / defending / transition moments (metered by `allowance()`) interrupt in the same way and issue `move`/`hold`/`press`/`screen` commands.
8. Fast Play (F) forces ×3+ outside windows; Pause (Space) freezes the frame loop; Escape cancels drawing; the full-time card shows score, real time and the moment summary; `reportFromRuntime()` → `completeMatch()`.
9. Reload during a match restarts it from kick-off (no runtime save).

---

## 5. Systems that assume continuous control

| # | Assumption | Location |
| --- | --- | --- |
| C1 | The match is always rendered and always ticking in real time (slow/normal/fast); "skipping" does not exist, only ×32 acceleration capped at `MAX_TICKS_PER_FRAME = 24` per frame | `src/match/pace.ts`, `src/match/clock.ts`, `frame()` in `runtime.ts` |
| C2 | Off-ball, defending and transition moments interrupt the player (`allowance().other`, categories `off_ball`/`defending`/`transition`, ~11 of 25 moments) | `recognition.ts`, catalog entries `*_OFF_*`, `*_DEF_*`, `GK_POS_*`, `GK_LINE_01`, `GK_CROSS_01`, `GK_1V1_01`, `GK_SHOT_01`, `GK_SWEEP_01`, `GK_TRANS_02`, `RB/LB/DM_TRANS_01` |
| C3 | The window is measured in **simulated** ticks while the sim runs at ×0.3, so players keep moving during the decision | `WINDOW_SECONDS`, `open()`/`checkWindow()`, `SLOW_SCALE` |
| C4 | A suspended player keeps carrying/moving during the decision (`awaiting` branch in `tick()`), and the decision timer can expire because opponents arrive | `src/sim/engine.ts` ~L283–290 |
| C5 | Moments can be lost to `play_stopped` (ball goes dead while the user is deciding) | `checkWindow()` → `abandon()` |
| C6 | Total moment cap 18–25 and the on-ball allowance are spread across the whole 60 minutes (`onBallCount <= onMid·frac + 2`) — on-ball moments are rationed, not "every meaningful involvement" | `allowance()` in `recognition.ts`, `pacingFor()` per role |
| C7 | Fast Play override and speed badge/trails presume the user watches routine play | `matchScreen.ts` fast toggle, `render/presentation.ts` trails, `commentary.ts` |
| C8 | Pace budget assumes ~25 windows × 8–10 real seconds plus aftermath | `targetRealMs`, `routineScaleFor()`, `tools/paceBench.ts`, `tests/match/pace.test.ts` |
| C9 | Quick-match role picker says "the role stays locked for the whole match" — correct, but the lock is only data, and the UI copy assumes a controlled player rather than a followed player | `src/main.ts` |
| C10 | Story lesson cue is shown as a HUD ribbon during continuous play (`opts.lesson`) | `matchScreen.ts`, `activeLessonCue` |

---

## 6. Systems that assume manual execution

| # | Assumption | Location |
| --- | --- | --- |
| M1 | `TacticalOption.drawn` and `anchor`; most on-ball intents are `drawn: true` in the catalog | `src/tactics/moments.ts`, `content/catalog/provisional-u11.json`, `intents.ts` |
| M2 | Runtime stages `reading → drawing → targeting`, `select()` returning `null` to wait for a gesture, `previewGesture()`, `releaseGesture()`, `tapTarget()`, `cancel()`, `cancelActive` | `src/match/runtime.ts` |
| M3 | Gesture parsing, cancel gesture, `gestureAccuracy()`, `tapAccuracy()`, canvas pointer adapter | `src/gesture/gesture.ts`, `src/gesture/pointer.ts` |
| M4 | `commit(session, state, optionId, accuracy)` and `CommittedIntent.accuracy` | `src/tactics/session.ts` |
| M5 | `issueCommand(state, id, cmd, accuracy)` / `QueuedCommand.accuracy` | `src/sim/engine.ts`, `src/sim/types.ts` |
| M6 | `kick(…, intentAccuracy)` adds `0.06·(1 − intentAccuracy)` to the error | `src/sim/actions.ts` |
| M7 | `gradeExecution()` uses `committed.accuracy` for non-kick actions and reports `intentAccuracy` | `src/tactics/grading.ts` |
| M8 | Accessible alternative ("Tap targets") and `ACCESSIBLE_WINDOW_FACTOR` exist only because of drawing | `runtime.ts`, `matchScreen.ts` |
| M9 | UI copy: "Draw from your player toward where it should go. Release to commit; drag back … to cancel."; Escape = cancel drawing | `matchScreen.ts` |
| M10 | Tests asserting drawing/targeting behaviour | `tests/gesture/gesture.test.ts`, `tests/match/runtime.test.ts` (drawn/tap paths), `tests/tactics/session.test.ts` (accuracy) |
| M11 | Spec §11 "Drawing execution", §12 moving slow motion, §13 execution may consider timing/precision, §24 acceptance checks referencing gestures | `spec/SOCCERMASTER_RPG_STANDALONE_V1_1.md` |

Everything else in the engine already executes automatically with accuracy 1 (the AI path), which is
why the correction is a boundary change rather than an engine rewrite.

---

## 7. Corrected proposed match flow

```
 background sim ──► detector: selected player will receive / has first contact
      │                         │
      │  (skip; clock advances  ▼
      │   tick-exactly)     LEAD-IN  (replay the last N ticks from a snapshot at ×0.5–×1,
      │                      camera on the ball; shows pass in flight, runs, pressure, space)
      │                         │
      │                         ▼
      │                    FIRST CONTACT tick reached  → engine puts ball under control (firstTouch)
      │                         │
      │                         ▼
      │                    FREEZE (or ×0.05 dramatic hold): question + 2–4 answers + 15 s REAL timer
      │                         │   (only input: pick one answer; keyboard 1–4, tap, gamepad)
      │                         ▼
      │                    GRADE decision (gradeDecision against frozen option scores)
      │                         │
      │                         ▼
      │                    AUTO-EXECUTE: issueCommand(cmd, accuracy = 1); resumeDecisions
      │                         │
      │                         ▼
      │                    CONSEQUENCE: run the sim at ×1 for the outcome window (≤4 s sim or until
      │                      the ball changes hands / goes dead / goal), gradeExecution from kick error,
      │                      resolveOutcome from events; short caption
      │                         │
      └─────────────────────────┘  return to background; next detection
```

Details:

* **Background simulation** runs `tick()` as fast as the frame budget allows (headless bursts of up
  to N ticks per frame, N sized from measured tick cost, no rendering except the clock/score HUD and
  optional one-line commentary for goals/big events). Match clock and score are exact because they
  are the sim's own fields.
* **Detection** happens *before* the receive: each tick, if the ball is a pass whose `passTarget`
  is the selected player (or a loose ball whose `interceptPoint` the selected player reaches first),
  the detector marks `armed` and records a **snapshot ring** of the last ~40 ticks (2 s) so the
  lead-in can be replayed. On the tick the engine emits `receive`/`interception`/`recovery` for the
  selected player, the runtime **suspends** (`suspendDecisions`) — the engine already keeps the
  player on the ball — and switches to `lead_in` using the ring, then `frozen`.
* **Pacing target 12–18 on-ball moments** is met by (a) removing the off-ball/defending share from
  the interruption budget, (b) merging receive + decision into one moment (options instantiated on
  the *controlled* state right after first contact, so pass/carry/shoot/switch are available), and
  (c) a **salience filter** rather than a time ration: skip involvements whose best and second-best
  option scores are within a clarity threshold *and* pressure < x (a trivial back-pass under no
  pressure is not a question), skip repeats of the same entry inside a repeat gap, keep a soft
  spacing so moments do not cluster in one 3-minute spell. Floors and ceilings become soft targets
  with an explicit "state did not offer enough" report (Q3, Q10).
* **First touch** becomes part of the automatic execution: the engine's `firstTouch()` already
  resolves control from ball speed, pressure, attributes and fatigue; the answer may still be a
  first-touch decision when that is the meaningful question (e.g. ST receiving with GK 2.6 m
  away), otherwise the touch is automatic and the question is the next action.
* **Timer** is 15 s **real** time (Q6), counted only while the tab is visible and the match is not
  paused; on expiry the engine's own choice runs (`continuationDefault` → `decideOnBall`), graded
  as `timeout` (Q7).
* **Consequence** is rendered at ×1 from the live sim (no separate cinematic model); the existing
  aftermath/commentary/trails present it.
* **Return** clears the moment, resumes AI, and the background burst continues. Half-time and
  full-time are ledger events that the runtime turns into short beats (Q13).

---

## 8. Retain / adapt / replace / deprecate

| Component | Verdict | Why |
| --- | --- | --- |
| `src/sim/*` (engine, ai, actions, perception, formation, rules, squad, rng, types) | **Retain** (tiny adaptation: drop `accuracy` plumbing or pin it to 1) | Deterministic, event-ordered, already AI-driven; nothing here knows about input. |
| `readField`, `instantiateIntent`, `scoreAction`, `gradeDecision`, `resolveOutcome`, `kickAfter`, catalog loader/coverage | **Retain** | This *is* the soccer-logic evaluator the questions are built from. |
| `recognize()` + `allowance()` + `DEFAULT_PACING` | **Adapt** | Selected-player on-ball only, receive+decision merge, salience filter, 12–18 target, remove `other` allowance for official matches. |
| `gradeExecution()` | **Adapt** | Quality from kick error / touch result / pressure / fatigue only; `intentAccuracy` removed or fixed at 1. |
| `session.ts` (`observe`, `commit`, `timeout`, `abandon`, `continuationDefault`) | **Adapt** | Drop the `accuracy` argument; `commit` always executes; add `armed → lead_in → frozen` transitions or move them to the runtime. |
| `runtime.ts` | **Replace the interaction core, retain the shell** | Keep `createRuntime`, `frame`, pause, `eventCursor`, records, real-time measurement; remove `drawing`/`targeting`, gesture functions, `WINDOW_SECONDS` in sim ticks; add background bursts, snapshot ring, real-time 15 s timer, moment phases. |
| `pace.ts` | **Adapt (renamed responsibilities)** | Keep `routine/aftermath/halftime` as *presentation* phases; `window` becomes `lead_in`/`frozen` with real-time durations; `routineScaleFor` becomes "how many ticks per frame while skipping"; `withinBand` target re-derived (Q17). |
| `clock.ts` | **Retain** | Real ms → ticks is still needed for lead-in and consequence. |
| `report.ts`, `campaign/match.ts` | **Retain with small adaptation** | Same records/events; add per-moment `answerLatencyMs` and `timeout` count if wanted. |
| `matchScreen.ts` | **Replace interaction, retain rendering/HUD/full-time** | Remove pointer adapter, gesture hints, Tap-targets, Fast Play (background is already fast); add question card, answer buttons, 15 s ring timer, lead-in caption, skip-progress indicator. |
| `render/*`, `commentary.ts` | **Retain (visual-only)** | Camera focus on the ball during lead-in and freeze can use `render/camera.ts`; trails may be kept for the consequence (Q18). |
| `gesture/gesture.ts`, `gesture/pointer.ts` | **Deprecate for official matches only — keep the modules** | They are shared: `attachPointer` is also imported by `drillScreen.ts`, `crossbarScreen.ts`, `smallSidedScreen.ts`; `gesture.ts` by `training/firstTouch.ts`, `crossbar.ts`, `smallSided.ts` and `render/pitch.ts` (type). Training activities are not official matches, so drawing stays legitimate there (Q19). |
| Drawn/tap paths in `tests/match/runtime.test.ts`, accuracy cases in `tests/tactics/session.test.ts` | **Replace** | Superseded behaviour; new tests in §13. |
| `tests/match/pace.test.ts`, `tools/paceBench.ts` | **Adapt** | Re-target to the approved budget; the 9-role proof stays. |
| Catalog `provisional-u11.json` | **Adapt content** | `drawn` flags become inert; on-ball entries need `switch_play`/`draw_defender` where the methodology demands, a second-9/narrow intent (new), and 3–4 answer minimums; GK on-ball entries currently offer only "Build short" vs "Hold" in 9 of 11 moments (§14). |
| `save.ts` pending match | **Adapt** | Add the moment-boundary runtime save (§9). |
| Spec §9–§14, §21, §24 | **Replace text** in the implementation PR after approval | |

---

## 9. Proposed state contracts (not implemented)

```ts
// src/match/moments.ts (new) — runtime-level phases; TacticalMoment keeps its shape minus drawn/anchor
export type MatchPhaseUI =
  | { kind: "background"; ticksPerFrame: number }              // skipping routine play
  | { kind: "lead_in"; moment: TacticalMoment; fromTick: number; toTick: number; scale: number }
  | { kind: "frozen"; moment: TacticalMoment; deadlineRealMs: number; selected: string | null }
  | { kind: "consequence"; moment: TacticalMoment; untilTick: number }
  | { kind: "halftime"; untilRealMs: number }
  | { kind: "finished" };

export interface OnBallDetector {
  armed: boolean;                 // a pass/loose ball is heading to the selected player
  armedTick: number | null;
  ring: MatchState[];             // last N structured clones for the lead-in (N = 40 ⇒ 2 s)
  lastMomentTick: number;
  lastByEntry: Record<string, number>;
  skipped: { tick: number; entryId: string; reason: "low_salience" | "repeat" | "spacing" | "cap" }[];
}

export interface MomentRuntime {           // replaces MatchRuntime.active
  moment: TacticalMoment;                  // options frozen at first contact; no `drawn`, no `anchor`
  question: string;                        // from entry.title / cues[0]
  answers: { optionId: string; label: string }[];   // 2–4, order seeded per moment (Q8)
  openedRealMs: number;
  deadlineRealMs: number;                  // openedRealMs + 15_000 (paused time excluded)
  answeredRealMs: number | null;
  selected: string | null;
  closeReason: "answered" | "timeout" | "play_stopped" | null;
}

export interface MatchRuntimeV2 {
  state: MatchState;                       // unchanged engine state (controlled = selected player)
  session: TacticalSession;                // records, pacing
  detector: OnBallDetector;
  phase: MatchPhaseUI;
  active: MomentRuntime | null;
  paused: boolean;
  realElapsedMs: number;                   // unchanged measurement
  eventCursor: number;
  target: { onBall: [12, 18] };            // approved range
}

// Save/reload at moment boundaries (only when phase.kind === "background" | "frozen")
export interface MatchCheckpoint {
  version: 1;
  matchId: string;
  configHash: string;                      // seed, rules, squads, controlled
  state: MatchState;                       // full engine state incl. rngState, eventSeq, events
  records: MomentRecord[];
  detector: Omit<OnBallDetector, "ring">;  // ring is rebuilt; lead-in cannot replay across reload
  active: MomentRuntime | null;            // if frozen: remaining real ms is stored, timer restarts from it
  realElapsedMs: number;
}
```

Determinism: the engine state is the only source of truth; `MomentRuntime.answers` order is derived
from `matchId + momentId` so replaying the same seed with the same answers reproduces the same
ledger. Position lock is `state.controlled`, unchanged for the whole match (Q1–Q2).

---

## 10. Proposed event contracts (not implemented)

Additions to the engine ledger are **not** required; the moment lifecycle is recorded in a separate
runtime ledger so the engine remains pure. If the owner prefers a single ledger, the same records can
be appended as `MatchEvent` variants with `tick` ordering preserved (they would be emitted from the
runtime between ticks, so ordering within a tick is `engine events → moment events`).

```ts
export type MomentEvent =
  | { id: string; tick: number; type: "moment_detected"; momentId: string; entryId: string; trigger: "pass_to_me" | "loose_ball" | "on_ball" }
  | { id: string; tick: number; type: "moment_skipped"; entryId: string; reason: "low_salience" | "repeat" | "spacing" | "cap" }
  | { id: string; tick: number; type: "lead_in";  momentId: string; fromTick: number }
  | { id: string; tick: number; type: "question"; momentId: string; answers: string[]; deadlineRealMs: number }
  | { id: string; tick: number; type: "answer";   momentId: string; optionId: string; latencyMs: number }
  | { id: string; tick: number; type: "timeout";  momentId: string; engineChoice: PlayerCommand["type"] }
  | { id: string; tick: number; type: "graded";   momentId: string; decision: DecisionRecord }
  | { id: string; tick: number; type: "executed"; momentId: string; command: PlayerCommand; engineEventId: string | null }
  | { id: string; tick: number; type: "outcome";  momentId: string; outcome: OutcomeRecord; execution: ExecutionRecord }
  | { id: string; tick: number; type: "skip_span"; fromTick: number; toTick: number; realMs: number }   // background burst
  | { id: string; tick: number; type: "checkpoint"; phase: "background" | "frozen" };
```

Ids follow the engine convention `${matchId}:${tick}:m${seq}`. `report.ts` continues to consume
`DecisionRecord`/`ExecutionRecord`/`OutcomeRecord`; story systems keep reading `MatchReport` only.

---

## 11. Proposed file-change plan

**Implementation changes (later, after approval)**

| File | Change |
| --- | --- |
| `src/match/runtime.ts` | Remove gesture imports, `MomentStage`, `previewGesture/releaseGesture/tapTarget/cancel`, `WINDOW_SECONDS`, `ACCESSIBLE_WINDOW_FACTOR`; add detector, phases, background bursts, real-time 15 s timer, `answer()` API, checkpoint export/import. |
| `src/tactics/session.ts` | `commit()` without `accuracy`; `observe()` split into `detect()` (armed) and `open()` (at first contact); keep `timeout/abandon/continuationDefault`. |
| `src/tactics/recognition.ts` | On-ball-only recogniser for official matches; salience filter; `PacingConfig` → `{ onBall: [12,18], minGapSeconds, repeatGapSeconds, clarityFloor }`; build options on the post-touch state. |
| `src/tactics/grading.ts` | `gradeExecution()` without `intentAccuracy`; keep `gradeDecision`, `resolveOutcome`. |
| `src/tactics/moments.ts` | Drop `drawn`, `anchor`, `CommittedIntent.accuracy`; add `question`. |
| `src/tactics/intents.ts` | Remove `drawn` flags; add `narrow_inside` (second-9) intent if approved (Q-methodology); ensure `switch_play`/`draw_defender` instantiate for all on-ball roles. |
| `src/sim/engine.ts` | `issueCommand(state, id, cmd)` — accuracy parameter removed (or pinned to 1); optional `snapshot()` helper. |
| `src/sim/actions.ts` | `kick()` without `intentAccuracy`. |
| `src/sim/types.ts` | `QueuedCommand` loses `accuracy`. |
| `src/ui/matchScreen.ts` | Remove pointer adapter, gesture hints, Tap-targets, Fast toggle; add question card, answer buttons (1–4 keys, tap, gamepad), 15 s ring, lead-in/consequence captions, skip indicator; keep HUD, canvas, commentary, full-time card, phone layout. |
| `src/match/pace.ts` | Re-purpose phases; remove `SLOW_SCALE` windows; new burst sizing; re-derive `withinBand`. |
| `src/match/clock.ts` | Unchanged API; possibly `MAX_TICKS_PER_FRAME` raised for bursts. |
| `src/match/report.ts` | Add `timeouts`, `answerLatency` summary (optional). |
| `src/campaign/match.ts` | Unchanged contract; `reportFromRuntime` reads the new runtime. |
| `src/save/save.ts`, `src/campaign/*` pending | `pending = { kind: "match", fixtureId, checkpoint?: MatchCheckpoint }` + migration to `SAVE_VERSION = 6` (currently 5). |
| `src/app/session.ts`, `src/app/recovery.ts` | Autosave at moment boundaries; recovery restores the checkpoint instead of restarting. |
| `src/main.ts` | Quick-match copy; pass checkpoint on resume. |
| `content/catalog/provisional-u11.json` | Answer sets per on-ball entry (3–4), `switch_play`/`draw_defender` coverage, GK on-ball variety, question text. |
| `spec/SOCCERMASTER_RPG_STANDALONE_V1_1.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/ACCEPTANCE.md`, `docs/PERFORMANCE.md` | Text updates. |
| Tests: `tests/match/runtime.test.ts`, `tests/match/pace.test.ts`, `tests/tactics/session.test.ts`, `tests/tactics/goalkeeper.test.ts`, `tests/acceptance/*` | Replace gesture/window cases; add §13 suites. `tests/gesture/gesture.test.ts` stays (module still used by training). |

**Presentation-only files (visual changes at most)**: `src/render/pitch.ts`, `figures.ts`,
`sprites.ts`, `camera.ts`, `environment.ts`, `presentation.ts`, `spriteLayout.ts`,
`src/match/commentary.ts`, `src/ui/theme.css`.

**Should remain unchanged**: `src/sim/ai.ts`, `perception.ts`, `formation.ts`, `rules.ts`,
`squad.ts`, `rng.ts`, `geometry.ts`, `src/tactics/features.ts`, `catalog.ts`, `coverage.ts`,
`src/minigame/*`, `src/story/*`, `src/training/*`, `src/calendar/*`, `src/roster/*`, `src/pwa/*`.

---

## 12. Regression risks

| Risk | Detail | Mitigation |
| --- | --- | --- |
| Determinism | Snapshot ring must be a pure copy; background bursts must not reorder ticks; answer order seeding must not touch `rngState` | Replay test: same seed + scripted answers ⇒ identical `events` and `score` |
| Score/clock continuity | Skipping is only faster ticking, so exact by construction; risk is the UI showing a stale clock during bursts | Assert HUD reads `state.clock` after each frame |
| Recognition frequency | Removing the `other` allowance and merging receive+decision changes counts; GK gets only ~12 on-ball involvements per match (seed 11) | Per-role harness over ≥20 seeds before fixing the range; owner Q3/Q4 |
| Position lock | Unchanged field; detector must never target another player | Test: every `moment_detected.playerId === controlled.playerId` |
| Event ordering | Runtime ledger interleaved with engine events by tick | Ledger validation test (monotonic ticks, unique ids) |
| Background speed | ×32 with 24 ticks/frame ≈ 1.2 s sim per frame; a 60-minute match with 15 moments needs ~3 000 frames of pure skipping ≈ 50 s at 60 fps — acceptable, but low-end phones may drop below 60 fps | Burst sizing by measured tick cost; `perfBench` extension |
| Save/reload at boundaries | New checkpoint size (~9 players × state + events) is small; lead-in ring not restorable | Reload test in `frozen` and `background` |
| Pause/resume | Real timer must exclude paused/hidden time | Timer test with `visibilitychange` |
| Existing pace tests | `withinBand` 6–8 min will fail until re-targeted | Owner Q17 first |
| Graphics renderer | Camera focus and freeze frames are new render calls; sprites/trails unaffected | Paint-op budget test already exists |
| Story/lesson integration | `activeLessonCue` HUD ribbon and `matchLessonFact` rely on moment records — record shape kept | Existing story tests |
| Minigame/match boundary | Untouched; proof test remains | Existing boundary test |
| 18–25 vs 12–18 | `pacingFor()` per role, acceptance docs, README and spec all say 18–25 | One PR changes all of them together |

---

## 13. Test plan (to be implemented with the change)

| Area | Tests |
| --- | --- |
| Engine regression | Existing `tests/sim/*`, `tests/tactics/catalog|goalkeeper`, `tests/perf/*` unchanged and green |
| Background simulation | Headless: `frame()` in background advances ≥ N ticks per frame; final `clock.timeMs === halves·halfLength·1000`; score equals `runHeadless()` for the same seed when no answers differ from AI choices |
| 12–18 playable moments | 9 roles × 20 seeds: on-ball moment count within range or an explicit `state_limited` report; zero off-ball interruptions |
| Exact clock progression | Sum of `skip_span` + lead-in + consequence ticks equals total ticks; no tick executed twice |
| Selected-player-only detection | Every moment's `playerId` equals `controlled.playerId`; no moment opens unless the selected player owns the ball or is the engine's pass target / first arriver |
| Multiple-choice-only input | Runtime API surface has no gesture/aim/timing entry points (type-level test + `grep` guard in CI) |
| No manual movement / execution | Player's `moveTarget`/commands only ever come from `issueCommand` with the chosen option's command; `QueuedCommand` has no accuracy |
| Decision grading | Chosen best ⇒ band `good`; chosen worst ⇒ `poor`; same state, same grades (pure) |
| Automatic execution | After `answer()`, the engine emits the corresponding `pass/carry/shot/first_touch` event within the consequence window |
| Outcome & score continuity | `resolveOutcome` non-null for ≥95 % of moments; score never changes outside engine `goal` events |
| Position lock | `controlled` identical at kick-off and full time; quick match and campaign |
| Seeded replay | Same seed + same answer script ⇒ byte-identical events and records |
| Pause/resume | Timer excludes paused time; no ticks while paused; resume continues the same phase |
| Save/reload | Checkpoint in `background` and `frozen`; reload reproduces the remaining match tick-for-tick given the same answers |
| Event ledger | Ids unique, ticks monotonic, `question → (answer|timeout) → graded → executed → outcome` order per moment |
| No moment | A whole match with zero involvements (forced via config) finishes and reports `state_limited` |
| Timeout | 15 s real elapses ⇒ `continuationDefault` command issued, record `timeout`, match continues |
| Half-time | `half_time` event ⇒ halftime beat, no moment across the break, second half detection resumes |
| Substitutions/rotations | Not supported by the engine today (no substitution event) — test documents the absence (Q11) |
| Stoppage | Ball dead during `frozen` ⇒ `play_stopped` close, no execution, clock continues |
| Final whistle | `full_time` closes any open moment; report built once |
| Desktop presentation | Question card, 4 answers, timer visible at 1280×800 and 1920×1080; keyboard 1–4 |
| Phone presentation | 390×844 and 360×780: answers ≥44 px targets, no HUD overlap, safe areas |
| Graphics & pacing non-regression | Existing paint-op budget, sprite fallback, viewport tests; new pace band test |

---

## 14. Feasibility measurements (seed 11, current engine, headless)

Harness: `createRuntime()` per role, 60 fps frames, random answer after a short delay, current
`pacingFor(role)`. "Involvements" = ledger `receive`/`interception`/`recovery` events for the
selected player; "controlled s" = simulated seconds the selected player owned the ball.

| Role | Final | Total moments | On-ball moments | Of which first-touch (`*_RECV_01`) | Involvements | Controlled s |
| --- | --- | --- | --- | --- | --- | --- |
| GK | 0–0 | 24 | 11 | 0 | 12 | 17 |
| CB | 0–2 | 25 | 14 | 0 (no CB receive entry) | 41 | 35 |
| LB | 1–2 | 25 | 14 | 13 | 100 | 94 |
| DM | 1–0 | 25 | 14 | 9 | 163 | 142 |
| CM | 0–1 | 25 | 14 | ~5 | 278 | 266 |
| RW | 0–3 | 25 | 14 | 14 | 148 | 194 |
| LW | 1–2 | 25 | 14 | 11 | 126 | 136 |
| ST | 1–2 | 25 | 14 | 2 | 39 | 48 |

Findings:

* Raw involvement supply supports 12–18 on-ball moments for every outfield role; **GK is the
  exception** (12 involvements, 11 already used) — a GK range of 12–18 needs either counting
  positional/defensive keeper decisions as "on-ball moments" or accepting a lower GK range (Q4).
* The current allowance (`onBallCount <= onMid·frac + 2`, `minGap 6 s`) lets the **receive**
  entry win the slot and then rejects the real decision as `too_soon`, which is why wide roles get
  almost only two-answer first-touch questions. This is the main recogniser change.
* `draw_defender` was offered 3 times and never best; `switch_play` offered twice, never best, and
  absent when the engine scored it highest (§3.3). Catalog coverage of methodology items 2–4 is thin.
* GK on-ball moments: 9 of 11 were "Build short" vs "Hold and shield" with the hold infeasible under
  pressure — not a real question. GK on-ball answer sets need `keeper_distribute_long`,
  `switch_play` and a short-vs-long trade-off in more states.

---

## 15. Twelve sample moments from actual seed-11 states

All twelve are real states reached by the current engine (positions in metres on the 70×45 U11
pitch, home team attacking +x). "Correct" is the current engine's highest-scoring option in that
state. Execution and outcome lines describe what the engine does automatically when that answer is
chosen; outcomes marked *projected* were not recorded in the harness run (the scripted picker chose
randomly) and are what `resolveOutcome()` would grade from the ledger.

**1. Receiving under pressure — ST, 20'03, 1–0 up (`ST_RECV_01`)**
Ball loose, pass from LW (#11) arriving; ST at (64.2, 25.2), 6 m from goal, shot window 28°.
Opponents: GK 2.6 m, CB 2.7 m, RB 9.6 m; pressure 0.96. Space ahead 0.28, near side 0.88.
Question: *The ball is arriving with the keeper and centre-back on you — what is your first touch?*
A) Set it with a safe touch away from the keeper (touch_safe, 1.49) **✔** B) Touch forward into
the box (touch_forward, −0.07: "a defender arrives as the ball does") C) Let it run across goal
(not offered today; candidate `hold_ball`). Decision: A is clearly best (clarity high, difficulty
medium 0.41). Execution: `firstTouch()` with ball speed, pressure 0.96, ST first-touch attribute;
result clean/loose. Outcome (projected): retained possession under pressure → follow-up shot moment
plausible next tick. Continuation: ST has the ball 6 m out with the keeper committed.

**2. Attacking space — ST, 15'35, 1–0 up (`ST_TRANS_01` "Won it high")**
ST has just won the ball at (56.4, 7.8) on the right touchline, 20 m from goal. LB 1.0 m, CM 4.0 m;
pressure 1.12. Space ahead 0.53, pressure at carry end 0.03. Shot window 7°, lane blocked.
Question: *You've won it high on the flank — what now?* A) Attack the space ahead (attack_space,
1.27) **✔** B) Shoot (shoot, −0.19, blocked) C) Play the ball inside (through_gap — not offered here;
gap). Execution: `carry` toward the space vector; engine drives the player, defenders react.
Outcome (projected): carry into the box → `carry` event, next state near the byline. Continuation:
ST on the ball 12–15 m out; another moment likely (shoot / cut back).

**3. Drawing a defender — LB, 52'56, 1–2 down (`LB_ON_01`)**
LB on the ball at (51.6, 39.5) in the attacking half, CB 3.8 m, DM 8.0 m; pressure 0.32; lanes 2
open / 0 progressive; LW ahead. Options: recycle to CM (1.50) **✔ current engine**, attack_space
(1.09), draw_defender "carry at the defender 4 m away to commit them" (0.84), through_gap to LW
(0.82). Question: *Nothing is on ahead and the centre-back is holding off — do you commit him or
keep it?* Honest note: the engine ranks recycle over drawing the defender here because the catalog gives
`draw_defender` a low base (0.35) plus +0.5 only when `teammateRunAhead == 1` (no runner here), and
`instantiateIntent` bases its feasibility on progress gained by the carry alone. Under methodology
item 2 the owner may want "draw then release to the far side" rewarded when `spaceFar` is high
(0.56 here) — flagged, not changed. Execution: carry at the defender then release; Outcome
(projected): `carry` + `pass` events; Continuation: LW receives with the CB committed.

**4. Finding the spare player on the far side — CB, 25'00, 0–1 down (`CB_BUILD_01`)**
CB at (11.0, 14.6) on the right of own box; ST 6.0 m, LW 6.6 m, CM 7.7 m; pressure 0.10. Lanes 3
open / 2 progressive; far-side space 0.27 vs near 0.13; `bestSwitchScore` 1.11.
Answers: A) Play through the gap to CM #8 (1.42, lane margin 0.16 s, feasibility 0.27) **✔ score**
B) Switch to LB #3 on the far side (switch_play, 0.97, feasibility 0.77) C) Carry into midfield
(1.10) D) Recycle to GK (0.90). Decision-vs-execution point: A has the highest *score* but only
0.27 feasibility (tight lane); B is the safer far-side spare-player answer. This is exactly the
state where decision grading and execution risk diverge — the owner should decide whether the
"correct" answer is the highest expected value (A) or the methodology answer (B). Execution: `kick`
toward the receiver with error from CB passing attribute, pressure, distance. Outcome (projected): A
→ 27 % clean receive, else interception in own half; B → high-probability switch, attack restarts on
the left.

**5. Opposite winger narrows / second 9 — not reproducible today**
No engine or catalog state models the far winger tucking inside as a second 9. Closest existing
state: RW, 40'27, ball with LW (#11) on the far side, RW at (47.1, 8.2), `spaceNear` 0.88,
`spaceBehindLine` 6 m, `RW_OFF_01` "hold_width / run_behind / support_underneath". A proposed
`narrow_inside` intent would ask: *The ball is on the far side and the back line is flat — do you
hold your width or become the second striker?* with answers hold_width / narrow_inside (run to the
far-post channel) / support_underneath. This requires a new intent, `FieldRead.farSideBallWidth`
and a `decideOffBall` branch (§11) and owner approval of the rule.

**6. Pass decision — CB, 15'13, 0–0 (`CB_BUILD_01`)**
CB at (6.7, 16.8) deep on the right; ST 4.0 m, LW 11.1 m; pressure 0.28; lanes 3 / 2; CM #8 free
between the lines (lane margin 0.82 s, receiver space 0.86). Answers: A) Through the gap to CM #8
(2.00) **✔** B) Carry into midfield (1.15, "teammates were open further up") C) Recycle to LB #3
(0.85, "forward options were open, recycling wastes them"). Execution: `kick` pass, ~25 m, error
model; Outcome (projected): clean receive by CM → `pass`+`receive(clean)` events; Continuation: CM
facing forward with 2 progressive lanes.

**7. Carry decision — CB, 14'30, 0–0 (`CB_TRANS_01` "Just won it back")**
CB has just recovered the ball at (7.3, 30.3); ST 5.0 m, CM 6.5 m; pressure 0.18; space ahead 0.77
with pressure 0.00 at the carry end; forward lane to CM only 0.17 s margin. Answers: A) Attack the
space (1.22) **✔** B) Through the gap to CM (1.13, feas 0.29) C) Recycle to LB (1.10) D) Hold and
shield (0.81). Note the top three are within 0.12 — `difficultyOf` marks it medium (0.61) and the
owner may want near-ties to count as "either is acceptable" (Q9). Execution: carry ~8 m; Outcome
(projected): `carry` event, opponents' shape recovers; Continuation: CB at ~15 m with the ball.

**8. First-touch decision — CM, 25'11, 0–1 down (`CM_RECV_01`)**
Pass from RW (#7) arriving at CM (33.3, 21.0); nearest opponents DM 12.8 m, LW 13.7 m; pressure
0.00; space ahead 0.59, far side 1.00; lanes 4 open / 1 progressive. Answers: A) First touch
forward into the space (1.55, feasibility 0.81) **✔** B) Safe touch away from pressure (1.15).
Difficulty easy (0.23). Under the corrected flow this touch is
*automatic* and the question moves to the next action (pass/carry) — unless the owner wants
first-touch questions kept when they are the meaningful read (they are for #1 above).

**9. Shooting decision — ST, 40'03, 1–2 down (`ST_TRANS_01`)**
ST at (61.0, 22.8), 9 m from goal, shot window 40°, "the goal is open"; CB 4.6 m, GK 4.9 m; pressure
0.54. Answers: A) Shoot (2.10) **✔** B) Attack the space (0.98) C) Play through the gap (not
offered — DM the only receiver). Execution: `kick(shot)` with ST shooting attribute, pressure,
distance → `shot` event, `pendingShot` → `save`/`goal`. Outcome (projected): `saveChance()` from
GK attributes, shot speed and 9 m distance decides `goal` vs `save`; either way the ledger records it
and `resolveOutcome()` grades from that event. Continuation: goal → kick-off; save → keeper
possession or rebound.

**10. Defensive moment — CB, 50'53, 0–2 down (`CB_DEF_01` "Runner attacking the space behind")**
Opponents in possession (A-11 carrying, 11 m away); ST runner 1.8 m from CB at (2.4, 19.9), line
deep; pressure 0.57. Answers: A) Track the runner goal-side (1.59) **✔** B) Drop off to protect the
space behind (1.23) C) Press the carrier (0.76, feas 0.20). Under the corrected definition this is
**not** an on-ball moment; kept here to show the engine can generate it if the owner counts
defensive decisions (Q4). Execution: `move` command; Outcome: interception/recovery or shot faced
within 4 s.

**11. Goalkeeper moment (on-ball) — GK, 26'59, 0–0 (`GK_BUILD_02` "Play through the press")**
GK on the ball at (5.9, 23.7); RW 3.0 m, ST 3.2 m pressing; pressure 0.94; lanes 4 open / 2
progressive; space behind their line 30 m. Answers: A) Build short to LB #3 (1.50) **✔** B) Go long
to RW #7 behind the press (1.26) C) Hold and shield (−0.10, "invites the tackle"). This is the best
GK question the current catalog produced in the seed — a real short-vs-long trade-off. Execution:
`kick` pass; Outcome (projected): A clean → build-up continues; B ~60 % retained.

**12. Goalkeeper moment (off-ball, if counted) — GK, 45'16, 0–0 (`GK_CROSS_01` "Ball wide near your box")**
A-7 has the ball wide; ST 0.9 m from the GK at (2.6, 27.9); runner going behind; pressure 0.80.
Answers: A) Stay set, goal covered (keeper_set, 1.41) **✔** B) Protect the near post (1.37) C)
Organise the line (0.90, "too late to talk"). Near-tie between A and B (clarity low → difficulty
hard 0.85). Execution: `move`/`hold`; Outcome: shot faced or cross claimed within the window.

Coverage check: receiving under pressure (#1), attacking space (#2), drawing a defender (#3 — with
weighting flag), far-side spare player (#4), second 9 (#5 — gap), pass (#6), carry (#7), first touch
(#8), shooting (#9), defensive (#10), goalkeeper (#11, #12).

---

## 16. Open questions requiring owner approval

1. **Selected player**: the campaign `PLAYER_ID` in their locked role (current behaviour). Confirm.
2. **Locked all match**: yes today (no substitutions exist). Confirm, or specify rotation rules.
3. **12–18**: hard range enforced by recogniser ceiling only (floor cannot be forced without padding) vs average target across a season. Proposed: ceiling 18 hard, floor 12 soft with a `state_limited` report.
4. **What counts**: strictly on-ball (receive/first contact/possession) — then GK matches will run ~8–12 unless keeper positional decisions count. Proposed: outfield = on-ball only; GK = on-ball + 1v1/cross/sweep decisions where the ball is coming to the keeper's zone.
5. **Review after selection**: show the correct answer and a one-line reason after the consequence (current feedback card) — yes/no?
6. **15-second timer**: real time (proposed), excluding paused/hidden time.
7. **Timeout**: engine's own `decideOnBall` choice, graded as a timeout (no decision credit). Alternative: the safest feasible option.
8. **Answer count**: 3–4 (2 only when the state truly has two reads). Order seeded per moment or always best-first-shuffled?
9. **Near-ties**: options within 0.15 of the best both count as correct (decision band `good`)?
10. **Below 12**: allowed with an explicit report; no padding with trivial touches (proposed).
11. **Substitutions/injuries**: not in the engine; out of scope for this PR unless requested.
12. **Halftime**: 3-second beat with score (current) or a story hook?
13. **Set pieces/restarts**: the taker's delivery counts as an on-ball moment when the selected player takes it (goal kicks for GK, throw-ins/corners for outfield) — yes/no?
14. **Kick-off touch**: exclude (proposed).
15. **Stoppage during the freeze**: cannot happen once frozen (sim is halted); during lead-in the moment is cancelled if the ball goes dead (`play_stopped`).
16. **Position lock**: unchanged; confirm no "follow the ball" camera control by the user.
17. **6–8 real minutes**: keep, drop, or re-baseline? Estimate: 15 moments × (lead-in 3 s + answer ≤15 s + consequence 4 s) ≈ 5.5 min worst case + skipping ~1 min + half-time → 4–7 min. Proposed new band 4–8.
18. **Graphics**: keep trails/slow-motion for the lead-in and consequence; freeze frame with a vignette for the question. Approve or specify.
19. **Gesture modules**: they stay for training drills (first-touch, crossbar, small-sided); confirm that drawing remains acceptable *outside* official matches, or should those activities also move to answer-only?
20. **Provisional catalog**: the 63 entries remain provisional; the answer-only model needs 3–4 answers per on-ball entry and new `switch_play`/`draw_defender`/second-9 coverage. Approve catalog edits within the implementation PR, or review them separately first?
21. **Spec update**: revise §9–§14, §21, §24 in the same PR (proposed) or a separate docs PR?

---

## 17. Statement

No implementation has been performed. No product source, test, catalog, spec or configuration
file was modified for this audit; the only addition is this document. Branch creation for the
corrected match system, code changes and spec edits wait for the owner's approval of §7–§11 and
answers to §16.
