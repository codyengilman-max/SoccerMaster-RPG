# SoccerMaster RPG

A youth soccer role-playing game: a player's journey from U11 to U16, combining an authored
life/campaign layer (identity, school, family, relationships, training, calendar, clubs,
progression, consequences) with continuous, accurately simulated soccer matches in which the
player's tactical decisions — chosen, then drawn — carry real, truthfully reported consequences.

Proprietary. All rights reserved. No open-source license is granted.

## Project rules

- This is an **independent project**. It does not read, import, copy, modify or depend on any
  previous SoccerMaster repository, engine, branch, pull request, execution packet or agent
  instructions.
- The single source of requirements is `spec/SOCCERMASTER_RPG_STANDALONE_V1_1.md`. Anything it
  leaves open is recorded with a proposed default in `spec/OPEN_QUESTIONS.md`, never resolved by
  retrieving an older reference.
- All work lands through pull requests. Nothing is merged or deployed without owner approval.

## Documents

| Path | Purpose |
|---|---|
| `spec/SOCCERMASTER_RPG_STANDALONE_V1_1.md` | Owner-supplied build specification (verbatim) |
| `spec/OPEN_QUESTIONS.md` | Missing inputs, proposed defaults, review gates |
| `docs/IMPLEMENTATION_PLAN.md` | Stack proposal, module structure, milestone PR breakdown |
| `docs/STORY_ENGINE.md` | Story Engine v2: minigame framework, ledger, relationship memory, episode integration, engine boundary |

## Development

Requires Node 20 (see `.node-version`).

```
npm ci            # install
npm run dev       # local dev server
npm test          # unit + acceptance tests (Vitest)
npm run typecheck # strict TypeScript
npm run sim:headless -- 5        # AI-vs-AI match report for seed 5
npm run sim:tactics -- 5 CM random  # controlled CM, scripted user; prints tactical coverage
npm run catalog:build            # regenerate content/catalog/provisional-u11.json
npm run smoke:week               # headless: opening → first two campaign weeks (trainings, crossbar, juggling, a hobby)
npm run smoke:season -- 11       # headless: a full U11 season (leagues, tournaments, season end, tryouts, transfer) for seed 11
npm run perf                     # headless CPU budget check (docs/PERFORMANCE.md)
npm run pace -- 4 CM all         # real-time pace check: complete 60-minute matches in 6–8 real minutes with 18–25 moments
npm run story:tones              # editorial mix of authored scenes vs the 30/15/55 target (spec §6)
npm run build     # static build → dist/
```

`npm run dev` opens the quick-match screen: pick a position and seed, then play one U11 9v9
match. Tactical moments slow the field (it keeps moving) and list readable options; drawn
options preview while the pointer is down and commit on release — drag back to the start to
cancel, or toggle **Tap targets** to aim with a tap instead (window extended 1.5×).

### Cloudflare Pages

Static site, no server functions required.

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | `/` |
| Node version | from `.node-version` |

## Layout

```
spec/       specification and open questions
docs/       implementation plan
src/        application source (see docs/IMPLEMENTATION_PLAN.md §2 for module map)
content/    authored data: tactical catalog, story (opening, week, season, U11 arc, tryouts, hobbies, Episode One), school
            (age-tagged presentation topics), rules profiles
            (U11 9v9, competitions, progression tracks + unlock rules, tryouts + U12 roster capacity, hobbies)
tests/      Vitest suites
```
