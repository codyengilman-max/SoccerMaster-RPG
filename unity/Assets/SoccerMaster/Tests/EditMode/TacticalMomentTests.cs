using System.Collections.Generic;
using System.IO;
using NUnit.Framework;
using SoccerMaster.Core.Director;
using SoccerMaster.Core.Sim;
using SoccerMaster.Core.Tactics;
using SoccerMaster.Tests.Parity;
using UnityEngine;

namespace SoccerMaster.Tests.EditMode
{
    /// <summary>
    /// Cross-language parity for the tactical core: recognizer, exact-four windows, commit-time
    /// re-instantiation, settlement and grading must reproduce the web oracle's recorded runs.
    /// </summary>
    public class TacticsParityTests
    {
        public const string FixturePath = "Assets/SoccerMaster/Tests/Fixtures/tactics_parity.json";
        public const string CatalogPath = "Assets/SoccerMaster/Resources/SoccerMaster/Catalog/provisional-u11.json";

        internal static string ProjectFile(string rel) => Path.Combine(Path.GetDirectoryName(Application.dataPath) ?? ".", rel);

        internal static string CatalogJson()
        {
            var path = ProjectFile(CatalogPath);
            Assert.That(File.Exists(path), Is.True, "catalog missing: " + path);
            return File.ReadAllText(path);
        }

        [Test]
        public void MatchesWebFixtureExactly()
        {
            var path = ProjectFile(FixturePath);
            Assert.That(File.Exists(path), Is.True, "fixture missing: " + path + " (run `npm run native:fixtures`)");
            var result = TacticsParityChecker.Check(File.ReadAllText(path), CatalogJson());
            Assert.That(result.Moments, Is.GreaterThan(20), "fixture too small to be meaningful");
            Assert.That(result.Settled, Is.EqualTo(result.Commits), "every commit must settle");
            Assert.That(result.Failures, Is.Empty, string.Join("\n", result.Failures));
            Debug.Log($"[parity] tactics: {result.Comparisons} comparisons, {result.Failures.Count} failures");
        }
    }

    /// <summary>
    /// The native match loop: routine → lead-in → frozen question → timer → resolving → feedback, with
    /// exactly four legitimate choices, hidden ranking, canonical settlement and versioned save/reload.
    /// </summary>
    public class MatchRuntimeTests
    {
        private const double FrameMs = 1000.0 / 60;

        private static Catalog LoadCatalog() => Catalog.Load(TacticsParityTests.CatalogJson());

        private static MatchRuntime Create(Catalog catalog, int seed = 7, string role = "RW") =>
            MatchRuntime.Create(MatchSetup.Official(seed, role), catalog, PacingConfig.NativeFour(role));

        /// <summary>Advance real frames until the runtime reaches <paramref name="phase"/> (fails if it never does).</summary>
        private static void RunUntil(MatchRuntime rt, RuntimePhase phase, int maxFrames = 120_000)
        {
            for (var i = 0; i < maxFrames && rt.Phase != phase; i++)
            {
                rt.Frame(FrameMs);
                if (rt.Phase == RuntimePhase.Question && phase != RuntimePhase.Question) rt.Ready();
                if (rt.Phase == RuntimePhase.Timer && phase != RuntimePhase.Timer && phase != RuntimePhase.Question)
                    rt.Answer(rt.Active.Moment.Options[0].Id);
                if (rt.Phase == RuntimePhase.Finished) break;
            }
            Assert.That(rt.Phase, Is.EqualTo(phase), $"runtime never reached {phase}");
        }

        [Test]
        public void FrozenQuestionOffersExactlyFourDistinctLegitimateChoices()
        {
            var rt = Create(LoadCatalog());
            RunUntil(rt, RuntimePhase.Question);
            var m = rt.Active.Moment;
            Assert.That(m.Options.Count, Is.EqualTo(4));
            Assert.That(m.PlayerId, Is.EqualTo(rt.State.Controlled.PlayerId), "moment must belong to the controlled player");
            var ids = new HashSet<string>();
            var labels = new HashSet<string>();
            foreach (var o in m.Options)
            {
                Assert.That(ids.Add(o.Id), "duplicate option id " + o.Id);
                Assert.That(labels.Add(o.Label), "duplicate option label " + o.Label);
                Assert.That(o.Command, Is.Not.Null, "option without a canonical command: " + o.Label);
                Assert.That(o.Feasibility, Is.GreaterThan(0), "infeasible option offered: " + o.Label);
            }
            Assert.That(MatchRuntime.QuestionFor(m), Is.Not.Empty);
            Assert.That(rt.QuestionOpen, Is.True);
        }

