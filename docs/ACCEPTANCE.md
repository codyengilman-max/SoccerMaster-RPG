# Acceptance checks (spec §24)

Every check in §24 of `spec/SOCCERMASTER_RPG_STANDALONE_V1_1.md` maps to one `it` in
`tests/acceptance/spec24.test.ts` (same number, same order) plus the module tests that cover the
mechanism in depth. Checks 17 and 18 are only partly verifiable in Node; the automated test pins the
preconditions and the manual procedure below is the acceptance evidence.

Run everything with `npm test`; the acceptance file alone with `npx vitest run tests/acceptance`.

| # | Check | Automated | Supporting tests | Manual |
|---|-------|-----------|------------------|--------|
| 1 | No dependency on the previous project | scans `package.json`, `src/`, `content/`, `tests/`, `tools/`, `public/` for the old repository URL/package, and rejects relative imports that leave the repo | — | — |
| 2 | Selected role locked throughout a match | full campaign match through `MatchRuntime`; role and `controlled` asserted every frame; every moment records the same role | `tests/campaign/week.test.ts` (roster → match) | — |
| 3 | Story characters map to roster identities | both campaigns: `sceneVars().friend` and the match squad names/ids equal `roster.people` | `tests/campaign/campaign.test.ts` (roster), `tests/app/session.test.ts`, `tests/campaign/tryouts.test.ts` (the transfer moves the same person; relationships, knowledge, position and attributes untouched) | — |
| 4 | Cinematic lead-in replays real simulation; the frozen decision state is the live state | the lead-in history is the last 3 s of authoritative ticks (consecutive, ball/players moving); during lead-in and the question `clock.tick` does not advance; the frozen `state` is the one the answers were instantiated from | `tests/match/runtime.test.ts` | — |
| 5 | The selected answer is executed against the frozen field state | `answer()` issues exactly the command `instantiateIntent` produces for that option at the frozen state; `commitTick` is the frozen tick; an answer whose intent is no longer available is recorded as `unavailable`, never silently swapped | `tests/match/runtime.test.ts`, `tests/tactics/session.test.ts`, `tests/tactics/answerSet.test.ts` | — |
| 6 | Selecting the answer is the whole tactical moment | one `answer()` call adds exactly one record and issues one command; no manual-execution API (`select`/`releaseGesture`/`previewGesture`/`tapTarget`/`intentAccuracy`) exists on the official-match runtime | `tests/match/runtime.test.ts`, `tests/tactics/session.test.ts` | — |
| 7 | Decision, execution, outcome separate | every record has independent bands; the report's decision tallies sum to `moments.total`; `goodReadPoorExecution` / `poorReadGoodOutcome` exist | `tests/tactics/session.test.ts`, `tests/campaign/campaign.test.ts` (match reports) | — |
| 8 | Play continues from the actual outcome | tick and event counts are monotonic across commits; score never decreases; ≥ 2 kick-offs | `tests/match/runtime.test.ts` | — |
| 9 | Triggers reject unsuitable states | `no_controlled_player`, `not_open_play`, `moment_pending` | `tests/tactics/session.test.ts` | — |
| 10 | Coverage and difficulty measurable | `coverageReport` totals, difficulty and category partitions, shortfalls | `tests/tactics/session.test.ts`, `npm run sim:tactics` | — |
| 11 | Saves preserve pending consequences and competition records | save after a match and a coach choice; `story.pending`, `queuedScenes`, `promises`, `appliedEventIds`, fixture results, reports, commitments and progression survive `resumeSession` and `serialize`/`deserialize` | `tests/campaign/campaign.test.ts` (saves), `tests/campaign/week.test.ts`, `tests/campaign/tryouts.test.ts` (saves: tryout state, offers, promises, next-season rosters, changed club), `tests/campaign/season.test.ts` (saves: pending tournament answer, moved fixture, v2 → v3 migration) | — |
| 12 | Duplicate events cannot apply twice | second `completeCampaignMatch` and `ingestResult` with the same `eventId` are no-ops; the same scoped story choice is `duplicate`; `processDue` fires each key once; modelled results are applied through the same path and `settleFixtures` is a no-op on a settled season | `tests/calendar/competitions.test.ts`, `tests/story/consequences.test.ts`, `tests/campaign/season.test.ts` | — |
| 13 | U11/U12 barred from both major events | `pacific-wave` and `lone-star` ineligible at U11 and U12 with the "before U13" reason, even with a perfect record; non-major `.500` events stay open; a full U11 season never enters `pacific-wave` | `tests/calendar/competitions.test.ts`, `tests/campaign/season.test.ts` | — |
| 14 | State qualification uses cutoff evidence | decision at the cutoff is unchanged by later results; a later cutoff sees them; `asOfDay` before any result is ineligible; in a live season the club registers only inside the window and only when eligible that day | `tests/calendar/competitions.test.ts`, `tests/campaign/season.test.ts` | — |
| 15 | Different first-week commitments → different later interactions, same score | two identical campaigns, one attends training and one skips; the same deterministic report is applied to both; the coach's post-match scene differs in lines and choices (`lead_warmup` vs `own_it`), sets different flags/pending consequences and diverges the coach relationship | `tests/campaign/week.test.ts` | — |
| 16 | Playable without AI | `AuthoredProvider.available()` is false; `acceptResponse(null)` falls back to the authored line; no `fetch`/socket/model API in `src/`; opening + week run headless | `tests/campaign/campaign.test.ts` (dialogue provider), `npm run smoke:week` | — |
| 17 | Answer selection, 15 s timer, pause and read-aloud on mobile | static: answer group (`role=group`), `role=timer`, Pause, Read aloud toggle, viewport meta, safe-area insets; runtime: the timer does not move before `ready()`, pause holds it, answering ends it, `ANSWER_MS` = 15 000 | `tests/match/runtime.test.ts`, `tests/acceptance/spec24.test.ts` | **yes — below** |
| 18 | Tactical information readable during cinematic presentation | static: opaque answer dock pinned to the bottom, bold title, ≥ 44 px answer height, text-shadow on the timer, no font below 0.75 rem, live regions, reduced-motion hook; runtime: every moment has title, cues and 3–6 labelled answers | — | **yes — below** |
| 19 | Every displayed answer is available in the state; the engine's highest-scoring option is never omitted without a documented exclusion | seeded matches for all nine roles through the tactical session: each option re-instantiates to the same command at the tick it was shown; on-ball moments contain the engine's `evaluateOnBall` best or hit `DOCUMENTED_EXCLUSIONS`; `switch_play` only with a matching engine route; `narrow_inside` only with the second-9 read on | `tests/tactics/answerSet.test.ts`, `tests/tactics/secondNine.test.ts` | — |
| 20 | 12–18 direct-involvement moments in 5–7 real minutes | a complete campaign match at 30 fps records 12–18 moments and `totalRealMs` within 4–8 minutes; every match across nine roles × player models lands in 12–18 and the acceptable band (`npm run pace -- 3 all all`) | `tests/match/pace.test.ts`, `tests/tactics/session.test.ts` (nine-role benchmark) | — |
| 21 | Timeout: no decision grade, engine action graded separately, shown as the character acting | letting `ANSWER_MS` elapse closes the moment with `decision.band === "timeout"` and no quality; `execution.actor === "engine"`; the feedback says no choice was committed in time | `tests/match/runtime.test.ts` | — |

