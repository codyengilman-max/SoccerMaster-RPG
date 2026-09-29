using System;
using System.Collections.Generic;
using SoccerMaster.Core.Serialization;
using SoccerMaster.Core.Sim;
using SoccerMaster.Core.Tactics;

namespace SoccerMaster.Core.Director
{
    /// <summary>
    /// Versioned native save of a match mid-flight (counterpart of web <c>RuntimeSave</c>). The
    /// authoritative state, its events and RNG are stored verbatim — nothing about the simulation
    /// is re-derived on load — and doubles round-trip bit-exactly, so a restored match ticks on to
    /// the same future as the one that was saved. A frozen question comes back before its timer.
    /// The catalog is not stored: the loader supplies it and the save records its identity.
    /// </summary>
    public static class MatchSave
    {
        public const string Format = "soccermaster-native-match";
        public const int Version = 1;

        public static string Serialize(MatchRuntime rt, string catalogId, bool pretty = false)
        {
            var o = new Dictionary<string, object>
            {
                ["format"] = Format,
                ["version"] = (double)Version,
                ["catalogId"] = catalogId,
                ["state"] = WriteState(rt.State),
                ["session"] = WriteSession(rt.Session),
                ["clock"] = new Dictionary<string, object> { ["scale"] = rt.Clock.Scale, ["carryMs"] = rt.Clock.CarryMs, ["realElapsedMs"] = rt.Clock.RealElapsedMs },
                ["phase"] = RuntimePhases.Name(rt.Phase),
                ["active"] = rt.Active == null ? null : WriteActive(rt.Active),
                ["halfTimeLeftMs"] = rt.HalfTimeLeftMs,
                ["realMs"] = WriteRealMs(rt.RealMs),
                ["history"] = WriteHistory(rt.History),
                ["eventCursor"] = (double)rt.EventCursor,
                ["halfTimePending"] = rt.HalfTimePending,
            };
            return Json.Write(o, pretty);
        }

        public static MatchRuntime Restore(string text, Catalog catalog)
        {
            var o = Json.Obj(Json.Parse(text), "save");
            if (Json.OptStr(o, "format") != Format) throw new FormatException("not a SoccerMaster native match save");
            double version = Json.Num(Json.Get(o, "version", "save"), "save.version");
            if (version != Version) throw new FormatException($"unsupported native match save v{version}");
            string catalogId = Json.OptStr(o, "catalogId");
            if (catalogId != null && catalogId != catalog.Id) throw new FormatException($"save was recorded against catalog {catalogId}, loaded catalog is {catalog.Id}");

            MatchState state = ReadState(Json.Obj(Json.Get(o, "state", "save"), "save.state"));
            TacticalSession session = ReadSession(Json.Obj(Json.Get(o, "session", "save"), "save.session"), catalog);
            var byId = new Dictionary<string, MomentRecord>();
            foreach (MomentRecord r in session.Records) byId[r.Moment.Id] = r;
            var c = Json.Obj(Json.Get(o, "clock", "save"), "save.clock");
            var clock = new RuntimeClock(Json.Num(Json.Get(c, "scale", "clock"), "scale"))
            {
                CarryMs = Json.Num(Json.Get(c, "carryMs", "clock"), "carryMs"),
                RealElapsedMs = Json.Num(Json.Get(c, "realElapsedMs", "clock"), "realElapsedMs"),
            };
            RuntimePhase phase = RuntimePhases.Parse(Json.Str(Json.Get(o, "phase", "save"), "phase"));
            object activeRaw = Json.Opt(o, "active");
            ActiveMoment active = activeRaw == null ? null : ReadActive(Json.Obj(activeRaw, "save.active"), byId);
            double[] realMs = ReadRealMs(Json.Obj(Json.Get(o, "realMs", "save"), "realMs"));
            List<Snapshot> history = ReadHistory(Json.Arr(Json.Get(o, "history", "save"), "history"), state.Players.Count);
            return MatchRuntime.Restore(state, session, clock, phase, active,
                Json.Num(Json.Get(o, "halfTimeLeftMs", "save"), "halfTimeLeftMs"), realMs, history,
                (int)Json.Num(Json.Get(o, "eventCursor", "save"), "eventCursor"),
                Json.Bool(Json.Get(o, "halfTimePending", "save"), "halfTimePending"));
        }

        // ------------------------------------------------------------------ primitives

        private static Dictionary<string, object> V(Vec2D v) => new Dictionary<string, object> { ["x"] = v.X, ["y"] = v.Y };

        private static Vec2D RV(object v, string where)
        {
            var o = Json.Obj(v, where);
            return new Vec2D(Json.Num(Json.Get(o, "x", where), where + ".x"), Json.Num(Json.Get(o, "y", where), where + ".y"));
        }

        private static List<object> Strings(IEnumerable<string> xs)
        {
            var l = new List<object>();
            foreach (string s in xs) l.Add(s);
            return l;
        }

        private static List<string> RStrings(object v, string where)
        {
            var l = new List<string>();
            foreach (object x in Json.Arr(v, where)) l.Add(Json.Str(x, where + "[]"));
            return l;
        }

        private static Dictionary<string, object> IntMap(Dictionary<string, int> m)
        {
            var o = new Dictionary<string, object>();
            foreach (var kv in m) o[kv.Key] = (double)kv.Value;
            return o;
        }

        private static Dictionary<string, int> RIntMap(object v, string where)
        {
            var m = new Dictionary<string, int>();
            foreach (var kv in Json.Obj(v, where)) m[kv.Key] = (int)Json.Num(kv.Value, where + "." + kv.Key);
            return m;
        }

        private static double? ONum(Dictionary<string, object> o, string key) => Json.Opt(o, key) is double d ? d : (double?)null;

        // ------------------------------------------------------------------ match state

