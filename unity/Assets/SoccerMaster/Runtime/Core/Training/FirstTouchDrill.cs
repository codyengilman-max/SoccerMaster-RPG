using System;
using System.Collections.Generic;
using System.Linq;
using SoccerMaster.Core.Gesture;
using SoccerMaster.Core.Sim;

namespace SoccerMaster.Core.Training
{
    public enum GateId { Left, Forward, Right }

    public enum DecisionBand { Strong, Acceptable, Weak, Timeout }

    public enum ExecutionBand { None, Clean, Ok, Loose }

    public enum Outcome { None, Through, Wide, Intercepted }

    public enum Phase { Serve, Window, Resolve, Between, Done }

    public enum ReadsBand { Sharp, Mixed, Rushed }

    public enum TouchBand { Clean, Ok, Loose }

    public sealed class Gate
    {
        public GateId Id;
        public Vec2D Center;
        public Vec2D A;
        public Vec2D B;
    }

    public sealed class RepRecord
    {
        public int Index;
        public Vec2D DefenderFrom;
        public GateId BestGate;
        public GateId? ChosenGate;
        public DecisionBand Decision;
        public double Accuracy;
        public ExecutionBand Execution;
        public Outcome Outcome;
    }

    public enum DrillEventType { WindowOpen, Committed, Timeout, Outcome, Done }

    public readonly struct DrillEvent
    {
        public readonly DrillEventType Type;
        public readonly int Rep;
        public readonly GateId Gate;
        public readonly DecisionBand Decision;
        public readonly double Accuracy;
        public readonly Outcome Outcome;

        public DrillEvent(DrillEventType type, int rep, GateId gate = GateId.Forward, DecisionBand decision = DecisionBand.Timeout, double accuracy = 0, Outcome outcome = Outcome.None)
        {
            Type = type;
            Rep = rep;
            Gate = gate;
            Decision = decision;
            Accuracy = accuracy;
            Outcome = outcome;
        }

        /// <summary>Stable wire name matching the web oracle's event <c>type</c> strings.</summary>
        public string TypeName
        {
            get
            {
                switch (Type)
                {
                    case DrillEventType.WindowOpen: return "window_open";
                    case DrillEventType.Committed: return "committed";
                    case DrillEventType.Timeout: return "timeout";
                    case DrillEventType.Outcome: return "outcome";
                    default: return "done";
                }
            }
        }
    }

    public sealed class DrawRead
    {
        public GateId? Gate;
        public double Accuracy;
        public GestureRead Gesture;
    }

    public sealed class DrillSummary
    {
        public int Reps;
        public int Strong, Acceptable, Weak, Timeout;
        public int Clean, Ok, Loose;
        public int Through, Wide, Intercepted;
        public double MeanAccuracy;
        public ReadsBand Reads;
        public TouchBand Touch;
    }

    /// <summary>
    /// "Receive and go" — the introductory activity, port of src/training/firstTouch.ts. A server
    /// plays the ball in, one defender closes from a direction the user must read, and the first
    /// touch has to take the ball through the gate that is away from the pressure. Same three
    /// layers as a match moment: the gate chosen is the decision, the drawing is the execution,
    /// and whether the ball gets through is the outcome — graded separately. Deterministic for a
    /// seed, and bit-for-bit identical to the web oracle for the same seed and inputs.
    ///
    /// The simulation owns every position, phase and outcome; a view only reads this state.
    /// </summary>
    public sealed class FirstTouchDrill
    {
        public const double AreaLength = 24;
        public const double AreaWidth = 18;
        public static readonly Vec2D ReceivePoint = new Vec2D(10, 9);
        public static readonly Vec2D ServerPoint = new Vec2D(3, 9);
        public const int TickMs = 50;
        public const int WindowMs = 2500;
        public const double AccessibleWindowFactor = 1.5;
        /// <summary>Simulated time runs at this fraction of real time while the window is open (match clock DRILL_SLOW_SCALE).</summary>
        public const double DrillSlowScale = 0.12;
        private const double ServeSpeed = 8;
        private const double TouchSpeed = 5;
        private const double DefenderSpeed = 5;
        private const double DefenderStartDist = 8;
        /// <summary>The defender waits until the pass is on its way before closing.</summary>
        private const double DefenderClosesAtM = 5;
        private const double WindowOpensAtM = 3.5;
        private const double InterceptRadius = 1.2;
        private const double GateWidth = 4;
        private const int BetweenMs = 1200;
        private const double MaxTouchTravel = 14;
        /// <summary>Directional error of a first touch drawn with zero precision.</summary>
        private const double MaxTouchErrorRad = Math.PI / 9;
        private const double TechniqueNoiseRad = Math.PI / 45;
        /// <summary>Drawn direction must be within this angle of a gate to mean it.</summary>
        private const double GateIntentRad = Math.PI / 3.6;

