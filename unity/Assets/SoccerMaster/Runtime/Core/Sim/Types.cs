using System;
using System.Collections.Generic;

namespace SoccerMaster.Core.Sim
{
    // Port of src/sim/types.ts. Mutable reference types mirror the web engine's plain objects so the
    // tick function can be transcribed line for line; nothing here references UnityEngine.

    public enum Side { Home, Away }

    public static class Sides
    {
        public static Side Other(Side s) => s == Side.Home ? Side.Away : Side.Home;
        public static string Name(Side s) => s == Side.Home ? "home" : "away";

        public static Side Parse(string s)
        {
            switch (s)
            {
                case "home": return Side.Home;
                case "away": return Side.Away;
                default: throw new FormatException($"unknown side '{s}'");
            }
        }
    }

    public static class Roles
    {
        /// <summary>Shirt numbers of the 1-3-2-3 in squad order (ROLE_NUMBERS).</summary>
        public static readonly int[] Numbers = { 1, 2, 3, 4, 6, 8, 7, 9, 11 };

        public static string IdOf(int role)
        {
            switch (role)
            {
                case 1: return "GK";
                case 2: return "RB";
                case 3: return "LB";
                case 4: return "CB";
                case 6: return "DM";
                case 8: return "CM";
                case 7: return "RW";
                case 9: return "ST";
                case 11: return "LW";
                default: throw new ArgumentOutOfRangeException(nameof(role), role, "not a 1-3-2-3 role");
            }
        }

        public static string LabelOf(int role)
        {
            switch (role)
            {
                case 1: return "Goalkeeper";
                case 2: return "Right back";
                case 3: return "Left back";
                case 4: return "Centre back";
                case 6: return "Defensive mid";
                case 8: return "Central mid";
                case 7: return "Right winger";
                case 9: return "Striker";
                case 11: return "Left winger";
                default: throw new ArgumentOutOfRangeException(nameof(role), role, "not a 1-3-2-3 role");
            }
        }

        public static bool IsValid(int role) => Array.IndexOf(Numbers, role) >= 0;
    }

    /// <summary>0–100 scales, integer valued after squad generation.</summary>
    public sealed class Attributes
    {
        public double Pace, Acceleration, Passing, FirstTouch, Dribbling, Shooting, Tackling, Positioning, Awareness, Stamina, Strength, Goalkeeping;

        public static readonly string[] Keys =
        {
            "pace", "acceleration", "passing", "firstTouch", "dribbling", "shooting",
            "tackling", "positioning", "awareness", "stamina", "strength", "goalkeeping",
        };

        public double Get(string key)
        {
            switch (key)
            {
                case "pace": return Pace;
                case "acceleration": return Acceleration;
                case "passing": return Passing;
                case "firstTouch": return FirstTouch;
                case "dribbling": return Dribbling;
                case "shooting": return Shooting;
                case "tackling": return Tackling;
                case "positioning": return Positioning;
                case "awareness": return Awareness;
                case "stamina": return Stamina;
                case "strength": return Strength;
                case "goalkeeping": return Goalkeeping;
                default: throw new ArgumentException($"unknown attribute '{key}'");
            }
        }

        public void Set(string key, double v)
        {
            switch (key)
            {
                case "pace": Pace = v; break;
                case "acceleration": Acceleration = v; break;
                case "passing": Passing = v; break;
                case "firstTouch": FirstTouch = v; break;
                case "dribbling": Dribbling = v; break;
                case "shooting": Shooting = v; break;
                case "tackling": Tackling = v; break;
                case "positioning": Positioning = v; break;
                case "awareness": Awareness = v; break;
                case "stamina": Stamina = v; break;
                case "strength": Strength = v; break;
                case "goalkeeping": Goalkeeping = v; break;
                default: throw new ArgumentException($"unknown attribute '{key}'");
            }
        }

        public Attributes Clone() => (Attributes)MemberwiseClone();
    }

    public sealed class PlayerState
    {
        public string Id;
        public Side Side;
        public int Role;
        public string Name;
        public Attributes Attributes;
        public Vec2D Pos;
        public Vec2D Vel;
        /// <summary>0 = fresh, 1 = exhausted.</summary>
        public double Fatigue;
        public Vec2D MoveTarget;
        public int TouchCooldown;
        public int Stunned;
        public int CommitUntilTick;
    }