        [Test]
        public void ControlsAreUnavailableOutsideQuestionAndTimer()
        {
            var rt = Create(LoadCatalog());
            Assert.That(rt.Phase, Is.EqualTo(RuntimePhase.Routine));
            Assert.That(rt.QuestionOpen, Is.False);
            Assert.That(rt.Answer("anything"), Is.False, "answer accepted during routine play");
            RunUntil(rt, RuntimePhase.LeadIn);
            Assert.That(rt.QuestionOpen, Is.False);
            Assert.That(rt.Answer(rt.Active.Moment.Options[0].Id), Is.False, "answer accepted during the lead-in");
            RunUntil(rt, RuntimePhase.Question);
            Assert.Throws<System.ArgumentException>(() => rt.Answer("not-an-option"), "unknown option id accepted");
            Assert.That(rt.Phase, Is.EqualTo(RuntimePhase.Question));
        }

        [Test]
        public void TimerStartsOnlyAfterReadyAndTimesOutToAnEngineDecision()
        {
            var rt = Create(LoadCatalog());
            RunUntil(rt, RuntimePhase.Question);
            var left = rt.TimerRemaining();
            for (var i = 0; i < 120; i++) rt.Frame(FrameMs);
            Assert.That(rt.Phase, Is.EqualTo(RuntimePhase.Question), "frozen question advanced without Ready()");
            Assert.That(rt.TimerRemaining(), Is.EqualTo(left), "timer ran before Ready()");
            Assert.That(rt.State.Clock.Tick, Is.EqualTo(rt.Active.Moment.Tick), "canonical clock moved while frozen");

            rt.Ready();
            Assert.That(rt.Phase, Is.EqualTo(RuntimePhase.Timer));
            rt.Frame(FrameMs);
            Assert.That(rt.TimerRemaining(), Is.LessThan(left));

            var frames = 0;
            while (rt.Phase == RuntimePhase.Timer && frames++ < 100_000) rt.Frame(FrameMs);
            Assert.That(rt.Phase, Is.Not.EqualTo(RuntimePhase.Timer), "timer never expired");
            RunUntil(rt, RuntimePhase.Feedback);
            var r = rt.Active.Record;
            Assert.That(r.Decision.Band, Is.EqualTo("timeout"));
            Assert.That(r.Acted, Is.Not.Null, "timeout must still commit a canonical action");
            Assert.That(r.Acted.Actor, Is.EqualTo("engine"));
            Assert.That(r.Outcome, Is.Not.Null, "timeout action never settled");
        }

        [Test]
        public void UserAnswerIsReinstantiatedIssuedAndSettledCanonically()
        {
            var rt = Create(LoadCatalog());
            RunUntil(rt, RuntimePhase.Question);
            var m = rt.Active.Moment;
            var chosen = m.Options[2];
            rt.Ready();
            var tickBefore = rt.State.Clock.Tick;
            Assert.That(rt.Answer(chosen.Id), Is.True);
            Assert.That(rt.Phase, Is.EqualTo(RuntimePhase.Resolving));
            var res = rt.Active.Result;
            Assert.That(res.Acted, Is.Not.Null);
            Assert.That(res.Acted.Actor, Is.EqualTo("user"));
            Assert.That(res.Acted.OptionId, Is.EqualTo(chosen.Id));
            Assert.That(res.Acted.CommitTick, Is.EqualTo(tickBefore), "commit must target the frozen state");
            Assert.That(res.Acted.Command.Type, Is.EqualTo(chosen.Command.Type));

            RunUntil(rt, RuntimePhase.Feedback);
            var r = rt.Active.Record;
            Assert.That(r.Decision.Quality, Is.Not.Null);
            Assert.That(r.Decision.Quality.Value, Is.InRange(0, 1));
            Assert.That(r.Execution, Is.Not.Null);
            Assert.That(r.Outcome, Is.Not.Null);
            Assert.That(r.Outcome.Summary, Is.Not.Empty);
            Assert.That(rt.State.Clock.Tick, Is.GreaterThan(tickBefore), "consequence must come from later canonical ticks");
            Assert.That(rt.Session.Records, Does.Contain(r));

            rt.ContinueNow();
            Assert.That(rt.Phase, Is.EqualTo(RuntimePhase.Routine).Or.EqualTo(RuntimePhase.HalfTime).Or.EqualTo(RuntimePhase.Finished));
            RunUntil(rt, RuntimePhase.Question);
            Assert.That(rt.Active.Moment.Tick, Is.GreaterThan(m.Tick), "next moment must come from a later canonical state");
        }

