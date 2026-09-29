using System;
using System.Collections.Generic;
using SoccerMaster.Core.Sim;

namespace SoccerMaster.Core.Tactics
{
    /// <summary>Official-match direct-involvement policy (port of DirectPolicy in src/tactics/recognition.ts).</summary>
    public sealed class DirectPolicy
    {
        public int MinOptions;
        public int MaxOptions;
        public List<string> OffBall = new List<string>();
        public int MaxOffBall;
        public int MaxPerEntry;
        public int FirstContactTicks;
        /// <summary>Fill a short answer window with the role's other legitimate plays (web <c>fillFromRole</c>).</summary>
        public bool FillFromRole;

        public DirectPolicy Clone()
        {
            var c = (DirectPolicy)MemberwiseClone();
            c.OffBall = new List<string>(OffBall);
            return c;
        }
    }

    public sealed class PacingConfig
    {
        public int TotalLo, TotalHi;
        public int OnBallLo, OnBallHi;
        public double MinGapSeconds;
        public double RepeatGapSeconds;
        /// <summary>Present: direct-involvement selection. Null: the legacy metered mix.</summary>
        public DirectPolicy Direct;

        public PacingConfig Clone()
        {
            var c = (PacingConfig)MemberwiseClone();
            c.Direct = Direct?.Clone();
            return c;
        }

        public static readonly int[] DirectRange = { 12, 18 };

        /// <summary>Legacy metered mix kept for headless tooling.</summary>
        public static PacingConfig Default() => new PacingConfig { TotalLo = 18, TotalHi = 25, OnBallLo = 10, OnBallHi = 14, MinGapSeconds = 60, RepeatGapSeconds = 180 };

        public static PacingConfig GkLegacy() => new PacingConfig { TotalLo = 18, TotalHi = 25, OnBallLo = 7, OnBallHi = 12, MinGapSeconds = 60, RepeatGapSeconds = 180 };

        public static PacingConfig DirectPacing() => new PacingConfig
        {
            TotalLo = DirectRange[0], TotalHi = DirectRange[1], OnBallLo = DirectRange[0], OnBallHi = DirectRange[1],
            MinGapSeconds = 45, RepeatGapSeconds = 60,
            Direct = new DirectPolicy { MinOptions = 3, MaxOptions = 6, OffBall = new List<string> { "defending" }, MaxOffBall = 3, MaxPerEntry = 6, FirstContactTicks = 6 },
        };

        public static PacingConfig GkDirectPacing() => new PacingConfig
        {
            TotalLo = DirectRange[0], TotalHi = DirectRange[1], OnBallLo = 2, OnBallHi = DirectRange[1],
            MinGapSeconds = 30, RepeatGapSeconds = 150,
            Direct = new DirectPolicy { MinOptions = 3, MaxOptions = 6, OffBall = new List<string> { "defending", "transition", "off_ball" }, MaxOffBall = DirectRange[1], MaxPerEntry = 5, FirstContactTicks = 6 },
        };

        /// <summary>Official-match pacing for a role (web pacingFor).</summary>
        public static PacingConfig For(string role) => role == "GK" ? GkDirectPacing() : DirectPacing();

        /// <summary>
        /// The native slice shows exactly four answers (web <c>fourAnswerPacingFor</c>): the same
        /// direct-involvement policy with the window pinned to four, filled from the role's other
        /// legitimate plays when the triggering entry offers fewer in the current state.
        /// </summary>
        public static PacingConfig NativeFour(string role)
        {
            PacingConfig p = For(role);
            p.Direct.MinOptions = 4;
            p.Direct.MaxOptions = 4;
            p.Direct.FillFromRole = true;
            return p;
        }
    }

    public sealed class RecognizerState
    {
        public double LastMomentTick = double.NegativeInfinity;
        public Dictionary<string, int> LastByEntry = new Dictionary<string, int>();
        public Dictionary<string, int> UsesByEntry = new Dictionary<string, int>();
        public int Count;
        public int OnBallCount;
        public Dictionary<string, int> ByCategory = new Dictionary<string, int> { { "on_ball", 0 }, { "off_ball", 0 }, { "defending", 0 }, { "transition", 0 } };
        public int Seq;
        /// <summary>Tick the controlled player's current possession spell began; -1 when not in possession.</summary>
        public int ControlSinceTick = -1;
    }