    public enum BallStatus { Loose, Controlled, Dead }

    public static class BallStatuses
    {
        public static string Name(BallStatus s) => s == BallStatus.Loose ? "loose" : s == BallStatus.Controlled ? "controlled" : "dead";

        public static BallStatus Parse(string s)
        {
            switch (s)
            {
                case "loose": return BallStatus.Loose;
                case "controlled": return BallStatus.Controlled;
                case "dead": return BallStatus.Dead;
                default: throw new FormatException($"unknown ball status '{s}'");
            }
        }
    }

    public sealed class BallState
    {
        public Vec2D Pos;
        public Vec2D Vel;
        public BallStatus Status;
        public string Owner;
        public string LastTouch;
        public Side? LastTouchSide;
        public string PassTarget;
        public string PassFrom;

        public BallState Clone() => (BallState)MemberwiseClone();
    }

    public enum PhaseKind { Kickoff, OpenPlay, GoalKick, Corner, ThrowIn, FreeKick, HalfTime, FullTime }

    public static class PhaseKinds
    {
        public static string Name(PhaseKind k)
        {
            switch (k)
            {
                case PhaseKind.Kickoff: return "kickoff";
                case PhaseKind.OpenPlay: return "open_play";
                case PhaseKind.GoalKick: return "goal_kick";
                case PhaseKind.Corner: return "corner";
                case PhaseKind.ThrowIn: return "throw_in";
                case PhaseKind.FreeKick: return "free_kick";
                case PhaseKind.HalfTime: return "half_time";
                default: return "full_time";
            }
        }

        public static PhaseKind Parse(string s)
        {
            switch (s)
            {
                case "kickoff": return PhaseKind.Kickoff;
                case "open_play": return PhaseKind.OpenPlay;
                case "goal_kick": return PhaseKind.GoalKick;
                case "corner": return PhaseKind.Corner;
                case "throw_in": return PhaseKind.ThrowIn;
                case "free_kick": return PhaseKind.FreeKick;
                case "half_time": return PhaseKind.HalfTime;
                case "full_time": return PhaseKind.FullTime;
                default: throw new FormatException($"unknown phase '{s}'");
            }
        }
    }

    /// <summary>Discriminated union flattened: fields not meaningful for a kind are left default.</summary>
    public sealed class MatchPhase
    {
        public PhaseKind Kind;
        public Side Side;
        public Vec2D At;
        /// <summary>free_kick only: "offside" | "foul" | "build_out".</summary>
        public string Reason;

        public static MatchPhase Kickoff(Side side) => new MatchPhase { Kind = PhaseKind.Kickoff, Side = side };
        public static MatchPhase OpenPlay() => new MatchPhase { Kind = PhaseKind.OpenPlay };
        public static MatchPhase GoalKick(Side side) => new MatchPhase { Kind = PhaseKind.GoalKick, Side = side };
        public static MatchPhase Corner(Side side, Vec2D at) => new MatchPhase { Kind = PhaseKind.Corner, Side = side, At = at };
        public static MatchPhase ThrowIn(Side side, Vec2D at) => new MatchPhase { Kind = PhaseKind.ThrowIn, Side = side, At = at };
        public static MatchPhase FreeKick(Side side, Vec2D at, string reason) => new MatchPhase { Kind = PhaseKind.FreeKick, Side = side, At = at, Reason = reason };
        public static MatchPhase HalfTime() => new MatchPhase { Kind = PhaseKind.HalfTime };
        public static MatchPhase FullTime() => new MatchPhase { Kind = PhaseKind.FullTime };

        public bool HasSide => Kind != PhaseKind.OpenPlay && Kind != PhaseKind.HalfTime && Kind != PhaseKind.FullTime;
        public bool HasAt => Kind == PhaseKind.Corner || Kind == PhaseKind.ThrowIn || Kind == PhaseKind.FreeKick;
    }

    public sealed class Clock
    {
        public int Tick;
        public double TimeMs;
        public int Half;
        public double HalfTimeS;

        public Clock Clone() => (Clock)MemberwiseClone();
    }

