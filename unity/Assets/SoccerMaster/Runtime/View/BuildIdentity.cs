using System;
using UnityEngine;

namespace SoccerMaster.View
{
    /// <summary>
    /// Version / build number / commit shown in every scene so a TestFlight tester can say exactly
    /// which build they are looking at. Read from Resources/build_info.json (written by the iOS build
    /// step); falls back to the Player settings when the file is absent (Editor, local runs).
    /// </summary>
    [Serializable]
    public sealed class BuildIdentity
    {
        public const string Resource = "build_info";

        public string appVersion;
        public int buildNumber;
        public string gitSha;
        public string builtAtUtc;
        public string unityVersion;

        public static BuildIdentity Load()
        {
            var asset = Resources.Load<TextAsset>(Resource);
            BuildIdentity id = null;
            if (asset != null && !string.IsNullOrWhiteSpace(asset.text))
            {
                try { id = JsonUtility.FromJson<BuildIdentity>(asset.text); }
                catch (Exception e) { Debug.LogWarning("[SoccerMaster] build_info.json unreadable: " + e.Message); }
            }
            if (id == null) id = new BuildIdentity();
            if (string.IsNullOrEmpty(id.appVersion)) id.appVersion = Application.version;
            if (string.IsNullOrEmpty(id.gitSha)) id.gitSha = "unknown";
            if (string.IsNullOrEmpty(id.unityVersion)) id.unityVersion = Application.unityVersion;
            return id;
        }

        public string ShortSha => gitSha != null && gitSha.Length > 7 ? gitSha.Substring(0, 7) : gitSha;

        /// <summary>e.g. "v0.1.0 (42) · 3595ed9 · Unity 6000.3.24f1".</summary>
        public string Line => $"v{appVersion} ({(buildNumber > 0 ? buildNumber.ToString() : "dev")}) · {ShortSha} · Unity {unityVersion}";
    }
}
