using System;
using SoccerMaster.Core.Sim;

namespace SoccerMaster.Core.Director
{
    /// <summary>
    /// Port of src/match/clock.ts. Presentation time → simulation ticks: the simulation only ever
    /// advances in whole 50 ms ticks; the clock decides how many a real-time frame is worth. Slow
    /// motion is the same tick function run less often, never a frozen snapshot with animation on top.
    /// </summary>
    public sealed class RuntimeClock
    {
        public const double NormalScale = 1;
        /// <summary>Skipped routine play runs this many simulated seconds per real second.</summary>
        public const double SkipScale = 180;
        /// <summary>Never run more than this many ticks in one frame (app was backgrounded, long pause...).</summary>
        public const int MaxTicksPerFrame = 24;
        /// <summary>Per-frame cap while skipping: bounded compute per frame, still ~3 s of match per frame at 60 fps.</summary>
        public const int MaxSkipTicksPerFrame = 120;

        public double Scale;
        /// <summary>Simulated milliseconds owed but not yet ticked (always in [0, TickMs)).</summary>
        public double CarryMs;
        /// <summary>Real milliseconds fed to the clock while the match was running (pauses excluded).</summary>
        public double RealElapsedMs;

        public RuntimeClock(double scale = NormalScale)
        {
            Scale = scale;
        }

        /// <summary>Convert a real frame into the number of ticks to run now. Deterministic in its inputs.</summary>
        public int Advance(double realDtMs, int maxTicks = MaxTicksPerFrame)
        {
            double dt = Math.Max(0, realDtMs);
            RealElapsedMs += dt;
            double owed = CarryMs + dt * Scale;
            int ticks = (int)Math.Floor(owed / MatchState.TickMs);
            if (ticks > maxTicks)
            {
                CarryMs = 0;
                return maxTicks;
            }
            CarryMs = owed - ticks * MatchState.TickMs;
            return ticks;
        }
    }
}
