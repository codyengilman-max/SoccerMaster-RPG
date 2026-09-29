using System;
using System.Collections.Generic;
using SoccerMaster.Core.Sim;
using SoccerMaster.Core.Tactics;

namespace SoccerMaster.Core.Director
{
    public enum RuntimePhase { Routine, LeadIn, Question, Timer, Resolving, Feedback, HalfTime, Finished }

    public static class RuntimePhases
    {
        public static readonly RuntimePhase[] All =
        {
            RuntimePhase.Routine, RuntimePhase.LeadIn, RuntimePhase.Question, RuntimePhase.Timer,
            RuntimePhase.Resolving, RuntimePhase.Feedback, RuntimePhase.HalfTime, RuntimePhase.Finished,
        };

        public static string Name(RuntimePhase p)
        {
            switch (p)
            {
                case RuntimePhase.Routine: return "routine";
                case RuntimePhase.LeadIn: return "lead_in";
                case RuntimePhase.Question: return "question";
                case RuntimePhase.Timer: return "timer";
                case RuntimePhase.Resolving: return "resolving";
                case RuntimePhase.Feedback: return "feedback";
                case RuntimePhase.HalfTime: return "halftime";
                default: return "finished";
            }
        }

        public static RuntimePhase Parse(string s)
        {
            foreach (RuntimePhase p in All) if (Name(p) == s) return p;
            throw new FormatException($"unknown runtime phase '{s}'");
        }
    }

    /// <summary>"committed" | "timeout" | "intent_unavailable" | "play_stopped".</summary>
    public static class CloseReasons
    {
        public const string Committed = "committed";
        public const string Timeout = "timeout";
        public const string IntentUnavailable = "intent_unavailable";
        public const string PlayStopped = "play_stopped";
    }

    /// <summary>Positions at one tick, kept for the lead-in replay.</summary>
    public sealed class Snapshot
    {
        public int Tick;
        public Vec2D[] Pos;
        public Vec2D[] Vel;
        public BallState Ball;

        public static Snapshot Of(MatchState state)
        {
            var s = new Snapshot { Tick = state.Clock.Tick, Pos = new Vec2D[state.Players.Count], Vel = new Vec2D[state.Players.Count], Ball = state.Ball.Clone() };
            for (int i = 0; i < state.Players.Count; i++)
            {
                s.Pos[i] = state.Players[i].Pos;
                s.Vel[i] = state.Players[i].Vel;
            }
            return s;
        }
    }

    public sealed class ActiveMoment
    {
        public TacticalMoment Moment;
        /// <summary>Real ms of lead-in replayed so far.</summary>
        public double LeadInMs;
        /// <summary>Total real ms the lead-in will take (history available, ≥ LeadInMinMs).</summary>
        public double LeadInTotalMs;
        /// <summary>Position history from HistoryTicks before the freeze up to the frozen tick itself.</summary>
        public List<Snapshot> History = new List<Snapshot>();
        /// <summary>Real ms left on the answer timer; AnswerMs until Ready() starts it.</summary>
        public double TimerLeftMs;
        public bool TimerRunning;
        public CommitResult Result;
        public string Reason;
        public MomentRecord Record;
        /// <summary>Real ms the feedback has been showing.</summary>
        public double FeedbackMs;
        public List<string> Feedback;
    }

    public sealed class MomentClosed
    {
        public TacticalMoment Moment;
        public string Reason;
        public CommitResult Result;
        public MomentRecord Record;
    }

    public sealed class FrameResult
    {
        public int Ticks;
        public TacticalMoment Opened;
        public MomentClosed Closed;
        public List<MatchEvent> Events = new List<MatchEvent>();
        public bool Finished;
    }

    /// <summary>What to draw this frame: during the lead-in the recorded positions at the replay point, otherwise the state itself.</summary>
    public sealed class FieldView
    {
        public int Tick;
        public double TimeMs;
        public Vec2D[] Pos;
        public Vec2D[] Vel;
        public Vec2D BallPos;
        public BallStatus BallStatus;
        public string BallOwner;
    }

    /// <summary>
    /// Port of src/match/runtime.ts — the moment director. The engine simulates the whole match; the
    /// player experiences only the selected character's meaningful direct involvements:
    ///
    ///   routine ─▶ lead_in ─▶ question ─▶ timer ─▶ resolving ─▶ feedback ─▶ routine …
    ///
    /// routine skips the simulation forward at SkipScale (tick by tick, nothing is jumped over);
    /// lead_in replays the last seconds that actually happened at real speed; question freezes the
    /// field where the answers were generated and waits for Ready(); timer runs 15 real seconds;
    /// resolving plays the consequence at real speed until the outcome settles from recorded events;
    /// feedback holds briefly, then play skips on. No engine-side timers: the view feeds frames and
    /// answers and reads back what to draw, so a headless driver measures exactly what a phone would.
    /// </summary>
    public sealed class MatchRuntime
    {
        public const double AnswerMs = 15_000;
        public const double LeadInMs = 3_000;
        public const double LeadInMinMs = 2_000;
        public static readonly int HistoryTicks = (int)Math.Round(LeadInMs / MatchState.TickMs);
        public const double FeedbackMs = 3_000;
        public const double HalfTimeMs = 2_500;