        public static Dictionary<string, object> WriteState(MatchState s)
        {
            var players = new List<object>();
            foreach (PlayerState p in s.Players)
            {
                var attrs = new Dictionary<string, object>();
                foreach (string k in Attributes.Keys) attrs[k] = p.Attributes.Get(k);
                players.Add(new Dictionary<string, object>
                {
                    ["id"] = p.Id, ["side"] = Sides.Name(p.Side), ["role"] = (double)p.Role, ["name"] = p.Name, ["attributes"] = attrs,
                    ["pos"] = V(p.Pos), ["vel"] = V(p.Vel), ["fatigue"] = p.Fatigue, ["moveTarget"] = V(p.MoveTarget),
                    ["touchCooldown"] = (double)p.TouchCooldown, ["stunned"] = (double)p.Stunned, ["commitUntilTick"] = (double)p.CommitUntilTick,
                });
            }
            var events = new List<object>();
            foreach (MatchEvent e in s.Events) events.Add(WriteEvent(e));
            var commands = new Dictionary<string, object>();
            foreach (var kv in s.Commands) commands[kv.Key] = new Dictionary<string, object> { ["command"] = WriteCommand(kv.Value.Command), ["accuracy"] = kv.Value.Accuracy };
            return new Dictionary<string, object>
            {
                ["matchId"] = s.MatchId,
                ["rules"] = WriteRules(s.Rules),
                ["seed"] = s.Seed,
                ["rngState"] = (double)s.RngState,
                ["home"] = WriteTeam(s.Home),
                ["away"] = WriteTeam(s.Away),
                ["players"] = players,
                ["ball"] = WriteBall(s.Ball),
                ["phase"] = WritePhase(s.Phase),
                ["restartTimer"] = (double)s.RestartTimer,
                ["possession"] = s.Possession.HasValue ? Sides.Name(s.Possession.Value) : null,
                ["score"] = new Dictionary<string, object> { ["home"] = (double)s.Score.Home, ["away"] = (double)s.Score.Away },
                ["clock"] = new Dictionary<string, object> { ["tick"] = (double)s.Clock.Tick, ["timeMs"] = s.Clock.TimeMs, ["half"] = (double)s.Clock.Half, ["halfTimeS"] = s.Clock.HalfTimeS },
                ["events"] = events,
                ["offsideSnapshot"] = s.OffsideSnapshot == null ? null : new Dictionary<string, object> { ["side"] = Sides.Name(s.OffsideSnapshot.Side), ["offsidePlayers"] = Strings(s.OffsideSnapshot.OffsidePlayers) },
                ["controlled"] = s.Controlled == null ? null : new Dictionary<string, object> { ["side"] = Sides.Name(s.Controlled.Side), ["playerId"] = s.Controlled.PlayerId },
                ["commands"] = commands,
                ["awaiting"] = s.Awaiting,
                ["decisionTimers"] = IntMap(s.DecisionTimers),
                ["eventSeq"] = (double)s.EventSeq,
                ["pendingShot"] = s.PendingShot == null ? null : new Dictionary<string, object> { ["shooter"] = s.PendingShot.Shooter, ["side"] = Sides.Name(s.PendingShot.Side), ["onTarget"] = s.PendingShot.OnTarget },
            };
        }

        public static MatchState ReadState(Dictionary<string, object> o)
        {
            const string w = "state";
            var s = new MatchState
            {
                MatchId = Json.Str(Json.Get(o, "matchId", w), "matchId"),
                Rules = ReadRules(Json.Obj(Json.Get(o, "rules", w), "rules")),
                Seed = Json.Num(Json.Get(o, "seed", w), "seed"),
                RngState = (uint)Json.Num(Json.Get(o, "rngState", w), "rngState"),
                Home = ReadTeam(Json.Obj(Json.Get(o, "home", w), "home")),
                Away = ReadTeam(Json.Obj(Json.Get(o, "away", w), "away")),
                Ball = ReadBall(Json.Obj(Json.Get(o, "ball", w), "ball")),
                Phase = ReadPhase(Json.Obj(Json.Get(o, "phase", w), "phase")),
                RestartTimer = (int)Json.Num(Json.Get(o, "restartTimer", w), "restartTimer"),
                Possession = Json.OptStr(o, "possession") is string ps ? Sides.Parse(ps) : (Side?)null,
                Awaiting = Json.OptStr(o, "awaiting"),
                DecisionTimers = RIntMap(Json.Get(o, "decisionTimers", w), "decisionTimers"),
                EventSeq = (int)Json.Num(Json.Get(o, "eventSeq", w), "eventSeq"),
            };
            foreach (object pv in Json.Arr(Json.Get(o, "players", w), "players"))
            {
                var p = Json.Obj(pv, "player");
                var attrs = new Attributes();
                var ao = Json.Obj(Json.Get(p, "attributes", "player"), "attributes");
                foreach (string k in Attributes.Keys) attrs.Set(k, Json.Num(Json.Get(ao, k, "attributes"), k));
                s.Players.Add(new PlayerState
                {
                    Id = Json.Str(Json.Get(p, "id", "player"), "id"),
                    Side = Sides.Parse(Json.Str(Json.Get(p, "side", "player"), "side")),
                    Role = (int)Json.Num(Json.Get(p, "role", "player"), "role"),
                    Name = Json.Str(Json.Get(p, "name", "player"), "name"),
                    Attributes = attrs,
                    Pos = RV(Json.Get(p, "pos", "player"), "pos"),
                    Vel = RV(Json.Get(p, "vel", "player"), "vel"),
                    Fatigue = Json.Num(Json.Get(p, "fatigue", "player"), "fatigue"),
                    MoveTarget = RV(Json.Get(p, "moveTarget", "player"), "moveTarget"),
                    TouchCooldown = (int)Json.Num(Json.Get(p, "touchCooldown", "player"), "touchCooldown"),
                    Stunned = (int)Json.Num(Json.Get(p, "stunned", "player"), "stunned"),
                    CommitUntilTick = (int)Json.Num(Json.Get(p, "commitUntilTick", "player"), "commitUntilTick"),
                });
            }
            var sc = Json.Obj(Json.Get(o, "score", w), "score");
            s.Score = new Score { Home = (int)Json.Num(Json.Get(sc, "home", "score"), "home"), Away = (int)Json.Num(Json.Get(sc, "away", "score"), "away") };
            var ck = Json.Obj(Json.Get(o, "clock", w), "clock");
            s.Clock = new Clock
            {
                Tick = (int)Json.Num(Json.Get(ck, "tick", "clock"), "tick"),
                TimeMs = Json.Num(Json.Get(ck, "timeMs", "clock"), "timeMs"),
                Half = (int)Json.Num(Json.Get(ck, "half", "clock"), "half"),
                HalfTimeS = Json.Num(Json.Get(ck, "halfTimeS", "clock"), "halfTimeS"),
            };
            foreach (object ev in Json.Arr(Json.Get(o, "events", w), "events")) s.Events.Add(ReadEvent(Json.Obj(ev, "event")));
            if (Json.Opt(o, "offsideSnapshot") is Dictionary<string, object> os)
                s.OffsideSnapshot = new OffsideSnapshot { Side = Sides.Parse(Json.Str(Json.Get(os, "side", "offsideSnapshot"), "side")), OffsidePlayers = RStrings(Json.Get(os, "offsidePlayers", "offsideSnapshot"), "offsidePlayers") };
            if (Json.Opt(o, "controlled") is Dictionary<string, object> co)
                s.Controlled = new Controlled { Side = Sides.Parse(Json.Str(Json.Get(co, "side", "controlled"), "side")), PlayerId = Json.Str(Json.Get(co, "playerId", "controlled"), "playerId") };
            foreach (var kv in Json.Obj(Json.Get(o, "commands", w), "commands"))
            {
                var q = Json.Obj(kv.Value, "command");
                s.Commands[kv.Key] = new QueuedCommand { Command = ReadCommand(Json.Obj(Json.Get(q, "command", "queued"), "command")), Accuracy = Json.Num(Json.Get(q, "accuracy", "queued"), "accuracy") };
            }
            if (Json.Opt(o, "pendingShot") is Dictionary<string, object> sh)
                s.PendingShot = new PendingShot { Shooter = Json.Str(Json.Get(sh, "shooter", "pendingShot"), "shooter"), Side = Sides.Parse(Json.Str(Json.Get(sh, "side", "pendingShot"), "side")), OnTarget = Json.Bool(Json.Get(sh, "onTarget", "pendingShot"), "onTarget") };
            return s;
        }

