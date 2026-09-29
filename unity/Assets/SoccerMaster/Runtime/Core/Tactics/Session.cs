using System;
using System.Collections.Generic;
using SoccerMaster.Core.Sim;

namespace SoccerMaster.Core.Tactics
{
    public sealed class CommitResult
    {
        /// <summary>"committed" | "intent_unavailable" | "timeout" | "cancelled".</summary>
        public string Status;
        public DecisionRecord Decision;
        /// <summary>What the character carried out; Actor == "engine" when the user did not choose.</summary>
        public CommittedIntent Acted;
        /// <summary>Command actually issued to the engine, whoever chose it.</summary>
        public PlayerCommand Issued;
    }

    public sealed class OpenRecord
    {
        public MomentRecord Record;
        public CommittedIntent Committed;
    }

    /// <summary>
    /// Port of src/tactics/session.ts. Drives one match's tactical moments against the engine:
    /// recognise → suspend the controlled player's AI → (user answers) → commit against the
    /// <em>current</em> state → grade → the engine executes → watch the event stream for the outcome.
    /// Timing belongs to the runtime; this layer is headless and deterministic.
    /// </summary>
    public sealed class TacticalSession
    {
        public Catalog Catalog;
        public PacingConfig Pacing;
        public RecognizerState Recognizer = new RecognizerState();
        public TacticalMoment Active;
        public List<OpenRecord> Open = new List<OpenRecord>();
        public List<MomentRecord> Records = new List<MomentRecord>();
        /// <summary>Ticks where recognition declined, by reason — coverage diagnostics.</summary>
        public Dictionary<string, int> Rejects = new Dictionary<string, int>();

        public TacticalSession(Catalog catalog, PacingConfig pacing)
        {
            Catalog = catalog;
            Pacing = pacing ?? PacingConfig.Default();
        }

        /// <summary>Call once per engine tick. Returns a new moment when one starts.</summary>
        public TacticalMoment Observe(MatchState state)
        {
            Settle(state);
            if (Active != null) return null;
            RecognitionResult r = Recognition.Recognize(state, Catalog, Recognizer, Pacing);
            if (r.Reject != null) Rejects[r.Reject] = (Rejects.TryGetValue(r.Reject, out int n) ? n : 0) + 1;
            if (r.Moment == null) return null;
            Active = r.Moment;
            Engine.SuspendDecisions(state, r.Moment.PlayerId);
            return r.Moment;
        }

        private void FinishActive(MatchState state, DecisionRecord decision, CommittedIntent committed)
        {
            TacticalMoment moment = Active;
            if (moment == null) return;
            PlayerState p = Perception.FindPlayer(state, moment.PlayerId);
            var record = new MomentRecord
            {
                Moment = moment,
                Decision = decision,
                Acted = committed,
                Execution = committed != null && p != null ? Grading.GradeExecution(state, p, committed, null) : null,
                Outcome = null,
            };
            Records.Add(record);
            Open.Add(new OpenRecord { Record = record, Committed = committed });
            Active = null;
            Engine.ResumeDecisions(state);
        }

        /// <summary>
        /// Commit the user's answer. The intent is re-instantiated against the current state so the
        /// ball goes where the field is now, and the decision is graded on that state. The engine then
        /// executes the command itself.
        /// </summary>
        public CommitResult Commit(MatchState state, string optionId)
        {
            TacticalMoment moment = Active;
            if (moment == null) throw new InvalidOperationException("no active moment");
            PlayerState p = Perception.FindPlayer(state, moment.PlayerId);
            TacticalOption option = moment.Option(optionId);
            if (p == null || option == null) throw new InvalidOperationException($"option {optionId} not in moment {moment.Id}");

            Instantiated inst = Intents.Instantiate(state, p, option.Intent);
            if (inst == null)
            {
                DecisionRecord decision = UnavailableDecision(state, moment, $"{option.Label} was no longer available when committed: the field had moved.");
                decision.ChosenOptionId = option.Id;
                CommittedIntent acted = EngineContinuation(state, moment);
                FinishActive(state, decision, acted);
                return new CommitResult { Status = "intent_unavailable", Decision = decision, Acted = acted, Issued = acted?.Command };
            }
            DecisionRecord graded = Grading.GradeDecision(state, Catalog, moment, option.Id);
            var user = new CommittedIntent { MomentId = moment.Id, Actor = "user", OptionId = option.Id, Label = option.Label, Command = inst.Command, CommitTick = state.Clock.Tick };
            Engine.IssueCommand(state, p.Id, inst.Command, 1);
            FinishActive(state, graded, user);
            return new CommitResult { Status = "committed", Decision = graded, Acted = user, Issued = inst.Command };
        }

        /// <summary>The answer window expired: no user decision is graded; the engine's own action is recorded as engine-selected.</summary>
        public CommitResult Timeout(MatchState state)
        {
            TacticalMoment moment = Active;
            if (moment == null) throw new InvalidOperationException("no active moment");
            DecisionRecord decision = Grading.GradeDecision(state, Catalog, moment, null);
            CommittedIntent acted = EngineContinuation(state, moment);
            if (acted != null) decision.Explanation.Add($"The character played on without you: {acted.Label}.");
            FinishActive(state, decision, acted);
            return new CommitResult { Status = "timeout", Decision = decision, Acted = acted, Issued = acted?.Command };
        }

