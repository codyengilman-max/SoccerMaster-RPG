using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;
using SoccerMaster.Core.Sim;

namespace SoccerMaster.Core.Tactics
{
    /// <summary>
    /// Port of src/tactics/grading.ts. Three separate grades, never blended: the decision (was the
    /// chosen answer close to the best one at commit time), the execution (how cleanly the character
    /// carried it out) and the outcome (what the event stream says happened afterwards).
    /// The Decision Quality formula is the web one, unchanged.
    /// </summary>
    public static class Grading
    {
        private static CatalogEntry EntryOf(Catalog catalog, TacticalMoment moment)
        {
            CatalogEntry e = catalog.Find(moment.EntryId);
            if (e == null) throw new InvalidOperationException($"catalog entry {moment.EntryId} missing");
            return e;
        }

        /// <summary>Re-score the moment's options against the current state (used at commit so late movement counts).</summary>
        public static List<TacticalOption> RescoreAtCommit(MatchState state, Catalog catalog, TacticalMoment moment)
        {
            PlayerState p = Perception.FindPlayer(state, moment.PlayerId);
            if (p == null) return moment.Options;
            FieldRead read = FieldRead.Read(state, p);
            List<TacticalOption> fresh = Recognition.BuildOptions(state, p, EntryOf(catalog, moment), read, moment.Id);
            var bySource = new Dictionary<string, List<TacticalOption>>();
            var result = new List<TacticalOption>();
            foreach (TacticalOption o in moment.Options)
            {
                List<TacticalOption> list = fresh;
                if (o.SourceEntryId != null && !bySource.TryGetValue(o.SourceEntryId, out list))
                {
                    CatalogEntry source = catalog.Find(o.SourceEntryId);
                    list = source != null ? Recognition.BuildOptions(state, p, source, read, moment.Id) : new List<TacticalOption>();
                    bySource[o.SourceEntryId] = list;
                }
                TacticalOption f = null;
                foreach (TacticalOption x in list) if (x.ActionId == o.ActionId) { f = x; break; }
                if (f != null && o.SourceEntryId != null)
                {
                    f.Id = o.Id;
                    f.SourceEntryId = o.SourceEntryId;
                }
                result.Add(f ?? o);
            }
            return result;
        }

        public static string CoachReasons(List<string> reasons)
        {
            var out_ = new List<string>();
            foreach (string s in reasons)
            {
                foreach (string r in s.Split(new[] { "; " }, StringSplitOptions.None))
                {
                    string plain = FieldLanguage(r);
                    if (plain != null && !out_.Contains(plain)) out_.Add(plain);
                }
            }
            return out_.Count > 0 ? string.Join("; ", out_) : "no field condition stood out either way";
        }

        private static readonly Regex SpaceRe = new Regex(@"^space (\d+\.\d+) ahead$");
        private static readonly Regex EndPressureRe = new Regex(@"^pressure (\d+\.\d+) at end$");
        private static readonly Regex LaneRe = new Regex(@"^lane margin (\d+\.\d+) s$");
        private static readonly Regex ReceiverRe = new Regex(@"^receiver space (\d+\.\d+)$");
        private static readonly Regex WindowRe = new Regex(@"^shot window (\d+)°$");
        private static readonly Regex DistRe = new Regex(@"^(\d+) m from goal$");
        private static readonly Regex NumericRe = new Regex(@"\d\.\d|\d°");

        private static double? Num(Regex re, string reason)
        {
            Match m = re.Match(reason);
            return m.Success ? double.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture) : (double?)null;
        }

        private static string FieldLanguage(string reason)
        {
            double? space = Num(SpaceRe, reason);
            if (space != null) return space > 0.6 ? "plenty of grass in front of you" : space > 0.35 ? "some room ahead" : null;
            double? endPressure = Num(EndPressureRe, reason);
            if (endPressure != null) return endPressure > 0.6 ? "a defender is waiting where the carry ends" : endPressure < 0.15 ? "nobody at the end of the run" : null;
            double? lane = Num(LaneRe, reason);
            if (lane != null) return lane > 0.3 ? "the passing lane is clearly open" : lane < 0.12 ? "the lane is tight" : null;
            double? receiver = Num(ReceiverRe, reason);
            if (receiver != null) return receiver > 0.6 ? "the receiver has time" : receiver < 0.3 ? "the receiver is marked" : null;
            double? window = Num(WindowRe, reason);
            if (window != null) return window >= 25 ? "the goal is open" : window >= 12 ? "a narrow sight of goal" : "the shot is blocked";
            double? dist = Num(DistRe, reason);
            if (dist != null) return dist <= 14 ? "close enough to score" : dist >= 22 ? "a long way out" : null;
            if (NumericRe.IsMatch(reason) || reason == "to feet" || reason == "into space ahead") return null;
            return reason;
        }