    public sealed class RecognitionResult
    {
        public TacticalMoment Moment;
        /// <summary>Why recognition declined this tick (web RejectReason), or null when a moment opened.</summary>
        public string Reject;
    }

    /// <summary>
    /// Turns the live simulation into tactical moments for the controlled player (port of
    /// src/tactics/recognition.ts). Moments emerge from eligible field states matched against the
    /// catalog; pacing keeps the count near the target band without manufacturing situations.
    /// </summary>
    public static class Recognition
    {
        /// <summary>Weight of the engine's own view when an answer is on the ball (web ENGINE_GAP_WEIGHT).</summary>
        public const double EngineGapWeight = 0.8;

        public static (double score, List<string> reasons) ScoreAction(CatalogEntry entry, string actionId, FieldRead read, double feasibility)
        {
            CatalogAction a = null;
            foreach (CatalogAction x in entry.Actions) if (x.Id == actionId) { a = x; break; }
            if (a == null) return (double.NegativeInfinity, new List<string>());
            double score = a.Base + feasibility * 0.8;
            var reasons = new List<string>();
            foreach (Criterion c in a.Eval)
            {
                if (Condition.AllHold(read, c.When))
                {
                    score += c.Add;
                    reasons.Add(c.Why);
                }
            }
            return (score, reasons);
        }

        /// <summary>Build the concrete, scored options for <paramref name="entry"/> in the current state.</summary>
        public static List<TacticalOption> BuildOptions(MatchState state, PlayerState p, CatalogEntry entry, FieldRead read, string momentId)
        {
            var options = new List<TacticalOption>();
            var seen = new HashSet<string>();
            List<OnBallOption> engine = read.HasBall == 1 ? Ai.EvaluateOnBall(state, p) : new List<OnBallOption>();
            double engineBest = double.NegativeInfinity;
            foreach (OnBallOption o in engine) engineBest = Math.Max(engineBest, o.Score);
            foreach (CatalogAction a in entry.Actions)
            {
                Instantiated inst = Intents.Instantiate(state, p, a.Intent);
                if (inst == null) continue;
                string key = inst.Command.Key();
                if (!seen.Add(key)) continue;
                (double score, List<string> reasons) = ScoreAction(entry, a.Id, read, inst.Feasibility);
                OnBallOption own = null;
                foreach (OnBallOption o in engine) if (o.Command.Key() == key) { own = o; break; }
                if (own != null && engineBest > own.Score)
                {
                    double gap = engineBest - own.Score;
                    score -= EngineGapWeight * gap;
                    if (gap > 0.5) reasons.Add("a clearly better play was on from here");
                }
                reasons.Add(inst.Detail);
                options.Add(new TacticalOption
                {
                    Id = momentId + ":" + a.Id,
                    ActionId = a.Id,
                    Label = a.Label,
                    Intent = a.Intent,
                    Drawn = Catalog.DrawnIntents.Contains(a.Intent),
                    Command = inst.Command,
                    Anchor = inst.Anchor,
                    Score = score,
                    Feasibility = inst.Feasibility,
                    Reasons = reasons,
                    Receiver = inst.Receiver,
                });
            }
            return options;
        }

        public static Difficulty DifficultyOf(List<TacticalOption> options, FieldRead read)
        {
            var sorted = new List<TacticalOption>(options);
            JsMath.StableSort(sorted, (a, b) => b.Score.CompareTo(a.Score));
            double best = sorted.Count > 0 ? sorted[0].Score : 0;
            double second = sorted.Count > 1 ? sorted[1].Score : best;
            double clarity = Vec2D.Clamp((best - second) / 0.8, 0, 1);
            int alternatives = options.Count;
            double score = Vec2D.Clamp(0.45 * (1 - clarity) + 0.35 * read.Pressure + 0.1 * Vec2D.Clamp((alternatives - 2) / 2.0, 0, 1) + 0.1 * Vec2D.Clamp(1 - read.NearestOppDist / 10, 0, 1), 0, 1);
            string band = score < 0.35 ? "easy" : score < 0.65 ? "medium" : "hard";
            return new Difficulty { Band = band, Clarity = clarity, Pressure = read.Pressure, Alternatives = alternatives, Score = score };
        }