        public static readonly IReadOnlyList<Gate> Gates = new[]
        {
            MakeGate(GateId.Left, new Vec2D(17, 3.5)),
            MakeGate(GateId.Forward, new Vec2D(21, 9)),
            MakeGate(GateId.Right, new Vec2D(17, 14.5)),
        };

        /// <summary>Where the defender starts, as an angle around the receive point (0 = from the server's side; ±90 = from the side).</summary>
        private static readonly double[] Approaches = new double[] { 60, -60, 90, -90, 120, -120 }.Select(deg => deg * Math.PI / 180).ToArray();

        private static Gate MakeGate(GateId id, Vec2D center)
        {
            Vec2D dir = Vec2D.Norm(Vec2D.Sub(center, ReceivePoint));
            Vec2D across = Vec2D.Scale(Vec2D.Rotate(dir, Math.PI / 2), GateWidth / 2);
            return new Gate { Id = id, Center = center, A = Vec2D.Sub(center, across), B = Vec2D.Add(center, across) };
        }

        public double Seed { get; }
        public uint RngState { get; private set; }
        public int Reps { get; }
        public int Index { get; private set; }
        public Phase Phase { get; private set; }
        /// <summary>Simulated ms since the drill began.</summary>
        public int TimeMs { get; private set; }
        /// <summary>Real ms the current window has been open.</summary>
        public double WindowOpenMs { get; private set; }
        public bool Accessible { get; }
        public Vec2D BallPos { get; private set; }
        public Vec2D BallVel { get; private set; }
        public Vec2D Player { get; private set; }
        public Vec2D DefenderPos { get; private set; }
        public Vec2D DefenderStart { get; private set; }
        public List<RepRecord> Records { get; } = new List<RepRecord>();
        /// <summary>Events emitted by the most recent <see cref="Step"/> (or by construction).</summary>
        public List<DrillEvent> Events { get; private set; } = new List<DrillEvent>();
        public double Acc { get; private set; }

        public FirstTouchDrill(double seed, int reps = 6, bool accessible = false)
        {
            var rng = new Rng(seed);
            Seed = seed;
            RngState = rng.Snapshot();
            Reps = reps;
            Index = -1;
            Phase = Phase.Between;
            TimeMs = 0;
            WindowOpenMs = 0;
            Accessible = accessible;
            BallPos = ServerPoint;
            BallVel = Vec2D.Zero;
            Player = ReceivePoint;
            DefenderPos = ReceivePoint;
            DefenderStart = ReceivePoint;
            Acc = 0;
            StartRep(rng);
            RngState = rng.Snapshot();
        }

        private void StartRep(Rng rng)
        {
            Index++;
            if (Index >= Reps)
            {
                Phase = Phase.Done;
                Events.Add(new DrillEvent(DrillEventType.Done, Index));
                return;
            }
            double angle = Approaches[rng.Int(0, Approaches.Length)];
            Vec2D from = Vec2D.Add(ReceivePoint, Vec2D.Scale(Vec2D.Rotate(new Vec2D(-1, 0), angle), DefenderStartDist));
            DefenderPos = from;
            DefenderStart = from;
            Player = ReceivePoint;
            BallPos = ServerPoint;
            BallVel = Vec2D.Scale(Vec2D.Norm(Vec2D.Sub(ReceivePoint, ServerPoint)), ServeSpeed);
            Phase = Phase.Serve;
            WindowOpenMs = 0;
            Records.Add(new RepRecord
            {
                Index = Index,
                DefenderFrom = from,
                BestGate = BestGate(from),
                ChosenGate = null,
                Decision = DecisionBand.Timeout,
                Accuracy = 0,
                Execution = ExecutionBand.None,
                Outcome = Outcome.None,
            });
        }

