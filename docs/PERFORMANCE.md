# Mobile performance

Spec §21 asks for measurable mobile performance targets, demonstrated on representative phones.
This file states the targets, how to measure them, and what has actually been measured so far.

## Targets

Representative phones: a 2019–2020 mid-range Android (e.g. Pixel 4a / Galaxy A51 class) and an
iPhone SE (2nd gen) or iPhone 11, in the default mobile browser, portrait, with the game installed
from the PWA manifest or run in a tab.

| Area | Target | Why |
|------|--------|-----|
| Match frame rate | 60 fps typical; **≥ 30 fps floor** — p95 frame time ≤ 33 ms, no frame > 100 ms during a moment | Slow-motion decisions depend on smooth motion; a 100 ms hitch shifts the anchor the player is drawing towards |
| Match frame budget | `frame()` (simulation + tactical recognition) p95 ≤ 4 ms; canvas render p95 ≤ 4 ms; ≤ 320 draw calls (fill / stroke / drawImage / text / clip) and ≤ 1200 context calls in total per frame | Leaves ≥ 8 ms of a 16.7 ms frame for layout, input and compositing on a phone-class CPU (~5–8× slower than a desktop core) |
| Input latency | pointer move → preview redraw within the next frame (no async work between `pointermove` and `previewGesture`) | Drawing must feel attached to the finger |
| Cold load (4G, empty cache) | interactive ≤ 3 s; JS ≤ 150 kB gzip; CSS ≤ 20 kB gzip | Casual return visits between weeks |
| Warm / installed load | interactive ≤ 1 s offline | Service worker precaches the shell (`pwa/sw.js`) |
| Memory | steady across a full match (no per-frame allocations that grow); heap ≤ 150 MB on a phone | Long matches on low-RAM devices |
| Battery | no work while the tab is hidden (`requestAnimationFrame` pauses; the runtime clamps `dt` to 100 ms on return) | Background drain |
| Real match duration | target (spec §9): a complete 60-minute match finishes in **5–7 real minutes** (4–8 acceptable, 8 hard maximum) with **12–18 meaningful direct-involvement moments**, reported as median / min / max across benchmark seeds; the current runtime (before the cinematic decision-match PR) still runs the earlier 6–8 minute, 18–25 moment pace director and is measured by `RuntimeClock.realElapsedMs`, shown live in the HUD and at full time | Playtesting feedback: the match must not drag |
| Fast-forward CPU | routine play runs up to ×32 but never more than `MAX_TICKS_PER_FRAME` (24) simulation ticks per frame; the pace bench reports the peak scale and ticks/frame actually used | Bounded per-frame work while accelerating |

## How to measure

### Headless CPU budget (repeatable, any machine)

```
npm run perf              # 3 full matches, CM, 60 Hz cadence
npm run perf -- 5 ST      # 5 matches as the striker
npm run perf -- 3 CM json # machine-readable
```

`tools/perfBench.ts` drives the real `MatchRuntime` at a fixed 60 Hz cadence with a scripted user
who answers every tactical moment (half drawn, half chosen), times `frame()` and the renderer, and
counts canvas calls against a phone-sized stub context (780×1120 device pixels). Two counts are
kept: *draw calls* are the rasterising methods (`fill`, `stroke`, `fillRect`, `drawImage`,
`fillText`, …), *ctx calls* include path building (`moveTo`, `lineTo`, `arc`) and `save`/`restore`.
`npm run perf -- 3 CM fallback` benches the procedural-figure path used when a sprite sheet failed
to load. `npx tsx tools/drawCallProfile.ts` attributes one frame's counts to the render layers. The
bench exits non-zero if any p95 breaks the frame budget above. It measures *CPU work per frame on the machine
running it*; it does **not** measure phone frame rate, GPU raster or compositing.

### Real match duration (repeatable, any machine)

```
npm run pace              # 4 seeds, CM, typical decision speed
npm run pace -- 4 CM all  # 4 seeds × quick / typical / slow deciders
npm run pace -- 3 GK      # goalkeeper (OPEN_QUESTIONS #10 — same total band, lower on-ball band)
npm run pace -- 3 all     # every supported position, 3 seeds each
```

`tools/paceBench.ts` drives the real `MatchRuntime` at 60 Hz with a scripted user whose decision
latency follows a profile (quick ≈ 1.5 s per decision, typical ≈ 4 s, slow lets every window
time out — the worst case), advances
wall-clock time exactly as the browser loop would, and reports for every match the real time,
moments (total and on-ball), simulated minutes, score, and the split between decisions, live
aftermath, fast-forward (with the peak scale and max ticks per frame) and half time. It exits
non-zero if any match leaves the 6:00–8:00 band, its role's moment band (`pacingFor(role).total`) or
60 simulated minutes. Latest run (`3 all typical`): every outfield match 6:59–7:00 with 24–25 moments
(13–14 on the ball); goalkeeper matches 6:44 with 20 moments (5–7 on the ball). `tests/match/pace.test.ts`
keeps the budget arithmetic honest and covers every role; `tests/tactics/goalkeeper.test.ts` covers the
keeper's moment quality and continuation.

### In-app probe (the phone evidence)

