using System;
using System.Collections.Generic;
using System.Linq;
using SoccerMaster.Core.Gesture;
using SoccerMaster.Core.Sim;
using SoccerMaster.Core.Training;

namespace SoccerMaster.Tests.Parity
{
    /// <summary>
    /// Replays the web-generated fixture through the C# port and reports every divergence. Host
    /// agnostic: the Unity EditMode test and the dotnet pre-check both call <see cref="Check"/>.
    /// Doubles are compared exactly (the port is meant to be bit-for-bit with V8) except where the
    /// oracle's own arithmetic order is not reproducible, where a tolerance is named explicitly.
    /// </summary>
    public static class ParityChecker
    {
        /// <summary>Kinematics accumulate through Math.hypot/trig; allow last-ulp drift only.</summary>
        private const double Eps = 1e-9;

        public sealed class Result
        {
            public readonly List<string> Failures = new List<string>();
            public int Comparisons;
            public bool Passed => Failures.Count == 0;
        }

        public static Result Check(ParityFixture f)
        {
            var r = new Result();
            CheckGates(f, r);
            foreach (RngDto rng in f.rng) CheckRng(rng, r);
            foreach (RunDto run in f.runs) CheckRun(run, r);
            for (int i = 0; i < f.gestures.Count; i++) CheckGesture(f.gestures[i], i, r);
            for (int i = 0; i < f.taps.Count; i++) CheckTap(f.taps[i], i, r);
            return r;
        }

        private static void Expect(Result r, string where, double expected, double actual, double eps = 0)
        {
            r.Comparisons++;
            if (double.IsNaN(expected) != double.IsNaN(actual) || Math.Abs(expected - actual) > eps)
                r.Failures.Add($"{where}: expected {expected:R}, got {actual:R}");
        }

        private static void Expect(Result r, string where, string expected, string actual)
        {
            r.Comparisons++;
            if (expected != actual) r.Failures.Add($"{where}: expected '{expected}', got '{actual}'");
        }

        private static void Expect(Result r, string where, bool expected, bool actual)
        {
            r.Comparisons++;
            if (expected != actual) r.Failures.Add($"{where}: expected {expected}, got {actual}");
        }

        private static void CheckGates(ParityFixture f, Result r)
        {
            Expect(r, "gates.count", f.gates.Count.ToString(), FirstTouchDrill.Gates.Count.ToString());
            for (int i = 0; i < Math.Min(f.gates.Count, FirstTouchDrill.Gates.Count); i++)
            {
                GateDto e = f.gates[i];
                Gate g = FirstTouchDrill.Gates[i];
                Expect(r, $"gates[{i}].id", e.id, FirstTouchDrill.Name(g.Id));
                Expect(r, $"gates[{i}].center.x", e.cx, g.Center.X);
                Expect(r, $"gates[{i}].center.y", e.cy, g.Center.Y);
                Expect(r, $"gates[{i}].a.x", e.ax, g.A.X);
                Expect(r, $"gates[{i}].a.y", e.ay, g.A.Y);
                Expect(r, $"gates[{i}].b.x", e.bx, g.B.X);
                Expect(r, $"gates[{i}].b.y", e.by, g.B.Y);
            }
        }

        private static void CheckRng(RngDto e, Result r)
        {
            var rng = new Rng(e.seed);
            string tag = $"rng[seed={e.seed:R}]";
            for (int i = 0; i < e.next.Count; i++) Expect(r, $"{tag}.next[{i}]", e.next[i], rng.Next());
            for (int i = 0; i < e.ints.Count; i++) Expect(r, $"{tag}.int[{i}]", e.ints[i], rng.Int(0, 6));
            for (int i = 0; i < e.gaussians.Count; i++) Expect(r, $"{tag}.gaussian[{i}]", e.gaussians[i], rng.Gaussian());
            Expect(r, $"{tag}.state", e.state, rng.Snapshot());
        }

