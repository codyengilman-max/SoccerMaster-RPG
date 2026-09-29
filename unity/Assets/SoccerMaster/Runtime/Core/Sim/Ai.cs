using System;
using System.Collections.Generic;

namespace SoccerMaster.Core.Sim
{
    public enum OptionKind { Carry, Pass, Switch, Shoot, Hold }

    /// <summary>A scored alternative the carrier considered; the tactical layer reuses the same evaluation.</summary>
    public sealed class OnBallOption
    {
        public PlayerCommand Command;
        public OptionKind Kind;
        public double Score;
        public List<string> Reasons = new List<string>();
        public string Receiver;
    }

    public sealed class SecondNineRead
    {
        public bool On;
        public Vec2D? Target;
        public bool WidthProvided;
        public double FarPostSpace;
        public int RestDefense;
    }

    /// <summary>Port of src/sim/ai.ts: the engine's own on-ball evaluation and off-ball movement.</summary>
    public static class Ai
    {
        private const double PassMarginMin = 0.15;

        private static readonly double[] CarryDegrees = { 0, -35, 35, -70, 70, -110, 110 };

        public static List<OnBallOption> EvaluateOnBall(MatchState state, PlayerState p)
        {
            Rules rules = state.Rules;
            var opps = Perception.Opponents(state, p.Side);
            var mates = new List<PlayerState>();
            foreach (PlayerState m in Perception.Teammates(state, p.Side)) if (m.Id != p.Id) mates.Add(m);
            int dir = p.Side == Side.Home ? 1 : -1;
            double myProgress = Perception.Progress(rules, p.Side, p.Pos);
            double myPressure = Perception.PressureAt(p.Pos, opps);
            var options = new List<OnBallOption>();

            double dGoal = Perception.DistanceToGoal(rules, p.Side, p.Pos);
            if (dGoal < 26 && p.Role != 1)
            {
                double window = Perception.ShotWindow(rules, p.Side, p.Pos, opps);
                PlayerState keeper = null;
                foreach (PlayerState o in opps) if (o.Role == 1) { keeper = o; break; }
                Vec2D target = rules.GoalCenter(rules.AttackingGoalX(p.Side));
                Vec2D aim = target;
                if (keeper != null)
                {
                    int side = keeper.Pos.Y > rules.Width / 2 ? -1 : 1;
                    aim = new Vec2D(target.X, target.Y + side * rules.GoalWidth * 0.32);
                }
                double score = Vec2D.Clamp((window / 0.5) * (1 - dGoal / 32) * 2.2 - myPressure * 0.15, 0, 2.5);
                var opt = new OnBallOption { Command = PlayerCommand.Shoot(aim), Kind = OptionKind.Shoot, Score = score };
                opt.Reasons.Add("shot window " + JsMath.ToFixed(window * 57.3, 0) + "°");
                opt.Reasons.Add(JsMath.ToFixed(dGoal, 0) + " m from goal");
                options.Add(opt);
            }

            var forward = new Vec2D(dir, 0);
            foreach (double deg in CarryDegrees)
            {
                Vec2D d = Vec2D.Rotate(forward, (deg * Math.PI) / 180);
                double spaceAhead = Perception.SpaceAt(Vec2D.Add(p.Pos, Vec2D.Scale(d, 4)), opps);
                double distance = Vec2D.Clamp(3 + spaceAhead * 10, 3, 12);
                Vec2D end = Vec2D.Add(p.Pos, Vec2D.Scale(d, distance));
                if (end.X < 0.5 || end.X > rules.Length - 0.5 || end.Y < 0.5 || end.Y > rules.Width - 0.5) continue;
                double gain = Perception.Progress(rules, p.Side, end) - myProgress;
                double endPressure = Perception.PressureAt(end, opps);
                double space = Perception.SpaceAt(end, opps);
                double score = 0.65 + gain * 3 + space * 0.7 - endPressure * 0.5 - myPressure * 0.25;
                if (p.Role == 1) score -= 0.8;
                if (rules.InPenaltyArea(rules.DefendingGoalX(p.Side), end)) score -= 0.4;
                var opt = new OnBallOption { Command = PlayerCommand.Carry(d, distance), Kind = OptionKind.Carry, Score = score };
                opt.Reasons.Add("space " + JsMath.ToFixed(space, 2) + " ahead");
                opt.Reasons.Add("pressure " + JsMath.ToFixed(endPressure, 2) + " at end");
                if (gain > 0.04 && space > 0.4) opt.Reasons.Add("open space to attack");
                options.Add(opt);
            }

            double nearSideSpace = Perception.SpaceAt(Vec2D.Add(p.Pos, Vec2D.Scale(forward, 8)), opps);
            foreach (PlayerState m in mates)
            {
                var candidates = new List<(Vec2D point, string label)>();
                Vec2D lead = Vec2D.Add(m.Pos, Vec2D.Scale(m.Vel, 0.4));
                candidates.Add((lead, "to feet"));
                Vec2D ahead = Vec2D.Add(m.Pos, Vec2D.Scale(forward, 6));
                if (ahead.X > 1 && ahead.X < rules.Length - 1 && Perception.SpaceAt(ahead, opps) > 0.35 && Vec2D.Len(m.Vel) > 1)
                    candidates.Add((ahead, "into space ahead"));
                foreach ((Vec2D point, string label) c in candidates)
                {
                    double d = Vec2D.Dist(p.Pos, c.point);
                    if (d < 3 || d > 40) continue;
                    double speed = Actions.SpeedForDistance(d);
                    LaneReport lane = Perception.LaneReport(p.Pos, c.point, speed, opps);
                    if (lane.Margin < PassMarginMin) continue;
                    double gain = Perception.Progress(rules, p.Side, c.point) - myProgress;
                    double recvPressure = Perception.PressureAt(c.point, opps);
                    double recvSpace = Perception.SpaceAt(c.point, opps);
                    double lateral = Math.Abs(c.point.Y - p.Pos.Y);
                    bool isSwitch = lateral > rules.Width * 0.4 && recvSpace > nearSideSpace + 0.2;
                    double score =
                        0.35 + gain * 2.2 + recvSpace * 0.7 - recvPressure * 0.4 + Vec2D.Clamp(lane.Margin, 0, 1) * 0.3 - (d / 40) * 0.25;
                    if (isSwitch) score += 0.35;
                    if (myPressure > 0.8) score += 0.3;
                    if (m.Role == 1) score -= 0.6;
                    if (gain < -0.15) score -= 0.2;
                    if (d < 7) score -= 0.25;
                    var opt = new OnBallOption
                    {
                        Command = PlayerCommand.Pass(c.point, m.Id),
                        Kind = isSwitch ? OptionKind.Switch : OptionKind.Pass,
                        Score = score,
                        Receiver = m.Id,
                    };
                    opt.Reasons.Add("lane margin " + JsMath.ToFixed(lane.Margin, 2) + " s");
                    opt.Reasons.Add("receiver space " + JsMath.ToFixed(recvSpace, 2));
                    opt.Reasons.Add(c.label);
                    if (isSwitch) opt.Reasons.Add("far side more open: switch");
                    options.Add(opt);
                }
            }

            var hold = new OnBallOption { Command = PlayerCommand.Hold(), Kind = OptionKind.Hold, Score = 0.2 - myPressure * 0.3 };
            hold.Reasons.Add("keep possession, wait for support");
            options.Add(hold);

            JsMath.StableSort(options, (a, b) => Compare(b.Score - a.Score));
            return options;
        }

