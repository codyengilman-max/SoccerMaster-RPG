#!/usr/bin/env bash
# Repeatable iOS export entry point (Unity Editor stage only; no signing here).
#
#   UNITY_EDITOR=/path/to/Unity SM_BUILD_NUMBER=42 unity/build/ios.sh
#
# Required:  UNITY_EDITOR      Unity 6000.3.x editor binary with the iOS module installed
#            SM_BUILD_NUMBER   positive integer, strictly increasing per upload (CFBundleVersion)
# Optional:  SM_APP_VERSION    MAJOR.MINOR.PATCH (default 0.1.0)
#            SM_BUNDLE_ID      default com.codyengilman.soccermaster
#            SM_IOS_OUTPUT     Xcode project output dir (default build/output/ios)
#            SM_GIT_SHA        commit recorded in build_info.json (default: git rev-parse HEAD)
# Output: an Xcode project in SM_IOS_OUTPUT plus build/logs/ios-build.log. Exit code is Unity's.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${UNITY_EDITOR:?set UNITY_EDITOR to the Unity editor binary}"
: "${SM_BUILD_NUMBER:?set SM_BUILD_NUMBER to a positive integer}"
export SM_GIT_SHA="${SM_GIT_SHA:-$(git -C "$here" rev-parse HEAD 2>/dev/null || echo unknown)}"
export SM_IOS_OUTPUT="${SM_IOS_OUTPUT:-$here/build/output/ios}"
mkdir -p "$here/build/logs" "$SM_IOS_OUTPUT"
"$UNITY_EDITOR" -batchmode -nographics -quit \
  -projectPath "$here" \
  -buildTarget iOS \
  -executeMethod SoccerMaster.Editor.IosBuild.Build \
  -logFile "$here/build/logs/ios-build.log"
echo "iOS Xcode project exported to $SM_IOS_OUTPUT (commit $SM_GIT_SHA, build $SM_BUILD_NUMBER)"
