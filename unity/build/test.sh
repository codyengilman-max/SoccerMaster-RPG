#!/usr/bin/env bash
# Runs Unity EditMode and PlayMode tests headlessly and writes NUnit XML + logs to build/logs/.
#   UNITY_EDITOR=/path/to/Unity unity/build/test.sh [editmode|playmode|all]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${UNITY_EDITOR:?set UNITY_EDITOR to the Unity editor binary}"
mode="${1:-all}"
mkdir -p "$here/build/logs"
status=0
for platform in EditMode PlayMode; do
  lower="$(echo "$platform" | tr '[:upper:]' '[:lower:]')"
  [[ "$mode" == "all" || "$mode" == "$lower" ]] || continue
  set +e
  "$UNITY_EDITOR" -batchmode -nographics \
    -projectPath "$here" \
    -runTests -testPlatform "$platform" \
    -testResults "$here/build/logs/$lower-results.xml" \
    -logFile "$here/build/logs/$lower.log"
  rc=$?
  set -e
  echo "$platform exit=$rc results=build/logs/$lower-results.xml"
  [[ $rc -eq 0 ]] || status=$rc
done
exit $status