    public enum EventType
    {
        Kickoff, Pass, Receive, Carry, Shot, Save, Goal, Interception, Recovery, Tackle,
        PossessionChange, OutOfPlay, Offside, Restart, HalfTime, FullTime,
    }

    public static class EventTypes
    {
        public static string Name(EventType t)
        {
            switch (t)
            {
                case EventType.Kickoff: return "kickoff";
                case EventType.Pass: return "pass";
                case EventType.Receive: return "receive";
                case EventType.Carry: return "carry";
                case EventType.Shot: return "shot";
                case EventType.Save: return "save";
                case EventType.Goal: return "goal";
                case EventType.Interception: return "interception";
                case EventType.Recovery: return "recovery";
                case EventType.Tackle: return "tackle";
                case EventType.PossessionChange: return "possession_change";
                case EventType.OutOfPlay: return "out_of_play";
                case EventType.Offside: return "offside";
                case EventType.Restart: return "restart";
                case EventType.HalfTime: return "half_time";
                default: return "full_time";
            }
        }

        public static EventType Parse(string s)
        {
            switch (s)
            {
                case "kickoff": return EventType.Kickoff;
                case "pass": return EventType.Pass;
                case "receive": return EventType.Receive;
                case "carry": return EventType.Carry;
                case "shot": return EventType.Shot;
                case "save": return EventType.Save;
                case "goal": return EventType.Goal;
                case "interception": return EventType.Interception;
                case "recovery": return EventType.Recovery;
                case "tackle": return EventType.Tackle;
                case "possession_change": return EventType.PossessionChange;
                case "out_of_play": return EventType.OutOfPlay;
                case "offside": return EventType.Offside;
                case "restart": return EventType.Restart;
                case "half_time": return EventType.HalfTime;
                case "full_time": return EventType.FullTime;
                default: throw new FormatException($"unknown event type '{s}'");
            }
        }
    }

    /// <summary>
    /// One engine event (union flattened). Field usage by type:
    /// kickoff{side} pass{from,to?,target,side,error} receive{player,from?,clean} carry{player,from(Vec),to(Vec)}
    /// shot{player,target,onTarget,side,error} save{keeper,shooter} goal{scorer,side,assist?}
    /// interception{player,from?} recovery{player} tackle{player,victim,won} possession_change{to(side),reason}
    /// out_of_play{restart,side} offside{player,side} restart{restart,side,taker} half_time{} full_time{home,away}.
    /// </summary>
    public sealed class MatchEvent
    {
        public string Id;
        public int Tick;
        public EventType Type;
        public Side Side;
        public bool HasSide;
        public string Player;
        public string From;
        public string To;
        public Vec2D Target;
        public bool HasTarget;
        public Vec2D FromPos;
        public Vec2D ToPos;
        public double Error;
        public bool Clean;
        public bool OnTarget;
        public string Keeper;
        public string Shooter;
        public string Scorer;
        public string Assist;
        public string Victim;
        public bool Won;
        public Side ToSide;
        public string Reason;
        public PhaseKind Restart;
        public string Taker;
        public int Home;
        public int Away;
    }

    public sealed class TeamInfo
    {
        public Side Side;
        public string Name;
        public string ShortName;
    }

    public enum CommandType { Pass, Carry, Shoot, FirstTouch, Move, Hold, Press, Screen }

    public static class CommandTypes
    {
        public static string Name(CommandType t)
        {
            switch (t)
            {
                case CommandType.Pass: return "pass";
                case CommandType.Carry: return "carry";
                case CommandType.Shoot: return "shoot";
                case CommandType.FirstTouch: return "first_touch";
                case CommandType.Move: return "move";
                case CommandType.Hold: return "hold";
                case CommandType.Press: return "press";
                default: return "screen";
            }
        }

        public static CommandType Parse(string s)
        {
            switch (s)
            {
                case "pass": return CommandType.Pass;
                case "carry": return CommandType.Carry;
                case "shoot": return CommandType.Shoot;
                case "first_touch": return CommandType.FirstTouch;
                case "move": return CommandType.Move;
                case "hold": return CommandType.Hold;
                case "press": return CommandType.Press;
                case "screen": return CommandType.Screen;
                default: throw new FormatException($"unknown command '{s}'");
            }
        }
    }

