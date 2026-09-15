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
| 3 | Story characters map to roster identities | both campaigns: `sceneVars().friend` and the match squad names/ids equal `roster.people` | `tests/campaign/campaign.test.ts` (roster), `tests/app/session.test.ts` | — |
| 4 | Slow motion advances the real simulation | while a moment is open, `clock.tick` advances at the reduced rate and other players/ball move | `tests/match/runtime.test.ts` | — |
| 5 | Gesture commitment uses the current field state | select a drawn option, let ticks pass, release toward `liveAnchor` (= receiver's live position); `commitTick` is the current tick | `tests/match/runtime.test.ts`, `tests/tactics/session.test.ts` | — |
| 6 | Choice + drawing = one moment | select adds no record; preview adds no record; release adds exactly one record for that moment | `tests/tactics/session.test.ts` | — |
| 7 | Decision, execution, outcome separate | every record has independent bands; the report's decision tallies sum to `moments.total`; `goodReadPoorExecution` / `poorReadGoodOutcome` exist | `tests/tactics/session.test.ts`, `tests/campaign/campaign.test.ts` (match reports) | — |
| 8 | Play continues from the actual outcome | tick and event counts are monotonic across commits; score never decreases; ≥ 2 kick-offs | `tests/match/runtime.test.ts` | — |
| 9 | Triggers reject unsuitable states | `no_controlled_player`, `not_open_play`, `moment_pending` | `tests/tactics/session.test.ts` | — |
| 10 | Coverage and difficulty measurable | `coverageReport` totals, difficulty and category partitions, shortfalls | `tests/tactics/session.test.ts`, `npm run sim:tactics` | — |
| 11 | Saves preserve pending consequences and competition records | save after a match and a coach choice; `story.pending`, `queuedScenes`, `promises`, `appliedEventIds`, fixture results, reports, commitments and progression survive `resumeSession` and `serialize`/`deserialize` | `tests/campaign/campaign.test.ts` (saves), `tests/campaign/week.test.ts`, `tests/campaign/season.test.ts` (saves: pending tournament answer, moved fixture, v2 → v3 migration) | — |
| 12 | Duplicate events cannot apply twice | second `completeCampaignMatch` and `ingestResult` with the same `eventId` are no-ops; the same scoped story choice is `duplicate`; `processDue` fires each key once; modelled results are applied through the same path and `settleFixtures` is a no-op on a settled season | `tests/calendar/competitions.test.ts`, `tests/story/consequences.test.ts`, `tests/campaign/season.test.ts` | — |
| 13 | U11/U12 barred from both major events | `pacific-wave` and `lone-star` ineligible at U11 and U12 with the "before U13" reason, even with a perfect record; non-major `.500` events stay open; a full U11 season never enters `pacific-wave` | `tests/calendar/competitions.test.ts`, `tests/campaign/season.test.ts` | — |
| 14 | State qualification uses cutoff evidence | decision at the cutoff is unchanged by later results; a later cutoff sees them; `asOfDay` before any result is ineligible; in a live season the club registers only inside the window and only when eligible that day | `tests/calendar/competitions.test.ts`, `tests/campaign/season.test.ts` | — |
| 15 | Different first-week commitments → different later interactions, same score | two identical campaigns, one attends training and one skips; the same deterministic report is applied to both; the coach's post-match scene differs in lines and choices (`lead_warmup` vs `own_it`), sets different flags/pending consequences and diverges the coach relationship | `tests/campaign/week.test.ts` | — |
| 16 | Playable without AI | `AuthoredProvider.available()` is false; `acceptResponse(null)` falls back to the authored line; no `fetch`/socket/model API in `src/`; opening + week run headless | `tests/campaign/campaign.test.ts` (dialogue provider), `npm run smoke:week` | — |
| 17 | Drawing, cancel, accessible alternatives on mobile | static: Pointer Events only, `touch-action: none`, viewport meta, "Tap targets" toggle, Back button; runtime: drag-back cancel, `cancel()`, tap-target commit | `tests/gesture/gesture.test.ts`, `tests/match/runtime.test.ts` | **yes — below** |
| 18 | Tactical information readable during cinematic presentation | static: opaque option panel, bold title, ≥ 44 px option height, text-shadow on the window bar, no font below 0.75 rem, live regions; runtime: every moment has title, cues and labelled options | — | **yes — below** |

## Manual procedure for 17 and 18

Do this on a real phone (see `docs/PERFORMANCE.md` for the device list) against a production build
(`npm run build && npm run preview --host`, or the Cloudflare preview of the branch). Record the
device, OS/browser version and the outcome of each step in the PR.

1. Start → New campaign → any name → any position → play the opening to the first match. Confirm
   the hub and scene screens fit the viewport with no horizontal scroll in portrait.
2. In the match, wait for the first moment. Confirm (18): the pitch is still moving in slow motion,
   the window bar counts down, the title and cues are legible over the pitch, the option panel is
   readable at arm's length, and the options are tappable without zooming.
3. Tap a **drawn** option (the hint says "Draw from your player…"). Draw from your player toward
   the highlighted receiver and release. Confirm (17): the intended arrow is visible while drawing,
   the moment closes on release, and play continues from the result without a reset.
4. On the next drawn option, start drawing and drag back to the start point, then release.
   Confirm: the moment stays open and the option list is shown again (cancel by drag-back).
5. On another drawn option, start drawing and touch the screen with a second finger. Confirm: the
   gesture is cancelled and the moment stays open (cancel by `pointercancel`).
6. Tap **Back** in the hint. Confirm the option list returns with the window still counting down.
7. Toggle **Tap targets**. Tap a drawn option, then tap the target on the pitch. Confirm the moment
   closes and the window was noticeably longer (×1.5).
8. Toggle **Pause** and **Fast play**; confirm the window bar and ticker keep their readability.
9. Let a moment time out. Confirm the ticker names the fallback that was taken and play continues.
10. Rotate to landscape and repeat step 2 once.

Pass criteria: every "Confirm" holds; no control needed a second attempt because of size or
overlap; no text overlapped the pitch canvas in a way that hid the ball or the receiver marker.

## Not covered by software tests

Per spec §24, these tests establish that the software behaves as specified. They do not establish
that the tactical catalogue is coaching-accurate (all entries remain `provisional`) or that story
lines are approved (`reviewStatus: proposal`). Those remain owner and coaching review items listed
in `spec/OPEN_QUESTIONS.md`.