        /// <summary>Openness of each gate against pressure arriving from <paramref name="from"/>: 1 = directly away, −1 = straight into it.</summary>
        public static Dictionary<GateId, double> Openness(Vec2D from)
        {
            Vec2D pressure = Vec2D.Norm(Vec2D.Sub(from, ReceivePoint));
            var out_ = new Dictionary<GateId, double>();
            foreach (Gate g in Gates) out_[g.Id] = -Vec2D.Dot(Vec2D.Norm(Vec2D.Sub(g.Center, ReceivePoint)), pressure);
            return out_;
        }

        /// <summary>Gate ids ranked by openness, descending; ties keep gate order (stable, like Array.prototype.sort).</summary>
        private static List<GateId> Ranked(Dictionary<GateId, double> o) =>
            Gates.Select(g => g.Id).OrderByDescending(id => o[id]).ToList();

        public static GateId BestGate(Vec2D from) => Ranked(Openness(from))[0];

        /// <summary>Decision band for a gate: ranked by openness; near-ties with the best also count as strong.</summary>
        public static DecisionBand GradeGate(Vec2D from, GateId chosen)
        {
            Dictionary<GateId, double> o = Openness(from);
            List<GateId> ranked = Ranked(o);
            if (chosen == ranked[0] || o[ranked[0]] - o[chosen] < 0.15) return DecisionBand.Strong;
            return chosen == ranked[1] ? DecisionBand.Acceptable : DecisionBand.Weak;
        }

        public static ExecutionBand ExecutionBandFor(double accuracy) =>
            accuracy >= 0.75 ? ExecutionBand.Clean : accuracy >= 0.45 ? ExecutionBand.Ok : ExecutionBand.Loose;

        public double WindowLimitMs => WindowMs * (Accessible ? AccessibleWindowFactor : 1);
        public double WindowProgress => Phase == Phase.Window ? Vec2D.Clamp(WindowOpenMs / WindowLimitMs, 0, 1) : 0;
        public double TimeScale => Phase == Phase.Window ? DrillSlowScale : 1;
        public RepRecord Current => Index >= 0 && Index < Records.Count ? Records[Index] : null;

        /// <summary>Advance by real elapsed time; simulated time runs slower during the window. Returns events emitted.</summary>
        public List<DrillEvent> Step(double realDtMs)
        {
            Events = new List<DrillEvent>();
            if (Phase == Phase.Done) return Events;
            if (Phase == Phase.Window)
            {
                WindowOpenMs += realDtMs;
                if (WindowOpenMs >= WindowLimitMs) TimeoutRep();
            }
            Acc += realDtMs * TimeScale;
            while (Acc >= TickMs && Phase != Phase.Done)
            {
                Acc -= TickMs;
                Tick();
            }
            return Events;
        }

        private void Tick()
        {
            double dt = TickMs / 1000.0;
            TimeMs += TickMs;
            var rng = new Rng(0);
            rng.Restore(RngState);
            switch (Phase)
            {
                case Phase.Serve:
                case Phase.Window:
                {
                    BallPos = Vec2D.Add(BallPos, Vec2D.Scale(BallVel, dt));
                    if (Phase == Phase.Serve && Vec2D.Dist(BallPos, ReceivePoint) <= WindowOpensAtM)
                    {
                        Phase = Phase.Window;
                        WindowOpenMs = 0;
                        Events.Add(new DrillEvent(DrillEventType.WindowOpen, Index));
                    }
                    if (Vec2D.Dist(BallPos, ReceivePoint) <= DefenderClosesAtM) MoveDefender(dt);
                    if (Vec2D.Dist(BallPos, ReceivePoint) < 0.15 || Vec2D.Dot(BallVel, Vec2D.Sub(ReceivePoint, BallPos)) < 0)
                    {
                        BallPos = ReceivePoint;
                        if (Phase == Phase.Window) TimeoutRep();
                        else ResolveTouch(rng, GateId.Forward, 0.4);
                    }
                    break;
                }
                case Phase.Resolve:
                {
                    Vec2D prev = BallPos;
                    BallPos = Vec2D.Add(BallPos, Vec2D.Scale(BallVel, dt));
                    Player = Vec2D.Add(Player, Vec2D.Scale(Vec2D.Norm(Vec2D.Sub(BallPos, Player)), Math.Min(3.5 * dt, Vec2D.Dist(BallPos, Player))));
                    MoveDefender(dt);
                    RepRecord rec = Current;
                    Gate target = Gates.FirstOrDefault(g => rec.ChosenGate.HasValue && g.Id == rec.ChosenGate.Value) ?? Gates[1];
                    if (Vec2D.Dist(DefenderPos, BallPos) <= InterceptRadius) FinishRep(Outcome.Intercepted);
                    else if (Crosses(prev, BallPos, target.A, target.B)) FinishRep(Outcome.Through);
                    else if (Vec2D.Dist(BallPos, ReceivePoint) > MaxTouchTravel || PassedGateLine(BallPos, target)) FinishRep(Outcome.Wide);
                    break;
                }
                case Phase.Between:
                {
                    WindowOpenMs += TickMs;
                    if (WindowOpenMs >= BetweenMs) StartRep(rng);
                    break;
                }
                case Phase.Done:
                    break;
            }
            RngState = rng.Snapshot();
        }

