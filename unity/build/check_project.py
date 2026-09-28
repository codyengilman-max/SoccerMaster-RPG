#!/usr/bin/env python3
"""Static consistency checks for the Unity project (no Editor needed).

Catches the configuration drift that would otherwise only surface as a failed cloud build:
scene list vs. scene asset vs. IosBuild.RequiredScenes, script GUIDs referenced by the scene,
iOS player settings the build script assumes, and the Editor version pinned in CI images.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REPO = os.path.dirname(ROOT)
errors = []


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def expect(cond, msg):
    if not cond:
        errors.append(msg)


def meta_guid(asset_rel):
    meta = os.path.join(ROOT, asset_rel + ".meta")
    if not os.path.exists(meta):
        errors.append(f"missing {asset_rel}.meta")
        return None
    m = re.search(r"^guid: ([0-9a-f]{32})$", read(meta), re.M)
    expect(m, f"{asset_rel}.meta has no guid")
    return m.group(1) if m else None


# --- Editor version ---------------------------------------------------------------------------
version = re.search(r"^m_EditorVersion: (\S+)$", read(os.path.join(ROOT, "ProjectSettings/ProjectVersion.txt")), re.M).group(1)
for wf in ("unity.yml",):
    text = read(os.path.join(REPO, ".github/workflows", wf))
    for tag in re.findall(r"unityci/editor:ubuntu-(\S+?)-", text):
        expect(tag == version, f"{wf} pins GameCI image {tag}, ProjectVersion.txt says {version}")

# --- Scenes ---------------------------------------------------------------------------------
ios_build = read(os.path.join(ROOT, "Assets/SoccerMaster/Editor/IosBuild.cs"))
scene_builder = read(os.path.join(ROOT, "Assets/SoccerMaster/Editor/FirstTouchSceneBuilder.cs"))
scene_path = re.search(r'ScenePath = "([^"]+)"', scene_builder).group(1)
expect("FirstTouchSceneBuilder.ScenePath" in ios_build, "IosBuild.RequiredScenes no longer lists FirstTouchSceneBuilder.ScenePath")
expect(os.path.exists(os.path.join(ROOT, scene_path)), f"scene asset missing: {scene_path}")
scene_guid = meta_guid(scene_path)

ebs = read(os.path.join(ROOT, "ProjectSettings/EditorBuildSettings.asset"))
listed = re.findall(r"- enabled: (\d)\n\s+path: (\S+)\n\s+guid: ([0-9a-f]{32})", ebs)
expect([(p, g) for e, p, g in listed if e == "1"] == [(scene_path, scene_guid)],
       f"EditorBuildSettings scenes {listed} != [{scene_path} {scene_guid}]")

scene = read(os.path.join(ROOT, scene_path))
script_guids = set(re.findall(r"m_Script: \{fileID: 11500000, guid: ([0-9a-f]{32}), type: 3\}", scene))
expect(len(script_guids) >= 2, "FirstTouch scene should reference FirstTouchController and FirstTouchRig")
known = {}
for dirpath, _, files in os.walk(os.path.join(ROOT, "Assets")):
    for f in files:
        if f.endswith(".cs.meta"):
            known[meta_guid(os.path.relpath(os.path.join(dirpath, f[:-5]), ROOT))] = f[:-8]
for g in script_guids:
    expect(g in known, f"scene references script guid {g} that no .cs.meta declares")
for cls in ("FirstTouchController", "FirstTouchRig"):
    expect(cls in known.values() and any(known.get(g) == cls for g in script_guids), f"scene does not reference {cls}")
expect(re.search(r"^--- !u!20 ", scene, re.M) is None, "scene should not contain a Camera; FirstTouchRig creates it at runtime")

# --- iOS player settings ---------------------------------------------------------------------
ps = read(os.path.join(ROOT, "ProjectSettings/ProjectSettings.asset"))
bundle = re.search(r'DefaultBundleId = "([^"]+)"', ios_build).group(1)
expect(re.search(rf"^\s+iPhone: {re.escape(bundle)}$", ps, re.M), f"ProjectSettings.asset iPhone applicationIdentifier != {bundle}")
for key, want in (("defaultScreenOrientation", "0"), ("targetDevice", "0"), ("appleEnableAutomaticSigning", "0"),
                  ("overrideDefaultApplicationIdentifier", "1"), ("activeInputHandler", "1"),
                  ("allowedAutorotateToPortrait", "1"), ("allowedAutorotateToLandscapeLeft", "0"),
                  ("allowedAutorotateToLandscapeRight", "0"), ("productName", "SoccerMaster")):
    m = re.search(rf"^  {key}: (.*)$", ps, re.M)
    expect(m and m.group(1).strip() == want, f"ProjectSettings.asset {key} = {m.group(1) if m else None!r}, want {want}")
expect(re.search(r"^  scriptingBackend:\n    iPhone: 1$", ps, re.M), "iOS scripting backend must be IL2CPP (1)")
expect(re.search(r"^  platformArchitecture:\n    iPhone: 1$", ps, re.M), "iOS architecture must be ARM64 (1)")

# --- No dangling render-pipeline references ------------------------------------------------------
manifest = json.load(open(os.path.join(ROOT, "Packages/manifest.json")))["dependencies"]
gfx = read(os.path.join(ROOT, "ProjectSettings/GraphicsSettings.asset"))
qs = read(os.path.join(ROOT, "ProjectSettings/QualitySettings.asset"))
if "com.unity.render-pipelines.universal" not in manifest:
    expect("m_CustomRenderPipeline: {fileID: 0}" in gfx, "GraphicsSettings references a render pipeline asset but URP is not a dependency")
    expect("customRenderPipeline: {fileID: 11400000" not in qs, "QualitySettings references URP assets but URP is not a dependency")
for pkg in ("com.unity.inputsystem", "com.unity.ugui", "com.unity.test-framework"):
    expect(pkg in manifest, f"manifest.json missing {pkg}")

if errors:
    print("project check FAILED:\n  " + "\n  ".join(errors))
    sys.exit(1)
print(f"project check OK: Unity {version}, scene {scene_path}, bundle {bundle}, {len(known)} scripts")