        public MatchState State;
        public TacticalSession Session;
        public RuntimeClock Clock;
        public RuntimePhase Phase = RuntimePhase.Routine;
        public ActiveMoment Active;
        public double HalfTimeLeftMs;
        /// <summary>Real ms spent per phase (pauses excluded), indexed by (int)RuntimePhase.</summary>
        public double[] RealMs = new double[RuntimePhases.All.Length];
        public bool Paused;
        public List<Snapshot> History = new List<Snapshot>();
        public int EventCursor;
        public bool HalfTimePending;

        private MatchRuntime() { }

        public static MatchRuntime Create(MatchConfig cfg, Catalog catalog, PacingConfig pacing = null)
        {
            MatchState state = Engine.CreateMatch(cfg);
            var rt = new MatchRuntime
            {
                State = state,
                Session = new TacticalSession(catalog, pacing ?? PacingConfig.DirectPacing()),
                Clock = new RuntimeClock(RuntimeClock.SkipScale),
                EventCursor = state.Events.Count,
            };
            rt.PushHistory();
            return rt;
        }

        /// <summary>Rebuild from saved parts (see <see cref="MatchSave"/>); an open timer resumes as the frozen question.</summary>
        internal static MatchRuntime Restore(MatchState state, TacticalSession session, RuntimeClock clock, RuntimePhase phase, ActiveMoment active,
            double halfTimeLeftMs, double[] realMs, List<Snapshot> history, int eventCursor, bool halfTimePending)
        {
            var rt = new MatchRuntime
            {
                State = state, Session = session, Clock = clock, Phase = phase, Active = active, HalfTimeLeftMs = halfTimeLeftMs,
                RealMs = realMs, History = history, EventCursor = eventCursor, HalfTimePending = halfTimePending,
            };
            if (rt.Phase == RuntimePhase.Timer && rt.Active != null)
            {
                rt.Active.TimerRunning = false;
                rt.SetPhase(RuntimePhase.Question);
            }
            return rt;
        }

        public double TotalRealMs()
        {
            double t = 0;
            foreach (double v in RealMs) t += v;
            return t;
        }

        private void PushHistory()
        {
            History.Add(Snapshot.Of(State));
            if (History.Count > HistoryTicks + 1) History.RemoveRange(0, History.Count - (HistoryTicks + 1));
        }

        private void SetPhase(RuntimePhase phase)
        {
            Phase = phase;
            Clock.Scale = phase == RuntimePhase.Routine ? RuntimeClock.SkipScale : RuntimeClock.NormalScale;
            Clock.CarryMs = 0;
        }

        /// <summary>Advance one real-time frame. Only routine and resolving run the simulation.</summary>
        public FrameResult Frame(double realDtMs)
        {
            double dt = Math.Max(0, realDtMs);
            var result = new FrameResult { Finished = Engine.IsFinished(State) };
            if (result.Finished && Phase != RuntimePhase.Finished) SetPhase(RuntimePhase.Finished);
            if (Paused || Phase == RuntimePhase.Finished) return result;
            RealMs[(int)Phase] += dt;

            switch (Phase)
            {
                case RuntimePhase.Routine:
                    RunRoutine(dt, result);
                    break;
                case RuntimePhase.LeadIn:
                    Active.LeadInMs += dt;
                    if (Active.LeadInMs >= Active.LeadInTotalMs) SetPhase(RuntimePhase.Question);
                    break;
                case RuntimePhase.Question:
                    break;
                case RuntimePhase.Timer:
                    Active.TimerLeftMs -= dt;
                    if (Active.TimerLeftMs <= 0)
                    {
                        Active.TimerLeftMs = 0;
                        Finish(CloseReasons.Timeout, Session.Timeout(State));
                    }
                    break;
                case RuntimePhase.Resolving:
                    RunResolving(dt, result);
                    break;
                case RuntimePhase.Feedback:
                    Active.FeedbackMs += dt;
                    if (Active.FeedbackMs >= FeedbackMs) ContinueNow();
                    break;
                case RuntimePhase.HalfTime:
                    HalfTimeLeftMs -= dt;
                    if (HalfTimeLeftMs <= 0)
                    {
                        HalfTimeLeftMs = 0;
                        SetPhase(RuntimePhase.Routine);
                    }
                    break;
            }

            bool halfTime = false;
            for (int i = EventCursor; i < State.Events.Count; i++)
            {
                result.Events.Add(State.Events[i]);
                halfTime |= State.Events[i].Type == EventType.HalfTime;
            }
            EventCursor = State.Events.Count;
            if (halfTime)
            {
                if (Phase == RuntimePhase.Routine) BeginHalfTime();
                else HalfTimePending = true;
            }
            result.Finished = Engine.IsFinished(State);
            if (result.Finished) SetPhase(RuntimePhase.Finished);
            return result;
        }

