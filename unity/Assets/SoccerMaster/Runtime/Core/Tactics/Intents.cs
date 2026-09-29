using System;
using System.Collections.Generic;
using SoccerMaster.Core.Sim;

namespace SoccerMaster.Core.Tactics
{
    /// <summary>
    /// A catalog intent made concrete against the live field state (port of src/tactics/intents.ts).
    /// <see cref="Feasibility"/> (0..1) says how well the state supports the intent right now; it feeds
    /// option scoring and is never shown as "the right answer". <see cref="Anchor"/> is the point a
    /// drawn intent is compared against (null for non-drawn intents).
    /// </summary>
    public sealed class Instantiated
    {
        public PlayerCommand Command;
        public double Feasibility;
        public Vec2D? Anchor;
        public string Detail;
        public string Receiver;
    }

    public static class Intents
    {
        /// <summary>First element with the highest score: what <c>sort((a, b) =&gt; b.score - a.score)[0]</c> yields from a stable sort.</summary>
        private static OnBallOption Best(List<OnBallOption> options, Func<OnBallOption, bool> pred)
        {
            OnBallOption best = null;
            foreach (OnBallOption o in options)
            {
                if (!pred(o)) continue;
                if (best == null || o.Score > best.Score) best = o;
            }
            return best;
        }

        private static PlayerState NearestTo(List<PlayerState> players, Vec2D point, Func<PlayerState, bool> pred)
        {
            PlayerState best = null;
            double bestD = double.PositiveInfinity;
            foreach (PlayerState o in players)
            {
                if (!pred(o)) continue;
                double d = Vec2D.Dist(o.Pos, point);
                if (best == null || d < bestD) { best = o; bestD = d; }
            }
            return best;
        }

        private static Instantiated FromPass(OnBallOption best, double feasibility, string detail) => new Instantiated
        {
            Command = best.Command,
            Feasibility = feasibility,
            Anchor = best.Command.Target,
            Detail = detail,
            Receiver = best.Receiver,
        };

        private static string Reasons(OnBallOption o) => string.Join("; ", o.Reasons);

