#!/usr/bin/env python3
"""Thin Unity Build Automation (Cloud Build) API client used to drive iOS builds without the dashboard.

Env: UNITY_BUILD_API_KEY (required), UNITY_ORG_ID (required), UNITY_PROJECT_ID (default: SoccerMaster rpg).
The key is only ever sent as an Authorization header; nothing here prints it.

  uba.py versions                         supported Editor versions / Xcode images
  uba.py project                          project record (scm link, settings)
  uba.py targets                          build targets
  uba.py target <id>                      one target
  uba.py create-target <spec.json>        POST buildtargets with the JSON body in <spec.json>
  uba.py update-target <id> <patch.json>  PUT buildtargets/<id>
  uba.py build <id> [--clean]             start a build, prints the build number
  uba.py status <id> <n>                  build record (status, revision, artifacts)
  uba.py wait <id> <n> [--poll 60]        poll until the build finishes; exit 0 only on success
  uba.py log <id> <n> [--full]            build log (compact by default)
  uba.py credentials                      iOS signing credential sets (ids/labels only)
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

API = "https://build-api.cloud.unity3d.com/api/v1"
DEFAULT_PROJECT = "32575c1e-2193-4caf-ab3f-c6fd811b1f51"
FINISHED = {"success", "failure", "canceled", "cancelled", "unknown"}


def env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if not value:
        sys.exit(f"missing env {name}")
    return value


def request(method: str, path: str, body: dict | None = None, raw: bool = False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", "Basic " + env("UNITY_BUILD_API_KEY"))
    req.add_header("Accept", "text/plain" if raw else "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            payload = resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        sys.exit(f"HTTP {e.code} {method} {path}\n{detail[:2000]}")
    if raw:
        return payload.decode(errors="replace")
    return json.loads(payload) if payload else None


def project_path() -> str:
    return f"/orgs/{env('UNITY_ORG_ID')}/projects/{env('UNITY_PROJECT_ID', DEFAULT_PROJECT)}"


def dump(obj) -> None:
    print(json.dumps(obj, indent=2, sort_keys=True))


def compact_build(b: dict) -> dict:
    keys = ["build", "buildtargetid", "buildStatus", "platform", "created", "finished", "totalTimeInSeconds",
            "lastBuiltRevision", "scmBranch", "unityVersion", "xcodeVersion", "checkoutTimeInSeconds",
            "buildTimeInSeconds", "publishTimeInSeconds", "error", "failureDetails"]
    out = {k: b.get(k) for k in keys if k in b}
    links = b.get("links", {})
    out["artifacts"] = [a.get("name") or a.get("key") for a in b.get("artifacts", [])]
    out["download"] = (links.get("download_primary") or {}).get("href")
    out["log"] = (links.get("log") or {}).get("href")
    return out


def compact_log(text: str) -> str:
    keep = []
    for line in text.splitlines():
        l = line.lower()
        if any(t in l for t in ("error", "exception", "failed", "warning cs", "build succeeded", "build failed",
                                 "compil", "test", "xcodebuild", "archive", "export", "unity version",
                                 "cs(", "##", "exit code", "license", "package manager", "resolve",
                                 "postprocess", "preexport", "pre-export", "[soccermaster]")):
            keep.append(line)
    return "\n".join(keep)


def main(argv: list[str]) -> int:
    if not argv or argv[0] in {"-h", "--help"}:
        print(__doc__)
        return 0
    cmd, args = argv[0], argv[1:]
    p = project_path()
    if cmd == "versions":
        dump(request("GET", "/versions/unity"))
    elif cmd == "project":
        dump(request("GET", p))
    elif cmd == "targets":
        dump([{k: t.get(k) for k in ("buildtargetid", "name", "platform", "enabled")} for t in request("GET", p + "/buildtargets")])
    elif cmd == "target":
        dump(request("GET", f"{p}/buildtargets/{args[0]}"))
    elif cmd == "create-target":
        with open(args[0]) as f:
            dump(request("POST", p + "/buildtargets", json.load(f)))
    elif cmd == "update-target":
        with open(args[1]) as f:
            dump(request("PUT", f"{p}/buildtargets/{args[0]}", json.load(f)))
    elif cmd == "build":
        body = {"clean": "--clean" in args}
        res = request("POST", f"{p}/buildtargets/{args[0]}/builds", body)
        for b in res if isinstance(res, list) else [res]:
            print(json.dumps(compact_build(b)))
    elif cmd == "status":
        dump(compact_build(request("GET", f"{p}/buildtargets/{args[0]}/builds/{args[1]}")))
    elif cmd == "wait":
        poll = int(args[args.index("--poll") + 1]) if "--poll" in args else 60
        while True:
            b = request("GET", f"{p}/buildtargets/{args[0]}/builds/{args[1]}")
            status = b.get("buildStatus")
            print(time.strftime("%H:%M:%S"), status, b.get("lastBuiltRevision", ""), flush=True)
            if status in FINISHED:
                dump(compact_build(b))
                return 0 if status == "success" else 1
            time.sleep(poll)
    elif cmd == "log":
        text = request("GET", f"{p}/buildtargets/{args[0]}/builds/{args[1]}/log", raw=True)
        print(text if "--full" in args else compact_log(text))
    elif cmd == "credentials":
        creds = request("GET", p + "/credentials/signing/ios")
        dump([{k: c.get(k) for k in ("credentialid", "label")} | {"team": (c.get("certificate") or {}).get("teamId"),
               "distribution": (c.get("certificate") or {}).get("isDistribution"),
               "expires": (c.get("certificate") or {}).get("expiration")} for c in creds])
    else:
        sys.exit(f"unknown command {cmd}\n{__doc__}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