        private static Dictionary<string, object> WriteRules(Rules r) => new Dictionary<string, object>
        {
            ["id"] = r.Id, ["label"] = r.Label, ["reviewStatus"] = r.ReviewStatus, ["playersPerSide"] = (double)r.PlayersPerSide,
            ["length"] = r.Length, ["width"] = r.Width, ["goalWidth"] = r.GoalWidth, ["goalAreaDepth"] = r.GoalAreaDepth, ["goalAreaWidth"] = r.GoalAreaWidth,
            ["penaltyAreaDepth"] = r.PenaltyAreaDepth, ["penaltyAreaWidth"] = r.PenaltyAreaWidth, ["penaltySpotDistance"] = r.PenaltySpotDistance,
            ["centerCircleRadius"] = r.CenterCircleRadius, ["buildOutLine"] = r.BuildOutLine, ["offside"] = r.Offside, ["headingAllowed"] = r.HeadingAllowed,
            ["halves"] = (double)r.Halves, ["halfLengthSeconds"] = r.HalfLengthSeconds, ["goalkeeperPuntAllowed"] = r.GoalkeeperPuntAllowed,
        };

        private static Rules ReadRules(Dictionary<string, object> o)
        {
            const string w = "rules";
            double N(string k) => Json.Num(Json.Get(o, k, w), k);
            bool B(string k) => Json.Bool(Json.Get(o, k, w), k);
            return new Rules
            {
                Id = Json.Str(Json.Get(o, "id", w), "id"), Label = Json.Str(Json.Get(o, "label", w), "label"), ReviewStatus = Json.Str(Json.Get(o, "reviewStatus", w), "reviewStatus"),
                PlayersPerSide = (int)N("playersPerSide"), Length = N("length"), Width = N("width"), GoalWidth = N("goalWidth"), GoalAreaDepth = N("goalAreaDepth"),
                GoalAreaWidth = N("goalAreaWidth"), PenaltyAreaDepth = N("penaltyAreaDepth"), PenaltyAreaWidth = N("penaltyAreaWidth"), PenaltySpotDistance = N("penaltySpotDistance"),
                CenterCircleRadius = N("centerCircleRadius"), BuildOutLine = B("buildOutLine"), Offside = B("offside"), HeadingAllowed = B("headingAllowed"),
                Halves = (int)N("halves"), HalfLengthSeconds = N("halfLengthSeconds"), GoalkeeperPuntAllowed = B("goalkeeperPuntAllowed"),
            };
        }

        private static Dictionary<string, object> WriteTeam(TeamInfo t) => new Dictionary<string, object> { ["side"] = Sides.Name(t.Side), ["name"] = t.Name, ["shortName"] = t.ShortName };

        private static TeamInfo ReadTeam(Dictionary<string, object> o) => new TeamInfo
        {
            Side = Sides.Parse(Json.Str(Json.Get(o, "side", "team"), "side")), Name = Json.Str(Json.Get(o, "name", "team"), "name"), ShortName = Json.Str(Json.Get(o, "shortName", "team"), "shortName"),
        };