        private void BeginHalfTime()
        {
            HalfTimePending = false;
            HalfTimeLeftMs = HalfTimeMs;
            SetPhase(RuntimePhase.HalfTime);
        }

        private void ResumeRoutine()
        {
            if (HalfTimePending) BeginHalfTime();
            else SetPhase(RuntimePhase.Routine);
        }

        private void RunRoutine(double dt, FrameResult result)
        {
            int ticks = Clock.Advance(dt, RuntimeClock.MaxSkipTicksPerFrame);
            for (int i = 0; i < ticks && !Engine.IsFinished(State); i++)
            {
                TacticalMoment moment = Session.Observe(State);
                if (moment != null)
                {
                    Open(moment);
                    result.Opened = moment;
                    return;
                }
                Engine.Tick(State);
                PushHistory();
                result.Ticks++;
                if (State.Events.Count > 0 && State.Events[State.Events.Count - 1].Type == EventType.HalfTime) return;
            }
        }

        private void Open(TacticalMoment moment)
        {
            var history = new List<Snapshot>(History);
            double available = Math.Max(0, history.Count - 1) * MatchState.TickMs;
            Active = new ActiveMoment
            {
                Moment = moment,
                LeadInTotalMs = Math.Max(LeadInMinMs, Math.Min(LeadInMs, available)),
                History = history,
                TimerLeftMs = AnswerMs,
            };
            SetPhase(RuntimePhase.LeadIn);
        }

        /// <summary>The view has shown the question and the answers are interactable: start the 15 seconds.</summary>
        public void Ready()
        {
            if (Phase != RuntimePhase.Question || Active == null) return;
            Active.TimerRunning = true;
            SetPhase(RuntimePhase.Timer);
        }

        /// <summary>Skip the remaining lead-in straight to the frozen question.</summary>
        public void SkipLeadIn()
        {
            if (Phase != RuntimePhase.LeadIn || Active == null) return;
            Active.LeadInMs = Active.LeadInTotalMs;
            SetPhase(RuntimePhase.Question);
        }

        /// <summary>
        /// The user selected an answer (allowed before or after the timer starts). The session
        /// re-instantiates the intent against the frozen state, grades the decision and issues the
        /// exact command; the engine executes it.
        /// </summary>
        public bool Answer(string optionId)
        {
            if (Active == null || (Phase != RuntimePhase.Question && Phase != RuntimePhase.Timer)) return false;
            if (Active.Moment.Option(optionId) == null) throw new ArgumentException($"unknown option {optionId}");
            CommitResult res = Session.Commit(State, optionId);
            Finish(res.Status == "committed" ? CloseReasons.Committed : CloseReasons.IntentUnavailable, res);
            return true;
        }

        private void Finish(string reason, CommitResult res)
        {
            ActiveMoment a = Active;
            a.TimerRunning = false;
            a.Result = res;
            a.Reason = reason;
            a.Record = Session.Records.Count > 0 ? Session.Records[Session.Records.Count - 1] : null;
            SetPhase(RuntimePhase.Resolving);
        }

        private void RunResolving(double dt, FrameResult result)
        {
            ActiveMoment a = Active;
            int ticks = Clock.Advance(dt);
            for (int i = 0; i < ticks && !Engine.IsFinished(State); i++)
            {
                Engine.Tick(State);
                PushHistory();
                result.Ticks++;
                Session.Settle(State);
                if (a.Record?.Outcome != null) break;
            }
            if (Engine.IsFinished(State)) Session.Settle(State);
            if (a.Record?.Outcome != null || Engine.IsFinished(State))
            {
                a.Feedback = a.Record != null ? Session.FeedbackFor(a.Record) : new List<string>();
                a.FeedbackMs = 0;
                if (a.Record != null && a.Result != null && a.Reason != null)
                    result.Closed = new MomentClosed { Moment = a.Moment, Reason = a.Reason, Result = a.Result, Record = a.Record };
                SetPhase(RuntimePhase.Feedback);
            }
        }

