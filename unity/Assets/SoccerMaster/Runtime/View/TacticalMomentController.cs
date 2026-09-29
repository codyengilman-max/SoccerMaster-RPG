using System;
using System.IO;
using SoccerMaster.Core.Director;
using SoccerMaster.Core.Sim;
using SoccerMaster.Core.Tactics;
using UnityEngine;

namespace SoccerMaster.View
{
    /// <summary>
    /// Scene adapter for <see cref="MatchRuntime"/> — the native match loop:
    /// fast-forward → lead-in → frozen question → timer → canonical consequence → feedback → next.
    /// The runtime, session and engine own every tactical judgement; this component only feeds
    /// wall-clock frames, forwards taps as option ids, and persists/restores the runtime through
    /// <see cref="MatchSave"/> when the app is backgrounded or resumed.
    /// </summary>
    public sealed class TacticalMomentController : MonoBehaviour
    {
        public const string CatalogResource = "SoccerMaster/Catalog/provisional-u11";
        public const string SaveFolder = "saves";
        public const string DefaultSlot = "match";
        /// <summary>Real ms the frozen picture is shown before the answers arm and the timer starts.</summary>
        public const double QuestionSettleMs = 700;
        /// <summary>Frame time cap so a long background stall is not fed to the timer or the skip clock.</summary>
        public const double MaxFrameMs = 250;

        [Header("Match")]
        [SerializeField] private int seed = 7;
        [SerializeField] private string roleId = "RW";
        [SerializeField] private string slot = DefaultSlot;
        [SerializeField] private bool autoStart = true;
        [SerializeField] private bool resumeSavedMatch = true;

        public Catalog Catalog { get; private set; }
        public MatchRuntime Runtime { get; private set; }
        public FrameResult LastFrame { get; private set; }
        /// <summary>Real ms the current frozen question has been visible (before Ready()).</summary>
        public double SettleMs { get; private set; }
        public bool RestoredFromSave { get; private set; }
        public string LastSaveError { get; private set; }
        public int SaveCount { get; private set; }
        public int Seed => seed;
        public string RoleId => roleId;

        private RuntimePhase _lastPhase = RuntimePhase.Finished;

        public string SavePath => Path.Combine(Application.persistentDataPath, SaveFolder, slot + ".json");

        private void Awake()
        {
            Catalog = LoadCatalog();
            if (!autoStart) return;
            if (!(resumeSavedMatch && TryLoad())) NewMatch(seed, roleId);
        }

        public static Catalog LoadCatalog()
        {
            var asset = Resources.Load<TextAsset>(CatalogResource);
            if (asset == null) throw new FileNotFoundException("tactical catalog resource missing: " + CatalogResource);
            return Catalog.Load(asset.text);
        }

        public void NewMatch(int matchSeed, string role)
        {
            seed = matchSeed;
            roleId = role;
            Runtime = MatchRuntime.Create(MatchSetup.Official(matchSeed, role), Catalog, PacingConfig.NativeFour(role));
            LastFrame = null;
            SettleMs = 0;
            RestoredFromSave = false;
            _lastPhase = Runtime.Phase;
        }

        /// <summary>Restore the slot; false (and a fresh start is expected) when there is no usable, unfinished save.</summary>
        public bool TryLoad()
        {
            string path = SavePath;
            if (!File.Exists(path)) return false;
            try
            {
                MatchRuntime restored = MatchSave.Restore(File.ReadAllText(path), Catalog);
                if (Engine.IsFinished(restored.State)) return false;
                Runtime = restored;
                LastFrame = null;
                SettleMs = 0;
                RestoredFromSave = true;
                _lastPhase = Runtime.Phase;
                LastSaveError = null;
                return true;
            }
            catch (Exception e)
            {
                LastSaveError = e.Message;
                Debug.LogWarning("[SoccerMaster] save rejected: " + e.Message);
                return false;
            }
        }

        /// <summary>Write the slot atomically (temp file then replace) so an interrupted write never leaves a torn save.</summary>
        public bool Save()
        {
            if (Runtime == null) return false;
            string path = SavePath;
            string tmp = path + ".tmp";
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                File.WriteAllText(tmp, MatchSave.Serialize(Runtime, Catalog.Id));
                if (File.Exists(path)) File.Replace(tmp, path, null);
                else File.Move(tmp, path);
                SaveCount++;
                LastSaveError = null;
                return true;
            }
            catch (Exception e)
            {
                LastSaveError = e.Message;
                Debug.LogWarning("[SoccerMaster] save failed: " + e.Message);
                return false;
            }
        }

        public void DeleteSave()
        {
            string path = SavePath;
            if (File.Exists(path)) File.Delete(path);
            if (File.Exists(path + ".tmp")) File.Delete(path + ".tmp");
        }

        private void Update()
        {
            if (Runtime == null) return;
            Advance(Time.unscaledDeltaTime * 1000.0);
        }

        /// <summary>Feed one real-time frame; the runtime decides how many canonical ticks that is.</summary>
        public FrameResult Advance(double realDtMs)
        {
            double dt = Math.Min(Math.Max(0, realDtMs), MaxFrameMs);
            LastFrame = Runtime.Frame(dt);
            if (Runtime.Phase != _lastPhase)
            {
                _lastPhase = Runtime.Phase;
                SettleMs = 0;
            }
            if (Runtime.Phase == RuntimePhase.Question)
            {
                SettleMs += dt;
                if (SettleMs >= QuestionSettleMs) Runtime.Ready();
            }
            return LastFrame;
        }

        /// <summary>Answers accept taps only once the picture has settled and the timer is running.</summary>
        public bool Armed => Runtime != null && Runtime.Phase == RuntimePhase.Timer && Runtime.Active != null;

        /// <summary>Tap on the n-th answer (0-based). Ignored unless <see cref="Armed"/>.</summary>
        public bool Choose(int index)
        {
            if (!Armed) return false;
            var options = Runtime.Active.Moment.Options;
            if (index < 0 || index >= options.Count) return false;
            return Runtime.Answer(options[index].Id);
        }

        public bool Answer(string optionId) => Armed && Runtime.Active.Moment.Option(optionId) != null && Runtime.Answer(optionId);

        public void Continue() => Runtime?.ContinueNow();

        public void SkipLeadIn() => Runtime?.SkipLeadIn();

        private void OnApplicationPause(bool paused)
        {
            if (Runtime != null) Runtime.Paused = paused;
            if (paused) Save();
        }

        private void OnApplicationFocus(bool focused)
        {
            if (!focused) Save();
        }

        private void OnApplicationQuit()
        {
            Save();
        }
    }
}