        private static void CheckRun(RunDto e, Result r)
        {
            string tag = $"run[seed={e.seed:R},policy={e.policy},step={e.stepMs:R}]";
            var d = new FirstTouchDrill(e.seed, e.reps, e.accessible);
            CheckFrame(r, $"{tag}.frame[0]", e.frames[0], d, d.Events.Select(ev => ev.TypeName).ToList());
            for (int i = 1; i < e.frames.Count; i++)
            {
                if (d.Phase == Phase.Done)
                {
                    r.Failures.Add($"{tag}.frame[{i}]: port finished early (oracle has {e.frames.Count} frames)");
                    break;
                }
                List<string> events = d.Step(e.stepMs).Select(ev => ev.TypeName).ToList();
                if (events.Contains("window_open"))
                {
                    RepRecord rec = d.Current;
                    GateId? gate = null;
                    double accuracy = 0;
                    if (e.policy == "best")
                    {
                        gate = rec.BestGate;
                        accuracy = 0.9;
                    }
                    else if (e.policy == "worst")
                    {
                        Dictionary<GateId, double> o = FirstTouchDrill.Openness(rec.DefenderFrom);
                        gate = FirstTouchDrill.Gates.Select(g => g.Id).OrderBy(id => o[id]).First();
                        accuracy = 0.2;
                    }
                    if (gate.HasValue)
                    {
                        RepRecord committed = d.CommitGate(gate.Value, accuracy);
                        events.Add($"commit:{FirstTouchDrill.Name(gate.Value)}:{(committed == null ? "null" : FirstTouchDrill.Name(committed.Decision))}");
                    }
                }
                CheckFrame(r, $"{tag}.frame[{i}]", e.frames[i], d, events);
            }
            if (d.Phase != Phase.Done) r.Failures.Add($"{tag}: port did not finish after {e.frames.Count} frames (phase {d.Phase})");

            Expect(r, $"{tag}.records.count", e.records.Count.ToString(), d.Records.Count.ToString());
            for (int i = 0; i < Math.Min(e.records.Count, d.Records.Count); i++)
            {
                RecordDto x = e.records[i];
                RepRecord a = d.Records[i];
                string t = $"{tag}.records[{i}]";
                Expect(r, $"{t}.index", x.index.ToString(), a.Index.ToString());
                Expect(r, $"{t}.defenderFrom.x", x.defenderFromX, a.DefenderFrom.X);
                Expect(r, $"{t}.defenderFrom.y", x.defenderFromY, a.DefenderFrom.Y);
                Expect(r, $"{t}.bestGate", x.bestGate, FirstTouchDrill.Name(a.BestGate));
                Expect(r, $"{t}.chosenGate", x.chosenGate, a.ChosenGate.HasValue ? FirstTouchDrill.Name(a.ChosenGate.Value) : "");
                Expect(r, $"{t}.decision", x.decision, FirstTouchDrill.Name(a.Decision));
                Expect(r, $"{t}.accuracy", x.accuracy, a.Accuracy);
                Expect(r, $"{t}.execution", x.execution, FirstTouchDrill.Name(a.Execution));
                Expect(r, $"{t}.outcome", x.outcome, FirstTouchDrill.Name(a.Outcome));
            }

            DrillSummary s = d.Summarize();
            SummaryDto y = e.summary;
            Expect(r, $"{tag}.summary.reps", y.reps.ToString(), s.Reps.ToString());
            Expect(r, $"{tag}.summary.decisions", $"{y.strong}/{y.acceptable}/{y.weak}/{y.timeout}", $"{s.Strong}/{s.Acceptable}/{s.Weak}/{s.Timeout}");
            Expect(r, $"{tag}.summary.executions", $"{y.clean}/{y.ok}/{y.loose}", $"{s.Clean}/{s.Ok}/{s.Loose}");
            Expect(r, $"{tag}.summary.outcomes", $"{y.through}/{y.wide}/{y.intercepted}", $"{s.Through}/{s.Wide}/{s.Intercepted}");
            Expect(r, $"{tag}.summary.meanAccuracy", y.meanAccuracy, s.MeanAccuracy);
            Expect(r, $"{tag}.summary.reads", y.reads, FirstTouchDrill.Name(s.Reads));
            Expect(r, $"{tag}.summary.touch", y.touch, FirstTouchDrill.Name(s.Touch));
        }

        private static void CheckFrame(Result r, string tag, FrameDto e, FirstTouchDrill d, List<string> events)
        {
            Expect(r, $"{tag}.timeMs", e.timeMs.ToString(), d.TimeMs.ToString());
            Expect(r, $"{tag}.phase", e.phase, FirstTouchDrill.Name(d.Phase));
            Expect(r, $"{tag}.windowMs", e.windowMs, d.WindowOpenMs, Eps);
            Expect(r, $"{tag}.acc", e.acc, d.Acc, Eps);
            Expect(r, $"{tag}.rngState", e.rngState, d.RngState);
            Expect(r, $"{tag}.ball.x", e.ballX, d.BallPos.X, Eps);
            Expect(r, $"{tag}.ball.y", e.ballY, d.BallPos.Y, Eps);
            Expect(r, $"{tag}.ball.vx", e.ballVx, d.BallVel.X, Eps);
            Expect(r, $"{tag}.ball.vy", e.ballVy, d.BallVel.Y, Eps);
            Expect(r, $"{tag}.player.x", e.playerX, d.Player.X, Eps);
            Expect(r, $"{tag}.player.y", e.playerY, d.Player.Y, Eps);
            Expect(r, $"{tag}.defender.x", e.defenderX, d.DefenderPos.X, Eps);
            Expect(r, $"{tag}.defender.y", e.defenderY, d.DefenderPos.Y, Eps);
            Expect(r, $"{tag}.events", string.Join(",", e.events), string.Join(",", events));
        }

        private static void CheckGesture(GestureDto e, int i, Result r)
        {
            string tag = $"gesture[{i}]";
            List<Vec2D> pts = e.points.Select(p => new Vec2D(p.x, p.y)).ToList();
            GestureRead g = GestureReader.ReadGesture(pts);
            Expect(r, $"{tag}.valid", e.valid, g != null);
            if (g != null)
            {
                Expect(r, $"{tag}.direction.x", e.directionX, g.Direction.X, Eps);
                Expect(r, $"{tag}.direction.y", e.directionY, g.Direction.Y, Eps);
                Expect(r, $"{tag}.length", e.length, g.Length, Eps);
                Expect(r, $"{tag}.straightness", e.straightness, g.Straightness, Eps);
                Expect(r, $"{tag}.reach", e.reach, g.Reach, Eps);
            }
            Expect(r, $"{tag}.cancel", e.cancel, GestureReader.IsCancelGesture(pts));
            DrawRead d = FirstTouchDrill.ReadDraw(pts);
            Expect(r, $"{tag}.gate", e.gate, d.Gate.HasValue ? FirstTouchDrill.Name(d.Gate.Value) : "");
            Expect(r, $"{tag}.accuracy", e.accuracy, d.Accuracy, Eps);
        }

        private static void CheckTap(TapDto e, int i, Result r)
        {
            DrawRead d = FirstTouchDrill.ReadTap(new Vec2D(e.x, e.y));
            Expect(r, $"tap[{i}].gate", e.gate, d.Gate.HasValue ? FirstTouchDrill.Name(d.Gate.Value) : "");
            Expect(r, $"tap[{i}].accuracy", e.accuracy, d.Accuracy, Eps);
        }
    }
}