        private static Dictionary<string, object> WriteBall(BallState b) => new Dictionary<string, object>
        {
            ["pos"] = V(b.Pos), ["vel"] = V(b.Vel), ["status"] = BallStatuses.Name(b.Status), ["owner"] = b.Owner, ["lastTouch"] = b.LastTouch,
            ["lastTouchSide"] = b.LastTouchSide.HasValue ? Sides.Name(b.LastTouchSide.Value) : null, ["passTarget"] = b.PassTarget, ["passFrom"] = b.PassFrom,
        };

        private static BallState ReadBall(Dictionary<string, object> o) => new BallState
        {
            Pos = RV(Json.Get(o, "pos", "ball"), "ball.pos"), Vel = RV(Json.Get(o, "vel", "ball"), "ball.vel"),
            Status = BallStatuses.Parse(Json.Str(Json.Get(o, "status", "ball"), "status")), Owner = Json.OptStr(o, "owner"), LastTouch = Json.OptStr(o, "lastTouch"),
            LastTouchSide = Json.OptStr(o, "lastTouchSide") is string ls ? Sides.Parse(ls) : (Side?)null, PassTarget = Json.OptStr(o, "passTarget"), PassFrom = Json.OptStr(o, "passFrom"),
        };

        private static Dictionary<string, object> WritePhase(MatchPhase p)
        {
            var o = new Dictionary<string, object> { ["kind"] = PhaseKinds.Name(p.Kind) };
            if (p.HasSide) o["side"] = Sides.Name(p.Side);
            if (p.HasAt) o["at"] = V(p.At);
            if (p.Reason != null) o["reason"] = p.Reason;
            return o;
        }

        private static MatchPhase ReadPhase(Dictionary<string, object> o)
        {
            var p = new MatchPhase { Kind = PhaseKinds.Parse(Json.Str(Json.Get(o, "kind", "phase"), "kind")), Reason = Json.OptStr(o, "reason") };
            if (Json.OptStr(o, "side") is string s) p.Side = Sides.Parse(s);
            if (Json.Opt(o, "at") != null) p.At = RV(Json.Opt(o, "at"), "phase.at");
            return p;
        }

        private static Dictionary<string, object> WriteEvent(MatchEvent e) => new Dictionary<string, object>
        {
            ["id"] = e.Id, ["tick"] = (double)e.Tick, ["type"] = EventTypes.Name(e.Type),
            ["side"] = e.HasSide ? Sides.Name(e.Side) : null, ["player"] = e.Player, ["from"] = e.From, ["to"] = e.To,
            ["target"] = e.HasTarget ? V(e.Target) : null, ["fromPos"] = V(e.FromPos), ["toPos"] = V(e.ToPos), ["error"] = e.Error,
            ["clean"] = e.Clean, ["onTarget"] = e.OnTarget, ["keeper"] = e.Keeper, ["shooter"] = e.Shooter, ["scorer"] = e.Scorer, ["assist"] = e.Assist,
            ["victim"] = e.Victim, ["won"] = e.Won, ["toSide"] = Sides.Name(e.ToSide), ["reason"] = e.Reason, ["restart"] = PhaseKinds.Name(e.Restart),
            ["taker"] = e.Taker, ["home"] = (double)e.Home, ["away"] = (double)e.Away,
        };

        private static MatchEvent ReadEvent(Dictionary<string, object> o)
        {
            const string w = "event";
            var e = new MatchEvent
            {
                Id = Json.Str(Json.Get(o, "id", w), "id"), Tick = (int)Json.Num(Json.Get(o, "tick", w), "tick"), Type = EventTypes.Parse(Json.Str(Json.Get(o, "type", w), "type")),
                Player = Json.OptStr(o, "player"), From = Json.OptStr(o, "from"), To = Json.OptStr(o, "to"),
                FromPos = RV(Json.Get(o, "fromPos", w), "fromPos"), ToPos = RV(Json.Get(o, "toPos", w), "toPos"), Error = Json.Num(Json.Get(o, "error", w), "error"),
                Clean = Json.Bool(Json.Get(o, "clean", w), "clean"), OnTarget = Json.Bool(Json.Get(o, "onTarget", w), "onTarget"),
                Keeper = Json.OptStr(o, "keeper"), Shooter = Json.OptStr(o, "shooter"), Scorer = Json.OptStr(o, "scorer"), Assist = Json.OptStr(o, "assist"),
                Victim = Json.OptStr(o, "victim"), Won = Json.Bool(Json.Get(o, "won", w), "won"), ToSide = Sides.Parse(Json.Str(Json.Get(o, "toSide", w), "toSide")),
                Reason = Json.OptStr(o, "reason"), Restart = PhaseKinds.Parse(Json.Str(Json.Get(o, "restart", w), "restart")), Taker = Json.OptStr(o, "taker"),
                Home = (int)Json.Num(Json.Get(o, "home", w), "home"), Away = (int)Json.Num(Json.Get(o, "away", w), "away"),
            };
            if (Json.OptStr(o, "side") is string s) { e.HasSide = true; e.Side = Sides.Parse(s); }
            if (Json.Opt(o, "target") != null) { e.HasTarget = true; e.Target = RV(Json.Opt(o, "target"), "target"); }
            return e;
        }

        public static Dictionary<string, object> WriteCommand(PlayerCommand c)
        {
            if (c == null) return null;
            var o = new Dictionary<string, object> { ["type"] = CommandTypes.Name(c.Type) };
            switch (c.Type)
            {
                case CommandType.Pass: o["target"] = V(c.Target); o["receiver"] = c.Receiver; break;
                case CommandType.Carry: o["direction"] = V(c.Direction); o["distance"] = c.Distance; break;
                case CommandType.Shoot: o["target"] = V(c.Target); break;
                case CommandType.FirstTouch: o["direction"] = V(c.Direction); break;
                case CommandType.Move: o["target"] = V(c.Target); break;
                case CommandType.Press: o["targetId"] = c.TargetId; break;
                case CommandType.Screen: o["fromId"] = c.FromId; o["toId"] = c.ToId; break;
            }
            return o;
        }

