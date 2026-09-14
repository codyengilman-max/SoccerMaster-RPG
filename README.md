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
npm run build     # static build → dist/
```

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
content/    authored data: tactical catalog, story, rules profiles (added with the milestone PRs)
tests/      Vitest suites
```
