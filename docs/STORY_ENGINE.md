# Story Engine v2 — architecture (Phase 1)

Canonical source: the owner's *SoccerMaster Story Engine Version 2* document. This note records
how the code realises it and where the boundaries sit. Phase 1 ships the shared framework, World
Cup Knockout, Group Presentation and Episode One; Phase 2 (Two-versus-Two Court, Crossbar
Challenge, Keep-Away Circle, Next Goal Wins) and Phase 3 (Locker Dash, Study Session, age-tagged
academic content for U13–U16) plug into the same contract.

## 1. Layers

```
content/story/episode1-u11.json   authored episode: scenes, minigame launch specs, continuations
content/school/presentations-u11.json  age-tagged academic topics (U11–U12)
src/minigame/contract.ts          result contract, lifecycle phases, accessibility settings, validateResult
src/minigame/machine.ts           generic lifecycle: start / pause / resume / input / tick / exit, snapshot / restore, replay
src/minigame/registry.ts          gameId → GameLogic; MINIGAME_IDS lists all eight games
src/minigame/worldCupKnockout.ts  recess soccer game (deterministic, five rule variants)
src/minigame/groupPresentation.ts classroom game (assign / order / rehearse / deliver / feedback)
src/story/ledger.ts               verified event ledger: minigame_engine and soccer_engine entries
src/story/memory.ts               relationship dimensions + remembered events (who saw what, how they felt)
src/story/episode.ts              launch / checkpoint / cancel / complete a minigame inside a scene
src/story/episodes.ts             episode planner: queues authored beats when their conditions hold
src/story/lesson.ts               Coach Code's lesson → catalog entry ids → verdict read from the match report
src/ui/minigameScreen.ts          shared shell: HUD, pause, checkpoint save, touch / keyboard / gamepad, a11y
src/ui/minigame/wckView.ts        canvas view for World Cup Knockout
src/ui/minigame/presentationView.ts DOM view for Group Presentation
```

## 2. Lifecycle and result contract

Every game is a pure `GameLogic<S, I>` (`create`, `tick`, `input`, `checkpoint`, `done`,
`result`) driven by the shared machine. Phases: `start → active ⇄ paused → resolved | abandoned`.
A session records every input with its timestamp, so `replay(logic, config, inputs)` rebuilds the
same result; `snapshot`/`restore` are plain JSON and a session saved while active resumes paused.

`MinigameResult` carries `gameId, episodeId, ageBand, locationId, participantIds, ruleVariant,
verifiedActions, outcomeTier (success | partial | failure), witnessedBehavior, relationshipEffects,
startedAt, resolvedAt, exitReason (completed | timeout | voluntary_exit), seed, day, summary`.
`validateResult` rejects anything malformed before it can reach the ledger.

## 3. Story integration

A scene may declare a `minigame` launch spec (game, variant, participants as cast roles, and a
continuation scene per `success | partial | failure | timeout | voluntary_exit`). The scene cannot
be continued until the game is committed:

1. `launchMinigame` builds the config (age band from the campaign, location from the scene,
   participants resolved to the campaign's cast, recess skill from who the person is — `participantSkill`: a club player, a classmate, the rival — never from match attributes) and
   stores the session as `campaign.pending`.
2. `checkpointMinigame` saves the session at round boundaries and on pause; `pendingMinigame`
   restores it (paused) as the canonical pending session after a reload.
3. `completeMinigame` validates the result, appends it to the ledger (deterministic id
   `mg:<episode>:<game>:<day>:<seed>`, duplicates rejected), writes `mg:*` facts, applies the
   result's relationship effects, turns witnessed behaviour into memories for the people who saw
   it, records the continuation, clears `pending` and only then advances the scene.
4. `cancelMinigame` drops a session that never got going; nothing is recorded.

Official matches append a `soccer_engine` ledger entry from the `MatchReport`. The lesson layer
(`scan_before_receive`) maps to catalog entry ids per role and derives `lesson:*` facts from the
moments the engine actually recorded; it never adds, grades or re-grades a moment.

## 4. Engine boundary

Story and minigames may change relationships, trust, reputation, knowledge, optional scenes,
invitations, teacher/parent confidence, time and memories. They cannot reach the soccer engine:

- `campaignMatchConfig` reads the roster, fixture and seed only; `tests/story/boundary.test.ts`
  plays the same fixture with and without a week of minigame results, relationship swings and facts
  and requires byte-identical moment records, grades and score.
- Minigame facts live under `mg:`, lesson facts under `lesson:`; relationship effects target people,
  not player attributes.
- Narrative text is built from ledger-backed facts (`last_score`, `lesson_faced`,
  `mg:world_cup_knockout:players`, …) via `sceneVars`; scenes cannot state a result that was not
  recorded.

## 5. Episode One route (U11, both campaigns)

Monday homeroom (best friend's Knockout invitation, Sonoran classmate two desks over) → recess World
Cup Knockout (won / knocked out early / knocked out deep / bell / walked off / watched) → the
fractions-and-pizza group project is assigned → Tuesday FC Batavia training with Coach Code
(`scan_before_receive`) → Wednesday Group Presentation (strong / mixed / failed / bell / left) →
home decision (extra practice vs homework) → Saturday official match (lesson verdict read from the
report) → Monday consequence (only recorded events; rival remembers recess) → Episode Two hook
(`ep2_hook`: tight-space rematch or the friend's wall rematch).

## 6. Accessibility

Shared settings (`AccessibilitySettings`): reduced motion, high contrast, timer scale ×1 / ×1.5 /
×2, assist — changed from the pause overlay (timer scale locks once a game has started), persisted
in `localStorage`, applied through `reduced-motion` / `high-contrast` classes and the views (no
flashes or trails under reduced motion, longer clocks under timer scale). HUD and dock respect
`env(safe-area-inset-*)`; touch targets ≥ 44 px; each view lists its touch, keyboard and gamepad
controls in the pause overlay's "How to play" list.

## 7. Adding a game (Phases 2–3)

Implement `GameLogic<S, I>` with a deterministic `create` (seeded `Rng` stored in state), register
it in `registry.ts`, add a view under `src/ui/minigame/`, author a scene with a `minigame` spec and
five continuations, and add a test file following `tests/minigame/worldCupKnockout.test.ts`
(states, tiers, timeout, exit, pause/resume, save/reload, replay, bad input).