        public static PlayerCommand ReadCommand(Dictionary<string, object> o)
        {
            if (o == null) return null;
            const string w = "command";
            var c = new PlayerCommand { Type = CommandTypes.Parse(Json.Str(Json.Get(o, "type", w), "type")) };
            switch (c.Type)
            {
                case CommandType.Pass: c.Target = RV(Json.Get(o, "target", w), "target"); c.Receiver = Json.OptStr(o, "receiver"); break;
                case CommandType.Carry: c.Direction = RV(Json.Get(o, "direction", w), "direction"); c.Distance = Json.Num(Json.Get(o, "distance", w), "distance"); break;
                case CommandType.Shoot: c.Target = RV(Json.Get(o, "target", w), "target"); break;
                case CommandType.FirstTouch: c.Direction = RV(Json.Get(o, "direction", w), "direction"); break;
                case CommandType.Move: c.Target = RV(Json.Get(o, "target", w), "target"); break;
                case CommandType.Press: c.TargetId = Json.Str(Json.Get(o, "targetId", w), "targetId"); break;
                case CommandType.Screen: c.FromId = Json.Str(Json.Get(o, "fromId", w), "fromId"); c.ToId = Json.Str(Json.Get(o, "toId", w), "toId"); break;
            }
            return c;
        }

        // ------------------------------------------------------------------ tactical session

        private static Dictionary<string, object> WriteSession(TacticalSession s)
        {
            var open = new List<object>();
            foreach (OpenRecord o in s.Open) open.Add(new Dictionary<string, object> { ["momentId"] = o.Record.Moment.Id, ["committed"] = WriteCommitted(o.Committed) });
            var records = new List<object>();
            foreach (MomentRecord r in s.Records) records.Add(WriteRecord(r));
            return new Dictionary<string, object>
            {
                ["pacing"] = WritePacing(s.Pacing),
                ["recognizer"] = WriteRecognizer(s.Recognizer),
                ["active"] = s.Active == null ? null : WriteMoment(s.Active),
                ["open"] = open,
                ["records"] = records,
                ["rejects"] = IntMap(s.Rejects),
            };
        }

        private static TacticalSession ReadSession(Dictionary<string, object> o, Catalog catalog)
        {
            const string w = "session";
            var s = new TacticalSession(catalog, ReadPacing(Json.Obj(Json.Get(o, "pacing", w), "pacing")))
            {
                Recognizer = ReadRecognizer(Json.Obj(Json.Get(o, "recognizer", w), "recognizer")),
                Active = Json.Opt(o, "active") is Dictionary<string, object> a ? ReadMoment(a) : null,
                Rejects = RIntMap(Json.Get(o, "rejects", w), "rejects"),
            };
            var byId = new Dictionary<string, MomentRecord>();
            foreach (object rv in Json.Arr(Json.Get(o, "records", w), "records"))
            {
                MomentRecord r = ReadRecord(Json.Obj(rv, "record"));
                s.Records.Add(r);
                byId[r.Moment.Id] = r;
            }
            foreach (object ov in Json.Arr(Json.Get(o, "open", w), "open"))
            {
                var oo = Json.Obj(ov, "open");
                if (byId.TryGetValue(Json.Str(Json.Get(oo, "momentId", "open"), "momentId"), out MomentRecord rec))
                    s.Open.Add(new OpenRecord { Record = rec, Committed = Json.Opt(oo, "committed") is Dictionary<string, object> c ? ReadCommitted(c) : null });
            }
            return s;
        }

        private static Dictionary<string, object> WritePacing(PacingConfig p)
        {
            var o = new Dictionary<string, object>
            {
                ["totalLo"] = (double)p.TotalLo, ["totalHi"] = (double)p.TotalHi, ["onBallLo"] = (double)p.OnBallLo, ["onBallHi"] = (double)p.OnBallHi,
                ["minGapSeconds"] = p.MinGapSeconds, ["repeatGapSeconds"] = p.RepeatGapSeconds,
            };
            if (p.Direct != null)
                o["direct"] = new Dictionary<string, object>
                {
                    ["minOptions"] = (double)p.Direct.MinOptions, ["maxOptions"] = (double)p.Direct.MaxOptions, ["offBall"] = Strings(p.Direct.OffBall),
                    ["maxOffBall"] = (double)p.Direct.MaxOffBall, ["maxPerEntry"] = (double)p.Direct.MaxPerEntry, ["firstContactTicks"] = (double)p.Direct.FirstContactTicks,
                    ["fillFromRole"] = p.Direct.FillFromRole,
                };
            return o;
        }

        private static PacingConfig ReadPacing(Dictionary<string, object> o)
        {
            const string w = "pacing";
            var p = new PacingConfig
            {
                TotalLo = (int)Json.Num(Json.Get(o, "totalLo", w), "totalLo"), TotalHi = (int)Json.Num(Json.Get(o, "totalHi", w), "totalHi"),
                OnBallLo = (int)Json.Num(Json.Get(o, "onBallLo", w), "onBallLo"), OnBallHi = (int)Json.Num(Json.Get(o, "onBallHi", w), "onBallHi"),
                MinGapSeconds = Json.Num(Json.Get(o, "minGapSeconds", w), "minGapSeconds"), RepeatGapSeconds = Json.Num(Json.Get(o, "repeatGapSeconds", w), "repeatGapSeconds"),
            };
            if (Json.Opt(o, "direct") is Dictionary<string, object> d)
                p.Direct = new DirectPolicy
                {
                    MinOptions = (int)Json.Num(Json.Get(d, "minOptions", "direct"), "minOptions"), MaxOptions = (int)Json.Num(Json.Get(d, "maxOptions", "direct"), "maxOptions"),
                    OffBall = RStrings(Json.Get(d, "offBall", "direct"), "offBall"), MaxOffBall = (int)Json.Num(Json.Get(d, "maxOffBall", "direct"), "maxOffBall"),
                    MaxPerEntry = (int)Json.Num(Json.Get(d, "maxPerEntry", "direct"), "maxPerEntry"), FirstContactTicks = (int)Json.Num(Json.Get(d, "firstContactTicks", "direct"), "firstContactTicks"),
                    FillFromRole = Json.OptBool(d, "fillFromRole", false),
                };
            return p;
        }

