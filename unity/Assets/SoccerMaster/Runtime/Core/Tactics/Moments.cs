using System.Collections.Generic;
using SoccerMaster.Core.Sim;

namespace SoccerMaster.Core.Tactics
{
    /// <summary>Port of src/tactics/moments.ts: the records the tactical layer produces.</summary>
    public sealed class Difficulty
    {
        /// <summary>"easy" | "medium" | "hard".</summary>
        public string Band;
        /// <summary>Gap between the best and second-best option, normalised; low = unclear read.</summary>
        public double Clarity;
        public double Pressure;
        public int Alternatives;
        /// <summary>0 (trivial) → 1 (very hard).</summary>
        public double Score;
    }

    /// <summary>One credible alternative offered to the user. <see cref="Score"/> is internal and must never be shown before selection.</summary>
    public sealed class TacticalOption
    {
        public string Id;
        public string ActionId;
        public string Label;
        public string Intent;
        /// <summary>Executed by drawing (preview + commit on release) vs a contextual control.</summary>
        public bool Drawn;
        public PlayerCommand Command;
        /// <summary>Point a drawing is compared against (null for non-drawn intents).</summary>
        public Vec2D? Anchor;
        public double Score;
        public double Feasibility;
        public List<string> Reasons = new List<string>();
        public string Receiver;
        /// <summary>Catalog entry the action was drawn from when it is not the moment's own entry (four-answer fill).</summary>
        public string SourceEntryId;
    }

    public sealed class TacticalMoment
    {
        public string Id;
        public int Tick;
        public double TimeMs;
        public string EntryId;
        public string Title;
        /// <summary>"on_ball" | "off_ball" | "defending" | "transition".</summary>
        public string Category;
        public string Phase;
        public string Role;
        public string PlayerId;
        public List<string> Cues = new List<string>();
        public List<TacticalOption> Options = new List<TacticalOption>();
        public Difficulty Difficulty;
        /// <summary>Stronger cinematic emphasis: shots, last-defender situations, late-game swings.</summary>
        public bool Major;
        /// <summary>"first_touch" | "on_ball" | "off_ball".</summary>
        public string Involvement;
        public FieldRead Read;

        public TacticalOption Option(string id)
        {
            foreach (TacticalOption o in Options) if (o.Id == id) return o;
            return null;
        }
    }

    public sealed class DecisionRecord
    {
        public string MomentId;
        public string ChosenOptionId;
        /// <summary>null when the window expired or the intent became unavailable before commit.</summary>
        public double? Quality;
        /// <summary>"strong" | "acceptable" | "weak" | "timeout" | "intent_unavailable".</summary>
        public string Band;
        public string BestOptionId;
        /// <summary>Field-condition explanations (never "you were wrong").</summary>
        public List<string> Explanation = new List<string>();
        /// <summary>Tick at which the choice was committed; grading used the field state at this tick.</summary>
        public int CommitTick;
    }

    public sealed class ExecutionRecord
    {
        public string MomentId;
        /// <summary>"user" | "engine": whose choice the character executed.</summary>
        public string Actor;
        public double Quality;
        /// <summary>"clean" | "loose" | "poor".</summary>
        public string Band;
        public double PressureAtCommit;
        public double FatigueAtCommit;
    }

    public sealed class OutcomeRecord
    {
        public string MomentId;
        /// <summary>"success" | "partial" | "failure" | "neutral".</summary>
        public string Result;
        public string Summary;
        public List<string> EventIds = new List<string>();
        public int ResolvedTick;
    }

    public sealed class CommittedIntent
    {
        public string MomentId;
        /// <summary>"user" | "engine".</summary>
        public string Actor;
        /// <summary>Displayed option whose command this is; null when the engine chose something that was not on offer.</summary>
        public string OptionId;
        public string Label;
        public PlayerCommand Command;
        public int CommitTick;
    }

    public sealed class MomentRecord
    {
        public TacticalMoment Moment;
        public DecisionRecord Decision;
        /// <summary>The action the character actually carried out (user- or engine-selected); null when play stopped first.</summary>
        public CommittedIntent Acted;
        public ExecutionRecord Execution;
        public OutcomeRecord Outcome;
    }
}
