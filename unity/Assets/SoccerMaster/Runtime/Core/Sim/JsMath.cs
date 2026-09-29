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

        /// <summary><c>Math.round</c>: halves round toward +∞ (not banker's rounding).</summary>
        public static double Round(double v)
        {
            if (double.IsNaN(v) || double.IsInfinity(v)) return v;
            double f = Math.Floor(v);
            return v - f >= 0.5 ? f + 1 : f;
        }

        /// <summary><c>Math.sign</c> for finite doubles (-1, 0, 1; NaN passes through).</summary>
        public static double Sign(double v) => double.IsNaN(v) ? v : v > 0 ? 1 : v < 0 ? -1 : v;

        /// <summary>
        /// <c>Number.prototype.toFixed(digits)</c> for |x| &lt; 1e21: the exact decimal value of the
        /// double is rounded to <paramref name="digits"/> places with ties toward +∞, computed with
        /// integer arithmetic so the result does not depend on the host's formatting routines.
        /// </summary>
        public static string ToFixed(double x, int digits)
        {
            if (double.IsNaN(x)) return "NaN";
            if (double.IsInfinity(x)) return x > 0 ? "Infinity" : "-Infinity";
            if (Math.Abs(x) >= 1e21) return x.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
            bool negative = x < 0;
            long bits = BitConverter.DoubleToInt64Bits(x);
            int exponent = (int)((bits >> 52) & 0x7FF);
            long mantissa = bits & 0xFFFFFFFFFFFFFL;
            if (exponent == 0) exponent++;
            else mantissa |= 1L << 52;
            exponent -= 1075;
            // |x| = mantissa * 2^exponent ; n = floor(|x| * 10^digits + 1/2) for x >= 0
            // JS: for negative x the sign is peeled first and the magnitude is rounded, so ties go away from zero.
            System.Numerics.BigInteger num = new System.Numerics.BigInteger(mantissa) * System.Numerics.BigInteger.Pow(10, digits);
            System.Numerics.BigInteger den = System.Numerics.BigInteger.One;
            if (exponent >= 0) num <<= exponent;
            else den <<= -exponent;
            System.Numerics.BigInteger n = System.Numerics.BigInteger.Divide(2 * num + den, 2 * den);
            string s = n.ToString();
            if (digits > 0)
            {
                if (s.Length <= digits) s = new string('0', digits - s.Length + 1) + s;
                s = s.Substring(0, s.Length - digits) + "." + s.Substring(s.Length - digits);
            }
            return negative ? "-" + s : s;
        }

        /// <summary>
        /// Stable sort with a JS-style comparator (Array.prototype.sort is stable in V8). Insertion
        /// sort: the lists sorted by the engine hold at most a few dozen entries.
        /// </summary>
        public static void StableSort<T>(System.Collections.Generic.List<T> items, Comparison<T> compare)
        {
            for (int i = 1; i < items.Count; i++)
            {
                T v = items[i];
                int j = i - 1;
                while (j >= 0 && compare(items[j], v) > 0)
                {
                    items[j + 1] = items[j];
                    j--;
                }
                items[j + 1] = v;
            }
        }
    }
}