        private static Dictionary<string, object> WriteRecognizer(RecognizerState r) => new Dictionary<string, object>
        {
            ["lastMomentTick"] = double.IsNegativeInfinity(r.LastMomentTick) ? null : (object)r.LastMomentTick,
            ["lastByEntry"] = IntMap(r.LastByEntry), ["usesByEntry"] = IntMap(r.UsesByEntry), ["count"] = (double)r.Count, ["onBallCount"] = (double)r.OnBallCount,
            ["byCategory"] = IntMap(r.ByCategory), ["seq"] = (double)r.Seq, ["controlSinceTick"] = (double)r.ControlSinceTick,
        };

        private static RecognizerState ReadRecognizer(Dictionary<string, object> o)
        {
            const string w = "recognizer";
            return new RecognizerState
            {
                LastMomentTick = Json.Opt(o, "lastMomentTick") is double t ? t : double.NegativeInfinity,
                LastByEntry = RIntMap(Json.Get(o, "lastByEntry", w), "lastByEntry"), UsesByEntry = RIntMap(Json.Get(o, "usesByEntry", w), "usesByEntry"),
                Count = (int)Json.Num(Json.Get(o, "count", w), "count"), OnBallCount = (int)Json.Num(Json.Get(o, "onBallCount", w), "onBallCount"),
                ByCategory = RIntMap(Json.Get(o, "byCategory", w), "byCategory"), Seq = (int)Json.Num(Json.Get(o, "seq", w), "seq"),
                ControlSinceTick = (int)Json.Num(Json.Get(o, "controlSinceTick", w), "controlSinceTick"),
            };
        }

        public static Dictionary<string, object> WriteMoment(TacticalMoment m)
        {
            var options = new List<object>();
            foreach (TacticalOption op in m.Options)
                options.Add(new Dictionary<string, object>
                {
                    ["id"] = op.Id, ["actionId"] = op.ActionId, ["label"] = op.Label, ["intent"] = op.Intent, ["drawn"] = op.Drawn,
                    ["command"] = WriteCommand(op.Command), ["anchor"] = op.Anchor.HasValue ? V(op.Anchor.Value) : null, ["score"] = op.Score,
                    ["feasibility"] = op.Feasibility, ["reasons"] = Strings(op.Reasons), ["receiver"] = op.Receiver, ["sourceEntryId"] = op.SourceEntryId,
                });
            var read = new Dictionary<string, object>();
            if (m.Read != null) foreach (string n in FieldRead.Names) read[n] = m.Read.Get(n);
            return new Dictionary<string, object>
            {
                ["id"] = m.Id, ["tick"] = (double)m.Tick, ["timeMs"] = m.TimeMs, ["entryId"] = m.EntryId, ["title"] = m.Title, ["category"] = m.Category,
                ["phase"] = m.Phase, ["role"] = m.Role, ["playerId"] = m.PlayerId, ["cues"] = Strings(m.Cues), ["options"] = options,
                ["difficulty"] = m.Difficulty == null ? null : new Dictionary<string, object>
                {
                    ["band"] = m.Difficulty.Band, ["clarity"] = m.Difficulty.Clarity, ["pressure"] = m.Difficulty.Pressure,
                    ["alternatives"] = (double)m.Difficulty.Alternatives, ["score"] = m.Difficulty.Score,
                },
                ["major"] = m.Major, ["involvement"] = m.Involvement, ["read"] = m.Read == null ? null : read,
            };
        }

        public static TacticalMoment ReadMoment(Dictionary<string, object> o)
        {
            const string w = "moment";
            var m = new TacticalMoment
            {
                Id = Json.Str(Json.Get(o, "id", w), "id"), Tick = (int)Json.Num(Json.Get(o, "tick", w), "tick"), TimeMs = Json.Num(Json.Get(o, "timeMs", w), "timeMs"),
                EntryId = Json.Str(Json.Get(o, "entryId", w), "entryId"), Title = Json.Str(Json.Get(o, "title", w), "title"), Category = Json.Str(Json.Get(o, "category", w), "category"),
                Phase = Json.Str(Json.Get(o, "phase", w), "phase"), Role = Json.Str(Json.Get(o, "role", w), "role"), PlayerId = Json.Str(Json.Get(o, "playerId", w), "playerId"),
                Cues = RStrings(Json.Get(o, "cues", w), "cues"), Major = Json.Bool(Json.Get(o, "major", w), "major"), Involvement = Json.OptStr(o, "involvement"),
            };
            foreach (object ov in Json.Arr(Json.Get(o, "options", w), "options"))
            {
                var op = Json.Obj(ov, "option");
                m.Options.Add(new TacticalOption
                {
                    Id = Json.Str(Json.Get(op, "id", "option"), "id"), ActionId = Json.Str(Json.Get(op, "actionId", "option"), "actionId"),
                    Label = Json.Str(Json.Get(op, "label", "option"), "label"), Intent = Json.Str(Json.Get(op, "intent", "option"), "intent"),
                    Drawn = Json.Bool(Json.Get(op, "drawn", "option"), "drawn"), Command = ReadCommand(Json.Opt(op, "command") as Dictionary<string, object>),
                    Anchor = Json.Opt(op, "anchor") is Dictionary<string, object> an ? RV(an, "anchor") : (Vec2D?)null,
                    Score = Json.Num(Json.Get(op, "score", "option"), "score"), Feasibility = Json.Num(Json.Get(op, "feasibility", "option"), "feasibility"),
                    Reasons = RStrings(Json.Get(op, "reasons", "option"), "reasons"), Receiver = Json.OptStr(op, "receiver"), SourceEntryId = Json.OptStr(op, "sourceEntryId"),
                });
            }
            if (Json.Opt(o, "difficulty") is Dictionary<string, object> d)
                m.Difficulty = new Difficulty
                {
                    Band = Json.Str(Json.Get(d, "band", "difficulty"), "band"), Clarity = Json.Num(Json.Get(d, "clarity", "difficulty"), "clarity"),
                    Pressure = Json.Num(Json.Get(d, "pressure", "difficulty"), "pressure"), Alternatives = (int)Json.Num(Json.Get(d, "alternatives", "difficulty"), "alternatives"),
                    Score = Json.Num(Json.Get(d, "score", "difficulty"), "score"),
                };
            if (Json.Opt(o, "read") is Dictionary<string, object> rd)
            {
                var read = new FieldRead();
                foreach (string n in FieldRead.Names) read.Set(n, Json.Num(Json.Get(rd, n, "read"), n));
                m.Read = read;
            }
            return m;
        }