        public static Instantiated Instantiate(MatchState state, PlayerState p, string intent)
        {
            Rules rules = state.Rules;
            BallState ball = state.Ball;
            List<PlayerState> opps = Perception.Opponents(state, p.Side);
            int dir = p.Side == Side.Home ? 1 : -1;
            var fwd = new Vec2D(dir, 0);
            bool hasBall = ball.Status == BallStatus.Controlled && ball.Owner == p.Id;
            Vec2D ourGoal = rules.GoalCenter(rules.DefendingGoalX(p.Side));
            List<OnBallOption> options = hasBall ? Ai.EvaluateOnBall(state, p) : new List<OnBallOption>();
            PlayerState Carrier()
            {
                if (ball.Status != BallStatus.Controlled || ball.Owner == null) return null;
                return Perception.FindPlayer(state, ball.Owner);
            }
            PlayerState TeammateCarrier()
            {
                if (ball.Owner == null || ball.Owner == p.Id) return null;
                PlayerState c = Perception.FindPlayer(state, ball.Owner);
                return c != null && c.Side == p.Side ? c : null;
            }

            switch (intent)
            {
                case "attack_space":
                {
                    OnBallOption best = Best(options, o => o.Kind == OptionKind.Carry && o.Command.Type == CommandType.Carry);
                    if (best == null) return null;
                    Vec2D end = Vec2D.Add(p.Pos, Vec2D.Scale(best.Command.Direction, best.Command.Distance));
                    return new Instantiated { Command = best.Command, Feasibility = Vec2D.Clamp(Perception.SpaceAt(end, opps), 0, 1), Anchor = end, Detail = Reasons(best) };
                }
                case "draw_defender":
                {
                    PlayerState nearest = NearestTo(opps, p.Pos, o => o.Role != 1);
                    if (nearest == null || !hasBall) return null;
                    double d = Vec2D.Dist(nearest.Pos, p.Pos);
                    if (d < 2 || d > 14) return null;
                    Vec2D direction = Vec2D.Norm(Vec2D.Sub(nearest.Pos, p.Pos));
                    double distance = Vec2D.Clamp(d - 2.5, 2, 6);
                    Vec2D end = Vec2D.Add(p.Pos, Vec2D.Scale(direction, distance));
                    double gain = Perception.Progress(rules, p.Side, end) - Perception.Progress(rules, p.Side, p.Pos);
                    return new Instantiated
                    {
                        Command = PlayerCommand.Carry(direction, distance),
                        Feasibility = Vec2D.Clamp(0.5 + gain * 4, 0, 1),
                        Anchor = end,
                        Detail = $"carry at the defender {JsMath.ToFixed(d, 0)} m away to commit them",
                    };
                }
                case "through_gap":
                {
                    double myProg = Perception.Progress(rules, p.Side, p.Pos);
                    OnBallOption best = Best(options, o => o.Kind == OptionKind.Pass && o.Command.Type == CommandType.Pass && Perception.Progress(rules, p.Side, o.Command.Target) > myProg + 0.04);
                    if (best == null) return null;
                    LaneReport lane = Perception.LaneReport(p.Pos, best.Command.Target, Actions.SpeedForDistance(Vec2D.Dist(p.Pos, best.Command.Target)), opps);
                    return FromPass(best, Vec2D.Clamp(lane.Margin / 0.6, 0, 1), Reasons(best));
                }
                case "switch_play":
                {
                    OnBallOption best = Best(options, o => o.Kind == OptionKind.Switch);
                    if (best == null || best.Command.Type != CommandType.Pass) return null;
                    return FromPass(best, Vec2D.Clamp(Perception.SpaceAt(best.Command.Target, opps), 0, 1), Reasons(best));
                }
                case "recycle":
                {
                    double myProg = Perception.Progress(rules, p.Side, p.Pos);
                    OnBallOption best = Best(options, o => o.Kind == OptionKind.Pass && o.Command.Type == CommandType.Pass && Perception.Progress(rules, p.Side, o.Command.Target) <= myProg + 0.04);
                    if (best == null) return null;
                    return FromPass(best, Vec2D.Clamp(1 - Perception.PressureAt(best.Command.Target, opps), 0, 1), "keep the ball: " + Reasons(best));
                }
                case "shoot":
                {
                    OnBallOption best = null;
                    foreach (OnBallOption o in options) if (o.Kind == OptionKind.Shoot) { best = o; break; }
                    if (best == null || best.Command.Type != CommandType.Shoot) return null;
                    return new Instantiated { Command = best.Command, Feasibility = Vec2D.Clamp(best.Score / 2, 0, 1), Anchor = best.Command.Target, Detail = Reasons(best) };
                }
                case "hold_ball":
                {
                    if (!hasBall) return null;
                    return new Instantiated { Command = PlayerCommand.Hold(), Feasibility = Vec2D.Clamp(1 - Perception.PressureAt(p.Pos, opps), 0, 1), Anchor = null, Detail = "shield and wait for support" };
                }
                case "first_touch_forward":
                {
                    if (!(ball.Status == BallStatus.Loose && ball.PassTarget == p.Id)) return null;
                    Vec2D end = Vec2D.Add(p.Pos, Vec2D.Scale(fwd, 3));
                    return new Instantiated { Command = PlayerCommand.FirstTouch(fwd), Feasibility = Vec2D.Clamp(Perception.SpaceAt(end, opps), 0, 1), Anchor = end, Detail = "take the first touch forward into space" };
                }
                case "first_touch_safe":
                {
                    if (!(ball.Status == BallStatus.Loose && ball.PassTarget == p.Id)) return null;
                    PlayerState nearest = NearestTo(opps, p.Pos, o => true);
                    Vec2D away = nearest != null ? Vec2D.Norm(Vec2D.Sub(p.Pos, nearest.Pos)) : Vec2D.Scale(fwd, -1);
                    Vec2D end = Vec2D.Add(p.Pos, Vec2D.Scale(away, 3));
                    return new Instantiated { Command = PlayerCommand.FirstTouch(away), Feasibility = Vec2D.Clamp(1 - Perception.PressureAt(end, opps), 0, 1), Anchor = end, Detail = "touch away from pressure to keep the ball" };
                }
                case "run_behind":
                {
                    double lineX = Ai.LastDefenderLine(state, Sides.Other(p.Side));
                    Vec2D behind = Ai.ClampField(rules, new Vec2D(lineX + dir * 4, Vec2D.Clamp(p.Pos.Y + (rules.Width / 2 - p.Pos.Y) * 0.3, 3, rules.Width - 3)));
                    bool onside = dir > 0 ? p.Pos.X <= lineX + 0.3 : p.Pos.X >= lineX - 0.3;
                    if (!onside || Math.Abs(rules.AttackingGoalX(p.Side) - lineX) < 6) return null;
                    return new Instantiated { Command = PlayerCommand.Move(behind), Feasibility = Vec2D.Clamp(Perception.SpaceAt(behind, opps), 0, 1), Anchor = behind, Detail = "run beyond the last defender" };
                }
                case "overlap":
                {
                    PlayerState carrier = TeammateCarrier();
                    if (carrier == null) return null;
                    double wideY = carrier.Pos.Y < rules.Width / 2 ? 2 : rules.Width - 2;
                    Vec2D target = Ai.ClampField(rules, new Vec2D(carrier.Pos.X + dir * 8, wideY));
                    return new Instantiated { Command = PlayerCommand.Move(target), Feasibility = Vec2D.Clamp(Perception.SpaceAt(target, opps), 0, 1), Anchor = target, Detail = "overlap outside the carrier" };
                }
                case "support_underneath":
                {
                    PlayerState carrier = TeammateCarrier();
                    if (carrier == null) return null;
                    Vec2D target = Ai.ClampField(rules, Vec2D.Add(carrier.Pos, new Vec2D(-dir * 7, (p.Pos.Y - carrier.Pos.Y) * 0.5)));
                    return new Instantiated { Command = PlayerCommand.Move(target), Feasibility = Vec2D.Clamp(1 - Perception.PressureAt(target, opps), 0, 1), Anchor = target, Detail = "offer a safe angle behind the ball" };
                }
                case "hold_width":
                {
                    double wideY = p.Pos.Y < rules.Width / 2 ? 2.5 : rules.Width - 2.5;
                    Vec2D target = Ai.ClampField(rules, new Vec2D(p.Pos.X + dir * 2, wideY));
                    return new Instantiated { Command = PlayerCommand.Move(target), Feasibility = Vec2D.Clamp(Perception.SpaceAt(target, opps), 0, 1), Anchor = target, Detail = "stay wide to stretch the defence" };
                }
                case "narrow_inside":
                {
                    SecondNineRead nine = Ai.SecondNineRead(state, p);
                    if (!nine.On || nine.Target == null) return null;
                    return new Instantiated
                    {
                        Command = PlayerCommand.Move(nine.Target.Value),
                        Feasibility = Vec2D.Clamp(nine.FarPostSpace, 0, 1),
                        Anchor = nine.Target.Value,
                        Detail = "narrow into the far half-space as a temporary second striker",
                    };
                }
                case "hold_position":
                {
                    Vec2D shape = Formation.ShapePoint(rules, p, ball.Pos, state.Possession == p.Side);
                    return new Instantiated { Command = PlayerCommand.Move(shape), Feasibility = 0.6, Anchor = null, Detail = "keep the team shape" };
                }
                case "press":
                {
                    PlayerState carrier = Carrier();
                    if (carrier == null || carrier.Side == p.Side) return null;
                    double d = Vec2D.Dist(p.Pos, carrier.Pos);
                    if (d > 14) return null;
                    Vec2D goalSide = Vec2D.Norm(Vec2D.Sub(ourGoal, carrier.Pos));
                    PlayerCommand cmd = d < 1.6 ? PlayerCommand.Press(carrier.Id) : PlayerCommand.Move(Vec2D.Add(carrier.Pos, Vec2D.Scale(goalSide, 0.8)));
                    return new Instantiated { Command = cmd, Feasibility = Vec2D.Clamp(1 - d / 14, 0, 1), Anchor = null, Detail = $"close the carrier down ({JsMath.ToFixed(d, 0)} m)" };
                }
                case "delay":
                {
                    PlayerState carrier = Carrier();
                    if (carrier == null || carrier.Side == p.Side) return null;
                    Vec2D goalSide = Vec2D.Norm(Vec2D.Sub(ourGoal, carrier.Pos));
                    Vec2D target = Ai.ClampField(rules, Vec2D.Add(carrier.Pos, Vec2D.Scale(goalSide, 3)));
                    return new Instantiated { Command = PlayerCommand.Move(target), Feasibility = 0.7, Anchor = null, Detail = "stay goal-side, slow the carrier, no dive-in" };
                }
                case "drop":
                {
                    Vec2D target = Ai.ClampField(rules, Vec2D.Add(p.Pos, Vec2D.Scale(fwd, -6)));
                    return new Instantiated { Command = PlayerCommand.Move(target), Feasibility = 0.6, Anchor = null, Detail = "drop toward goal to protect the space behind" };
                }
                case "cover":
                {
                    PlayerState carrier = Carrier();
                    if (carrier == null || carrier.Side == p.Side) return null;
                    Vec2D goalSide = Vec2D.Norm(Vec2D.Sub(ourGoal, carrier.Pos));
                    Vec2D target = Ai.ClampField(rules, Vec2D.Add(carrier.Pos, Vec2D.Scale(goalSide, 6)));
                    return new Instantiated { Command = PlayerCommand.Move(target), Feasibility = 0.7, Anchor = null, Detail = "cover behind the pressing teammate" };
                }
                case "track_runner":
                {
                    PlayerState runner = NearestTo(opps, p.Pos, o => o.Role != 1 && o.Id != ball.Owner && Vec2D.Dist(o.Pos, p.Pos) < 12 && o.Vel.X * -dir > 0.5);
                    if (runner == null) return null;
                    Vec2D goalSide = Vec2D.Norm(Vec2D.Sub(ourGoal, runner.Pos));
                    Vec2D target = Ai.ClampField(rules, Vec2D.Add(runner.Pos, Vec2D.Scale(goalSide, 1.5)));
                    return new Instantiated { Command = PlayerCommand.Move(target), Feasibility = 0.8, Anchor = null, Detail = "go with the runner, goal-side" };
                }
                case "screen_lane":
                {
                    PlayerState carrier = Carrier();
                    if (carrier == null || carrier.Side == p.Side) return null;
                    // most dangerous receiver: opponent ahead of the carrier (toward our goal) with an open lane
                    List<PlayerState> mates = Perception.Teammates(state, p.Side);
                    PlayerState bestT = null;
                    double bestMargin = 0;
                    foreach (PlayerState o in opps)
                    {
                        if (o.Id == carrier.Id || o.Role == 1 || (o.Pos.X - carrier.Pos.X) * -dir <= 2) continue;
                        LaneReport lane = Perception.LaneReport(carrier.Pos, o.Pos, Actions.SpeedForDistance(Vec2D.Dist(carrier.Pos, o.Pos)), mates);
                        if (lane.Margin <= 0) continue;
                        if (bestT == null || lane.Margin > bestMargin) { bestT = o; bestMargin = lane.Margin; }
                    }
                    if (bestT == null) return null;
                    return new Instantiated { Command = PlayerCommand.Screen(carrier.Id, bestT.Id), Feasibility = Vec2D.Clamp(bestMargin, 0, 1), Anchor = null, Detail = $"cut the lane to their {bestT.Name}" };
                }
                case "communicate":
                    return new Instantiated { Command = PlayerCommand.Hold(), Feasibility = 0.5, Anchor = null, Detail = "hand off responsibility and hold" };
                case "keeper_sweep":
                {
                    if (p.Role != 1) return null;
                    bool ownerIsOpp = false;
                    if (ball.Status == BallStatus.Controlled) foreach (PlayerState o in opps) if (o.Id == ball.Owner) { ownerIsOpp = true; break; }
                    if (ball.Status != BallStatus.Loose && !ownerIsOpp) return null;
                    return new Instantiated
                    {
                        Command = PlayerCommand.Move(Ai.ClampField(rules, ball.Pos)),
                        Feasibility = ownerIsOpp ? 0.45 : 0.7,
                        Anchor = null,
                        Detail = ownerIsOpp ? "keep coming and smother the ball" : "come and claim the ball",
                    };
                }
                case "keeper_hold_line":
                {
                    if (p.Role != 1) return null;
                    Vec2D shape = Formation.ShapePoint(rules, p, ball.Pos, state.Possession == p.Side);
                    return new Instantiated { Command = PlayerCommand.Move(shape), Feasibility = 0.7, Anchor = null, Detail = "stay set on the line" };
                }
                case "keeper_distribute_short":
                {
                    if (p.Role != 1 || !hasBall) return null;
                    OnBallOption best = Best(options, o => o.Kind == OptionKind.Pass && o.Command.Type == CommandType.Pass && Vec2D.Dist(p.Pos, o.Command.Target) < 22);
                    if (best == null) return null;
                    return FromPass(best, Vec2D.Clamp(1 - Perception.PressureAt(best.Command.Target, opps), 0, 1), "build from the back");
                }
                case "keeper_step_up":
                {
                    if (p.Role != 1 || hasBall) return null;
                    double ourGoalX = rules.DefendingGoalX(p.Side);
                    double lineDepth = Math.Abs(Ai.LastDefenderLine(state, p.Side) - ourGoalX);
                    double depth = Vec2D.Clamp(lineDepth * 0.5, 6, rules.PenaltyAreaDepth + 2);
                    Vec2D target = Ai.ClampField(rules, new Vec2D(ourGoalX + dir * depth, rules.Width / 2 + (ball.Pos.Y - rules.Width / 2) * 0.3));
                    double spaceBehind = Perception.SpaceAt(Vec2D.Add(target, Vec2D.Scale(fwd, 3)), opps);
                    return new Instantiated { Command = PlayerCommand.Move(target), Feasibility = Vec2D.Clamp(0.3 + spaceBehind * 0.7, 0, 1), Anchor = null, Detail = $"start {JsMath.ToFixed(depth, 0)} m off the line to sweep behind the defence" };
                }
                case "keeper_near_post":
                {
                    if (p.Role != 1 || hasBall) return null;
                    double ourGoalX = rules.DefendingGoalX(p.Side);
                    int side = ball.Pos.Y >= rules.Width / 2 ? 1 : -1;
                    Vec2D target = Ai.ClampField(rules, new Vec2D(ourGoalX + dir * 1.2, rules.Width / 2 + side * (rules.GoalWidth / 2 - 0.6)));
                    double wide = Math.Abs(ball.Pos.Y - rules.Width / 2) / (rules.Width / 2);
                    return new Instantiated { Command = PlayerCommand.Move(target), Feasibility = Vec2D.Clamp(wide, 0, 1), Anchor = null, Detail = "get to the near post before the ball arrives" };
                }
                case "keeper_distribute_long":
                {
                    if (p.Role != 1 || !hasBall) return null;
                    OnBallOption best = Best(options, o => o.Kind != OptionKind.Shoot && o.Command.Type == CommandType.Pass && Vec2D.Dist(p.Pos, o.Command.Target) >= 22);
                    if (best == null) return null;
                    return FromPass(best, Vec2D.Clamp(Perception.SpaceAt(best.Command.Target, opps), 0, 1), "go long past the press");
                }
                default:
                    throw new ArgumentException($"unknown intent {intent}");
            }
        }
    }
}
