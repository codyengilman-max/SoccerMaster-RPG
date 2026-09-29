using System;

namespace SoccerMaster.Core.Sim
{
    /// <summary>Port of src/sim/formation.ts: the 1-3-2-3 base shape and ball-relative shape points.</summary>
    public static class Formation
    {
        /// <summary>Base shape in normalised field coordinates for a team attacking toward x = 1 (BASE_1323).</summary>
        public static Vec2D Base(int role)
        {
            switch (role)
            {
                case 1: return new Vec2D(0.06, 0.5);
                case 2: return new Vec2D(0.28, 0.2);
                case 4: return new Vec2D(0.24, 0.5);
                case 3: return new Vec2D(0.28, 0.8);
                case 6: return new Vec2D(0.42, 0.42);
                case 8: return new Vec2D(0.5, 0.6);
                case 7: return new Vec2D(0.68, 0.15);
                case 9: return new Vec2D(0.74, 0.5);
                case 11: return new Vec2D(0.68, 0.85);
                default: throw new ArgumentOutOfRangeException(nameof(role));
            }
        }

        private static Vec2D BallFollow(int role)
        {
            switch (role)
            {
                case 1: return new Vec2D(0.12, 0.15);
                case 2: return new Vec2D(0.45, 0.3);
                case 4: return new Vec2D(0.45, 0.35);
                case 3: return new Vec2D(0.45, 0.3);
                case 6: return new Vec2D(0.55, 0.4);
                case 8: return new Vec2D(0.6, 0.4);
                case 7: return new Vec2D(0.5, 0.2);
                case 9: return new Vec2D(0.45, 0.3);
                case 11: return new Vec2D(0.5, 0.2);
                default: throw new ArgumentOutOfRangeException(nameof(role));
            }
        }

        public static Vec2D ToField(Rules rules, Side side, Vec2D n)
        {
            double x = side == Side.Home ? n.X : 1 - n.X;
            double y = side == Side.Home ? n.Y : 1 - n.Y;
            return new Vec2D(x * rules.Length, y * rules.Width);
        }

        public static Vec2D BasePosition(Rules rules, Side side, int role) => ToField(rules, side, Base(role));

        /// <summary>Kickoff positions: everyone in own half, base shape compressed toward own goal.</summary>
        public static Vec2D KickoffPosition(Rules rules, Side side, int role, bool taking)
        {
            Vec2D b = Base(role);
            var n = new Vec2D(Math.Min(b.X * 0.8, 0.47), b.Y);
            if (taking && role == 9) n = new Vec2D(0.495, 0.5);
            if (taking && role == 8) n = new Vec2D(0.47, 0.55);
            return ToField(rules, side, n);
        }

        /// <summary>Ball-relative team shape: slides toward the ball per role, compresses defending, stretches attacking.</summary>
        public static Vec2D ShapePoint(Rules rules, PlayerState p, Vec2D ball, bool inPossession)
        {
            int dir = p.Side == Side.Home ? 1 : -1;
            Vec2D b = BasePosition(rules, p.Side, p.Role);
            Vec2D follow = BallFollow(p.Role);
            double dx = (ball.X - rules.Length / 2) * follow.X;
            double dy = (ball.Y - rules.Width / 2) * follow.Y;
            double x = b.X + dx;
            double y = b.Y + dy;
            if (inPossession)
            {
                if (p.Role == 7 || p.Role == 11 || p.Role == 9) x += dir * rules.Length * 0.05;
                if (p.Role == 7 || p.Role == 11) y = b.Y + dy * 0.4;
            }
            else
            {
                x -= dir * rules.Length * 0.07;
                y = rules.Width / 2 + (y - rules.Width / 2) * 0.8;
            }
            if (p.Role == 1)
            {
                double goalX = p.Side == Side.Home ? 0 : rules.Length;
                x = goalX + dir * Vec2D.Clamp(2 + Math.Abs(ball.X - goalX) * 0.08, 1.5, 8);
                y = rules.Width / 2 + (ball.Y - rules.Width / 2) * 0.35;
            }
            return new Vec2D(Vec2D.Clamp(x, 0.5, rules.Length - 0.5), Vec2D.Clamp(y, 0.5, rules.Width - 0.5));
        }
    }
}