        /// <summary>The defender runs an intercept line: toward where the ball will be, not where it is.</summary>
        private void MoveDefender(double dt)
        {
            double l = Vec2D.Dist(BallPos, DefenderPos);
            if (l < 0.05) return;
            double lead = Vec2D.Clamp(l / DefenderSpeed, 0, 1.2);
            Vec2D aim = Vec2D.Add(BallPos, Vec2D.Scale(BallVel, lead));
            Vec2D to = Vec2D.Sub(aim, DefenderPos);
            DefenderPos = Vec2D.Add(DefenderPos, Vec2D.Scale(Vec2D.Norm(to), Math.Min(DefenderSpeed * dt, Vec2D.Dist(aim, DefenderPos))));
        }

        private void TimeoutRep()
        {
            RepRecord rec = Current;
            rec.Decision = DecisionBand.Timeout;
            Events.Add(new DrillEvent(DrillEventType.Timeout, Index));
            var rng = new Rng(0);
            rng.Restore(RngState);
            ResolveTouch(rng, GateId.Forward, 0.4);
            RngState = rng.Snapshot();
        }

        /// <summary>The first touch itself: direction toward the gate, bent by imprecision and a little technique noise.</summary>
        private void ResolveTouch(Rng rng, GateId gateId, double accuracy)
        {
            RepRecord rec = Current;
            Gate g = Gates.First(x => x.Id == gateId);
            double err = (1 - accuracy) * MaxTouchErrorRad * (rng.Chance(0.5) ? 1 : -1) + rng.Gaussian() * TechniqueNoiseRad;
            BallPos = ReceivePoint;
            BallVel = Vec2D.Scale(Vec2D.Rotate(Vec2D.Norm(Vec2D.Sub(g.Center, ReceivePoint)), err), TouchSpeed);
            rec.ChosenGate = gateId;
            rec.Accuracy = accuracy;
            rec.Execution = rec.Decision == DecisionBand.Timeout ? ExecutionBand.Loose : ExecutionBandFor(accuracy);
            Phase = Phase.Resolve;
        }

        private void FinishRep(Outcome outcome)
        {
            RepRecord rec = Current;
            rec.Outcome = outcome;
            Events.Add(new DrillEvent(DrillEventType.Outcome, Index, outcome: outcome));
            Phase = Phase.Between;
            WindowOpenMs = 0;
        }

        /// <summary>Commit a gate during the window with an execution precision (0..1). Null outside the window.</summary>
        public RepRecord CommitGate(GateId gateId, double accuracy)
        {
            if (Phase != Phase.Window) return null;
            RepRecord rec = Current;
            rec.Decision = GradeGate(DefenderStart, gateId);
            double a = Vec2D.Clamp(accuracy, 0, 1);
            Events.Add(new DrillEvent(DrillEventType.Committed, Index, gateId, rec.Decision, a));
            var rng = new Rng(0);
            rng.Restore(RngState);
            ResolveTouch(rng, gateId, a);
            RngState = rng.Snapshot();
            return rec;
        }

        /// <summary>Read a drawn path (field metres) as intent + precision. Null gate: the drawing points at no gate.</summary>
        public static DrawRead ReadDraw(IReadOnlyList<Vec2D> points)
        {
            GestureRead g = GestureReader.ReadGesture(points);
            if (g == null) return new DrawRead { Gate = null, Accuracy = 0, Gesture = null };
            Gate best = null;
            double bestAngle = GateIntentRad;
            foreach (Gate gt in Gates)
            {
                double a = Vec2D.AngleBetween(g.Direction, Vec2D.Norm(Vec2D.Sub(gt.Center, ReceivePoint)));
                if (a < bestAngle)
                {
                    bestAngle = a;
                    best = gt;
                }
            }
            if (best == null) return new DrawRead { Gate = null, Accuracy = 0, Gesture = g };
            return new DrawRead { Gate = best.Id, Accuracy = GestureReader.GestureAccuracy(g, ReceivePoint, best.Center), Gesture = g };
        }