        private static bool IsMajor(CatalogEntry entry, FieldRead read, MatchState state)
        {
            bool late = state.Clock.TimeMs > state.Rules.Halves * state.Rules.HalfLengthSeconds * 1000 - 5 * 60_000;
            return entry.Phase == "final_third" || read.BallInOurBox == 1 || read.ShotWindow > 0.3 || (late && Math.Abs(read.ScoreDiff) <= 1);
        }

        private struct Allowance
        {
            public bool OnBall, Other, AnyTickOfControl, IgnoreEntryCap;
        }

        private static Allowance DirectAllowance(RecognizerState rec, MatchState state, PacingConfig pacing, DirectPolicy policy)
        {
            double totalS = state.Rules.Halves * state.Rules.HalfLengthSeconds;
            double elapsedS = state.Clock.TimeMs / 1000;
            double frac = Vec2D.Clamp(elapsedS / totalS, 0, 1);
            int lo = pacing.TotalLo, hi = pacing.TotalHi;
            double target = lo + (hi - lo) * 0.8;
            double expected = target * frac;
            double remainingS = Math.Max(1, totalS - elapsedS);
            bool behind = rec.Count < expected - 1.5;
            bool ahead = rec.Count > expected + 1.5;
            double sinceLast = (state.Clock.Tick - rec.LastMomentTick) * 0.05;
            int shortfall = lo - rec.Count;
            bool urgent = shortfall > 0 && remainingS / shortfall < 150;
            bool relaxed = behind || urgent;
            double onGap = urgent ? 3 : behind ? 10 : ahead ? pacing.MinGapSeconds * 2.5 : pacing.MinGapSeconds;
            bool room = rec.Count < hi && (rec.Count < Math.Ceiling(expected) + 3 || frac > 0.9);
            bool onBall = room && sinceLast >= onGap;
            int offCount = rec.Count - rec.OnBallCount;
            double offGap = urgent ? 12 : behind ? 20 : pacing.MinGapSeconds * 1.5;
            bool keeper = policy.OffBall.Count > 1;
            bool other = room && offCount < policy.MaxOffBall && sinceLast >= offGap && (keeper ? !ahead || urgent : relaxed);
            return new Allowance { OnBall = onBall, Other = other, AnyTickOfControl = relaxed, IgnoreEntryCap = relaxed };
        }

        private static Allowance LegacyAllowance(RecognizerState rec, MatchState state, PacingConfig pacing)
        {
            double total = state.Rules.Halves * state.Rules.HalfLengthSeconds;
            double frac = Vec2D.Clamp(state.Clock.TimeMs / 1000 / total, 0, 1);
            double totalMid = (pacing.TotalLo + pacing.TotalHi) / 2.0;
            double onMid = (pacing.OnBallLo + pacing.OnBallHi) / 2.0;
            int otherCount = rec.Count - rec.OnBallCount;
            double sinceLast = (state.Clock.Tick - rec.LastMomentTick) * 0.05;
            bool onBall = rec.OnBallCount < pacing.OnBallHi && rec.OnBallCount <= onMid * frac + 2 && sinceLast >= pacing.MinGapSeconds * 0.1;
            bool other = otherCount <= (totalMid - onMid) * frac + 1 && sinceLast >= pacing.MinGapSeconds;
            if (!other && rec.Count < totalMid * frac - 2 && sinceLast >= pacing.MinGapSeconds) other = true;
            return new Allowance { OnBall = onBall, Other = other, AnyTickOfControl = true, IgnoreEntryCap = true };
        }

        private static int TicksSinceResume(MatchState state)
        {
            for (int i = state.Events.Count - 1; i >= 0; i--)
            {
                MatchEvent e = state.Events[i];
                if (e.Type == EventType.Restart || e.Type == EventType.Kickoff) return state.Clock.Tick - e.Tick;
            }
            return state.Clock.Tick;
        }

        private static RecognitionResult Reject(string why) => new RecognitionResult { Moment = null, Reject = why };

