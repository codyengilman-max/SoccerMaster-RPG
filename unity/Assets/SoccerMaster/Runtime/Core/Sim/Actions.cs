using System;

namespace SoccerMaster.Core.Sim
{
    public sealed class KickResult
    {
        public Vec2D Velocity;
        /// <summary>0 (perfect) → 1 (badly misplayed) execution error magnitude.</summary>
        public double Error;
    }

    /// <summary>Port of src/sim/actions.ts: canonical action primitives with the engine's error model.</summary>
    public static class Actions
    {
        public const double BallFriction = 3.2;
        public const double ControlRadius = 0.9;
        public const int KickCooldownTicks = 6;

        public static double MaxKickSpeed(PlayerState p, bool shot)
        {
            double a = shot ? p.Attributes.Shooting : p.Attributes.Passing;
            double b = shot ? 13 + (a / 100) * 9 : 9 + (a / 100) * 7;
            return b * (1 - 0.15 * p.Fatigue) * (0.85 + 0.15 * (p.Attributes.Strength / 100));
        }

        /// <summary>Launch speed so a rolling ball arrives at distance d with residual speed.</summary>
        public static double SpeedForDistance(double d, double residual = 4) => Math.Sqrt(residual * residual + 2 * BallFriction * d);

        public static KickResult Kick(MatchState state, PlayerState p, Vec2D target, bool shot, Rng rng, double intentAccuracy = 1)
        {
            var opps = Perception.Opponents(state, p.Side);
            double pressure = Perception.PressureAt(p.Pos, opps);
            double d = Vec2D.Dist(p.Pos, target);
            double skill = (shot ? p.Attributes.Shooting : p.Attributes.Passing) / 100;
            double speed = shot ? MaxKickSpeed(p, true) * (0.8 + 0.2 * skill) : SpeedForDistance(d);
            speed = Math.Min(speed, MaxKickSpeed(p, shot));

            double baseErr = shot ? 0.08 : 0.05;
            double err =
                (baseErr + 0.18 * (1 - skill) + 0.06 * pressure + 0.08 * p.Fatigue + 0.06 * (1 - intentAccuracy)) *
                (0.6 + 0.4 * Math.Min(1, d / 30));
            double angleErr = rng.Gaussian() * err * 0.35;
            double speedErr = 1 + rng.Gaussian() * err * 0.5;
            Vec2D dir = Vec2D.Rotate(Vec2D.Norm(Vec2D.Sub(target, p.Pos)), angleErr);
            return new KickResult
            {
                Velocity = Vec2D.Scale(dir, Vec2D.Clamp(speed * speedErr, 2, 26)),
                Error = Vec2D.Clamp(Math.Abs(angleErr) * 3 + Math.Abs(speedErr - 1), 0, 1),
            };
        }

        /// <summary>First touch when receiving: new ball offset from the player and whether it was clean.</summary>
        public static (Vec2D offset, bool clean) FirstTouch(MatchState state, PlayerState p, double ballSpeed, Vec2D? direction, Rng rng)
        {
            var opps = Perception.Opponents(state, p.Side);
            double pressure = Perception.PressureAt(p.Pos, opps);
            double skill = p.Attributes.FirstTouch / 100;
            double difficulty = 0.05 + 0.012 * ballSpeed + 0.12 * pressure + 0.1 * p.Fatigue;
            bool clean = rng.Next() < Vec2D.Clamp(1 - difficulty * (1.4 - skill), 0.15, 0.98);
            Vec2D dir = direction.HasValue ? Vec2D.Norm(direction.Value) : Vec2D.Norm(p.Vel);
            double reach = clean ? 1 + 1.5 * skill : 2.5 + rng.Next() * 2.5;
            double wobble = clean ? 0.15 : 0.9;
            Vec2D off = Vec2D.Add(Vec2D.Scale(dir, reach), new Vec2D(rng.Gaussian() * wobble, rng.Gaussian() * wobble));
            return (off, clean);
        }

        public static bool TackleSuccess(PlayerState tackler, PlayerState carrier, Rng rng)
        {
            double t = tackler.Attributes.Tackling / 100;
            double d = carrier.Attributes.Dribbling / 100;
            double s = (tackler.Attributes.Strength - carrier.Attributes.Strength) / 200;
            double p = Vec2D.Clamp(0.32 + 0.35 * (t - d) + 0.15 * s - 0.1 * tackler.Fatigue + 0.1 * carrier.Fatigue, 0.1, 0.85);
            return rng.Next() < p;
        }

        public static double SaveChance(PlayerState keeper, double v, double d, double dOff)
        {
            double g = keeper.Attributes.Goalkeeping / 100;
            double b = 0.35 + 0.4 * g;
            double speedPenalty = Vec2D.Clamp((v - 12) / 30, 0, 0.35);
            double distBonus = Vec2D.Clamp((d - 8) / 40, 0, 0.3);
            double reachPenalty = Vec2D.Clamp(dOff / 6, 0, 0.5);
            return Vec2D.Clamp(b - speedPenalty + distBonus - reachPenalty, 0.05, 0.95);
        }
    }
}