        /// <summary>Accessible alternative: tap a gate.</summary>
        public static DrawRead ReadTap(Vec2D point)
        {
            Gate best = null;
            double bestD = 5;
            foreach (Gate gt in Gates)
            {
                double dd = Vec2D.Dist(point, gt.Center);
                if (dd < bestD)
                {
                    bestD = dd;
                    best = gt;
                }
            }
            if (best == null) return new DrawRead { Gate = null, Accuracy = 0, Gesture = null };
            return new DrawRead { Gate = best.Id, Accuracy = GestureReader.TapAccuracy(point, ReceivePoint, best.Center), Gesture = null };
        }

        public DrillSummary Summarize()
        {
            var s = new DrillSummary();
            double acc = 0;
            int n = 0;
            foreach (RepRecord r in Records)
            {
                if (r.Outcome == Outcome.None) continue;
                n++;
                switch (r.Decision)
                {
                    case DecisionBand.Strong: s.Strong++; break;
                    case DecisionBand.Acceptable: s.Acceptable++; break;
                    case DecisionBand.Weak: s.Weak++; break;
                    case DecisionBand.Timeout: s.Timeout++; break;
                }
                switch (r.Execution)
                {
                    case ExecutionBand.Clean: s.Clean++; break;
                    case ExecutionBand.Ok: s.Ok++; break;
                    case ExecutionBand.Loose: s.Loose++; break;
                }
                switch (r.Outcome)
                {
                    case Outcome.Through: s.Through++; break;
                    case Outcome.Wide: s.Wide++; break;
                    case Outcome.Intercepted: s.Intercepted++; break;
                }
                acc += r.Accuracy;
            }
            int total = Math.Max(1, n);
            double strongShare = (double)s.Strong / total;
            double readShare = (double)(s.Strong + s.Acceptable) / total;
            s.Reads = strongShare >= 0.66 && s.Timeout == 0 ? ReadsBand.Sharp : readShare >= 0.5 ? ReadsBand.Mixed : ReadsBand.Rushed;
            double meanAccuracy = n > 0 ? acc / n : 0;
            s.Touch = meanAccuracy >= 0.7 ? TouchBand.Clean : meanAccuracy >= 0.45 ? TouchBand.Ok : TouchBand.Loose;
            s.Reps = n;
            s.MeanAccuracy = meanAccuracy;
            return s;
        }

        private static bool Crosses(Vec2D p0, Vec2D p1, Vec2D a, Vec2D b)
        {
            double d1 = Side(a, b, p0);
            double d2 = Side(a, b, p1);
            double d3 = Side(p0, p1, a);
            double d4 = Side(p0, p1, b);
            return d1 * d2 < 0 && d3 * d4 < 0;
        }

        private static double Side(Vec2D a, Vec2D b, Vec2D p) => (b.X - a.X) * (p.Y - a.Y) - (b.Y - a.Y) * (p.X - a.X);

        /// <summary>Ball has gone past the plane of the gate (measured along the gate's approach direction).</summary>
        private static bool PassedGateLine(Vec2D ball, Gate g)
        {
            Vec2D dir = Vec2D.Norm(Vec2D.Sub(g.Center, ReceivePoint));
            return Vec2D.Dot(Vec2D.Sub(ball, g.Center), dir) > 1.5;
        }

        public static string Name(GateId g) => g == GateId.Left ? "left" : g == GateId.Forward ? "forward" : "right";
        public static string Name(DecisionBand b) => b.ToString().ToLowerInvariant();
        public static string Name(ExecutionBand b) => b == ExecutionBand.None ? "" : b.ToString().ToLowerInvariant();
        public static string Name(Outcome o) => o == Outcome.None ? "" : o.ToString().ToLowerInvariant();
        public static string Name(Phase p) => p.ToString().ToLowerInvariant();
        public static string Name(ReadsBand b) => b.ToString().ToLowerInvariant();
        public static string Name(TouchBand b) => b.ToString().ToLowerInvariant();

        public static GateId ParseGate(string s)
        {
            switch (s)
            {
                case "left": return GateId.Left;
                case "forward": return GateId.Forward;
                case "right": return GateId.Right;
                default: throw new ArgumentException($"unknown gate '{s}'");
            }
        }
    }
}