        /// <summary>JS comparator result (a double) → sign, as V8's sort consumes it.</summary>
        internal static int Compare(double v) => v > 0 ? 1 : v < 0 ? -1 : 0;

        // SECOND_NINE thresholds
        public const double SecondNineBallWideMin = 0.15;
        public const double SecondNineCarrierPressureMax = 0.5;
        public const double SecondNineCarrierProgressMin = 0.55;
        public const double SecondNineFarPostSpaceMin = 0.45;
        public const int SecondNineRestDefenseMin = 3;
        public const double SecondNineStrikerPinDist = 10;
        public const double SecondNineWidthLaneMin = 0.18;
        public const double SecondNineNarrowLane = 0.12;

        public static SecondNineRead SecondNineRead(MatchState state, PlayerState p)
        {
            var none = new SecondNineRead { On = false, Target = null, WidthProvided = false, FarPostSpace = 0, RestDefense = 0 };
            if (p.Role != 7 && p.Role != 11) return none;
            BallState ball = state.Ball;
            if (state.Possession != p.Side || ball.Status != BallStatus.Controlled || string.IsNullOrEmpty(ball.Owner) || ball.Owner == p.Id) return none;
            PlayerState carrier = Perception.FindPlayer(state, ball.Owner);
            if (carrier == null || carrier.Side != p.Side) return none;
            Rules rules = state.Rules;
            int dir = p.Side == Side.Home ? 1 : -1;
            double half = rules.Width / 2;
            double mySign = JsMath.Sign(Formation.BasePosition(rules, p.Side, p.Role).Y - half);
            if (mySign == 0) return none;
            double ballOffset = (ball.Pos.Y - half) * mySign;
            if (ballOffset > -rules.Width * SecondNineBallWideMin) return none;

            var opps = Perception.Opponents(state, p.Side);
            var mates = new List<PlayerState>();
            foreach (PlayerState m in Perception.Teammates(state, p.Side)) if (m.Id != p.Id && m.Role != 1) mates.Add(m);
            double lineX = LastDefenderLine(state, Sides.Other(p.Side));
            double carrierProgress = Perception.Progress(rules, p.Side, carrier.Pos);
            bool widthProvided = false;
            foreach (PlayerState m in mates)
            {
                if (JsMath.Sign(m.Pos.Y - half) == mySign && Math.Abs(m.Pos.Y - half) >= rules.Width * SecondNineWidthLaneMin && Perception.Progress(rules, p.Side, m.Pos) > 0.4)
                {
                    widthProvided = true;
                    break;
                }
            }
            int restDefense = 0;
            foreach (PlayerState m in mates) if (Perception.Progress(rules, p.Side, m.Pos) < carrierProgress - 0.05) restDefense++;
            Vec2D target = ClampField(rules, new Vec2D(lineX - dir * 1.5, half + mySign * rules.Width * SecondNineNarrowLane));
            double farPostSpace = Perception.SpaceAt(target, opps);
            PlayerState striker = null;
            foreach (PlayerState m in mates) if (m.Role == 9) { striker = m; break; }
            bool strikerPins = striker != null && Math.Abs(striker.Pos.X - lineX) < SecondNineStrikerPinDist && Math.Abs(striker.Pos.Y - half) < rules.Width * 0.2;
            bool on =
                widthProvided &&
                strikerPins &&
                Perception.PressureAt(carrier.Pos, opps) < SecondNineCarrierPressureMax &&
                carrierProgress >= SecondNineCarrierProgressMin &&
                farPostSpace >= SecondNineFarPostSpaceMin &&
                restDefense >= SecondNineRestDefenseMin &&
                Math.Abs(rules.AttackingGoalX(p.Side) - lineX) > 6;
            return new SecondNineRead { On = on, Target = target, WidthProvided = widthProvided, FarPostSpace = farPostSpace, RestDefense = restDefense };
        }

