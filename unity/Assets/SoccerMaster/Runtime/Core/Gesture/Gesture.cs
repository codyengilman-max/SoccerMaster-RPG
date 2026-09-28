using System;
using System.Collections.Generic;
using SoccerMaster.Core.Sim;

namespace SoccerMaster.Core.Gesture
{
    /// <summary>
    /// Drawing → intent precision, port of src/gesture/gesture.ts. A gesture is a pointer path in
    /// field metres. It never creates a new soccer action: the chosen option already names the
    /// intent; the drawing says how precisely the player expressed it, which the engine uses as
    /// execution noise. Nothing here knows about grading or the simulation state.
    /// </summary>
    public sealed class GestureRead
    {
        public Vec2D Origin;
        public Vec2D End;
        /// <summary>Unit vector from origin to end.</summary>
        public Vec2D Direction;
        public double Length;
        /// <summary>1 = a straight line; lower when the path wandered.</summary>
        public double Straightness;
        /// <summary>Farthest the path got from the origin (used for cancel detection).</summary>
        public double Reach;
    }

    public static class GestureReader
    {
        /// <summary>Shorter paths are taps, not drawings.</summary>
        public const double MinDrawLengthM = 1.5;
        /// <summary>Ending a drawing back inside this radius of its origin cancels it.</summary>
        public const double CancelRadiusM = 1.5;
        /// <summary>Angular error at which accuracy reaches zero.</summary>
        private const double MaxAngleError = Math.PI / 2;

        public static GestureRead ReadGesture(IReadOnlyList<Vec2D> points)
        {
            if (points.Count < 2) return null;
            Vec2D origin = points[0];
            Vec2D end = points[points.Count - 1];
            double length = Vec2D.Dist(origin, end);
            if (length < MinDrawLengthM) return null;
            double reach = 0;
            double deviation = 0;
            foreach (Vec2D p in points)
            {
                reach = Math.Max(reach, Vec2D.Dist(p, origin));
                deviation = Math.Max(deviation, Vec2D.DistToSegment(p, origin, end));
            }
            return new GestureRead
            {
                Origin = origin,
                End = end,
                Direction = Vec2D.Norm(Vec2D.Sub(end, origin)),
                Length = length,
                Straightness = Vec2D.Clamp(1 - deviation / Math.Max(length, 1), 0, 1),
                Reach = reach,
            };
        }

        /// <summary>Dragged out and back onto the origin marker: cancel, nothing is committed.</summary>
        public static bool IsCancelGesture(IReadOnlyList<Vec2D> points)
        {
            if (points.Count < 2) return false;
            Vec2D origin = points[0];
            Vec2D end = points[points.Count - 1];
            double reach = 0;
            foreach (Vec2D p in points) reach = Math.Max(reach, Vec2D.Dist(p, origin));
            return reach >= MinDrawLengthM * 2 && Vec2D.Dist(end, origin) <= CancelRadiusM;
        }

        /// <summary>
        /// How precisely the drawing expressed the intent whose target is <paramref name="anchor"/>, seen
        /// from the player. Direction dominates; length matters less because the engine, not the finger,
        /// chooses pace. Wobble costs a little.
        /// </summary>
        public static double GestureAccuracy(GestureRead g, Vec2D playerPos, Vec2D anchor)
        {
            Vec2D want = Vec2D.Sub(anchor, playerPos);
            double wantLen = Vec2D.Len(want);
            if (wantLen < 0.5) return Vec2D.Clamp(1 - Vec2D.Dist(g.End, anchor) / 6, 0, 1);
            double angle = Vec2D.AngleBetween(g.Direction, Vec2D.Norm(want));
            double directional = Vec2D.Clamp(1 - angle / MaxAngleError, 0, 1);
            double lengthRatio = g.Length / wantLen;
            double lengthScore = Vec2D.Clamp(1 - Math.Abs(Math.Log(Vec2D.Clamp(lengthRatio, 0.2, 5))) / Math.Log(4), 0, 1);
            double wobble = 0.85 + 0.15 * g.Straightness;
            return Vec2D.Clamp(directional * (0.7 + 0.3 * lengthScore) * wobble, 0, 1);
        }

        /// <summary>Accessible alternative: tap a target instead of drawing. Precision falls off with distance from the anchor.</summary>
        public static double TapAccuracy(Vec2D point, Vec2D playerPos, Vec2D anchor)
        {
            Vec2D want = Vec2D.Sub(anchor, playerPos);
            double wantLen = Vec2D.Len(want);
            if (wantLen < 0.5) return Vec2D.Clamp(1 - Vec2D.Dist(point, anchor) / 6, 0, 1);
            Vec2D toPoint = Vec2D.Sub(point, playerPos);
            double directional = Vec2D.Len(toPoint) < 0.5 ? 0 : Vec2D.Clamp(1 - Vec2D.AngleBetween(toPoint, want) / MaxAngleError, 0, 1);
            double radial = Vec2D.Clamp(1 - Vec2D.Dist(point, anchor) / Math.Max(8, wantLen * 0.6), 0, 1);
            return Vec2D.Clamp(0.6 * directional + 0.4 * radial, 0, 1);
        }
    }
}