        public static RecognitionResult Recognize(MatchState state, Catalog catalog, RecognizerState rec, PacingConfig pacing)
        {
            if (state.Controlled == null) return Reject("no_controlled_player");
            bool hasBall = state.Ball.Status == BallStatus.Controlled && state.Ball.Owner == state.Controlled.PlayerId;
            if (!hasBall) rec.ControlSinceTick = -1;
            else if (rec.ControlSinceTick < 0) rec.ControlSinceTick = state.Clock.Tick;
            if (state.Phase.Kind == PhaseKind.FullTime) return Reject("finished");
            if (state.Phase.Kind != PhaseKind.OpenPlay) return Reject("not_open_play");
            if (state.Ball.Status == BallStatus.Dead) return Reject("ball_dead");
            if (state.Awaiting != null) return Reject("moment_pending");
            if (rec.Count >= pacing.TotalHi) return Reject("cap_reached");

            PlayerState p = Perception.FindPlayer(state, state.Controlled.PlayerId);
            if (p == null) return Reject("no_controlled_player");
            DirectPolicy direct = pacing.Direct;
            Allowance allow = direct != null ? DirectAllowance(rec, state, pacing, direct) : LegacyAllowance(rec, state, pacing);
            if (!allow.OnBall && !allow.Other) return Reject("too_soon");

            FieldRead read = FieldRead.Read(state, p);
            bool onBallMoment = direct != null ? hasBall : read.HasBall == 1 || read.Receiving == 1;
            if (onBallMoment ? !allow.OnBall : !allow.Other) return Reject("too_soon");
            if (direct != null && onBallMoment && !allow.AnyTickOfControl && state.Clock.Tick - rec.ControlSinceTick > direct.FirstContactTicks) return Reject("too_soon");
            if (!onBallMoment && TicksSinceResume(state) < 3 / 0.05) return Reject("too_soon");
            List<CatalogEntry> entries = catalog.ForRole(Roles.IdOf(p.Role));
            double repeatTicks = pacing.RepeatGapSeconds / 0.05;
            int minOptions = direct?.MinOptions ?? 2;

            CatalogEntry bestEntry = null;
            List<TacticalOption> bestOptions = null;
            double bestSalience = 0;
            bool sawTrigger = false;
            string momentId = state.MatchId + ":m" + rec.Seq;
            foreach (CatalogEntry entry in entries)
            {
                if (entry.RequiresOffside && !state.Rules.Offside) continue;
                if (!entry.Trigger.Fires(read)) continue;
                if (direct != null && !onBallMoment && !direct.OffBall.Contains(entry.Category)) continue;
                int uses = rec.UsesByEntry.TryGetValue(entry.Id, out int u) ? u : 0;
                if (direct != null && !allow.IgnoreEntryCap && uses >= direct.MaxPerEntry) continue;
                sawTrigger = true;
                bool recent = rec.LastByEntry.TryGetValue(entry.Id, out int last) && state.Clock.Tick - last < repeatTicks;
                List<TacticalOption> options = BuildOptions(state, p, entry, read, momentId);
                if (direct != null && direct.FillFromRole && options.Count < minOptions) options = FillFromRole(state, p, entries, entry, options, read, momentId, minOptions);
                if (options.Count < minOptions) continue;
                double top = double.NegativeInfinity;
                foreach (TacticalOption o in options) top = Math.Max(top, o.Score);
                double salience = top + (entry.Category == "transition" ? 0.3 : 0) - (recent ? 1.0 : 0);
                if (rec.ByCategory[entry.Category] == 0 && rec.Count >= 4) salience += 0.4;
                if (direct != null) salience += DirectSalience(entry, read) - 0.15 * uses;
                if (bestEntry == null || salience > bestSalience)
                {
                    bestEntry = entry;
                    bestOptions = options;
                    bestSalience = salience;
                }
            }
            if (bestEntry == null) return Reject(sawTrigger ? "too_few_options" : "no_trigger");

            List<TacticalOption> shown = direct != null ? TrimOptions(bestOptions, direct.MaxOptions) : bestOptions;
            int firstContact = direct?.FirstContactTicks ?? 6;
            var moment = new TacticalMoment
            {
                Id = momentId,
                Tick = state.Clock.Tick,
                TimeMs = state.Clock.TimeMs,
                EntryId = bestEntry.Id,
                Title = bestEntry.Title,
                Category = bestEntry.Category,
                Phase = bestEntry.Phase,
                Role = bestEntry.Role,
                PlayerId = p.Id,
                Cues = new List<string>(bestEntry.Cues),
                Options = shown,
                Difficulty = DifficultyOf(shown, read),
                Major = IsMajor(bestEntry, read, state),
                Involvement = onBallMoment ? (state.Clock.Tick - rec.ControlSinceTick <= firstContact ? "first_touch" : "on_ball") : "off_ball",
                Read = read,
            };
            rec.Seq++;
            rec.Count++;
            rec.LastMomentTick = state.Clock.Tick;
            rec.LastByEntry[bestEntry.Id] = state.Clock.Tick;
            rec.UsesByEntry[bestEntry.Id] = (rec.UsesByEntry.TryGetValue(bestEntry.Id, out int n) ? n : 0) + 1;
            rec.ByCategory[bestEntry.Category]++;
            if (onBallMoment) rec.OnBallCount++;
            return new RecognitionResult { Moment = moment, Reject = null };
        }

