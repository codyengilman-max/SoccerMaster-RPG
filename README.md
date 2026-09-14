# SoccerMaster RPG

A youth soccer role-playing game: a player's journey from U11 upward, combining an authored
life/campaign layer (identity, school, family, relationships, training, calendar, clubs,
progression, consequences) with complete tactical soccer matches in which the player's
decisions carry real, truthfully reported consequences.

## Project rules

- This is an **independent project**. It does not read, import, copy, modify or depend on any
  previous SoccerMaster repository, engine, branch, pull request or agent instructions.
- The single source of requirements is the standalone specification in `spec/`. If something
  the specification needs is missing or ambiguous, it is **flagged** in `spec/OPEN_QUESTIONS.md`
  rather than resolved by retrieving an older reference.
- The agreed gameplay, tactical principles, story and visual direction are preserved as stated
  in the specification; the implementation is defined here from scratch.

## Status

Bootstrapped and awaiting the standalone specification. No implementation yet.

## Layout

```
spec/       standalone specification (owner-supplied) and open questions
```

Further directories are added as the specification is implemented, each via pull request.