        /// <summary>The situation ended before a choice landed (ball out, whistle): nothing is issued.</summary>
        public CommitResult Abandon(MatchState state, string why)
        {
            TacticalMoment moment = Active;
            if (moment == null) throw new InvalidOperationException("no active moment");
            DecisionRecord decision = UnavailableDecision(state, moment, why);
            FinishActive(state, decision, null);
            return new CommitResult { Status = "intent_unavailable", Decision = decision, Acted = null, Issued = null };
        }

        private DecisionRecord UnavailableDecision(MatchState state, TacticalMoment moment, string why)
        {
            DecisionRecord decision = Grading.GradeDecision(state, Catalog, moment, null);
            decision.Band = "intent_unavailable";
            TacticalOption best = moment.Option(decision.BestOptionId);
            decision.Explanation = best != null ? new List<string> { why, $"{best.Label} read best as the situation stood." } : new List<string> { why };
            return decision;
        }

        /// <summary>
        /// Role-specific continuation when no choice lands: on the ball the engine's own evaluator acts;
        /// off the ball the player keeps the team shape. Deterministic: the RNG is derived from the state.
        /// </summary>
        public static PlayerCommand ContinuationDefault(MatchState state, TacticalMoment moment)
        {
            PlayerState p = Perception.FindPlayer(state, moment.PlayerId);
            if (p == null) return null;
            bool onBall = state.Ball.Status == BallStatus.Controlled && state.Ball.Owner == p.Id;
            if (onBall)
            {
                var rng = new Rng(unchecked((int)(state.RngState ^ 0x5bd1e995u)));
                PlayerCommand cmd = Ai.DecideOnBall(state, p, rng);
                Engine.IssueCommand(state, p.Id, cmd, 1);
                return cmd;
            }
            Instantiated inst = Intents.Instantiate(state, p, "hold_position");
            if (inst == null) return null;
            Engine.IssueCommand(state, p.Id, inst.Command, 1);
            return inst.Command;
        }

        private static CommittedIntent EngineContinuation(MatchState state, TacticalMoment moment)
        {
            PlayerCommand cmd = ContinuationDefault(state, moment);
            if (cmd == null) return null;
            string key = cmd.Key();
            TacticalOption shown = null;
            foreach (TacticalOption o in moment.Options) if (o.Command.Key() == key) { shown = o; break; }
            return new CommittedIntent
            {
                MomentId = moment.Id,
                Actor = "engine",
                OptionId = shown?.Id,
                Label = shown?.Label ?? DescribeCommand(cmd),
                Command = cmd,
                CommitTick = state.Clock.Tick,
            };
        }

        public static string DescribeCommand(PlayerCommand cmd)
        {
            switch (cmd.Type)
            {
                case CommandType.Pass: return "Pass to a teammate";
                case CommandType.Shoot: return "Shoot";
                case CommandType.Carry: return "Carry the ball";
                case CommandType.Hold: return "Hold the ball";
                case CommandType.FirstTouch: return "Take a touch";
                case CommandType.Move: return "Hold the team shape";
                case CommandType.Press: return "Press the carrier";
                case CommandType.Screen: return "Screen the passing lane";
                default: throw new ArgumentOutOfRangeException(nameof(cmd));
            }
        }

        /// <summary>Resolve open outcomes from the events the engine has recorded since each commit; recognises nothing.</summary>
        public void Settle(MatchState state)
        {
            if (Open.Count == 0) return;
            var remaining = new List<OpenRecord>();
            foreach (OpenRecord o in Open)
            {
                OutcomeRecord outcome = Grading.ResolveOutcome(state, o.Record.Moment, o.Committed);
                if (outcome == null)
                {
                    remaining.Add(o);
                    continue;
                }
                o.Record.Outcome = outcome;
                if (o.Committed != null)
                {
                    PlayerState p = Perception.FindPlayer(state, o.Record.Moment.PlayerId);
                    MatchEvent kick = Grading.KickAfter(state, o.Record.Moment.PlayerId, o.Committed.CommitTick);
                    if (p != null && kick != null) o.Record.Execution = Grading.GradeExecution(state, p, o.Committed, kick.Error);
                }
            }
            Open = remaining;
        }

        /// <summary>Text feedback for a settled record: field conditions first, outcome last.</summary>
        public List<string> FeedbackFor(MomentRecord record)
        {
            CatalogEntry entry = Catalog.Find(record.Moment.EntryId);
            var lines = new List<string>(record.Decision.Explanation);
            if (record.Execution != null)
            {
                string who = record.Execution.Actor == "engine" ? "Execution (engine-selected action)" : "Execution";
                double pr = record.Execution.PressureAtCommit;
                string under = pr > 1.2 ? "under heavy pressure" : pr > 0.6 ? "under pressure" : pr > 0.2 ? "with a defender near" : "with time and space";
                lines.Add($"{who} {record.Execution.Band} {under}.");
            }
            if (record.Outcome != null) lines.Add($"Outcome: {record.Outcome.Summary}");
            if (record.Decision.Band == "weak" && entry != null && entry.Mistakes.Count > 0) lines.Add($"Common trap: {entry.Mistakes[0]}");
            return lines;
        }
    }
}