        private static double DirectSalience(CatalogEntry entry, FieldRead read)
        {
            double s = 0;
            if (entry.Category == "on_ball") s += 0.6;
            if (entry.Phase == "final_third") s += 0.3;
            if (read.BallInOurBox == 1 || read.ShotWindow > 0.3) s += 0.3;
            s += 0.25 * read.Pressure;
            if (entry.Role == "GK")
            {
                string id = entry.Id;
                if (id.Contains("CROSS") || id.Contains("1V1") || id.Contains("SWEEP") || id.Contains("SHOT")) s += 0.5;
                else if (id.Contains("POS") || id.Contains("LINE")) s -= 0.3;
            }
            return s;
        }

        /// <summary>
        /// Top up an entry's answers with the role's other catalog plays that are legitimate in this exact
        /// state (web <c>fillFromRole</c>): each is instantiated against the live field and scored by its own
        /// entry's criteria, commands already shown are skipped, and the highest-scoring extras fill the
        /// shortfall. Extras carry <see cref="TacticalOption.SourceEntryId"/> so commit-time rescoring rebuilds them.
        /// </summary>
        public static List<TacticalOption> FillFromRole(MatchState state, PlayerState p, List<CatalogEntry> entries, CatalogEntry entry, List<TacticalOption> options, FieldRead read, string momentId, int minOptions)
        {
            var seen = new HashSet<string>();
            foreach (TacticalOption o in options) seen.Add(o.Command.Key());
            var extra = new List<TacticalOption>();
            foreach (CatalogEntry other in entries)
            {
                if (ReferenceEquals(other, entry)) continue;
                if (other.RequiresOffside && !state.Rules.Offside) continue;
                foreach (TacticalOption o in BuildOptions(state, p, other, read, momentId))
                {
                    string key = o.Command.Key();
                    if (!seen.Add(key)) continue;
                    o.Id = momentId + ":" + other.Id + ":" + o.ActionId;
                    o.SourceEntryId = other.Id;
                    extra.Add(o);
                }
            }
            JsMath.StableSort(extra, (a, b) => b.Score.CompareTo(a.Score));
            var filled = new List<TacticalOption>(options);
            int take = Math.Min(extra.Count, minOptions - options.Count);
            for (int i = 0; i < take; i++) filled.Add(extra[i]);
            return filled;
        }

        /// <summary>Never show more than <paramref name="max"/> answers: keep the top scores, display order stays the catalog order.</summary>
        private static List<TacticalOption> TrimOptions(List<TacticalOption> options, int max)
        {
            if (options.Count <= max) return options;
            var sorted = new List<TacticalOption>(options);
            JsMath.StableSort(sorted, (a, b) => b.Score.CompareTo(a.Score));
            var keep = new HashSet<string>();
            for (int i = 0; i < max; i++) keep.Add(sorted[i].Id);
            var trimmed = new List<TacticalOption>();
            foreach (TacticalOption o in options) if (keep.Contains(o.Id)) trimmed.Add(o);
            return trimmed;
        }
    }
}
