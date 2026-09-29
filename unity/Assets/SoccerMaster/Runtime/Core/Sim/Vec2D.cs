using System;

namespace SoccerMaster.Core.Sim
{
    /// <summary>
    /// Double-precision 2D vector in simulation metres. Port of src/sim/geometry.ts; kept as
    /// doubles so the C# core reproduces the web oracle exactly. Rendering converts to Unity
    /// floats at the view boundary only.
    /// </summary>
    public readonly struct Vec2D : IEquatable<Vec2D>
    {
        public readonly double X;
        public readonly double Y;

        public Vec2D(double x, double y)
        {
            X = x;
            Y = y;
        }

        public static readonly Vec2D Zero = new Vec2D(0, 0);

        public static Vec2D Add(Vec2D a, Vec2D b) => new Vec2D(a.X + b.X, a.Y + b.Y);
        public static Vec2D Sub(Vec2D a, Vec2D b) => new Vec2D(a.X - b.X, a.Y - b.Y);
        public static Vec2D Scale(Vec2D a, double k) => new Vec2D(a.X * k, a.Y * k);
        public static double Dot(Vec2D a, Vec2D b) => a.X * b.X + a.Y * b.Y;
        public static double Len(Vec2D a) => JsMath.Hypot(a.X, a.Y);
        public static double Dist(Vec2D a, Vec2D b) => JsMath.Hypot(a.X - b.X, a.Y - b.Y);

        public static Vec2D Lerp(Vec2D a, Vec2D b, double t) =>
            new Vec2D(a.X + (b.X - a.X) * t, a.Y + (b.Y - a.Y) * t);

        public static Vec2D Norm(Vec2D a)
        {
            double l = Len(a);
            return l < 1e-9 ? Zero : new Vec2D(a.X / l, a.Y / l);
        }

        public static Vec2D ClampLen(Vec2D a, double max)
        {
            double l = Len(a);
            return l > max ? Scale(a, max / l) : a;
        }

        public static double Clamp(double v, double lo, double hi) => Math.Min(hi, Math.Max(lo, v));

        public static Vec2D Rotate(Vec2D a, double radians)
        {
            double c = Fdlibm.Cos(radians);
            double s = Fdlibm.Sin(radians);
            return new Vec2D(a.X * c - a.Y * s, a.X * s + a.Y * c);
        }

        public static double AngleBetween(Vec2D a, Vec2D b)
        {
            double la = Len(a);
            double lb = Len(b);
            if (la < 1e-9 || lb < 1e-9) return 0;
            return Fdlibm.Acos(Clamp(Dot(a, b) / (la * lb), -1, 1));
        }

        /// <summary>Closest point on segment ab to p, as parameter t in [0,1] and the point.</summary>
        public static (double t, Vec2D point) ClosestOnSegment(Vec2D p, Vec2D a, Vec2D b)
        {
            Vec2D ab = Sub(b, a);
            double l2 = Dot(ab, ab);
            if (l2 < 1e-9) return (0, a);
            double t = Clamp(Dot(Sub(p, a), ab) / l2, 0, 1);
            return (t, Add(a, Scale(ab, t)));
        }

        public static double DistToSegment(Vec2D p, Vec2D a, Vec2D b) => Dist(p, ClosestOnSegment(p, a, b).point);

        public bool Equals(Vec2D other) => X.Equals(other.X) && Y.Equals(other.Y);
        public override bool Equals(object obj) => obj is Vec2D other && Equals(other);
        public override int GetHashCode() => unchecked(X.GetHashCode() * 397 ^ Y.GetHashCode());
        public override string ToString() => $"({X:R}, {Y:R})";
    }
}