        private static Dictionary<string, object> WriteDecision(DecisionRecord d) => d == null ? null : new Dictionary<string, object>
        {
            ["momentId"] = d.MomentId, ["chosenOptionId"] = d.ChosenOptionId, ["quality"] = d.Quality.HasValue ? (object)d.Quality.Value : null,
            ["band"] = d.Band, ["bestOptionId"] = d.BestOptionId, ["explanation"] = Strings(d.Explanation), ["commitTick"] = (double)d.CommitTick,
        };

        private static DecisionRecord ReadDecision(Dictionary<string, object> o) => o == null ? null : new DecisionRecord
        {
            MomentId = Json.Str(Json.Get(o, "momentId", "decision"), "momentId"), ChosenOptionId = Json.OptStr(o, "chosenOptionId"), Quality = ONum(o, "quality"),
            Band = Json.Str(Json.Get(o, "band", "decision"), "band"), BestOptionId = Json.OptStr(o, "bestOptionId"),
            Explanation = RStrings(Json.Get(o, "explanation", "decision"), "explanation"), CommitTick = (int)Json.Num(Json.Get(o, "commitTick", "decision"), "commitTick"),
        };

        private static Dictionary<string, object> WriteCommitted(CommittedIntent c) => c == null ? null : new Dictionary<string, object>
        {
            ["momentId"] = c.MomentId, ["actor"] = c.Actor, ["optionId"] = c.OptionId, ["label"] = c.Label, ["command"] = WriteCommand(c.Command), ["commitTick"] = (double)c.CommitTick,
        };

        private static CommittedIntent ReadCommitted(Dictionary<string, object> o) => o == null ? null : new CommittedIntent
        {
            MomentId = Json.Str(Json.Get(o, "momentId", "committed"), "momentId"), Actor = Json.Str(Json.Get(o, "actor", "committed"), "actor"),
            OptionId = Json.OptStr(o, "optionId"), Label = Json.OptStr(o, "label"), Command = ReadCommand(Json.Opt(o, "command") as Dictionary<string, object>),
            CommitTick = (int)Json.Num(Json.Get(o, "commitTick", "committed"), "commitTick"),
        };

        private static Dictionary<string, object> WriteExecution(ExecutionRecord e) => e == null ? null : new Dictionary<string, object>
        {
            ["momentId"] = e.MomentId, ["actor"] = e.Actor, ["quality"] = e.Quality, ["band"] = e.Band, ["pressureAtCommit"] = e.PressureAtCommit, ["fatigueAtCommit"] = e.FatigueAtCommit,
        };

        private static ExecutionRecord ReadExecution(Dictionary<string, object> o) => o == null ? null : new ExecutionRecord
        {
            MomentId = Json.Str(Json.Get(o, "momentId", "execution"), "momentId"), Actor = Json.Str(Json.Get(o, "actor", "execution"), "actor"),
            Quality = Json.Num(Json.Get(o, "quality", "execution"), "quality"), Band = Json.Str(Json.Get(o, "band", "execution"), "band"),
            PressureAtCommit = Json.Num(Json.Get(o, "pressureAtCommit", "execution"), "pressureAtCommit"), FatigueAtCommit = Json.Num(Json.Get(o, "fatigueAtCommit", "execution"), "fatigueAtCommit"),
        };

        private static Dictionary<string, object> WriteOutcome(OutcomeRecord r) => r == null ? null : new Dictionary<string, object>
        {
            ["momentId"] = r.MomentId, ["result"] = r.Result, ["summary"] = r.Summary, ["eventIds"] = Strings(r.EventIds), ["resolvedTick"] = (double)r.ResolvedTick,
        };

        private static OutcomeRecord ReadOutcome(Dictionary<string, object> o) => o == null ? null : new OutcomeRecord
        {
            MomentId = Json.Str(Json.Get(o, "momentId", "outcome"), "momentId"), Result = Json.Str(Json.Get(o, "result", "outcome"), "result"),
            Summary = Json.Str(Json.Get(o, "summary", "outcome"), "summary"), EventIds = RStrings(Json.Get(o, "eventIds", "outcome"), "eventIds"),
            ResolvedTick = (int)Json.Num(Json.Get(o, "resolvedTick", "outcome"), "resolvedTick"),
        };

        private static Dictionary<string, object> WriteRecord(MomentRecord r) => new Dictionary<string, object>
        {
            ["moment"] = WriteMoment(r.Moment), ["decision"] = WriteDecision(r.Decision), ["acted"] = WriteCommitted(r.Acted),
            ["execution"] = WriteExecution(r.Execution), ["outcome"] = WriteOutcome(r.Outcome),
        };

