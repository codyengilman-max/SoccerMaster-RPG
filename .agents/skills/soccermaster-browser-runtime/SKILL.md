---
name: soccermaster-browser-runtime
description: Verify production identity, phase-specific cinematic match checkpoints, phone inputs, and campaign consequences through real browser gameplay.
---

# SoccerMaster browser runtime testing

## Environment
- Activate installed Node with `source ~/.nvm/nvm.sh && nvm use 20` if absent from PATH.
- Build with `npm run build`; serve using `npx vite preview --port 4173`. Reuse a preview only after verifying its served bundle.
- Match the visible start-screen build, `document.documentElement.dataset.build`, and production asset SHA to the requested revision. Dev mode is not equivalent.
- No login/backend required. Preserve existing localStorage before creating a fresh campaign; never fabricate campaign facts or result state.
- Coordinate exclusive shared-browser access. Maximize with `wmctrl`, not Super-arrow tiling.

## Routes and evidence
- Quick match (debug) → seed → numbered role starts immediately; quick matches do not persist.
- A fresh campaign has opening scenes/training and an early friendly before Episode One. Do not confuse this with the later Saturday fixture.
- Completed opening drills may use **Back to Coach Code**, not Continue. Inspect the visible result button rather than assuming every activity shares a continuation label.
- Hub Let the days pass advances to the next required action. Optional activities may be declined; record skips.
- Count full-time ledger rows, not detected UI changes. Passive requestAnimationFrame observation can establish that frozen answers precede an armed timer.
- Timer CSS classes can remain on hidden elements after selection. Compare each question's first visible frame with its first armed frame, not all frames containing a stale class.
- Keep selected labels, decision quality, execution and outcome separate. A favorable outcome alone does not prove a good decision.
- Preserve the actual match result before Back to the week, then compare postgame and Monday claims with it.

## Checkpoints
- Direct browser reload and explicit Save and leave are separate tests.
- Test after nonzero clock, changed score and several completed records. Capture clock/score/question, record IDs and relevant serialized state before and after.
- Exercise frozen question, feedback, and routine independently. Correctly serialized records do not establish that the visible feedback card/Continue control was reconstructed.
- Compare the entire feedback card before/after, including its coaching text and Continue. Continue must advance without duplicating or losing a record. When rendering is keyed to record identity, a second different feedback card helps detect stale-card reuse.
- Routine simulation advances immediately after restoration; distinguish restored checkpoint time from later screenshot time. Do not call a running-clock difference a reset without checking saved progress.
- A reloaded question may reopen frozen before its timer re-arms. Capture that sequence rather than assuming the timer should already run on the first frame.

## Browser caveats
- Existing CDP contexts may reject Playwright tap without hasTouch. Enable device metrics/touch emulation and dispatch native touchStart/touchEnd; do not label mouse clicks as touch.
- Set reduced-motion emulation before match mount. Verify visible frozen banner and actual lead-in frames; a true media query alone is insufficient.
- Playwright may force focus emulation on its owning CDP session. Disable it on that same session, then require actual document.hidden and unchanged timer. Do not override visibility getters or synthesize the event.
- Animated controls can defeat stability waits. Real input at visible bounding boxes is preferable to mutating application state.
- Check questions, feedback, halftime and report at requested sizes. Scroll wide ledgers; measure utility controls as well as answers; inspect campaign team labels, which may differ from debug labels.
- No connected gamepad means gamepad is untested. No available speech voices means completed read-aloud gating is untested. Emulated phone dimensions do not prove physical notch behavior.

## Recordings
- Annotated output may condense idle segments; retain ordered raw segments and encode a full-speed copy when complete gameplay timing is requested.
- Crop only after measuring display and toolbar offset; preserve the full app. Keep annotated originals.
- Keep screenshots, recordings, telemetry and reports revision-specific.
- Distinguish harness errors and setup timeouts from application console/page errors, and disclose both.

## Devin Secrets Needed
None for local production-preview gameplay.
