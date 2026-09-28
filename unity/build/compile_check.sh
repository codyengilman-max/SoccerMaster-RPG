#!/usr/bin/env bash
# License-free compile check of every SoccerMaster asmdef against the real Unity 6000.3.24f1
# managed DLLs and the real pinned package sources (Input System from the registry tarball,
# uGUI / Test Framework / NUnit from the Editor's bundled packages).
#
#   UNITY_EDITOR_DIR=/path/to/6000.3.24f1/Editor unity/build/compile_check.sh
#
# UNITY_EDITOR_DIR defaults to the parent of $UNITY_EDITOR when that is set. Requires the .NET 8 SDK
# and network access to packages.unity.com on first run (tarballs are cached under build/pkgcache).
# Passing here means "the C# compiles"; it is not an Editor import, test run or player build.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -z "${UNITY_EDITOR_DIR:-}" && -n "${UNITY_EDITOR:-}" ]]; then
  UNITY_EDITOR_DIR="$(dirname "$UNITY_EDITOR")"
fi
: "${UNITY_EDITOR_DIR:?set UNITY_EDITOR_DIR (…/6000.3.24f1/Editor) or UNITY_EDITOR}"
expected="$(sed -n 's/^m_EditorVersion: //p' "$here/ProjectSettings/ProjectVersion.txt")"
if [[ ! -f "$UNITY_EDITOR_DIR/Data/Managed/UnityEngine/UnityEngine.CoreModule.dll" ]]; then
  echo "UNITY_EDITOR_DIR=$UNITY_EDITOR_DIR does not look like a Unity Editor install" >&2; exit 2
fi
case "$UNITY_EDITOR_DIR" in *"$expected"*) ;; *) echo "warning: UNITY_EDITOR_DIR does not mention $expected (ProjectVersion.txt)" >&2 ;; esac

cache="$here/build/pkgcache"
src="$cache/src"
mkdir -p "$src"

# Registry packages that are not bundled with the Editor: read the pinned version from manifest.json.
pinned() {
  sed -n "s/^[[:space:]]*\"$1\": \"\([^\"]*\)\".*/\1/p" "$here/Packages/manifest.json"
}
fetch() {
  local name="$1" ver; ver="$(pinned "$name")"
  local tgz="$cache/$name-$ver.tgz" dst="$src/$name"
  if [[ ! -f "$tgz" ]]; then
    echo "fetching $name@$ver"
    curl -fsSL "https://packages.unity.com/$name/-/$name-$ver.tgz" -o "$tgz.part" && mv "$tgz.part" "$tgz"
  fi
  if [[ ! -f "$dst/.version" || "$(cat "$dst/.version")" != "$ver" ]]; then
    rm -rf "$dst"; mkdir -p "$dst"
    tar xzf "$tgz" -C "$dst" --strip-components=1
    echo "$ver" > "$dst/.version"
  fi
}
fetch com.unity.inputsystem

# Bundled packages must match the manifest pins (the Editor ships exactly one version of each).
builtin="$UNITY_EDITOR_DIR/Data/Resources/PackageManager/BuiltInPackages"
for p in com.unity.ugui com.unity.test-framework; do
  want="$(pinned "$p")"
  have="$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)".*/\1/p' "$builtin/$p/package.json" | head -1)"
  if [[ "$want" != "$have" ]]; then
    echo "manifest pins $p@$want but Editor $expected bundles $have" >&2; exit 3
  fi
done

export UNITY_EDITOR_DIR UNITY_PKG_SRC="$src"
mkdir -p "$here/build/logs"
dotnet build "$here/Tools/CompileCheck/CompileCheck.proj" -c Release -nologo -v minimal \
  2>&1 | tee "$here/build/logs/compile-check.log"
echo "COMPILE CHECK OK ($expected)"
