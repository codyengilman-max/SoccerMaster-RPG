using System;

namespace SoccerMaster.Core.Sim
{
    /// <summary>
    /// Bit-exact counterparts of the JavaScript number operations the web oracle relies on.
    /// The parity fixtures compare doubles produced by V8 against these, so the shapes of the
    /// computations (not just their mathematical meaning) mirror the ECMAScript definitions.
    /// </summary>
    public static class JsMath
    {
        /// <summary>ECMAScript ToUint32 of a double, as produced by <c>x >>> 0</c>.</summary>
        public static uint ToUint32(double v)
        {
            if (double.IsNaN(v) || double.IsInfinity(v)) return 0;
            double t = Math.Truncate(v);
            double m = t % 4294967296.0;
            if (m < 0) m += 4294967296.0;
            return (uint)m;
        }

        /// <summary><c>Math.imul(a, b) >>> 0</c>: 32-bit wrapping multiply.</summary>
        public static uint ImulU(uint a, uint b)
        {
            unchecked { return a * b; }
        }

        /// <summary>
        /// <c>Math.hypot(x, y)</c> as V8 computes it (scale by the largest magnitude, Kahan-compensated
        /// sum of squares), which differs in the last bit from <c>sqrt(x*x + y*y)</c>.
        /// </summary>
        public static double Hypot(double x, double y)
        {
            double ax = Math.Abs(x);
            double ay = Math.Abs(y);
            if (double.IsInfinity(ax) || double.IsInfinity(ay)) return double.PositiveInfinity;
            if (double.IsNaN(ax) || double.IsNaN(ay)) return double.NaN;
            double max = ax > ay ? ax : ay;
            if (max == 0) return 0;
            double sum = 0;
            double compensation = 0;
            AddSquare(ax / max, ref sum, ref compensation);
            AddSquare(ay / max, ref sum, ref compensation);
            return Math.Sqrt(sum) * max;
        }

        private static void AddSquare(double n, ref double sum, ref double compensation)
        {
            double summand = n * n - compensation;
            double preliminary = sum + summand;
            compensation = (preliminary - sum) - summand;
            sum = preliminary;
        }
    }
}
