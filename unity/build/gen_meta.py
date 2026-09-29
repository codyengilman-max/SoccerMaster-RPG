#!/usr/bin/env python3
"""Create missing Unity .meta files under unity/Assets with deterministic GUIDs.

Unity requires a .meta beside every asset and folder; a licensed Editor writes them with random
GUIDs on import. Without an Editor we write the same importer stanzas Unity would, with the GUID
derived from the asset path, so a clean checkout imports with stable references and never produces
"missing .meta" churn in Unity Build Automation. Existing .meta files are never modified, so an
Editor-generated file always wins once one exists.

    python3 unity/build/gen_meta.py          # write missing files
    python3 unity/build/gen_meta.py --check  # exit 1 if any asset lacks a .meta
"""
import hashlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ASSETS = os.path.join(ROOT, "Assets")
IGNORED_FILES = {".DS_Store", "Thumbs.db"}

FOLDER = """fileFormatVersion: 2
guid: {guid}
folderAsset: yes
DefaultImporter:
  externalObjects: {{}}
  userData: 
  assetBundleName: 
  assetBundleVariant: 
"""

SCRIPT = """fileFormatVersion: 2
guid: {guid}
MonoImporter:
  externalObjects: {{}}
  serializedVersion: 2
  defaultReferences: []
  executionOrder: 0
  icon: {{instanceID: 0}}
  userData: 
  assetBundleName: 
  assetBundleVariant: 
"""

ASMDEF = """fileFormatVersion: 2
guid: {guid}
AssemblyDefinitionImporter:
  externalObjects: {{}}
  userData: 
  assetBundleName: 
  assetBundleVariant: 
"""

TEXT = """fileFormatVersion: 2
guid: {guid}
TextScriptImporter:
  externalObjects: {{}}
  userData: 
  assetBundleName: 
  assetBundleVariant: 
"""

DEFAULT = """fileFormatVersion: 2
guid: {guid}
DefaultImporter:
  externalObjects: {{}}
  userData: 
  assetBundleName: 
  assetBundleVariant: 
"""

# Native iOS plug-in file (e.g. PrivacyInfo.xcprivacy): included only in the iOS player build.
IOS_PLUGIN = """fileFormatVersion: 2
guid: {guid}
PluginImporter:
  externalObjects: {{}}
  serializedVersion: 2
  iconMap: {{}}
  executionOrder: {{}}
  defineConstraints: []
  isPreloaded: 0
  isOverridable: 0
  isExplicitlyReferenced: 0
  validateReferences: 1
  platformData:
  - first:
      Any: 
    second:
      enabled: 0
      settings: {{}}
  - first:
      Editor: Editor
    second:
      enabled: 0
      settings:
        DefaultValueInitialized: true
  - first:
      iPhone: iOS
    second:
      enabled: 1
      settings: {{}}
  userData: 
  assetBundleName: 
  assetBundleVariant: 
"""

TEMPLATES = {
    ".cs": SCRIPT,
    ".xcprivacy": IOS_PLUGIN,
    ".asmdef": ASMDEF,
    ".json": TEXT,
    ".txt": TEXT,
    ".md": TEXT,
    ".unity": DEFAULT,
}


def guid_for(rel_path: str) -> str:
    return hashlib.md5(("SoccerMaster:" + rel_path.replace(os.sep, "/")).encode("utf-8")).hexdigest()


def stanza(path: str, is_dir: bool) -> str:
    rel = os.path.relpath(path, ROOT)
    if is_dir:
        return FOLDER.format(guid=guid_for(rel))
    ext = os.path.splitext(path)[1].lower()
    if ext not in TEMPLATES:
        raise SystemExit(f"no .meta template for {rel}; add one to gen_meta.py or let an Editor import it")
    return TEMPLATES[ext].format(guid=guid_for(rel))


def main(check: bool) -> int:
    missing = []
    for dirpath, dirnames, filenames in os.walk(ASSETS):
        dirnames.sort()
        entries = [(os.path.join(dirpath, d), True) for d in dirnames]
        entries += [(os.path.join(dirpath, f), False) for f in sorted(filenames)
                    if not f.endswith(".meta") and f not in IGNORED_FILES]
        for path, is_dir in entries:
            meta = path + ".meta"
            if os.path.exists(meta):
                continue
            missing.append(os.path.relpath(path, ROOT))
            if not check:
                with open(meta, "w", newline="\n") as fh:
                    fh.write(stanza(path, is_dir))
    stray = []
    for dirpath, _, filenames in os.walk(ASSETS):
        for f in filenames:
            if f.endswith(".meta") and not os.path.exists(os.path.join(dirpath, f[:-5])):
                stray.append(os.path.relpath(os.path.join(dirpath, f), ROOT))
    if stray:
        print("stray .meta without asset:\n  " + "\n  ".join(stray))
        return 1
    if check:
        if missing:
            print("assets without .meta:\n  " + "\n  ".join(missing))
            return 1
        print("all assets have .meta files")
        return 0
    print(f"wrote {len(missing)} .meta file(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main("--check" in sys.argv[1:]))
