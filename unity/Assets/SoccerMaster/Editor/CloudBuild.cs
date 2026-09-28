using System;
using UnityEditor;
using UnityEditor.Build;
using UnityEngine;

namespace SoccerMaster.Editor
{
    /// <summary>
    /// Unity Build Automation entry points. Set the iOS build target's
    /// "Pre-Export Method" to <c>SoccerMaster.Editor.CloudBuild.PreExport</c>.
    ///
    /// UBA owns checkout, the licensed Editor, Xcode, signing and the archive; this hook only
    /// (1) makes sure the committed FirstTouch scene is the explicit scene list and
    /// (2) stamps a unique, monotonic build number so every archive uploaded to App Store Connect
    ///     is distinguishable. The number comes from the UBA build manifest (<c>buildNumber</c>),
    ///     which UBA increments per build target; <c>SM_BUILD_NUMBER</c> overrides it for CI.
    /// Nothing here touches credentials: certificates, profiles and passwords live only in the
    /// UBA credential store and are applied by UBA after export.
    /// </summary>
    public static class CloudBuild
    {
#if UNITY_CLOUD_BUILD
        public static void PreExport(UnityEngine.CloudBuild.BuildManifestObject manifest)
        {
            string sha = null, number = null, bundle = null;
            manifest.TryGetValue("scmCommitId", out sha);
            manifest.TryGetValue("buildNumber", out number);
            manifest.TryGetValue("bundleId", out bundle);
            Run(sha, number, bundle);
        }
#else
        public static void PreExport()
        {
            Run(null, null, null);
        }
#endif

        private static void Run(string manifestSha, string manifestNumber, string manifestBundleId)
        {
            var buildNumber = FirstNonEmpty(Environment.GetEnvironmentVariable("SM_BUILD_NUMBER"), manifestNumber);
            if (!int.TryParse(buildNumber, out var n) || n <= 0)
                throw new BuildFailedException("CloudBuild: no positive build number (UBA manifest buildNumber or SM_BUILD_NUMBER)");

            var bundleId = FirstNonEmpty(Environment.GetEnvironmentVariable("SM_BUNDLE_ID"), manifestBundleId, IosBuild.DefaultBundleId);
            var version = FirstNonEmpty(Environment.GetEnvironmentVariable("SM_APP_VERSION"), IosBuild.DefaultAppVersion);
            var sha = FirstNonEmpty(Environment.GetEnvironmentVariable("SM_GIT_SHA"), manifestSha, "unknown");

            IosBuild.Configure(bundleId, version, n, sha);
            AssetDatabase.SaveAssets();
            Debug.Log("[SoccerMaster] CloudBuild.PreExport bundle=" + bundleId + " version=" + version + " build=" + n + " sha=" + sha);
        }

        private static string FirstNonEmpty(params string[] values)
        {
            foreach (var v in values)
                if (!string.IsNullOrWhiteSpace(v)) return v.Trim();
            return null;
        }
    }
}