        [Test]
        public void SaveRoundTripsAndRestoresATimerAsAFrozenQuestion()
        {
            var catalog = LoadCatalog();
            var rt = Create(catalog);
            RunUntil(rt, RuntimePhase.Question);
            rt.Ready();
            for (var i = 0; i < 30; i++) rt.Frame(FrameMs);
            Assert.That(rt.Phase, Is.EqualTo(RuntimePhase.Timer));
            var left = rt.TimerRemaining();

            var json = MatchSave.Serialize(rt, catalog.Id);
            var restored = MatchSave.Restore(json, catalog);
            Assert.That(restored.Phase, Is.EqualTo(RuntimePhase.Question), "a saved timer must come back frozen");
            Assert.That(restored.QuestionOpen, Is.True);
            Assert.That(restored.TimerRemaining(), Is.EqualTo(left).Within(1e-9));
            Assert.That(restored.Active.Moment.Options.Count, Is.EqualTo(4));
            Assert.That(restored.Active.Moment.Id, Is.EqualTo(rt.Active.Moment.Id));
            Assert.That(restored.State.Clock.Tick, Is.EqualTo(rt.State.Clock.Tick));
            Assert.That(restored.State.RngState, Is.EqualTo(rt.State.RngState));

            var again = MatchSave.Serialize(restored, catalog.Id);
            Assert.That(MatchSave.Serialize(MatchSave.Restore(again, catalog), catalog.Id), Is.EqualTo(again), "restore∘serialize is not a fixed point");
        }

        [Test]
        public void SaveRejectsWrongFormatVersionAndCatalog()
        {
            var catalog = LoadCatalog();
            var rt = Create(catalog);
            for (var i = 0; i < 60; i++) rt.Frame(FrameMs);
            var json = MatchSave.Serialize(rt, catalog.Id);
            Assert.Throws<System.FormatException>(() => MatchSave.Restore(json.Replace("\"version\":" + MatchSave.Version, "\"version\":" + (MatchSave.Version + 1)), catalog));
            Assert.Throws<System.FormatException>(() => MatchSave.Restore(json.Replace(MatchSave.Format, "some-other-format"), catalog));
            Assert.Throws<System.FormatException>(() => MatchSave.Restore(json.Replace(catalog.Id, catalog.Id + "-other"), catalog));
        }

        [Test]
        public void FullMatchReloadParityAcrossEveryPhase()
        {
            var result = RuntimeSaveChecker.Check(TacticsParityTests.CatalogJson(), 7, "RW");
            Assert.That(result.Failures, Is.Empty, string.Join("\n", result.Failures));
            Assert.That(result.Moments, Is.InRange(12, 30), "moment count outside the 15–25 band tolerance");
            Assert.That(result.Timeouts, Is.GreaterThan(0));
            Assert.That(result.Reloads, Is.GreaterThan(10));
            foreach (var p in RuntimePhases.All) Assert.That(result.PhasesSeen, Does.Contain(p), "phase never reached: " + p);
            Debug.Log($"[runtime] frames={result.Frames} moments={result.Moments} reloads={result.Reloads} comparisons={result.Comparisons}");
        }
    }
}
