# Visual review — phone viewport

Spec §21 sets the visual direction (navy/cyan palette, cinematic slow-motion, readable tactical
information on a phone) and §22 the mobile expectations. This is the review pass over the five
surfaces the first playable milestone (§23) names, at a phone viewport, against the production
build. It records what was checked, what was fixed and what still needs a real device.

## Setup

- Production build (`npm run build`) served with `vite preview`.
- Playwright `iPhone 12` device profile: 390 × 844 CSS px, DPR 3, touch enabled, mobile UA; a
  second pass at 844 × 390 (landscape).
- Review states come from `tools/reviewSaves.ts`, which emits autosave JSON for a campaign paused
  on the invitation scene, at the weekly hub, and at the first training slot
  (`npx tsx tools/reviewSaves.ts [boys|girls]` → values for localStorage key `smrpg:save:auto`).
- The match is the debug quick match as the striker with `?perf` so the frame-time probe is visible.
- Touch drawing was driven with CDP `Input.dispatchTouchEvent` (real touch events, not mouse).

Screenshots from the pass are attached to the PR that introduced this document; they are not
committed.

## Findings

| # | Surface | Result | Notes |
|---|---------|--------|-------|
| 1 | Start screen | pass after fix | Title, build line, primary "Start a campaign" (min 2.8 rem tall), debug quick-match link, provisional-content notice all readable. **Fixed:** the `.start` section was `width: 100%` plus 1 rem side padding without `box-sizing: border-box`, so every campaign screen was 32 px wider than the phone viewport — cards touched the edges and the hub overflowed sideways. |
| 2 | Best-friend invitation | pass | Scene header (place / date / title), speaker cards, italic narration, then four choice buttons under a divider. Choice buttons are full width and ≥ 3 rem tall. With four choices the last one sits below the fold on 844 px; the scene auto-scrolls to the newest line/choices, and the log itself scrolls. |
| 3 | Weekly hub | pass after fix | Day/slot heading, energy line, action list with label + detail, week table (Mon–Sun × 3 slots) with today highlighted, then club/league/tournament cards. Overflow fixed by #1; the week table fits 390 px without horizontal scroll; `.table-wrap` still scrolls if a title is long. |
| 4 | Training (3v2, slow motion) | pass | HUD (activity, rep counter, speed pill), decision-window bar, pitch with initials on teammates and the coach's cues, four option buttons in a 2 × 2 grid ≥ 2.9 rem tall, Tap targets / Leave training controls. Landscape: two-column layout (pitch left, options right, panel scrolls) — see #6. |
| 5 | Match: moving slow-motion moment | pass | Speed pill turns to `slow ×0.12`, window bar drains, players keep moving, "Read the field" banner, title + cues + options in the panel, ticker below. Selecting a drawn option shows the drawing hint with an inline Back (cancel) button; the drawn stroke renders as a cyan line with an arrowhead from the player, and the live anchor of the chosen option is shown as a dashed line to the current teammate position. Release commits and the banner shows the option and read band, play continues at ×1 from the actual outcome. Tap targets toggle reads as pressed and the hint changes to "Tap the target on the pitch". |
| 6 | Match / training in landscape | pass after fix | At 844 × 390 the single-column layout left ~65 CSS px of pitch. **Fixed:** the existing ≥ 900 px two-column layout now also applies to `(orientation: landscape) and (max-height: 500px)`, with the panel column `minmax(18rem, 22rem)` and scrollable. Pitch is ~330 px tall, options are a single column at full width. |

Probe line during the pass (desktop Chrome, phone viewport): `59 fps · frame p50 16.7 p95 16.8 ms ·
sim p95 0.20 · draw p95 0.30 · long 1/300`. This is desktop CPU evidence only (see
`docs/PERFORMANCE.md`).

Console was clean across all screens (no errors, no warnings). The service worker registered and
activated on the production preview with one cache holding the 10 precache entries.

## Readability during cinematic presentation (§24 check 18)

Checked at 390 px: the moment title (1 rem, bold, cyan) and cues (0.85 rem) sit in the dark panel
below the pitch, not over it, so field motion never runs behind text; the option buttons are ≥ 2.9
rem tall with 0.5 rem gaps; the window bar is 0.55 rem tall at the top of the stage; the "Read the
field" banner is the only overlay on the pitch and it is centred at 22 % of the stage height, above the
framed player. The `?perf` overlay does cover the bottom of the pitch — it is a debug aid and is
hidden by default.

## Not verified here

- Real-device touch feel (finger occlusion of the stroke, palm rejection, second-finger cancel),
  and real-device frame times — both need the manual phone pass in `docs/ACCEPTANCE.md`
  (checks 17 and 18) and `docs/PERFORMANCE.md`.
- Safe-area insets (notch) — the emulated profile reports zero insets.
- Home-screen install / splash from the manifest — needs an actual phone.
- Colour contrast was judged by eye against the palette; no automated contrast audit was run.
- Girls' campaign screens were not screenshotted separately; they share every component, only
  the authored text and cast differ.
