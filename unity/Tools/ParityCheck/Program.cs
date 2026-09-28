using System;
using System.IO;
using System.Text.Json;
using SoccerMaster.Tests.Parity;

namespace SoccerMaster.Tools.ParityCheck
{
    internal static class Program
    {
        private static int Main(string[] args)
        {
            string path = args.Length > 0
                ? args[0]
                : Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../Assets/SoccerMaster/Tests/Fixtures/first_touch_parity.json"));
            if (!File.Exists(path))
            {
                Console.Error.WriteLine($"fixture not found: {path}");
                return 2;
            }
            var options = new JsonSerializerOptions { IncludeFields = true };
            ParityFixture fixture = JsonSerializer.Deserialize<ParityFixture>(File.ReadAllText(path), options);
            ParityChecker.Result result = ParityChecker.Check(fixture);
            Console.WriteLine($"fixture: {path}");
            Console.WriteLine($"generator: {fixture.generator}; runs={fixture.runs.Count} gestures={fixture.gestures.Count} taps={fixture.taps.Count}");
            Console.WriteLine($"comparisons: {result.Comparisons}; failures: {result.Failures.Count}");
            int shown = 0;
            foreach (string failure in result.Failures)
            {
                Console.WriteLine("  " + failure);
                if (++shown >= 40)
                {
                    Console.WriteLine($"  ... {result.Failures.Count - shown} more");
                    break;
                }
            }
            Console.WriteLine(result.Passed ? "PARITY OK" : "PARITY FAILED");
            return result.Passed ? 0 : 1;
        }
    }
}