## Manual procedure for 17 and 18

Do this on a real phone (see `docs/PERFORMANCE.md` for the device list) against a production build
(`npm run build && npm run preview --host`, or the Cloudflare preview of the branch). Record the
device, OS/browser version and the outcome of each step in the PR.

1. Start → New campaign → any name → any position → play the opening to the first match. Confirm
   the hub and scene screens fit the viewport with no horizontal scroll in portrait.
2. In the match, wait for the first moment. Confirm (18): routine play is skipped (the clock jumps),
   the lead-in shows the ball travelling and players moving for 2–4 s, the picture freezes on your
   player, and the title, cues and answers are legible over the pitch and tappable without zooming.
3. Confirm (17): the 15-second timer bar appears only once the answers are painted (with **Read
   aloud** on, only after the spoken question and answers finish).
4. Tap an answer. Confirm: the answers disappear, your character executes that action with no
   further input, the consequence plays at real speed, one line of factual feedback follows, and the
   next moment (or skipped play) begins without a reset.
5. Toggle **Pause** during a question. Confirm the timer bar and the remaining seconds stop; resume
   and confirm they continue from the same value.
6. Let a moment time out. Confirm the feedback says no choice was committed in time and names the
   action the character took, and that the report lists it as a timeout, not as your decision.
7. Tap **Save & leave** during a question, return from the hub, and confirm the same question and
   answers are shown with the timer stopped until you are ready.
8. Rotate to landscape and repeat step 2 once.

Pass criteria: every "Confirm" holds; no control needed a second attempt because of size or
overlap; no text overlapped the pitch canvas in a way that hid the ball or your player.

## Not covered by software tests

Per spec §24, these tests establish that the software behaves as specified. They do not establish
that the tactical catalogue is coaching-accurate (all entries remain `provisional`) or that story
lines are approved (`reviewStatus: proposal`). Those remain owner and coaching review items listed
in `spec/OPEN_QUESTIONS.md`.