Open the game with `?perf` in the URL (e.g. `https://<host>/?perf`), start a match. A small monospace
line at the bottom-left of the pitch shows a rolling 300-frame summary:

```
60 fps · frame p50 16.7 p95 17.1 ms · sim p95 0.41 · draw p95 2.30 · long 0/300
```

`long` counts frames over 33.4 ms. The same summary is available programmatically from
`MatchScreenHandle.perf()`. Record the line during (a) normal play, (b) a slow-motion moment while
drawing, (c) a major moment. All three must meet the floor.

Cold-load numbers: Chrome DevTools → Lighthouse (mobile, "Slow 4G", 4× CPU) against the built site,
or WebPageTest on a real device. Bundle sizes come from `npm run build`.

## Measured so far

| Measurement | Result | Evidence |
|-------------|--------|----------|
| Headless budget, dev machine (Node 20, x86-64) | sim p95 **0.03 ms**, render path p95 **0.02 ms**, draw calls p95 **290** over 3 × 60-minute matches (~245k frames each); 0 long frames | `npm run perf`, 2026-09 |
| Bundle | JS **320.7 kB / 78.5 kB gzip**, CSS 10.9 kB / 2.9 kB gzip, shell HTML 1.05 kB | `npm run build`, 2026-09 |
| Desktop Chrome, in-app probe | not yet recorded in this repo | — |
| Representative phones | **not measured** — no representative phone has been available to this project | — |
| Real match duration, CM | 12/12 matches (4 seeds × quick / typical / slow) **6:59–7:03**, 25 moments (14 on ball), 60 simulated minutes; decisions ≈ 3:30, live aftermath ≈ 1:00, fast-forward ≈ 2:20 at peak ×21–×32 (≤ 11 ticks/frame), half time 0:02 | `npm run pace -- 4 CM all`, 2026-09 |
| Stabilization build | sim p95 0.21 ms, render path p95 0.05 ms, 554 context calls (richer turf / figures / trails; the bench counted every context method at the time); JS 502 kB / **125 kB gzip**, CSS 17.2 kB / 4.6 kB gzip, shell 2.7 kB (boot watchdog inline) | `npm run perf`, `npm run build`, 2026-09 |
| Graphics build, sprite sheets | sim p95 0.20 ms, render path p95 **0.07 ms**, draw calls p95 **141**, ctx calls p95 622 over 2 × 60-minute matches at a portrait phone viewport; 0 long frames | `npm run perf -- 2 CM`, 2026-09 |
| Graphics build, procedural fallback figures | render path p95 0.09 ms, draw calls p95 **199**, ctx calls p95 855 | `npm run perf -- 2 CM fallback`, 2026-09 |
| Graphics build, one frame by layer (phone portrait, zoom 15.6) | backdrop 5 / grass 17 / fence-benches-flags 27 / markings+goals+ball ≈ 34 / 18 figures ≈ 55 draw calls with sprites (≈ 110 procedural); total 138 with sprites, 194 fallback | `npx tsx tools/drawCallProfile.ts`, 2026-09 |
| Graphics build, bundle | JS 540 kB / **134 kB gzip**, CSS 19.1 kB / 5.0 kB gzip; four sprite sheets ≈ 100 kB PNG each, fetched once per kit in parallel after the match screen mounts (6 s timeout, fallback figures meanwhile) | `npm run build`, `ls -l public/assets/players`, 2026-09 |

The headless margin is large (≈100× under the CPU budget) so the per-frame work should fit on a
phone-class CPU with room to spare, but that is an inference, not a device result. The spec's
"demonstrate them on representative phones" item stays open until someone runs the in-app probe on
the two device classes above and records the lines here (see `spec/OPEN_QUESTIONS.md`).

## Design notes that keep the budget

- Fixed 20 Hz simulation tick (`TICKS_PER_SECOND`), so a 60 Hz frame does 0–1 ticks at normal speed,
  up to `MAX_TICKS_PER_FRAME` (24) when fast-forwarding or catching up after the 100 ms frame clamp,
  and in slow motion (`SLOW_SCALE` 0.3) roughly one tick every 10 frames; drills use
  `DRILL_SLOW_SCALE` 0.12. The pace director's fast-forward is capped at `FAST_SCALE_MAX` (×32 ≈ 11
  ticks per 60 Hz frame) so accelerated play stays well inside the per-frame budget.
- Tactical recognition runs once per tick, not per frame, and only opens a moment when none is active.
- The renderer is immediate-mode 2D with ~140 draw calls per frame (≈200 when a sprite sheet is
  missing and figures are painted from shapes), a handful of gradients (sky, turf lighting, ball,
  selection ring, slow-motion vignette) and flat ellipse shadows; no canvas `filter` or `shadowBlur`.
  Fence posts and figure shadows are batched into one path each; the turf grain is a 48 px
  `createPattern` tile built once; sprites are a single `drawImage` per figure (mirrored facings add
  a `save`/`scale`/`restore`).
- Sub-tick interpolation is display-only: the fixed 20 Hz simulation is never advanced or read back
  from the interpolated positions (`src/render/presentation.ts`).
- All content is bundled JSON; there is no network traffic during play.
