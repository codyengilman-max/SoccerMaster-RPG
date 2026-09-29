using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using SoccerMaster.Tests.Parity;

namespace SoccerMaster.Tools.ParityCheck
{
    /// <summary>
    /// Engine-free replay of every web-generated parity fixture through the C# core.
    /// `dotnet run -- [math|first_touch|tactics|runtime|all] [fixtureDir]`; defaults to `all` against the repo fixtures.
    /// </summary>
    internal static class Program
    {
        private static int Main(string[] args)
        {
            string which = args.Length > 0 ? args[0] : "all";
            string root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../Assets/SoccerMaster"));
            string fixtures = args.Length > 1 ? args[1] : Path.Combine(root, "Tests/Fixtures");
            bool ok = true;
            if (which == "all" || which == "math") ok &= MathFns(Path.Combine(fixtures, "math_parity.json"));
            if (which == "all" || which == "first_touch") ok &= FirstTouch(Path.Combine(fixtures, "first_touch_parity.json"));
            if (which == "all" || which == "tactics") ok &= Tactics(Path.Combine(fixtures, "tactics_parity.json"), Path.Combine(root, "Resources/SoccerMaster/Catalog/provisional-u11.json"));
            if (which == "all" || which == "runtime") ok &= Runtime(Path.Combine(root, "Resources/SoccerMaster/Catalog/provisional-u11.json"));
            Console.WriteLine(ok ? "PARITY OK" : "PARITY FAILED");
            return ok ? 0 : 1;
        }

        private static bool MathFns(string path)
        {
            if (!File.Exists(path)) { Console.Error.WriteLine($"fixture not found: {path} (run `npm run native:fixtures:math`)"); return false; }
            MathParityChecker.Result result = MathParityChecker.Check(File.ReadAllText(path));
            Console.WriteLine($"fixture: {path}");
            Console.WriteLine($"cases: {result.Cases}; failures: {result.Failures.Count}");
            Print(result.Failures);
            return result.Passed;
        }

        private static bool FirstTouch(string path)
        {
            if (!File.Exists(path)) { Console.Error.WriteLine($"fixture not found: {path}"); return false; }
            var options = new JsonSerializerOptions { IncludeFields = true };
            ParityFixture fixture = JsonSerializer.Deserialize<ParityFixture>(File.ReadAllText(path), options);
            ParityChecker.Result result = ParityChecker.Check(fixture);
            Console.WriteLine($"fixture: {path}");
            Console.WriteLine($"generator: {fixture.generator}; runs={fixture.runs.Count} gestures={fixture.gestures.Count} taps={fixture.taps.Count}");
            Console.WriteLine($"comparisons: {result.Comparisons}; failures: {result.Failures.Count}");
            Print(result.Failures);
            return result.Passed;
        }

        private static bool Tactics(string path, string catalogPath)
        {
            if (!File.Exists(path)) { Console.Error.WriteLine($"fixture not found: {path} (run `npm run native:fixtures:tactics`)"); return false; }
            if (!File.Exists(catalogPath)) { Console.Error.WriteLine($"catalog not found: {catalogPath}"); return false; }
            var sw = System.Diagnostics.Stopwatch.StartNew();
            TacticsParityChecker.Result result = TacticsParityChecker.Check(File.ReadAllText(path), File.ReadAllText(catalogPath));
            Console.WriteLine($"fixture: {path}");
            Console.WriteLine($"runs={result.Runs} moments={result.Moments} commits={result.Commits} settled={result.Settled} events={result.Events} ({sw.ElapsedMilliseconds} ms)");
            Console.WriteLine($"comparisons: {result.Comparisons}; failures: {result.Failures.Count}");
            Print(result.Failures);
            return result.Passed;
        }

        private static bool Runtime(string catalogPath)
        {
            if (!File.Exists(catalogPath)) { Console.Error.WriteLine($"catalog not found: {catalogPath}"); return false; }
            string catalog = File.ReadAllText(catalogPath);
            bool ok = true;
            foreach ((int seed, string role) in new[] { (7, "RW"), (3, "CM"), (11, "GK") })
            {
                var sw = System.Diagnostics.Stopwatch.StartNew();
                RuntimeSaveChecker.Result result = RuntimeSaveChecker.Check(catalog, seed, role);
                Console.WriteLine($"runtime seed={seed} role={role}: frames={result.Frames} realSeconds={result.RealSeconds:F1} moments={result.Moments} timeouts={result.Timeouts} reloads={result.Reloads} events={result.Events} ({sw.ElapsedMilliseconds} ms)");
                Console.WriteLine($"comparisons: {result.Comparisons}; failures: {result.Failures.Count}");
                Print(result.Failures);
                ok &= result.Passed;
            }
            return ok;
        }

        private static void Print(List<string> failures)
        {
            int shown = 0;
            foreach (string failure in failures)
            {
                Console.WriteLine("  " + failure);
                if (++shown >= 40)
                {
                    Console.WriteLine($"  ... {failures.Count - shown} more");
                    break;
                }
            }
        }
    }
}
