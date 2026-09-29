using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace SoccerMaster.Editor
{
    /// <summary>
    /// Repeatable iOS export: <c>Unity -batchmode -buildTarget iOS -executeMethod SoccerMaster.Editor.IosBuild.Build -quit</c>
    /// (see unity/build/ios.sh). Produces an Xcode project; signing, archiving and upload happen in the
    /// macOS stage (Unity Build Automation or Xcode) and never here. Fails fast when any required scene or
    /// build metadata is missing rather than exporting an under-specified app.
    /// </summary>
    public static class IosBuild
    {
        public const string DefaultBundleId = "com.codyengilman.soccermaster";
        public const string DefaultAppVersion = "0.1.0";

        /// <summary>Scenes shipped in the app, in load order (index 0 is the entry scene). Anything not listed is not built.</summary>
        public static readonly string[] RequiredScenes =
        {
            TacticalMomentSceneBuilder.ScenePath,
            FirstTouchSceneBuilder.ScenePath,
        };

        /// <summary>Points the Editor build settings at <see cref="RequiredScenes"/> (scene builders call this after saving).</summary>
        public static void SyncSceneList()
        {
            EditorBuildSettings.scenes = RequiredScenes.Select(p => new EditorBuildSettingsScene(p, true)).ToArray();
        }

        public static void Build()
        {
            var outDir = Env("SM_IOS_OUTPUT", Path.Combine("build", "output", "ios"));
            var bundleId = Env("SM_BUNDLE_ID", DefaultBundleId);
            var appVersion = Env("SM_APP_VERSION", DefaultAppVersion);
            var buildNumber = RequireInt("SM_BUILD_NUMBER");
            var gitSha = Env("SM_GIT_SHA", "unknown");

            Configure(bundleId, appVersion, buildNumber, gitSha);
            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = RequiredScenes,
                locationPathName = outDir,
                target = BuildTarget.iOS,
                targetGroup = BuildTargetGroup.iOS,
                options = BuildOptions.None,
            });
            var s = report.summary;
            Debug.Log($"[SoccerMaster] iOS export {s.result}: {s.totalSize} bytes, {s.totalErrors} errors, {s.totalWarnings} warnings, {s.totalTime.TotalSeconds:0}s -> {s.outputPath}");
            if (s.result != BuildResult.Succeeded)
                throw new BuildFailedException($"iOS export failed: {s.result} ({s.totalErrors} errors)");
        }

        /// <summary>Applies bundle/version/scene settings and validates them. Also used by tests.</summary>
        public static void Configure(string bundleId, string appVersion, int buildNumber, string gitSha)
        {
            var missing = RequiredScenes.Where(p => AssetDatabase.LoadAssetAtPath<SceneAsset>(p) == null).ToList();
            if (missing.Count > 0)
                throw new BuildFailedException("required scene(s) missing: " + string.Join(", ", missing));
            if (!IsBundleId(bundleId))
                throw new BuildFailedException($"invalid bundle identifier '{bundleId}'");
            if (!Version.TryParse(appVersion, out var v) || v.Build < 0)
                throw new BuildFailedException($"app version must be MAJOR.MINOR.PATCH, got '{appVersion}'");
            if (buildNumber <= 0)
                throw new BuildFailedException($"build number must be a positive integer, got {buildNumber}");

            SyncSceneList();
            PlayerSettings.SetApplicationIdentifier(NamedBuildTarget.iOS, bundleId);
            PlayerSettings.bundleVersion = appVersion;
            PlayerSettings.iOS.buildNumber = buildNumber.ToString();
            PlayerSettings.productName = "SoccerMaster";
            PlayerSettings.companyName = "SoccerMaster";
            PlayerSettings.iOS.targetDevice = iOSTargetDevice.iPhoneOnly;
            PlayerSettings.iOS.appleEnableAutomaticSigning = false;
            PlayerSettings.defaultInterfaceOrientation = UIOrientation.Portrait;
            PlayerSettings.SetScriptingBackend(NamedBuildTarget.iOS, ScriptingImplementation.IL2CPP);
            PlayerSettings.SetArchitecture(NamedBuildTarget.iOS, 1); // ARM64 only
            BuildInfo.Write(appVersion, buildNumber, gitSha);
        }

        private static bool IsBundleId(string s) =>
            !string.IsNullOrEmpty(s) && s.Contains('.') &&
            s.Split('.').All(part => part.Length > 0 && part.All(c => char.IsLetterOrDigit(c) || c == '-'));

        private static string Env(string name, string fallback)
        {
            var v = Environment.GetEnvironmentVariable(name);
            return string.IsNullOrWhiteSpace(v) ? fallback : v.Trim();
        }

        private static int RequireInt(string name)
        {
            var v = Environment.GetEnvironmentVariable(name);
            if (int.TryParse(v, out var n)) return n;
            throw new BuildFailedException($"{name} must be set to a positive integer (got '{v ?? "<unset>"}')");
        }
    }

    /// <summary>Writes Assets/SoccerMaster/Resources/build_info.json so the running app can display version, build and commit.</summary>
    public static class BuildInfo
    {
        public const string AssetPath = "Assets/SoccerMaster/Resources/build_info.json";

        [Serializable]
        public class Data
        {
            public string appVersion;
            public int buildNumber;
            public string gitSha;
            public string builtAtUtc;
            public string unityVersion;
        }

        public static void Write(string appVersion, int buildNumber, string gitSha)
        {
            var data = new Data
            {
                appVersion = appVersion,
                buildNumber = buildNumber,
                gitSha = gitSha,
                builtAtUtc = DateTime.UtcNow.ToString("o"),
                unityVersion = Application.unityVersion,
            };
            Directory.CreateDirectory(Path.GetDirectoryName(AssetPath));
            File.WriteAllText(AssetPath, JsonUtility.ToJson(data, true));
            AssetDatabase.ImportAsset(AssetPath);
        }
    }
}
