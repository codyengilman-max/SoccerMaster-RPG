#!/usr/bin/env python3
"""Static consistency checks for the Unity project (no Editor needed).

Catches the configuration drift that would otherwise only surface as a failed cloud build:
scene list vs. scene asset vs. IosBuild.RequiredScenes, script GUIDs referenced by the scene,
iOS player settings the build script assumes, and the Editor version pinned in CI images.
"""
import json
import plistlib
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
# Each shipped scene: (builder class, MonoBehaviours the single root object must carry). Order = load order.
SCENES = (
    ("TacticalMomentSceneBuilder", ("TacticalMomentController", "TacticalMomentRig")),
    ("FirstTouchSceneBuilder", ("FirstTouchController", "FirstTouchRig")),
)
ios_build = read(os.path.join(ROOT, "Assets/SoccerMaster/Editor/IosBuild.cs"))
required = re.search(r"RequiredScenes =\s*\{([^}]*)\}", ios_build, re.S).group(1)
required_order = re.findall(r"(\w+SceneBuilder)\.ScenePath", required)
expect(required_order == [b for b, _ in SCENES], f"IosBuild.RequiredScenes order {required_order} != {[b for b, _ in SCENES]}")

known = {}
for dirpath, _, files in os.walk(os.path.join(ROOT, "Assets")):
    for f in files:
        if f.endswith(".cs.meta"):
            known[meta_guid(os.path.relpath(os.path.join(dirpath, f[:-5]), ROOT))] = f[:-8]

expected_list = []
scene_paths = []
for builder, classes in SCENES:
    scene_builder = read(os.path.join(ROOT, f"Assets/SoccerMaster/Editor/{builder}.cs"))
    scene_path = re.search(r'ScenePath = "([^"]+)"', scene_builder).group(1)
    scene_paths.append(scene_path)
    expect(os.path.exists(os.path.join(ROOT, scene_path)), f"scene asset missing: {scene_path}")
    if not os.path.exists(os.path.join(ROOT, scene_path)):
        continue
    expected_list.append((scene_path, meta_guid(scene_path)))
    scene = read(os.path.join(ROOT, scene_path))
    script_guids = set(re.findall(r"m_Script: \{fileID: 11500000, guid: ([0-9a-f]{32}), type: 3\}", scene))
    expect(len(script_guids) == len(classes), f"{scene_path} should reference exactly {classes}")
    for g in script_guids:
        expect(g in known, f"{scene_path} references script guid {g} that no .cs.meta declares")
    for cls in classes:
        expect(any(known.get(g) == cls for g in script_guids), f"{scene_path} does not reference {cls}")
    expect(re.search(r"^--- !u!20 ", scene, re.M) is None, f"{scene_path} should not contain a Camera; the rig creates it at runtime")
    roots = re.search(r"^SceneRoots:\n  m_ObjectHideFlags: 0\n  m_Roots:\n((?:  - \{fileID: \d+\}\n?)+)", scene, re.M)
    expect(roots and len(roots.group(1).strip().splitlines()) == 1, f"{scene_path} should have exactly one root object")

ebs = read(os.path.join(ROOT, "ProjectSettings/EditorBuildSettings.asset"))
listed = re.findall(r"- enabled: (\d)\n\s+path: (\S+)\n\s+guid: ([0-9a-f]{32})", ebs)
expect([(p, g) for e, p, g in listed if e == "1"] == expected_list,
       f"EditorBuildSettings scenes {listed} != {expected_list}")

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

# --- Apple privacy manifest --------------------------------------------------------------------
import plistlib
privacy = os.path.join(ROOT, "Assets/Plugins/iOS/PrivacyInfo.xcprivacy")
expect(os.path.exists(privacy), "Assets/Plugins/iOS/PrivacyInfo.xcprivacy missing (App Store requires a privacy manifest)")
if os.path.exists(privacy):
    with open(privacy, "rb") as fh:
        pl = plistlib.load(fh)
    expect(pl.get("NSPrivacyTracking") is False, "PrivacyInfo.xcprivacy must declare NSPrivacyTracking = false")
    expect(any(t.get("NSPrivacyAccessedAPIType") == "NSPrivacyAccessedAPICategoryFileTimestamp" for t in pl.get("NSPrivacyAccessedAPITypes", [])),
           "PrivacyInfo.xcprivacy must declare the file-timestamp API reason (native save files)")
    pmeta = read(privacy + ".meta")
    expect("PluginImporter:" in pmeta and re.search(r"iPhone: iOS\n\s+second:\n\s+enabled: 1", pmeta),
           "PrivacyInfo.xcprivacy.meta must be a PluginImporter enabled for iOS")

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
print(f"project check OK: Unity {version}, scenes {scene_paths}, bundle {bundle}, {len(known)} scripts")
