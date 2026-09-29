using System;
using System.Collections.Generic;
using System.Text;
using SoccerMaster.Core.Director;
using SoccerMaster.Core.Sim;
using SoccerMaster.Core.Tactics;

namespace SoccerMaster.Tests.Parity
{
    /// <summary>
    /// Headless proof of the native moment director and its versioned save. Drives
    /// <see cref="MatchRuntime"/> at a fixed 60 Hz frame cadence with a deterministic answer policy
    /// (answer / let the timer expire / abandon-and-reload), and checks that:
    ///  - the same seed replays to the same canonical trace (determinism);
    ///  - the run visits every director phase and ends the match with ≥ 1 settled record;
    ///  - saving and reloading at many checkpoints — mid-skip, in the lead-in, on the frozen
    ///    question, during the running timer, mid-resolution, in feedback, at half-time — continues to
    ///    the same canonical future (events, records, score, RNG) as the unbroken run;
    ///  - a save reloads byte-identically (serialize ∘ restore ∘ serialize is the identity).
    /// Host agnostic: the Unity EditMode test and the dotnet pre-check both call <see cref="Check"/>.
    /// </summary>
    public static class RuntimeSaveChecker
    {
        public const double FrameMs = 1000.0 / 60;

        public sealed class Result
        {
            public readonly List<string> Failures = new List<string>();
            public int Comparisons;
            public int Frames;
            public int Moments;
            public int Timeouts;
            public int Reloads;
            public int Events;
            public double RealSeconds;
            public readonly HashSet<RuntimePhase> PhasesSeen = new HashSet<RuntimePhase>();
            public bool Passed => Failures.Count == 0;
        }

        private sealed class Trace
        {
            public readonly List<string> Lines = new List<string>();
            public string Final;
        }

        public static Result Check(string catalogJson, int seed = 7, string role = "RW")
        {
            var r = new Result();
            Catalog catalog = Catalog.Load(catalogJson);
            Trace a = Drive(catalog, seed, role, r, reload: false, record: true);
            Trace b = Drive(catalog, seed, role, r, reload: false, record: false);
            Expect(r, "determinism.final", a.Final, b.Final);
            Expect(r, "determinism.lines", a.Lines.Count, b.Lines.Count);
            for (int i = 0; i < Math.Min(a.Lines.Count, b.Lines.Count); i++) Expect(r, $"determinism.line[{i}]", a.Lines[i], b.Lines[i]);

            Trace c = Drive(catalog, seed, role, r, reload: true, record: false);
            Expect(r, "reload.final", a.Final, c.Final);
            Expect(r, "reload.lines", a.Lines.Count, c.Lines.Count);
            for (int i = 0; i < Math.Min(a.Lines.Count, c.Lines.Count); i++) Expect(r, $"reload.line[{i}]", a.Lines[i], c.Lines[i]);

            foreach (RuntimePhase p in RuntimePhases.All)
                if (p != RuntimePhase.Finished) ExpectTrue(r, $"phase {RuntimePhases.Name(p)} visited", r.PhasesSeen.Contains(p));
            ExpectTrue(r, "at least one moment", r.Moments > 0);
            ExpectTrue(r, "at least one timeout", r.Timeouts > 0);
            ExpectTrue(r, "at least one reload", r.Reloads > 0);
            return r;
        }

        /// <summary>
        /// Deterministic driver. Answer policy by moment index n: n % 3 == 2 → let the 15 s timer
        /// expire; otherwise answer the option at (n * 7) % options after 20 frames of timer. When
        /// <paramref name="reload"/> is set, the runtime is serialized, dropped and restored at a
        /// spread of checkpoints (each runtime phase, plus every 900th frame of routine skipping).
        /// </summary>
        private static Trace Drive(Catalog catalog, int seed, string role, Result r, bool reload, bool record)
        {
            var t = new Trace();
            MatchRuntime rt = MatchRuntime.Create(MatchSetup.Official(seed, role), catalog, PacingConfig.NativeFour(role));
            int eventCursor = 0;
            int momentIndex = -1;
            int timerFrames = 0;
            int questionFrames = 0;
            int frames = 0;
            var reloadedIn = new HashSet<RuntimePhase>();
            bool timerReloaded = false;
            int guard = 0;
            while (!Engine.IsFinished(rt.State))
            {
                if (++guard > 2_000_000) { r.Failures.Add("driver did not finish the match"); break; }
                RuntimePhase phase = rt.Phase;
                if (record) r.PhasesSeen.Add(phase);

                if (reload)
                {
                    bool checkpoint = (!reloadedIn.Contains(phase) && (phase != RuntimePhase.Routine || frames > 300))
                                      || (phase == RuntimePhase.Routine && frames % 1800 == 450)
                                      || (phase == RuntimePhase.Timer && timerFrames == 7 && !timerReloaded)
                                      || (phase == RuntimePhase.Resolving && frames % 60 == 0);
                    if (checkpoint)
                    {
                        reloadedIn.Add(phase);
                        if (phase == RuntimePhase.Timer) timerReloaded = true;
                        rt = Reload(rt, catalog, r, phase);
                        eventCursor = Math.Min(eventCursor, rt.State.Events.Count);
                    }
                }

                switch (rt.Phase)
                {
                    case RuntimePhase.Question:
                        questionFrames++;
                        if (questionFrames >= 2)
                        {
                            rt.Ready();
                            questionFrames = 0;
                        }
                        break;
                    case RuntimePhase.Timer:
                        timerFrames++;
                        if (momentIndex % 3 != 2 && timerFrames >= 20)
                        {
                            TacticalMoment m = rt.Active.Moment;
                            string optionId = m.Options[(momentIndex * 7) % m.Options.Count].Id;
                            rt.Answer(optionId);
                            t.Lines.Add($"answer|{m.Id}|{optionId}|{rt.State.Clock.Tick}");
                        }
                        break;
                }

                FrameResult fr = rt.Frame(FrameMs);
                frames++;
                if (fr.Opened != null)
                {
                    momentIndex++;
                    timerFrames = 0;
                    questionFrames = 0;
                    timerReloaded = false;
                    if (record) r.Moments++;
                    t.Lines.Add($"open|{fr.Opened.Id}|{fr.Opened.EntryId}|{fr.Opened.Tick}|{fr.Opened.Options.Count}|{OptionKeys(fr.Opened)}");
                }
                if (fr.Closed != null)
                {
                    MomentRecord rec = fr.Closed.Record;
                    if (record && fr.Closed.Reason == CloseReasons.Timeout) r.Timeouts++;
                    t.Lines.Add($"close|{rec.Moment.Id}|{fr.Closed.Reason}|{rec.Decision?.ChosenOptionId}|{Q(rec.Decision?.Quality)}|{rec.Decision?.Band}|{rec.Acted?.Actor}|{rec.Execution?.Band}|{rec.Outcome?.Result}|{rec.Outcome?.ResolvedTick}|{string.Join("/", rt.Session.FeedbackFor(rec))}");
                }
                for (int i = eventCursor; i < rt.State.Events.Count; i++) t.Lines.Add("event|" + TacticsParityChecker.EventLine(rt.State.Events[i]));
                eventCursor = rt.State.Events.Count;
            }
            t.Final = TacticsParityChecker.Sample(rt.State) + $"|records={rt.Session.Records.Count}|open={rt.Session.Open.Count}|count={rt.Session.Recognizer.Count}";
            if (record)
            {
                r.Frames = frames;
                r.Events = rt.State.Events.Count;
                r.RealSeconds = rt.TotalRealMs() / 1000;
                r.PhasesSeen.Add(rt.Phase);
            }
            return t;
        }