        public static DecisionRecord GradeDecision(MatchState state, Catalog catalog, TacticalMoment moment, string chosenOptionId)
        {
            List<TacticalOption> scored = RescoreAtCommit(state, catalog, moment);
            var sorted = new List<TacticalOption>(scored);
            JsMath.StableSort(sorted, (a, b) => b.Score.CompareTo(a.Score));
            if (sorted.Count == 0) throw new InvalidOperationException("moment has no options");
            TacticalOption best = sorted[0];
            TacticalOption worst = sorted[sorted.Count - 1];
            TacticalOption chosen = null;
            if (chosenOptionId != null) foreach (TacticalOption o in scored) if (o.Id == chosenOptionId) { chosen = o; break; }
            if (chosen == null)
            {
                return new DecisionRecord
                {
                    MomentId = moment.Id,
                    ChosenOptionId = null,
                    Quality = null,
                    Band = "timeout",
                    BestOptionId = best.Id,
                    Explanation = new List<string> { $"No choice was committed in time. {best.Label} was available: {CoachReasons(best.Reasons)}." },
                    CommitTick = state.Clock.Tick,
                };
            }
            // Decision Quality (unchanged web formula)
            double spread = Math.Max(0.6, best.Score - worst.Score);
            double quality = Vec2D.Clamp(1 - (best.Score - chosen.Score) / spread, 0, 1);
            string band = quality >= 0.85 ? "strong" : quality >= 0.55 ? "acceptable" : "weak";
            var explanation = new List<string> { $"{chosen.Label}: {CoachReasons(chosen.Reasons)}." };
            if (chosen.Id != best.Id) explanation.Add($"{best.Label} read better here: {CoachReasons(best.Reasons)}.");
            return new DecisionRecord
            {
                MomentId = moment.Id,
                ChosenOptionId = chosen.Id,
                Quality = quality,
                Band = band,
                BestOptionId = best.Id,
                Explanation = explanation,
                CommitTick = state.Clock.Tick,
            };
        }

        public static ExecutionRecord GradeExecution(MatchState state, PlayerState p, CommittedIntent committed, double? kickError)
        {
            double pressure = Perception.PressureAt(p.Pos, Perception.Opponents(state, p.Side));
            double fatigue = p.Fatigue;
            double quality = kickError != null ? Vec2D.Clamp(1 - kickError.Value, 0, 1) : Vec2D.Clamp((1 - 0.15 * pressure) * (1 - 0.1 * fatigue), 0, 1);
            string band = quality >= 0.75 ? "clean" : quality >= 0.45 ? "loose" : "poor";
            return new ExecutionRecord { MomentId = committed.MomentId, Actor = committed.Actor, Quality = quality, Band = band, PressureAtCommit = pressure, FatigueAtCommit = fatigue };
        }

        /// <summary>First pass/shot the player produced at or after <paramref name="commitTick"/>; its error is the execution evidence.</summary>
        public static MatchEvent KickAfter(MatchState state, string playerId, int commitTick, int withinTicks = 60)
        {
            foreach (MatchEvent e in state.Events)
            {
                if (e.Tick < commitTick) continue;
                if (e.Tick > commitTick + withinTicks) break;
                if (e.Type == EventType.Pass && e.From == playerId) return e;
                if (e.Type == EventType.Shot && e.Player == playerId) return e;
            }
            return null;
        }

        private static MatchEvent First(List<MatchEvent> events, Func<MatchEvent, bool> pred)
        {
            foreach (MatchEvent e in events) if (pred(e)) return e;
            return null;
        }

        private static bool Any(List<MatchEvent> events, Func<MatchEvent, bool> pred) => First(events, pred) != null;

        private static Side? SideOfPlayer(MatchState state, string id)
        {
            PlayerState p = id != null ? Perception.FindPlayer(state, id) : null;
            return p?.Side;
        }

