# Open questions, proposed defaults and missing inputs

Reconciled against `SOCCERMASTER_RPG_STANDALONE_V1_1.md` (the spec). Each entry is resolved by the
owner, never by consulting an earlier reference. "Default" is what the implementation uses until
the owner decides; it is marked provisional in-game or in code where visible.

Status legend: **Blocking** — cannot implement without it · **Default in use** — implemented with
the stated proposal · **Deferred** — outside the first playable milestone.

| # | Spec § | Item | Proposed default | Status |
|---|---|---|---|---|
| 1 | 1 | The standalone specification. | Supplied as v1.1 and saved to `spec/`. | Resolved |
| 2 | 22 | Technology stack. | TypeScript + Vite + Vitest, Canvas 2D, localStorage saves, static Cloudflare Pages build (`npm run build` → `dist`). See `docs/IMPLEMENTATION_PLAN.md` §1. | Default in use |
| 3 | 5 | Names of the best friend, parents, teammates, rivals; friend's position; cast biographies. | Placeholder cast with clearly fictional names, marked `reviewStatus: "proposal"` in `content/story/characters`. Best friend defaults to a midfielder (8) so the two players can share the field in any player position without duplicating a slot. | Default in use |
| 4 | 3 | Player-creation fields (name, appearance options, birth month for age-group eligibility, dominant foot). | Name, appearance preset, dominant foot, birth month. | Default in use |
| 5 | 3 | Authored differences between boys' and girls' campaigns. | Different friend, different opening kick-about scene, different family situation and school social thread; identical soccer rules and attribute ranges. Content is a proposal. | Default in use |
| 6 | 15 | Age/competition rules for U11 9v9 (field size, ball size, heading, offside, build-out line, GK punts, match length, substitutions) verified from current primary sources. | A `rules/u11-9v9.json` profile with each value tagged `source: "unverified"` until citations are added. Offside on; heading disallowed; build-out line on; 2 × 30 min. | Default in use — needs verification |
| 7 | 3, 15 | Match formats for U12–U16 (9v9 vs 11v11, field, duration). | Not implemented. Later seasons are blocked on an explicit ruleset per age group. | Deferred / Blocking for seasons 2–6 |
| 8 | 9, 12 | Slow-motion time scale, decision-window length, extension for accessible input, timeout behaviour. | Scale 0.12; window 2.5 s simulated (harder reads shorter); accessible mode ×1.5; timeout applies role default and is graded as a decision. | Default in use |
| 9 | 13 | Weights of match evidence vs training evidence in soccer assessment. | Match 0.7 / training 0.3 for tactical understanding; technical development weights training practice higher (0.5/0.5). | Default in use — needs review |
| 10 | 14 | Per-role moment targets (GK, defenders). | Outfield: 18–25 total, 10–14 on-ball. GK: 12–18 total, 6–9 on-ball. Shortfalls are reported, never fabricated. | Default in use |
| 11 | 16 | The full tactical catalog (≥ 40 per position, 360 minimum). | Prototype ships a small provisional set (target 4–6 per role) marked `provisional`. | Blocking for full game; Default in use for prototype |
| 12 | 17 | Numerical thresholds for state-championship qualification; tournament invitation thresholds. | Top 50 % of league table at cutoff qualifies; invitations: any team eligible for Valley Rising Cup and Presidential Cup, ≥ .500 record for Tuzona Challenge, Royal Holiday Classic and Desert Rush Invitational; Pacific Wave Cup and Lone Star International Cup require U13+. | Default in use |
| 13 | 17 | Registration cutoff dates and league season dates. | Fall league Sep–Nov, spring league Feb–Apr; state cutoff 1 Apr; tournament cutoffs 4 weeks before event. | Default in use |
| 14 | 18 | Fictional names for the five other clubs. | Placeholder names generated in `content/story/clubs`, marked proposal. | Default in use |
| 15 | 7 | Calendar slot model: slot count per day, activity durations, attendance rules, phone restrictions. | 4 slots/day (morning, school, afternoon, evening) on weekdays; 3 on weekends. Training Tue/Thu/Fri afternoons; league match Sat. Phone unavailable during the school slot. Missed mandatory training → attendance record + coach follow-up scene. | Default in use |
| 16 | 8 | Approved real demonstration videos for home assignments. | No links shipped. Assignment references a placeholder "approved demonstration" slot the owner fills. | Blocking for that content; flow implemented |
| 17 | 21 | Measurable mobile performance targets and representative phones. | Target ≥ 55 fps median during slow-motion moments and ≤ 100 ms input-to-preview on a mid-range Android (2022-class) and an iPhone 11-class device; startup ≤ 3 s on 4G. Owner to confirm devices. | Default in use |
| 18 | 21 | Art assets (character art, environments, audio). | Placeholder vector/procedural visuals in the navy-and-cyan palette; no audio. | Deferred |
| 19 | 20 | AI dialogue provider, hosting and budget. | Interface only; disabled; authored fallback always present. | Deferred |
| 20 | 19 | Explicit unlock requirements for progression milestones. | Proposed table to be supplied with the campaign PR; marked proposal. | Default in use (when reached) |
| 21 | 6 | Editorial mix (30/15/55) measurement method. | Scenes tagged `tone: reward|adversity|everyday`; a report tool counts per season. Never affects results. | Default in use |
| 22 | 24 | Coaching review of provisional tactical content. | Not a software task; tracked as a review gate on each catalog file. | Blocking for "approved" label |
