using System;
using System.Collections.Generic;
using System.Globalization;
using SoccerMaster.Core.Serialization;
using SoccerMaster.Core.Sim;

namespace SoccerMaster.Tests.Parity
{
    /// <summary>
    /// Bit-for-bit check of <see cref="Fdlibm"/> against V8's results recorded by
    /// <c>tools/nativeMathFixtures.ts</c> (`fn|arg[|arg]|result` lines, "-0" preserved).
    /// </summary>
    public static class MathParityChecker
    {
        public sealed class Result
        {
            public int Cases;
            public readonly List<string> Failures = new List<string>();
            public bool Passed => Failures.Count == 0;
        }

        private static double ParseNum(string s) => s == "-0" ? -0.0 : double.Parse(s, NumberStyles.Float, CultureInfo.InvariantCulture);

        private static bool SameBits(double a, double b) =>
            BitConverter.DoubleToInt64Bits(a) == BitConverter.DoubleToInt64Bits(b) || (double.IsNaN(a) && double.IsNaN(b));

        public static Result Check(string fixtureJson)
        {
            var r = new Result();
            Dictionary<string, object> f = Json.Obj(Json.Parse(fixtureJson), "fixture");
            if (Json.Str(Json.Get(f, "generator", "fixture"), "generator") != "tools/nativeMathFixtures.ts") r.Failures.Add("unexpected generator");
            foreach (object line in Json.Arr(Json.Get(f, "cases", "fixture"), "cases"))
            {
                string[] parts = Json.Str(line, "case").Split('|');
                double a = ParseNum(parts[1]);
                double expected = ParseNum(parts[parts.Length - 1]);
                double got;
                switch (parts[0])
                {
                    case "sin": got = Fdlibm.Sin(a); break;
                    case "cos": got = Fdlibm.Cos(a); break;
                    case "acos": got = Fdlibm.Acos(a); break;
                    case "atan": got = Fdlibm.Atan(a); break;
                    case "atan2": got = Fdlibm.Atan2(a, ParseNum(parts[2])); break;
                    default: r.Failures.Add("unknown function " + parts[0]); continue;
                }
                r.Cases++;
                if (!SameBits(got, expected)) r.Failures.Add($"{parts[0]}({string.Join(", ", parts, 1, parts.Length - 2)}): V8 {expected:R}, native {got:R}");
            }
            return r;
        }
    }
}