        private static MatchRuntime Reload(MatchRuntime rt, Catalog catalog, Result r, RuntimePhase phase)
        {
            string json = MatchSave.Serialize(rt, catalog.Id);
            MatchRuntime restored;
            try { restored = MatchSave.Restore(json, catalog); }
            catch (Exception ex)
            {
                r.Comparisons++;
                r.Failures.Add($"restore in {RuntimePhases.Name(phase)}: {ex.GetType().Name}: {ex.Message}");
                return rt;
            }
            string again = MatchSave.Serialize(restored, catalog.Id);
            string twice = MatchSave.Serialize(MatchSave.Restore(again, catalog), catalog.Id);
            r.Comparisons++;
            if (again != twice) r.Failures.Add($"save in {RuntimePhases.Name(phase)} is not a fixed point of serialize∘restore ({FirstDiff(again, twice)})");
            r.Comparisons++;
            if (phase != RuntimePhase.Timer && json != again) r.Failures.Add($"save in {RuntimePhases.Name(phase)} changed on reload ({FirstDiff(json, again)})");
            Expect(r, $"reload[{RuntimePhases.Name(phase)}].sample", TacticsParityChecker.Sample(rt.State), TacticsParityChecker.Sample(restored.State));
            Expect(r, $"reload[{RuntimePhases.Name(phase)}].events", rt.State.Events.Count, restored.State.Events.Count);
            Expect(r, $"reload[{RuntimePhases.Name(phase)}].records", rt.Session.Records.Count, restored.Session.Records.Count);
            RuntimePhase want = phase == RuntimePhase.Timer ? RuntimePhase.Question : phase;
            Expect(r, $"reload[{RuntimePhases.Name(phase)}].phase", RuntimePhases.Name(want), RuntimePhases.Name(restored.Phase));
            if (phase == RuntimePhase.Timer)
                Expect(r, "reload[timer].timerLeft", rt.Active.TimerLeftMs, restored.Active.TimerLeftMs);
            r.Reloads++;
            return restored;
        }

        private static string FirstDiff(string a, string b)
        {
            int n = Math.Min(a.Length, b.Length);
            int i = 0;
            while (i < n && a[i] == b[i]) i++;
            int lo = Math.Max(0, i - 40);
            return $"at {i}: '{a.Substring(lo, Math.Min(80, a.Length - lo))}' vs '{b.Substring(lo, Math.Min(80, b.Length - lo))}'";
        }

        private static string OptionKeys(TacticalMoment m)
        {
            var sb = new StringBuilder();
            foreach (TacticalOption o in m.Options) sb.Append(o.Id).Append(':').Append(o.Command?.Key()).Append(':').Append(o.Score.ToString("R")).Append(';');
            return sb.ToString();
        }

        private static string Q(double? q) => q.HasValue ? q.Value.ToString("R") : "";

        private static void Expect(Result r, string where, string expected, string actual)
        {
            r.Comparisons++;
            if (expected != actual) r.Failures.Add($"{where}: expected {expected}, got {actual}");
        }

        private static void Expect(Result r, string where, double expected, double actual)
        {
            r.Comparisons++;
            if (BitConverter.DoubleToInt64Bits(expected) != BitConverter.DoubleToInt64Bits(actual)) r.Failures.Add($"{where}: expected {expected:R}, got {actual:R}");
        }

        private static void ExpectTrue(Result r, string where, bool ok)
        {
            r.Comparisons++;
            if (!ok) r.Failures.Add(where);
        }
    }
}
