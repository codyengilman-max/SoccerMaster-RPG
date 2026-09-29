# SoccerMaster-RPG — working notes for agents

Two implementations live side by side and must stay behaviorally identical:

| | Path | Ships via |
| --- | --- | --- |
| Web (behavioral oracle) | repo root (`src/`, `app/`, `tests/`) | Cloudflare Pages, branch `integration/pr1-11` |
| Native iPhone (Unity 6000.3.24f1) | `unity/` | Unity Build Automation → App Store Connect → TestFlight |

Laws: `ENGINE STATE = VISUAL STATE = SOCCER READ = ENGINE RANKING`; AI chooses intent → engine
executes → renderer visualizes; the game is 15–25 tactical moments inside a believable continuous
match, not a match viewer. Never put tactical reasoning in a renderer/MonoBehaviour, never teleport
players, never change Decision Quality math or engine coefficients without documenting it, never add a
second tactical engine.

## Develop

```
npm ci                                  # Node >= 20.19 (.node-version)
npm run dev                             # web app
npm run native:fixtures                 # regenerate unity/Assets/SoccerMaster/Tests/Fixtures/*.json from the web code
```

Native C# under `unity/Assets/SoccerMaster/Runtime/Core` has no `UnityEngine` references; port web
behavior there first, then mirror it in `Runtime/View`. Every new asset needs a `.meta`:
`python3 unity/build/gen_meta.py` writes them deterministically (`--check` in CI).

## Validate (run all before a PR)

```
npm run typecheck && npm run build && npm test
python3 unity/build/gen_meta.py --check
python3 unity/build/check_project.py
UNITY_EDITOR_DIR=<Editor dir> unity/build/compile_check.sh      # license-free compile against real Unity DLLs
npm run native:fixtures && npm run native:parity                 # .NET oracle parity (math, first touch, tactics, save/reload)
```

Licensed Unity evidence (import, EditMode/PlayMode, scene inspection, iOS export) does **not** exist
on a Linux box without a license: `unity/build/test.sh` and the `tests`/`ios-export` jobs in
`.github/workflows/unity.yml` need `UNITY_LICENSE`; otherwise the first licensed run is the Unity
Build Automation build. Never report compile/parity checks as Unity test results.

## Build / release (cloud only, no local Mac)

* UBA target `SoccerMaster-iOS-TestFlight`, project subfolder `unity`, pre-export
  `SoccerMaster.Editor.CloudBuild.PreExport` (CFBundleVersion = UBA build number, writes
  `Resources/build_info.json`). Dashboard values: `unity/README.md`.
* `.github/workflows/ios-signing.yml` — creates App Store distribution signing on a GitHub macOS
  runner and stores it in UBA; `check_only` reports bundle-id registration.
* `.github/workflows/testflight.yml` — manual upload; requires `approved_sha` reachable from
  `integration/pr1-11`, UBA revision == that SHA, App Store signing, then uploads and waits for Apple
  processing; stores `testflight-record-<build>` (IPA SHA-256 etc.).
* Both run in the GitHub environment `ios-release` (required reviewer + environment secrets). Never
  put certificates, keys, `.p8`, tokens or passwords in Git, chat, logs or artifacts.

## Recover

* Native save rejected on launch → expected after a `MatchSave.Version` bump; app starts fresh and
  keeps the old file. Migrate deliberately rather than loosening validation.
* Licensed Editor re-serializes `.meta`/`ProjectSettings`/scenes → accept the diff only if it adds or
  removes no assets (`check_project.py` must still pass).
* Release gates fail (unreachable SHA, ad-hoc profile, wrong CFBundleVersion) → fix the input, do not
  weaken the workflow check. See "Recovery" in `unity/README.md`.
* Do not merge PRs or change Cloudflare production settings without explicit instruction.