        public static PlayerCommand DecideOnBall(MatchState state, PlayerState p, Rng rng)
        {
            List<OnBallOption> options = EvaluateOnBall(state, p);
            if (options.Count == 0) return PlayerCommand.Hold();
            OnBallOption best = options[0];
            OnBallOption second = options.Count > 1 ? options[1] : null;
            double awareness = p.Attributes.Awareness / 100;
            if (second != null && best.Score - second.Score < 0.15 && rng.Next() > 0.5 + awareness * 0.4) return second.Command;
            return best.Command;
        }

        public static PlayerCommand DecideOffBall(MatchState state, PlayerState p)
        {
            Rules rules = state.Rules;
            BallState ball = state.Ball;
            bool inPossession = state.Possession == p.Side;
            var opps = Perception.Opponents(state, p.Side);
            var mates = Perception.Teammates(state, p.Side);
            int dir = p.Side == Side.Home ? 1 : -1;
            Vec2D shape = Formation.ShapePoint(rules, p, ball.Pos, inPossession);

            if (ball.Status == BallStatus.Loose && ball.PassTarget == p.Id)
                return PlayerCommand.Move(ClampField(rules, Perception.InterceptPoint(p, ball).point));

            if (ball.Status == BallStatus.Loose)
            {
                double myT = Perception.ArrivalTime(p, ball.Pos);
                int teamFaster = 0;
                foreach (PlayerState q in state.Players)
                {
                    if (q.TouchCooldown != 0 || q.Stunned != 0) continue;
                    if (q.Id == p.Id) continue;
                    if (Perception.ArrivalTime(q, ball.Pos) < myT - 0.05 && q.Side == p.Side) teamFaster++;
                }
                bool keeperOwnBox = p.Role == 1 && rules.InPenaltyArea(rules.DefendingGoalX(p.Side), ball.Pos);
                if (teamFaster == 0 || keeperOwnBox)
                    return PlayerCommand.Move(ClampField(rules, Perception.InterceptPoint(p, ball).point));
            }

            if (inPossession)
            {
                PlayerState carrier = string.IsNullOrEmpty(ball.Owner) ? null : Perception.FindPlayer(state, ball.Owner);
                if (carrier != null && carrier.Id != p.Id)
                {
                    double carrierPressure = Perception.PressureAt(carrier.Pos, opps);
                    double carrierProgress = Perception.Progress(rules, p.Side, carrier.Pos);
                    double myProgress = Perception.Progress(rules, p.Side, p.Pos);
                    bool sameFlank = JsMath.Sign(carrier.Pos.Y - rules.Width / 2) == JsMath.Sign(p.Pos.Y - rules.Width / 2);

                    if (p.Role == 9 || p.Role == 7 || p.Role == 11)
                    {
                        double lastDefX = LastDefenderLine(state, Sides.Other(p.Side));
                        var behind = new Vec2D(lastDefX + dir * 3, Vec2D.Clamp(p.Pos.Y + (rules.Width / 2 - p.Pos.Y) * 0.3, 3, rules.Width - 3));
                        double goalX = rules.AttackingGoalX(p.Side);
                        bool offsideSafe = dir > 0 ? p.Pos.X <= lastDefX + 0.3 : p.Pos.X >= lastDefX - 0.3;
                        if (offsideSafe && Math.Abs(goalX - lastDefX) > 8 && Perception.SpaceAt(behind, opps) > 0.3 && Vec2D.Dist(carrier.Pos, behind) < 35)
                            return PlayerCommand.Move(behind);
                    }
                    if (p.Role == 7 || p.Role == 11)
                    {
                        SecondNineRead nine = SecondNineRead(state, p);
                        if (nine.On && nine.Target.HasValue) return PlayerCommand.Move(nine.Target.Value);
                    }
                    if ((p.Role == 2 || p.Role == 3) && sameFlank && (carrier.Role == 7 || carrier.Role == 11))
                    {
                        double wideY = carrier.Pos.Y < rules.Width / 2 ? 2 : rules.Width - 2;
                        var target = new Vec2D(carrier.Pos.X + dir * 8, wideY);
                        if (Perception.SpaceAt(target, opps) > 0.4) return PlayerCommand.Move(target);
                    }
                    if ((p.Role == 6 || p.Role == 8) && carrierPressure > 0.7 && myProgress > carrierProgress - 0.05)
                    {
                        Vec2D target = Vec2D.Add(carrier.Pos, new Vec2D(-dir * 7, (p.Pos.Y - carrier.Pos.Y) * 0.5));
                        return PlayerCommand.Move(ClampField(rules, target));
                    }
                    if (p.Role == 6 || p.Role == 8 || (p.Role == 4 && carrierPressure > 0.9))
                    {
                        double angle = ((p.Role == 8 ? 1 : -1) * Math.PI) / 4;
                        Vec2D off = Vec2D.Rotate(new Vec2D(-dir * 8, 0), angle);
                        Vec2D target = ClampField(rules, Vec2D.Add(carrier.Pos, off));
                        return PlayerCommand.Move(Vec2D.Lerp(shape, target, 0.6));
                    }
                }
                return PlayerCommand.Move(shape);
            }

            PlayerState oppCarrier = string.IsNullOrEmpty(ball.Owner) ? null : Perception.FindPlayer(state, ball.Owner);
            Vec2D ballPoint = oppCarrier != null ? oppCarrier.Pos : ball.Pos;
            var byDist = new List<PlayerState>();
            foreach (PlayerState m in mates) if (m.Role != 1 && m.Stunned == 0) byDist.Add(m);
            JsMath.StableSort(byDist, (a, b) => Compare(Vec2D.Dist(a.Pos, ballPoint) - Vec2D.Dist(b.Pos, ballPoint)));
            PlayerState first = byDist.Count > 0 ? byDist[0] : null;
            PlayerState second = byDist.Count > 1 ? byDist[1] : null;

            if (first != null && first.Id == p.Id && oppCarrier != null)
            {
                Vec2D goalSide = Vec2D.Norm(Vec2D.Sub(rules.GoalCenter(rules.DefendingGoalX(p.Side)), oppCarrier.Pos));
                Vec2D target = Vec2D.Add(oppCarrier.Pos, Vec2D.Scale(goalSide, 0.8));
                return Vec2D.Dist(p.Pos, oppCarrier.Pos) < 1.6 ? PlayerCommand.Press(oppCarrier.Id) : PlayerCommand.Move(target);
            }
            if (second != null && second.Id == p.Id && oppCarrier != null)
            {
                Vec2D goalSide = Vec2D.Norm(Vec2D.Sub(rules.GoalCenter(rules.DefendingGoalX(p.Side)), oppCarrier.Pos));
                return PlayerCommand.Move(ClampField(rules, Vec2D.Add(oppCarrier.Pos, Vec2D.Scale(goalSide, 6))));
            }
            if (p.Role == 2 || p.Role == 3 || p.Role == 4 || p.Role == 6)
            {
                var dangerous = new List<PlayerState>();
                foreach (PlayerState o in opps)
                {
                    if (o.Role != 1 && (dir > 0 ? o.Pos.X < shape.X + 6 : o.Pos.X > shape.X - 6) && Vec2D.Dist(o.Pos, shape) < 10) dangerous.Add(o);
                }
                PlayerState runner = Perception.Nearest(dangerous, shape);
                if (runner != null)
                {
                    Vec2D goalSide = Vec2D.Norm(Vec2D.Sub(rules.GoalCenter(rules.DefendingGoalX(p.Side)), runner.Pos));
                    return PlayerCommand.Move(ClampField(rules, Vec2D.Add(runner.Pos, Vec2D.Scale(goalSide, 1.5))));
                }
            }
            return PlayerCommand.Move(shape);
        }

        /// <summary>x of the second-last defender of <paramref name="side"/> (offside line), keeper included.</summary>
        public static double LastDefenderLine(MatchState state, Side side)
        {
            var xs = new List<double>();
            foreach (PlayerState p in Perception.Teammates(state, side)) xs.Add(p.Pos.X);
            JsMath.StableSort(xs, (a, b) => Compare(a - b));
            if (side == Side.Home) return xs.Count > 1 ? xs[1] : xs.Count > 0 ? xs[0] : 0;
            return xs.Count > 1 ? xs[xs.Count - 2] : xs.Count > 0 ? xs[xs.Count - 1] : state.Rules.Length;
        }

        public static Vec2D ClampField(Rules rules, Vec2D p) => new Vec2D(Vec2D.Clamp(p.X, 0.3, rules.Length - 0.3), Vec2D.Clamp(p.Y, 0.3, rules.Width - 0.3));
    }
}