        /// <summary>Dismiss the feedback early and skip on to the next involvement.</summary>
        public void ContinueNow()
        {
            if (Phase != RuntimePhase.Feedback) return;
            Active = null;
            ResumeRoutine();
        }

        /// <summary>
        /// Leave while a question is open: the situation is recorded as abandoned with no command
        /// issued, so nothing is attributed to the user and the simulation can carry on later.
        /// </summary>
        public MomentClosed AbandonActive(string why = "You left the match before choosing.")
        {
            if (Active == null || (Phase != RuntimePhase.LeadIn && Phase != RuntimePhase.Question && Phase != RuntimePhase.Timer)) return null;
            CommitResult res = Session.Abandon(State, why);
            MomentRecord record = Session.Records[Session.Records.Count - 1];
            TacticalMoment moment = Active.Moment;
            Active = null;
            ResumeRoutine();
            return new MomentClosed { Moment = moment, Reason = CloseReasons.PlayStopped, Result = res, Record = record };
        }

        /// <summary>Real seconds left on the answer timer (15 until it starts; 0 when no question is open).</summary>
        public double TimerRemaining()
        {
            if (Active == null || (Phase != RuntimePhase.Question && Phase != RuntimePhase.Timer)) return 0;
            return Active.TimerLeftMs / 1000;
        }

        /// <summary>0 when the timer starts → 1 at expiry.</summary>
        public double TimerProgress()
        {
            if (Active == null || Phase != RuntimePhase.Timer) return 0;
            return 1 - Active.TimerLeftMs / AnswerMs;
        }

        /// <summary>0 → 1 across the lead-in replay.</summary>
        public double LeadInProgress()
        {
            if (Active == null || Phase != RuntimePhase.LeadIn) return 1;
            return Math.Min(1, Active.LeadInMs / Active.LeadInTotalMs);
        }

        public bool QuestionOpen => Active != null && (Phase == RuntimePhase.Question || Phase == RuntimePhase.Timer);

        /// <summary>The field as it should be drawn. A copy — the simulation is never touched by presentation.</summary>
        public FieldView View()
        {
            int n = State.Players.Count;
            var v = new FieldView { Pos = new Vec2D[n], Vel = new Vec2D[n] };
            ActiveMoment a = Active;
            if (a == null || Phase != RuntimePhase.LeadIn || a.History.Count < 2)
            {
                v.Tick = State.Clock.Tick;
                v.TimeMs = State.Clock.TimeMs;
                for (int i = 0; i < n; i++)
                {
                    v.Pos[i] = State.Players[i].Pos;
                    v.Vel[i] = State.Players[i].Vel;
                }
                v.BallPos = State.Ball.Pos;
                v.BallStatus = State.Ball.Status;
                v.BallOwner = State.Ball.Owner;
                return v;
            }
            int count = a.History.Count;
            double replayMs = (count - 1) * MatchState.TickMs;
            double t = Math.Max(0, a.LeadInMs - (a.LeadInTotalMs - replayMs));
            double f = Math.Min(count - 1, t / MatchState.TickMs);
            int i0 = Math.Min(count - 2, (int)Math.Floor(f));
            double u = f - i0;
            Snapshot s0 = a.History[i0], s1 = a.History[i0 + 1];
            for (int i = 0; i < n; i++)
            {
                v.Pos[i] = Vec2D.Lerp(s0.Pos[i], s1.Pos[i], u);
                v.Vel[i] = s1.Vel[i];
            }
            BallState b = u < 0.5 ? s0.Ball : s1.Ball;
            v.BallPos = Vec2D.Lerp(s0.Ball.Pos, s1.Ball.Pos, u);
            v.BallStatus = b.Status;
            v.BallOwner = b.Owner;
            v.Tick = s0.Tick;
            v.TimeMs = Math.Max(0, State.Clock.TimeMs - (count - 1 - i0) * MatchState.TickMs);
            return v;
        }

        /// <summary>The one soccer-intelligence question asked at the freeze, worded by how the player is involved.</summary>
        public static string QuestionFor(TacticalMoment moment)
        {
            if (moment.Role == "GK" && moment.Category != "on_ball")
            {
                if (moment.Phase == "final_third") return "The attack is on you — what is the keeper's job right now?";
                if (moment.Category == "transition") return "The ball has just changed hands — where do you start from now?";
                return moment.Category == "defending" ? "They have the ball — how do you set up behind your line?" : "Your team has the ball — where should the keeper be?";
            }
            if (moment.Involvement == "first_touch") return "First touch taken — what is the play from here?";
            switch (moment.Category)
            {
                case "on_ball": return "You have the ball — what is the right play?";
                case "defending": return "They have the ball — what is your job right now?";
                case "transition": return "The ball has just changed hands — what do you do first?";
                default: return "Where should you be as this develops?";
            }
        }
    }
}
