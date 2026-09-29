using System;
using System.Collections.Generic;

namespace SoccerMaster.Core.Sim
{
    public sealed class LaneReport
    {
        public double MinClearance;
        public PlayerState Threat;
        public double Margin;
    }

    /// <summary>Port of src/sim/perception.ts: what a player can read from the field geometry.</summary>
    public static class Perception
    {
        public static List<PlayerState> Teammates(MatchState state, Side side)
        {
            var list = new List<PlayerState>();
            foreach (PlayerState p in state.Players) if (p.Side == side) list.Add(p);
            return list;
        }

        public static List<PlayerState> Opponents(MatchState state, Side side)
        {
            var list = new List<PlayerState>();
            foreach (PlayerState p in state.Players) if (p.Side != side) list.Add(p);
            return list;
        }

        public static PlayerState PlayerById(MatchState state, string id)
        {
            foreach (PlayerState p in state.Players) if (p.Id == id) return p;
            throw new KeyNotFoundException($"unknown player {id}");
        }

        /// <summary><c>state.players.find(q => q.id === id)</c>: null when absent.</summary>
        public static PlayerState FindPlayer(MatchState state, string id)
        {
            if (id == null) return null;
            foreach (PlayerState p in state.Players) if (p.Id == id) return p;
            return null;
        }

        public static PlayerState Nearest(IReadOnlyList<PlayerState> players, Vec2D point)
        {
            PlayerState best = null;
            double bestD = double.PositiveInfinity;
            foreach (PlayerState p in players)
            {
                double d = Vec2D.Dist(p.Pos, point);
                if (d < bestD)
                {
                    bestD = d;
                    best = p;
                }
            }
            return best;
        }

        /// <summary>Effective top speed in m/s after fatigue (4.2–6.8 m/s youth range, proposal).</summary>
        public static double TopSpeed(PlayerState p)
        {
            double b = 4.2 + (p.Attributes.Pace / 100) * 2.6;
            return b * (1 - 0.3 * p.Fatigue);
        }

        public static double ArrivalTime(PlayerState p, Vec2D point)
        {
            double d = Vec2D.Dist(p.Pos, point);
            if (d < 0.3) return 0;
            double toward = Vec2D.Dot(p.Vel, Vec2D.Norm(Vec2D.Sub(point, p.Pos)));
            double v = TopSpeed(p);
            double accel = 3 + (p.Attributes.Acceleration / 100) * 3;
            double v0 = Math.Max(0, toward);
            double tAcc = Math.Max(0, (v - v0) / accel);
            double dAcc = v0 * tAcc + 0.5 * accel * tAcc * tAcc;
            if (dAcc >= d) return (-v0 + Math.Sqrt(v0 * v0 + 2 * accel * d)) / accel;
            return tAcc + (d - dAcc) / v;
        }

        /// <summary>Pressure on a point from the given opponents: 0 (free) → 1+ (tightly pressed).</summary>
        public static double PressureAt(Vec2D point, IReadOnlyList<PlayerState> opps)
        {
            double total = 0;
            foreach (PlayerState o in opps)
            {
                double d = Vec2D.Dist(o.Pos, point);
                if (d > 8) continue;
                double closing = Math.Max(0, Vec2D.Dot(o.Vel, Vec2D.Norm(Vec2D.Sub(point, o.Pos))));
                double k = Math.Max(0, 1 - d / 8);
                total += k * k * (1 + closing / 6);
            }
            return total;
        }

        /// <summary>Space score at a point: distance to nearest opponent, capped, scaled 0..1.</summary>
        public static double SpaceAt(Vec2D point, IReadOnlyList<PlayerState> opps)
        {
            double minD = double.PositiveInfinity;
            foreach (PlayerState o in opps) minD = Math.Min(minD, Vec2D.Dist(o.Pos, point));
            return Math.Min(1, minD / 12);
        }

        /// <summary>Evaluate a straight pass from a to b at the given ball speed.</summary>
        public static LaneReport LaneReport(Vec2D a, Vec2D b, double ballSpeed, IReadOnlyList<PlayerState> opps)
        {
            double minClearance = double.PositiveInfinity;
            PlayerState threat = null;
            double margin = double.PositiveInfinity;
            double total = Vec2D.Dist(a, b);
            foreach (PlayerState o in opps)
            {
                (double t, Vec2D point) c = Vec2D.ClosestOnSegment(o.Pos, a, b);
                double clearance = Vec2D.Dist(o.Pos, c.point);
                minClearance = Math.Min(minClearance, clearance);
                double ballT = (c.t * total) / Math.Max(1, ballSpeed);
                double oppT = ArrivalTime(o, c.point) + 0.15;
                double m = oppT - ballT;
                if (m < margin)
                {
                    margin = m;
                    threat = o;
                }
            }
            return new LaneReport { MinClearance = minClearance, Threat = threat, Margin = margin };
        }

        /// <summary>Progress of a point toward the attacking goal, 0..1 along the field.</summary>
        public static double Progress(Rules rules, Side side, Vec2D p) => side == Side.Home ? p.X / rules.Length : 1 - p.X / rules.Length;

        public static double DistanceToGoal(Rules rules, Side side, Vec2D p) => Vec2D.Dist(p, rules.GoalCenter(rules.AttackingGoalX(side)));

        /// <summary>Shooting angle window (radians) to the attacking goal, reduced by defenders on the line.</summary>
        public static double ShotWindow(Rules rules, Side side, Vec2D from, IReadOnlyList<PlayerState> opps)
        {
            double gx = rules.AttackingGoalX(side);
            double half = rules.GoalWidth / 2;
            var left = new Vec2D(gx, rules.Width / 2 - half);
            var right = new Vec2D(gx, rules.Width / 2 + half);
            Vec2D vL = Vec2D.Sub(left, from);
            Vec2D vR = Vec2D.Sub(right, from);
            double angle = Math.Abs(Fdlibm.Atan2(vL.Y, vL.X) - Fdlibm.Atan2(vR.Y, vR.X));
            if (angle > Math.PI) angle = 2 * Math.PI - angle;
            Vec2D center = rules.GoalCenter(gx);
            foreach (PlayerState o in opps)
            {
                double d = Vec2D.DistToSegment(o.Pos, from, center);
                if (d < 1.2 && Vec2D.Len(Vec2D.Sub(o.Pos, from)) < Vec2D.Len(Vec2D.Sub(center, from))) angle *= 0.55;
            }
            return angle;
        }

        /// <summary>Ball friction (m/s²) used to predict a rolling ball; kept equal to Actions.BallFriction.</summary>
        public const double RollingFriction = 3.2;

        public static Vec2D BallPositionAt(BallState ball, double t)
        {
            double v = Vec2D.Len(ball.Vel);
            if (v < 1e-6) return ball.Pos;
            double tStop = v / RollingFriction;
            double tt = Math.Min(t, tStop);
            double s = v * tt - 0.5 * RollingFriction * tt * tt;
            return Vec2D.Add(ball.Pos, Vec2D.Scale(Vec2D.Norm(ball.Vel), s));
        }

        /// <summary>Earliest point on the ball's path the player reaches no later than the ball; else the stopping point.</summary>
        public static (Vec2D point, double t) InterceptPoint(PlayerState p, BallState ball, double horizon = 3)
        {
            for (double t = 0; t <= horizon; t += 0.05)
            {
                Vec2D point = BallPositionAt(ball, t);
                if (ArrivalTime(p, point) <= t + 0.02) return (point, t);
            }
            Vec2D end = BallPositionAt(ball, horizon);
            return (end, ArrivalTime(p, end));
        }
    }
}
