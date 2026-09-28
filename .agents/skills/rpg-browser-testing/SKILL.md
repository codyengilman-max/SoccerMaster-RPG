---
name: rpg-browser-save-testing
description: Test SoccerMaster-RPG campaign persistence and minigame results through the mobile browser UI.
---

# Runtime setup

Use the requested checkout, not the separate SoccerMaster static simulator.
Read `.node-version`; select the required version in every shell that starts
the Vite process. Existing shell defaults may differ. Start Vite with an explicit
localhost port, for example `npm run dev -- --host 127.0.0.1 --port 5174`.
No backend or authentication is needed for the local campaign.

## Devin Secrets Needed

None for local browser campaign testing.

## Campaign route

At approximately 390×844, create a campaign with a name and position. Reveal
dialogue with the visible Tap to continue button, then select authored choices.
The opening invitation and parent conversation lead to the six-rep Receive and
go activity. Joining the club leads to the weekly hub.

Use ordinary hub advancement and rest/skip decisions to reach Monday homeroom.
Choose to play at recess; the authored World Cup Knockout scene offers a Play
button. Use its visible call, touch and shoot controls until a result, then
Continue into the authored result scene. Automated rapid actions are not a
human gameplay-quality assessment.

## Persistence evidence

The autosave is `localStorage["smrpg:save:auto"]`. Preserve its actual raw string
outside the browser before any explicitly authorized corruption test.
Compare the whole parsed `campaign` across Reload → Continue, not just the
Start-screen summary. The wrapper's `savedAt` may legitimately refresh.

For a completed minigame inspect the story ledger entry, resolved timestamp,
verified actions, outcome, continuation scene, pending state and dropped entries.
Require exactly one committed result after reload, not merely a visible result.

Invalid slots may be hidden from the Start screen while retained in storage.
Require exact raw-string equality after reload and no global prototype pollution;
do not infer retention from a screenshot. Restore the genuine valid save and
prove it still resumes. Distinguish JavaScript string length from UTF-8 byte size.

## Browser tooling

Prefer native visible controls. If CDP/Playwright pointer dispatch stalls,
native computer clicks can use the rendered viewport position; never assume a
fixed desktop-to-mobile coordinate offset. Capture screenshots of actual results
and attach console/page/resource observers before reload.

Chrome device-toolbar DPR and effective devicePixelRatio may differ after
screenshot capture; recheck before making DPR claims. Chrome emulation is not
real iOS or installed-PWA coverage.