        private static MomentRecord ReadRecord(Dictionary<string, object> o) => new MomentRecord
        {
            Moment = ReadMoment(Json.Obj(Json.Get(o, "moment", "record"), "moment")),
            Decision = ReadDecision(Json.Opt(o, "decision") as Dictionary<string, object>),
            Acted = ReadCommitted(Json.Opt(o, "acted") as Dictionary<string, object>),
            Execution = ReadExecution(Json.Opt(o, "execution") as Dictionary<string, object>),
            Outcome = ReadOutcome(Json.Opt(o, "outcome") as Dictionary<string, object>),
        };

        private static Dictionary<string, object> WriteCommitResult(CommitResult r) => r == null ? null : new Dictionary<string, object>
        {
            ["status"] = r.Status, ["decision"] = WriteDecision(r.Decision), ["acted"] = WriteCommitted(r.Acted), ["issued"] = WriteCommand(r.Issued),
        };

        private static CommitResult ReadCommitResult(Dictionary<string, object> o) => o == null ? null : new CommitResult
        {
            Status = Json.Str(Json.Get(o, "status", "result"), "status"), Decision = ReadDecision(Json.Opt(o, "decision") as Dictionary<string, object>),
            Acted = ReadCommitted(Json.Opt(o, "acted") as Dictionary<string, object>), Issued = ReadCommand(Json.Opt(o, "issued") as Dictionary<string, object>),
        };

        // ------------------------------------------------------------------ runtime

        private static Dictionary<string, object> WriteActive(ActiveMoment a) => new Dictionary<string, object>
        {
            ["moment"] = WriteMoment(a.Moment), ["leadInMs"] = a.LeadInMs, ["leadInTotalMs"] = a.LeadInTotalMs, ["history"] = WriteHistory(a.History),
            ["timerLeftMs"] = a.TimerLeftMs, ["timerRunning"] = a.TimerRunning, ["result"] = WriteCommitResult(a.Result), ["reason"] = a.Reason,
            ["recordId"] = a.Record?.Moment.Id, ["feedbackMs"] = a.FeedbackMs, ["feedback"] = a.Feedback == null ? null : Strings(a.Feedback),
        };

        private static ActiveMoment ReadActive(Dictionary<string, object> o, Dictionary<string, MomentRecord> byId)
        {
            const string w = "active";
            var a = new ActiveMoment
            {
                Moment = ReadMoment(Json.Obj(Json.Get(o, "moment", w), "moment")),
                LeadInMs = Json.Num(Json.Get(o, "leadInMs", w), "leadInMs"), LeadInTotalMs = Json.Num(Json.Get(o, "leadInTotalMs", w), "leadInTotalMs"),
                TimerLeftMs = Json.Num(Json.Get(o, "timerLeftMs", w), "timerLeftMs"), TimerRunning = Json.Bool(Json.Get(o, "timerRunning", w), "timerRunning"),
                Result = ReadCommitResult(Json.Opt(o, "result") as Dictionary<string, object>), Reason = Json.OptStr(o, "reason"),
                FeedbackMs = Json.Num(Json.Get(o, "feedbackMs", w), "feedbackMs"),
                Feedback = Json.Opt(o, "feedback") is List<object> f ? RStrings(f, "feedback") : null,
            };
            a.History = ReadHistory(Json.Arr(Json.Get(o, "history", w), "history"), -1);
            if (Json.OptStr(o, "recordId") is string rid && byId.TryGetValue(rid, out MomentRecord rec)) a.Record = rec;
            return a;
        }

        private static Dictionary<string, object> WriteRealMs(double[] realMs)
        {
            var o = new Dictionary<string, object>();
            foreach (RuntimePhase p in RuntimePhases.All) o[RuntimePhases.Name(p)] = realMs[(int)p];
            return o;
        }

        private static double[] ReadRealMs(Dictionary<string, object> o)
        {
            var r = new double[RuntimePhases.All.Length];
            foreach (RuntimePhase p in RuntimePhases.All) r[(int)p] = Json.OptNum(o, RuntimePhases.Name(p), 0);
            return r;
        }

        private static List<object> WriteHistory(List<Snapshot> history)
        {
            var l = new List<object>();
            foreach (Snapshot s in history)
            {
                var pos = new List<object>();
                var vel = new List<object>();
                for (int i = 0; i < s.Pos.Length; i++)
                {
                    pos.Add(s.Pos[i].X); pos.Add(s.Pos[i].Y);
                    vel.Add(s.Vel[i].X); vel.Add(s.Vel[i].Y);
                }
                l.Add(new Dictionary<string, object> { ["tick"] = (double)s.Tick, ["pos"] = pos, ["vel"] = vel, ["ball"] = WriteBall(s.Ball) });
            }
            return l;
        }

        private static List<Snapshot> ReadHistory(List<object> arr, int expectPlayers)
        {
            var l = new List<Snapshot>();
            foreach (object sv in arr)
            {
                var o = Json.Obj(sv, "snapshot");
                List<object> pos = Json.Arr(Json.Get(o, "pos", "snapshot"), "pos");
                List<object> vel = Json.Arr(Json.Get(o, "vel", "snapshot"), "vel");
                if (pos.Count != vel.Count || pos.Count % 2 != 0) throw new FormatException("snapshot pos/vel length");
                int n = pos.Count / 2;
                if (expectPlayers >= 0 && n != expectPlayers) throw new FormatException($"snapshot has {n} players, state has {expectPlayers}");
                var s = new Snapshot { Tick = (int)Json.Num(Json.Get(o, "tick", "snapshot"), "tick"), Pos = new Vec2D[n], Vel = new Vec2D[n], Ball = ReadBall(Json.Obj(Json.Get(o, "ball", "snapshot"), "ball")) };
                for (int i = 0; i < n; i++)
                {
                    s.Pos[i] = new Vec2D(Json.Num(pos[2 * i], "pos"), Json.Num(pos[2 * i + 1], "pos"));
                    s.Vel[i] = new Vec2D(Json.Num(vel[2 * i], "vel"), Json.Num(vel[2 * i + 1], "vel"));
                }
                l.Add(s);
            }
            return l;
        }
    }
}
