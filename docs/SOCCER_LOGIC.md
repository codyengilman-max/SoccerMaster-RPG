# Soccer logic — canonical implementation map

Spec §15–§16 (`spec/SOCCERMASTER_RPG_STANDALONE_V1_1.md`) is the contract. This page maps it to the
code so nobody has to guess where a soccer decision comes from. There is no separately named
"HGA" or "Decision Utility" system; the pipeline below is the implementation.

## Pipeline for one on-ball moment

| Step | Function | File | What it owns |
|---|---|---|---|
| 1 | `readField(state, p)` | `src/tactics/features.ts` | the live field read: pressure, open / progressive lanes, near- and far-side space, receiving state, keeper context (`ourLineDepth`, `ballWide`, `distFromOwnGoalLine`), second-9 context (`widthProvidedMyFlank`, `farPostSpace`, `restDefenseCount`, `secondNineOn`) |
| 2 | `evaluateOnBall(state, p)` | `src/sim/ai.ts` | the engine's own scored options for the player on the ball — carry, pass, switch, shoot, hold — sorted best first; the AI plays from the same list |
| 3 | `instantiateIntent(state, p, intent)` | `src/tactics/intents.ts` | one catalog intent → one concrete `PlayerCommand` for this state, or `null` when the state does not support it |
| 4 | `buildOptions` / `scoreAction` | `src/tactics/recognition.ts` | instantiates every action of the matched catalog entry, drops the nulls, de-duplicates identical commands, scores each from the read and the entry's conditional criteria; at least two options or no moment |
| 5 | `gradeDecision`, execution, outcome | `src/tactics/grading.ts`, `src/tactics/session.ts` | decision quality (chosen vs the scored alternatives at commit), execution (the engine's kick / touch result) and outcome (what the ledger records) are three separate records |
| 6 | continuation | `src/sim/engine.ts` | deterministic fixed-tick simulation; the committed command runs against the live state and play continues from the actual result |

Priority order when a soccer decision is in doubt: the spec contract (§15) → the role's
responsibilities (`content/rules/u11-9v9.json`, `basePosition` in `src/sim/ai.ts`) → the valid
simulated state → the existing action library (`INTENTS` in `src/tactics/catalog.ts`) → the
methodology (attack space, draw defenders, find the spare player on the far side, opposite winger
narrows as a temporary second 9 when the context supports it, recognise pressure before receiving,
separate decision from execution and outcome) → tested engine behaviour. Contradictions are
reported in `spec/OPEN_QUESTIONS.md`, never resolved silently.

## Answer set rules

- The answers a player sees are the instantiated, scored actions of the matched catalog entry
  (`tools/authorCatalog.ts` is the authoring source; `npm run catalog:build` writes
  `content/catalog/provisional-u11.json`; never edit the JSON by hand).
- Every displayed answer exists in the state: `instantiateIntent` at the displayed tick returns the
  same command (`tests/tactics/answerSet.test.ts`).
- When the character is on the ball, the engine's best `evaluateOnBall` command is in the answer
  set, or the omission is listed with a soccer reason in `DOCUMENTED_EXCLUSIONS`
  (`src/tactics/exclusions.ts`). The only entry is the goalkeeper carry: keepers distribute, and
  the engine already penalises a keeper carry (−0.8). Undocumented omissions fail the suite.
- `switch_play` is offered wherever the engine has the far-side route (CB build-up and transition,
  DM / CM, wingers, striker, keeper distribution) and is scored from the state — far-side space,
  near-side space, pressure, overload — never assumed best because the ball is wide.
- Lay-off / recycle answers are offered to the striker so the underneath option cannot vanish
  when the shot or the forward lane is closed.
- `DRAWN_INTENTS` (`src/tactics/catalog.ts`) only marks which intents the pre-PR-B runtime and
  the training drills execute by drawing; it carries no soccer meaning and official matches after
  PR B execute every answer automatically.
- Between recognition and commit the state keeps moving. `commit()` re-instantiates the chosen
  intent in the *current* state; if it no longer exists (the ball went out, possession turned over,
  a long route closed) the record is `intent_unavailable`, no user grade is awarded, and the role's
  continuation default is issued so the match continues. This is a rare edge (≈3% of keeper
  moments across 60 seeds), guarded in `tests/tactics/goalkeeper.test.ts`.

## Second 9 (`narrow_inside`)

`secondNineRead(state, p)` in `src/sim/ai.ts` (thresholds in `SECOND_NINE`) is the single
predicate used by the AI wingers' off-ball movement (`decideOffBall`), the `narrow_inside` intent
and the field read. The opposite winger narrows into the far half-space only when all hold:

1. a teammate controls the ball on the *other* flank (the winger's flank is derived from the
   formation base position, not from where the winger has drifted);
2. the carrier is not pressed and is in the attacking half (ball secured);
3. width on the winger's own flank is already provided by an outside back or another teammate;
4. the striker pins the last defender line centrally;
5. the far-post / cutback space at the narrowing target is open;
6. at least `restDefenseMin` outfield teammates are behind the ball;
7. the back line is off the goal line (not a build-up / restart shape).

Condition 1 makes it impossible for both wingers of a side to be on at once
(`tests/tactics/secondNine.test.ts` checks this over full seeded matches as well as the synthetic
positive and each single-condition negative).

## Goalkeeper

Keeper answers are distribution (short, through pressure, skipping lines, switch) and
position-specific reads (starting position, organising the line, cross positioning, near post, 1v1,
sweeping, restart after a claim). The keeper is never offered a carry (documented exclusion) and
the engine has no punch action, so claim-vs-punch is authored as "come and claim" vs "protect the
near post / stay set" (`spec/OPEN_QUESTIONS.md` #10, #23).

## Tests that guard this page

`npx vitest run tests/tactics` — catalog validation, recognition, intents, session, grading,
answer-set integrity and second-9 gating. `npm run pace -- 3 all` proves the current runtime's
pace band per role; the 12–18 / 5–7 minute re-baseline belongs to the cinematic decision-match PR.