    /// <summary>
    /// External instruction for one player (union flattened):
    /// pass{Target,Receiver?} carry{Direction,Distance} shoot{Target} first_touch{Direction} move{Target}
    /// hold{} press{TargetId} screen{FromId,ToId}.
    /// </summary>
    public sealed class PlayerCommand
    {
        public CommandType Type;
        public Vec2D Target;
        public string Receiver;
        public Vec2D Direction;
        public double Distance;
        public string TargetId;
        public string FromId;
        public string ToId;

        public static PlayerCommand Pass(Vec2D target, string receiver = null) => new PlayerCommand { Type = CommandType.Pass, Target = target, Receiver = receiver };
        public static PlayerCommand Carry(Vec2D direction, double distance) => new PlayerCommand { Type = CommandType.Carry, Direction = direction, Distance = distance };
        public static PlayerCommand Shoot(Vec2D target) => new PlayerCommand { Type = CommandType.Shoot, Target = target };
        public static PlayerCommand FirstTouch(Vec2D direction) => new PlayerCommand { Type = CommandType.FirstTouch, Direction = direction };
        public static PlayerCommand Move(Vec2D target) => new PlayerCommand { Type = CommandType.Move, Target = target };
        public static PlayerCommand Hold() => new PlayerCommand { Type = CommandType.Hold };
        public static PlayerCommand Press(string targetId) => new PlayerCommand { Type = CommandType.Press, TargetId = targetId };
        public static PlayerCommand Screen(string fromId, string toId) => new PlayerCommand { Type = CommandType.Screen, FromId = fromId, ToId = toId };

        /// <summary>
        /// Structural identity, the counterpart of <c>JSON.stringify(cmd)</c> comparisons in the web
        /// session: two commands are the same play when every field is bit-identical.
        /// </summary>
        public string Key()
        {
            string V(Vec2D v) => BitConverter.DoubleToInt64Bits(v.X) + "," + BitConverter.DoubleToInt64Bits(v.Y);
            switch (Type)
            {
                case CommandType.Pass: return "pass|" + V(Target) + "|" + (Receiver ?? "");
                case CommandType.Carry: return "carry|" + V(Direction) + "|" + BitConverter.DoubleToInt64Bits(Distance);
                case CommandType.Shoot: return "shoot|" + V(Target);
                case CommandType.FirstTouch: return "first_touch|" + V(Direction);
                case CommandType.Move: return "move|" + V(Target);
                case CommandType.Hold: return "hold";
                case CommandType.Press: return "press|" + TargetId;
                default: return "screen|" + FromId + "|" + ToId;
            }
        }
    }

    public sealed class QueuedCommand
    {
        public PlayerCommand Command;
        public double Accuracy;
    }

    public sealed class OffsideSnapshot
    {
        public Side Side;
        public List<string> OffsidePlayers = new List<string>();
    }

    public sealed class Controlled
    {
        public Side Side;
        public string PlayerId;
    }

    public sealed class PendingShot
    {
        public string Shooter;
        public Side Side;
        public bool OnTarget;
    }

    public sealed class Score
    {
        public int Home;
        public int Away;
        public int Of(Side s) => s == Side.Home ? Home : Away;
    }

    public sealed class MatchState
    {
        public string MatchId;
        public Rules Rules;
        public double Seed;
        public uint RngState;
        public TeamInfo Home;
        public TeamInfo Away;
        public List<PlayerState> Players = new List<PlayerState>();
        public BallState Ball = new BallState();
        public MatchPhase Phase = MatchPhase.OpenPlay();
        public int RestartTimer;
        public Side? Possession;
        public Score Score = new Score();
        public Clock Clock = new Clock();
        public List<MatchEvent> Events = new List<MatchEvent>();
        public OffsideSnapshot OffsideSnapshot;
        public Controlled Controlled;
        /// <summary>Pending commands by player id (insertion ordered like a JS object).</summary>
        public Dictionary<string, QueuedCommand> Commands = new Dictionary<string, QueuedCommand>();
        public string Awaiting;
        public Dictionary<string, int> DecisionTimers = new Dictionary<string, int>();
        public int EventSeq;
        public PendingShot PendingShot;

        public const int TickMs = 50;
        public const double TickS = TickMs / 1000.0;
    }
}