        /// <summary>Outcome: read the event stream after commit. The window is short (~4 s) because later events belong to later moments.</summary>
        public static OutcomeRecord ResolveOutcome(MatchState state, TacticalMoment moment, CommittedIntent committed, int windowTicks = 80)
        {
            int from = committed != null ? committed.CommitTick : moment.Tick;
            int until = from + windowTicks;
            if (state.Clock.Tick < until && state.Phase.Kind != PhaseKind.FullTime) return null;
            PlayerState p = Perception.FindPlayer(state, moment.PlayerId);
            Side side = p?.Side ?? Side.Home;
            var events = new List<MatchEvent>();
            foreach (MatchEvent e in state.Events) if (e.Tick >= from && e.Tick <= until) events.Add(e);
            var ids = new List<string>();
            foreach (MatchEvent e in events) ids.Add(e.Id);
            OutcomeRecord Done(string result, string summary) => new OutcomeRecord { MomentId = moment.Id, Result = result, Summary = summary, EventIds = ids, ResolvedTick = state.Clock.Tick };

            if (Any(events, e => e.Type == EventType.Goal && e.Side == side)) return Done("success", "Goal for your team.");
            if (Any(events, e => e.Type == EventType.Goal && e.Side != side)) return Done("failure", "Goal conceded.");

            PlayerCommand cmd = committed?.Command;
            OutcomeRecord PassResult(MatchEvent kick)
            {
                MatchEvent received = First(events, e => e.Type == EventType.Receive && e.Tick > kick.Tick && SideOfPlayer(state, e.Player) == side);
                MatchEvent lost = First(events, e => e.Tick > kick.Tick && (e.Type == EventType.Interception || (e.Type == EventType.PossessionChange && e.ToSide != side)));
                if (received != null && (lost == null || received.Tick < lost.Tick)) return Done("success", $"Pass reached {(kick.To != null ? "the intended teammate" : "a teammate")}.");
                if (lost != null) return Done("failure", lost.Type == EventType.Interception ? "Pass intercepted." : "Possession lost.");
                return Done("neutral", "Pass still in play.");
            }
            bool IsMyKick(MatchEvent e) => (e.Type == EventType.Pass && e.From == moment.PlayerId) || (e.Type == EventType.Shot && e.Player == moment.PlayerId);

            if (cmd != null && (cmd.Type == CommandType.Pass || cmd.Type == CommandType.Shoot))
            {
                MatchEvent kick = First(events, IsMyKick);
                if (kick != null && kick.Type == EventType.Shot)
                {
                    if (Any(events, e => e.Type == EventType.Save)) return Done("partial", "Shot saved.");
                    return Done("failure", kick.OnTarget ? "Shot cleared or blocked." : "Shot off target.");
                }
                if (kick != null && kick.Type == EventType.Pass) return PassResult(kick);
                if (Any(events, e => e.Type == EventType.Tackle && e.Victim == moment.PlayerId && e.Won)) return Done("failure", "Tackled before the ball could be played.");
                if (Any(events, e => e.Type == EventType.PossessionChange && e.ToSide != side)) return Done("failure", "Possession lost.");
                return Done("neutral", cmd.Type == CommandType.Shoot ? "Shot not taken; ball still in play." : "Pass not played; ball still in play.");
            }
            bool onBall = moment.Read.HasBall == 1;
            if (onBall && cmd != null && (cmd.Type == CommandType.Carry || cmd.Type == CommandType.Hold || cmd.Type == CommandType.FirstTouch))
            {
                string verb = cmd.Type == CommandType.Carry ? "Carried" : cmd.Type == CommandType.Hold ? "Held the ball" : "Took the touch";
                MatchEvent tackled = First(events, e => e.Type == EventType.Tackle && e.Victim == moment.PlayerId && e.Won);
                MatchEvent lost = First(events, e => e.Type == EventType.PossessionChange && e.ToSide != side);
                MatchEvent release = First(events, IsMyKick);
                if (tackled != null && (release == null || tackled.Tick < release.Tick)) return Done("failure", $"{verb} but was tackled.");
                if (lost != null && (release == null || lost.Tick < release.Tick)) return Done("failure", $"{verb} but possession was lost.");
                if (release != null && release.Type == EventType.Shot)
                {
                    if (Any(events, e => e.Type == EventType.Save && e.Tick > release.Tick)) return Done("partial", $"{verb}, then shot: saved.");
                    return Done("failure", $"{verb}, then shot {(release.OnTarget ? "blocked or cleared" : "off target")}.");
                }
                if (release != null && release.Type == EventType.Pass)
                {
                    OutcomeRecord next = PassResult(release);
                    string to = release.To != null ? Perception.FindPlayer(state, release.To)?.Name : null;
                    next.Summary = $"{verb} and kept the ball, then passed{(to != null ? " to " + to : "")}: {next.Summary.ToLowerInvariant()}";
                    return next;
                }
                return Done("success", $"{verb} and kept the ball.");
            }

            MatchEvent regained = First(events, e => e.Type == EventType.PossessionChange && e.ToSide == side);
            MatchEvent lostTeam = First(events, e => e.Type == EventType.PossessionChange && e.ToSide != side);
            MatchEvent receivedByMe = First(events, e => e.Type == EventType.Receive && e.Player == moment.PlayerId);
            if (moment.Category == "defending" || moment.Category == "transition")
            {
                if (regained != null) return Done("success", "Ball won back.");
                if (Any(events, e => e.Type == EventType.Shot && e.Side != side)) return Done("failure", "Opponents got a shot away.");
                if (lostTeam != null) return Done("failure", "Possession lost.");
                return Done("partial", "Attack slowed; no shot conceded.");
            }
            if (receivedByMe != null) return Done("success", "You received the ball.");
            if (lostTeam != null) return Done("failure", "Team lost possession.");
            return Done("neutral", "Team kept the ball; run not used.");
        }
    }
}
