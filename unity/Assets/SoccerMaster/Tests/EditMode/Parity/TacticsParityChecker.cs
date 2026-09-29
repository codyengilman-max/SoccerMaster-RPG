using System;
using System.Collections.Generic;
using SoccerMaster.Core.Serialization;
using SoccerMaster.Core.Sim;
using SoccerMaster.Core.Tactics;

namespace SoccerMaster.Tests.Parity
{
    /// <summary>
    /// Replays the web-generated tactical fixture (tools/nativeTacticsFixtures.ts) through the C#
    /// engine + tactical layer and reports every divergence: engine trace (sampled ball/rng/score and
    /// every event), each recognised moment with its hidden option metadata, each commit (decision
    /// grade, attribution, issued command) and each settled execution/outcome. Host agnostic: the Unity
    /// EditMode test and the dotnet pre-check both call <see cref="Check"/>.
    /// </summary>
    public static class TacticsParityChecker
    {
        /// <summary>Positions/feature values accumulate through trig; last-ulp drift only.</summary>
        private const double Eps = 1e-9;

        public sealed class Result
        {
            public readonly List<string> Failures = new List<string>();
            public int Comparisons;
            public int Runs;
            public int Moments;
            public int Commits;
            public int Settled;
            public int Events;
            public bool Passed => Failures.Count == 0;
        }

        public static Result Check(string fixtureJson, string catalogJson)
        {
            var r = new Result();
            Dictionary<string, object> f = Json.Obj(Json.Parse(fixtureJson), "fixture");
            Expect(r, "generator", "tools/nativeTacticsFixtures.ts", Json.Str(Json.Get(f, "generator", "fixture"), "generator"));
            Catalog catalog;
            try { catalog = Catalog.Load(catalogJson); }
            catch (FormatException ex) { r.Comparisons++; r.Failures.Add("catalog: " + ex.Message); return r; }
            Dictionary<string, object> cat = Json.Obj(Json.Get(f, "catalog", "fixture"), "catalog");
            Expect(r, "catalog.id", Json.Str(Json.Get(cat, "id", "catalog"), "id"), catalog.Id);
            Expect(r, "catalog.entries", Json.Num(Json.Get(cat, "entries", "catalog"), "entries"), catalog.Entries.Count);
            foreach (object run in Json.Arr(Json.Get(f, "runs", "fixture"), "runs"))
            {
                r.Runs++;
                CheckRun(Json.Obj(run, "run"), catalog, r);
            }
            return r;
        }

        private static void Expect(Result r, string where, double expected, double actual, double eps = 0)
        {
            r.Comparisons++;
            if (double.IsNaN(expected) != double.IsNaN(actual) || Math.Abs(expected - actual) > eps)
                r.Failures.Add($"{where}: expected {expected:R}, got {actual:R}");
        }

        private static void Expect(Result r, string where, string expected, string actual)
        {
            r.Comparisons++;
            if (expected != actual) r.Failures.Add($"{where}: expected '{expected}', got '{actual}'");
        }

        private static void Expect(Result r, string where, bool expected, bool actual)
        {
            r.Comparisons++;
            if (expected != actual) r.Failures.Add($"{where}: expected {expected}, got {actual}");
        }

        private static void ExpectList(Result r, string where, List<object> expected, List<string> actual)
        {
            Expect(r, where + ".count", expected.Count, actual.Count);
            for (int i = 0; i < Math.Min(expected.Count, actual.Count); i++) Expect(r, $"{where}[{i}]", Json.Str(expected[i], where), actual[i]);
        }

        private static string F9(double x) => JsMath.ToFixed(x, 9);

        private static string OrEmpty(string s) => s ?? "";

        /// <summary>Mirror of the generator's `eventLine`.</summary>
        public static string EventLine(MatchEvent e)
        {
            string t = e.Tick.ToString();
            switch (e.Type)
            {
                case EventType.Kickoff: return $"{t}|kickoff|{Sides.Name(e.Side)}";
                case EventType.Pass: return $"{t}|pass|{e.From}|{OrEmpty(e.To)}|{Sides.Name(e.Side)}|{F9(e.Error)}";
                case EventType.Receive: return $"{t}|receive|{e.Player}|{OrEmpty(e.From)}|{(e.Clean ? 1 : 0)}";
                case EventType.Carry: return $"{t}|carry|{e.Player}";
                case EventType.Shot: return $"{t}|shot|{e.Player}|{Sides.Name(e.Side)}|{(e.OnTarget ? 1 : 0)}|{F9(e.Error)}";
                case EventType.Save: return $"{t}|save|{e.Keeper}|{e.Shooter}";
                case EventType.Goal: return $"{t}|goal|{e.Scorer}|{Sides.Name(e.Side)}|{OrEmpty(e.Assist)}";
                case EventType.Interception: return $"{t}|interception|{e.Player}|{OrEmpty(e.From)}";
                case EventType.Recovery: return $"{t}|recovery|{e.Player}";
                case EventType.Tackle: return $"{t}|tackle|{e.Player}|{e.Victim}|{(e.Won ? 1 : 0)}";
                case EventType.PossessionChange: return $"{t}|possession_change|{Sides.Name(e.ToSide)}|{e.Reason}";
                case EventType.OutOfPlay: return $"{t}|out_of_play|{PhaseKinds.Name(e.Restart)}|{Sides.Name(e.Side)}";
                case EventType.Offside: return $"{t}|offside|{e.Player}|{Sides.Name(e.Side)}";
                case EventType.Restart: return $"{t}|restart|{PhaseKinds.Name(e.Restart)}|{Sides.Name(e.Side)}|{e.Taker}";
                case EventType.HalfTime: return $"{t}|half_time";
                default: return $"{t}|full_time|{e.Home}|{e.Away}";
            }
        }

        /// <summary>Mirror of the generator's `sample`.</summary>
        public static string Sample(MatchState s) =>
            $"{s.Clock.Tick}|{s.RngState}|{F9(s.Ball.Pos.X)}|{F9(s.Ball.Pos.Y)}|{BallStatuses.Name(s.Ball.Status)}|{OrEmpty(s.Ball.Owner)}|{PhaseKinds.Name(s.Phase.Kind)}|{s.Score.Home}|{s.Score.Away}|{s.Events.Count}";

        private static int RoleNumber(string roleId)
        {
            foreach (int n in Roles.Numbers) if (Roles.IdOf(n) == roleId) return n;
            throw new ArgumentException("unknown role " + roleId);
        }

        private static void CheckRun(Dictionary<string, object> run, Catalog catalog, Result r)
        {
            int seed = (int)Json.Num(Json.Get(run, "seed", "run"), "seed");
            string role = Json.Str(Json.Get(run, "role", "run"), "role");
            string policy = Json.Str(Json.Get(run, "policy", "run"), "policy");
            bool four = Json.Bool(Json.Get(run, "four", "run"), "four");
            double quality = Json.Num(Json.Get(run, "quality", "run"), "quality");
            string tag = $"run[{seed} {role} {policy}{(four ? " four" : "")}]";
            double sampleEveryTickUntil = Json.Num(Json.Get(run, "sampleEveryTickUntil", "run"), "sampleEveryTickUntil");
            int sampleStride = (int)Json.Num(Json.Get(run, "sampleStride", "run"), "sampleStride");

            List<SquadPlayer> home = Squad.Generate(seed * 7 + 1, "H", quality);
            List<SquadPlayer> away = Squad.Generate(seed * 7 + 2, "A", quality);
            int roleNumber = RoleNumber(role);
            SquadPlayer me = null;
            foreach (SquadPlayer sp in home) if (sp.Role == roleNumber) { me = sp; break; }
            if (me == null) { r.Failures.Add(tag + ": role missing from squad"); return; }
            Expect(r, tag + ".controlledId", Json.Str(Json.Get(run, "controlledId", "run"), "controlledId"), me.Id);

            PacingConfig pacing = four ? PacingConfig.NativeFour(role) : PacingConfig.For(role);
            var session = new TacticalSession(catalog, pacing);
            MatchState state = Engine.CreateMatch(new MatchConfig
            {
                MatchId = $"tactics-parity-{seed}",
                Seed = seed,
                Rules = Rules.U11_9v9(),
                Home = new TeamConfig { Side = Side.Home, Name = "Home", ShortName = "HOM", Squad = home },
                Away = new TeamConfig { Side = Side.Away, Name = "Away", ShortName = "AWY", Squad = away },
                Controlled = new Controlled { Side = Side.Home, PlayerId = me.Id },
            });
            var user = new Rng(seed ^ unchecked((int)0x9e3779b9));

            List<object> samples = Json.Arr(Json.Get(run, "samples", "run"), "samples");
            List<object> moments = Json.Arr(Json.Get(run, "moments", "run"), "moments");
            List<object> commits = Json.Arr(Json.Get(run, "commits", "run"), "commits");
            List<object> settled = Json.Arr(Json.Get(run, "settled", "run"), "settled");
            int si = 0, mi = 0, ci = 0, ti = 0;
            var seen = new HashSet<MomentRecord>();
            int pendingUntil = -1;
            int seq = 0;

            void CheckSample()
            {
                string actual = Sample(state);
                if (si < samples.Count) Expect(r, $"{tag}.samples[{si}]", Json.Str(samples[si], "sample"), actual);
                else if (si == samples.Count) r.Failures.Add($"{tag}.samples: native produced extra sample {actual}");
                si++;
            }

            void CollectSettled()
            {
                foreach (MomentRecord rec in session.Records)
                {
                    if (rec.Outcome == null || !seen.Add(rec)) continue;
                    r.Settled++;
                    if (ti >= settled.Count) { if (ti == settled.Count) r.Failures.Add($"{tag}.settled: native settled extra record {rec.Moment.Id}"); ti++; continue; }
                    CheckSettled(Json.Obj(settled[ti], "settled"), rec, session, $"{tag}.settled[{ti}]", r);
                    ti++;
                }
            }

            string tracePath = Environment.GetEnvironmentVariable("SM_PARITY_TRACE");
            var trace = tracePath == null ? null : new System.Text.StringBuilder();
            while (!Engine.IsFinished(state))
            {
                int t = state.Clock.Tick;
                if (trace != null)
                {
                    var inv = System.Globalization.CultureInfo.InvariantCulture;
                    trace.Append(t).Append('|').Append(state.Ball.Pos.X.ToString("R", inv)).Append('|').Append(state.Ball.Pos.Y.ToString("R", inv)).Append('|').Append(state.Ball.Vel.X.ToString("R", inv)).Append('|').Append(state.Ball.Vel.Y.ToString("R", inv)).Append('|').Append(BallStatuses.Name(state.Ball.Status)).Append('|').Append(OrEmpty(state.Ball.Owner)).Append('|');
                    for (int k = 0; k < state.Players.Count; k++) { if (k > 0) trace.Append(';'); PlayerState q = state.Players[k]; trace.Append(q.Id).Append(':').Append(q.Pos.X.ToString("R", inv)).Append(',').Append(q.Pos.Y.ToString("R", inv)); }
                    trace.Append('\n');
                }
                if (t <= sampleEveryTickUntil || t % sampleStride == 0) CheckSample();
                TacticalMoment moment = session.Observe(state);
                if (moment == null && mi < moments.Count && session.Active == null)
                {
                    Dictionary<string, object> due = Json.Obj(moments[mi], "moment");
                    if ((int)Json.Num(Json.Get(due, "tick", "moment"), "tick") == t)
                    {
                        string lastReject = null;
                        foreach (KeyValuePair<string, int> kv in session.Rejects) lastReject = (lastReject == null ? "" : lastReject + ",") + kv.Key + "=" + kv.Value;
                        r.Comparisons++;
                        r.Failures.Add($"{tag}.moments[{mi}]: web opened {Json.Str(Json.Get(due, "entryId", "moment"), "entryId")} at tick {t}, native declined (rejects so far: {lastReject}; controlSince={session.Recognizer.ControlSinceTick} count={session.Recognizer.Count})");
                        PlayerState cp = state.Players.Find(x => x.Id == me.Id);
                        FieldRead nativeRead = FieldRead.Read(state, cp);
                        Dictionary<string, object> webRead = Json.Obj(Json.Get(due, "read", "moment"), "read");
                        foreach (string name in FieldRead.Names)
                        {
                            double expected = Json.Num(Json.Get(webRead, name, "read"), name);
                            double actual = nativeRead.Get(name);
                            if (Math.Abs(expected - actual) > Eps) r.Failures.Add($"{tag}.moments[{mi}].read.{name}: web {expected:R}, native {actual:R}");
                        }
                    }
                }
                if (moment != null)
                {
                    r.Moments++;
                    if (mi < moments.Count) CheckMoment(Json.Obj(moments[mi], "moment"), moment, $"{tag}.moments[{mi}]", r);
                    else if (mi == moments.Count) r.Failures.Add($"{tag}.moments: native recognised extra moment {moment.Id} at tick {t}");
                    mi++;
                    pendingUntil = policy == "cycle" ? t : t + user.Int(2, 8);
                }
                if (session.Active != null && t >= pendingUntil)
                {
                    TacticalMoment m = session.Active;
                    int n = seq++;
                    r.Commits++;
                    CommitResult res;
                    string kind;
                    string optionId = null;
                    if (n % 5 == 4) { kind = "timeout"; res = session.Timeout(state); }
                    else
                    {
                        kind = "commit";
                        optionId = m.Options[n % m.Options.Count].Id;
                        res = session.Commit(state, optionId);
                    }
                    if (ci < commits.Count) CheckCommit(Json.Obj(commits[ci], "commit"), kind, m, optionId, t, res, $"{tag}.commits[{ci}]", r);
                    else if (ci == commits.Count) r.Failures.Add($"{tag}.commits: native committed extra {kind} for {m.Id}");
                    ci++;
                }
                CollectSettled();
                Engine.Tick(state);
                if (r.Failures.Count > 200) { r.Failures.Add($"{tag}: too many failures, stopping this run"); break; }
            }
            if (trace != null) System.IO.File.WriteAllText(tracePath, trace.ToString());
            session.Observe(state);
            CollectSettled();
            CheckSample();

            Expect(r, tag + ".samples.count", samples.Count, si);
            Expect(r, tag + ".moments.count", moments.Count, mi);
            Expect(r, tag + ".commits.count", commits.Count, ci);
            Expect(r, tag + ".settled.count", settled.Count, ti);

            List<object> events = Json.Arr(Json.Get(run, "events", "run"), "events");
            Expect(r, tag + ".events.count", events.Count, state.Events.Count);
            int shownEventFailures = 0;
            for (int i = 0; i < Math.Min(events.Count, state.Events.Count); i++)
            {
                r.Comparisons++;
                r.Events++;
                string expected = Json.Str(events[i], "event");
                string actual = EventLine(state.Events[i]);
                if (expected != actual && shownEventFailures++ < 10) r.Failures.Add($"{tag}.events[{i}]: expected '{expected}', got '{actual}'");
            }

            Dictionary<string, object> final = Json.Obj(Json.Get(run, "final", "run"), "final");
            Expect(r, tag + ".final.tick", Json.Num(Json.Get(final, "tick", "final"), "tick"), state.Clock.Tick);
            Expect(r, tag + ".final.home", Json.Num(Json.Get(final, "home", "final"), "home"), state.Score.Home);
            Expect(r, tag + ".final.away", Json.Num(Json.Get(final, "away", "final"), "away"), state.Score.Away);
            Expect(r, tag + ".final.rng", Json.Num(Json.Get(final, "rng", "final"), "rng"), state.RngState);
            Expect(r, tag + ".final.records", Json.Num(Json.Get(final, "records", "final"), "records"), session.Records.Count);
            Expect(r, tag + ".final.open", Json.Num(Json.Get(final, "open", "final"), "open"), session.Open.Count);

            Dictionary<string, object> rejects = Json.Obj(Json.Get(run, "rejects", "run"), "rejects");
            foreach (KeyValuePair<string, object> kv in rejects)
                Expect(r, $"{tag}.rejects.{kv.Key}", Json.Num(kv.Value, "reject"), session.Rejects.TryGetValue(kv.Key, out int c) ? c : 0);
            foreach (KeyValuePair<string, int> kv in session.Rejects)
                if (!rejects.ContainsKey(kv.Key)) { r.Comparisons++; r.Failures.Add($"{tag}.rejects.{kv.Key}: native-only reject count {kv.Value}"); }
        }

        private static void CheckCommand(Dictionary<string, object> expected, PlayerCommand actual, string where, Result r)
        {
            if (expected == null || actual == null)
            {
                Expect(r, where + ".null", expected == null, actual == null);
                return;
            }
            string type = Json.Str(Json.Get(expected, "type", where), "type");
            Expect(r, where + ".type", type, CommandTypes.Name(actual.Type));
            switch (type)
            {
                case "pass":
                    CheckVec(Json.Obj(Json.Get(expected, "target", where), "target"), actual.Target, where + ".target", r);
                    Expect(r, where + ".receiver", Json.OptStr(expected, "receiver"), actual.Receiver);
                    break;
                case "carry":
                    CheckVec(Json.Obj(Json.Get(expected, "direction", where), "direction"), actual.Direction, where + ".direction", r);
                    Expect(r, where + ".distance", Json.Num(Json.Get(expected, "distance", where), "distance"), actual.Distance, Eps);
                    break;
                case "shoot":
                case "move":
                    CheckVec(Json.Obj(Json.Get(expected, "target", where), "target"), actual.Target, where + ".target", r);
                    break;
                case "first_touch":
                    CheckVec(Json.Obj(Json.Get(expected, "direction", where), "direction"), actual.Direction, where + ".direction", r);
                    break;
                case "press":
                    Expect(r, where + ".target", Json.Str(Json.Get(expected, "target", where), "target"), actual.TargetId);
                    break;
                case "screen":
                    Expect(r, where + ".from", Json.Str(Json.Get(expected, "from", where), "from"), actual.FromId);
                    Expect(r, where + ".to", Json.Str(Json.Get(expected, "to", where), "to"), actual.ToId);
                    break;
            }
        }

        private static void CheckVec(Dictionary<string, object> expected, Vec2D actual, string where, Result r)
        {
            Expect(r, where + ".x", Json.Num(Json.Get(expected, "x", where), "x"), actual.X, Eps);
            Expect(r, where + ".y", Json.Num(Json.Get(expected, "y", where), "y"), actual.Y, Eps);
        }

        private static void CheckMoment(Dictionary<string, object> e, TacticalMoment m, string where, Result r)
        {
            Expect(r, where + ".id", Json.Str(Json.Get(e, "id", where), "id"), m.Id);
            Expect(r, where + ".tick", Json.Num(Json.Get(e, "tick", where), "tick"), m.Tick);
            Expect(r, where + ".timeMs", Json.Num(Json.Get(e, "timeMs", where), "timeMs"), m.TimeMs, Eps);
            Expect(r, where + ".entryId", Json.Str(Json.Get(e, "entryId", where), "entryId"), m.EntryId);
            Expect(r, where + ".title", Json.Str(Json.Get(e, "title", where), "title"), m.Title);
            Expect(r, where + ".category", Json.Str(Json.Get(e, "category", where), "category"), m.Category);
            Expect(r, where + ".phase", Json.Str(Json.Get(e, "phase", where), "phase"), m.Phase);
            Expect(r, where + ".role", Json.Str(Json.Get(e, "role", where), "role"), m.Role);
            Expect(r, where + ".playerId", Json.Str(Json.Get(e, "playerId", where), "playerId"), m.PlayerId);
            ExpectList(r, where + ".cues", Json.Arr(Json.Get(e, "cues", where), "cues"), m.Cues);
            Expect(r, where + ".major", Json.Bool(Json.Get(e, "major", where), "major"), m.Major);
            Expect(r, where + ".involvement", Json.Str(Json.Get(e, "involvement", where), "involvement"), m.Involvement);

            Dictionary<string, object> d = Json.Obj(Json.Get(e, "difficulty", where), "difficulty");
            Expect(r, where + ".difficulty.band", Json.Str(Json.Get(d, "band", where), "band"), m.Difficulty.Band);
            Expect(r, where + ".difficulty.clarity", Json.Num(Json.Get(d, "clarity", where), "clarity"), m.Difficulty.Clarity, Eps);
            Expect(r, where + ".difficulty.pressure", Json.Num(Json.Get(d, "pressure", where), "pressure"), m.Difficulty.Pressure, Eps);
            Expect(r, where + ".difficulty.alternatives", Json.Num(Json.Get(d, "alternatives", where), "alternatives"), m.Difficulty.Alternatives);
            Expect(r, where + ".difficulty.score", Json.Num(Json.Get(d, "score", where), "score"), m.Difficulty.Score, Eps);

            Dictionary<string, object> read = Json.Obj(Json.Get(e, "read", where), "read");
            foreach (string name in FieldRead.Names)
                Expect(r, $"{where}.read.{name}", Json.Num(Json.Get(read, name, where), name), m.Read.Get(name), Eps);
            foreach (string key in read.Keys)
                if (Array.IndexOf(FieldRead.Names, key) < 0) { r.Comparisons++; r.Failures.Add($"{where}.read.{key}: web feature missing from the native FieldRead"); }

            List<object> options = Json.Arr(Json.Get(e, "options", where), "options");
            Expect(r, where + ".options.count", options.Count, m.Options.Count);
            for (int i = 0; i < Math.Min(options.Count, m.Options.Count); i++)
            {
                Dictionary<string, object> o = Json.Obj(options[i], "option");
                TacticalOption a = m.Options[i];
                string w = $"{where}.options[{i}]";
                Expect(r, w + ".id", Json.Str(Json.Get(o, "id", w), "id"), a.Id);
                Expect(r, w + ".actionId", Json.Str(Json.Get(o, "actionId", w), "actionId"), a.ActionId);
                Expect(r, w + ".label", Json.Str(Json.Get(o, "label", w), "label"), a.Label);
                Expect(r, w + ".intent", Json.Str(Json.Get(o, "intent", w), "intent"), a.Intent);
                Expect(r, w + ".drawn", Json.Bool(Json.Get(o, "drawn", w), "drawn"), a.Drawn);
                CheckCommand(Json.Opt(o, "command") == null ? null : Json.Obj(Json.Get(o, "command", w), "command"), a.Command, w + ".command", r);
                object anchor = Json.Opt(o, "anchor");
                Expect(r, w + ".anchor.null", anchor == null, a.Anchor == null);
                if (anchor != null && a.Anchor != null) CheckVec(Json.Obj(anchor, "anchor"), a.Anchor.Value, w + ".anchor", r);
                Expect(r, w + ".score", Json.Num(Json.Get(o, "score", w), "score"), a.Score, Eps);
                Expect(r, w + ".feasibility", Json.Num(Json.Get(o, "feasibility", w), "feasibility"), a.Feasibility, Eps);
                ExpectList(r, w + ".reasons", Json.Arr(Json.Get(o, "reasons", w), "reasons"), a.Reasons);
                Expect(r, w + ".receiver", Json.OptStr(o, "receiver"), a.Receiver);
                Expect(r, w + ".sourceEntryId", Json.OptStr(o, "sourceEntryId"), a.SourceEntryId);
            }
        }

        private static void CheckCommit(Dictionary<string, object> e, string kind, TacticalMoment m, string optionId, int tick, CommitResult res, string where, Result r)
        {
            Expect(r, where + ".kind", Json.Str(Json.Get(e, "kind", where), "kind"), kind);
            Expect(r, where + ".momentId", Json.Str(Json.Get(e, "momentId", where), "momentId"), m.Id);
            Expect(r, where + ".tick", Json.Num(Json.Get(e, "tick", where), "tick"), tick);
            Expect(r, where + ".optionId", Json.OptStr(e, "optionId"), optionId);
            Expect(r, where + ".status", Json.Str(Json.Get(e, "status", where), "status"), res.Status);

            Dictionary<string, object> d = Json.Obj(Json.Get(e, "decision", where), "decision");
            DecisionRecord dec = res.Decision;
            Expect(r, where + ".decision.momentId", Json.Str(Json.Get(d, "momentId", where), "momentId"), dec.MomentId);
            Expect(r, where + ".decision.chosenOptionId", Json.OptStr(d, "chosenOptionId"), dec.ChosenOptionId);
            object q = Json.Opt(d, "quality");
            Expect(r, where + ".decision.quality.null", q == null, dec.Quality == null);
            if (q != null && dec.Quality != null) Expect(r, where + ".decision.quality", Json.Num(q, "quality"), dec.Quality.Value, Eps);
            Expect(r, where + ".decision.band", Json.Str(Json.Get(d, "band", where), "band"), dec.Band);
            Expect(r, where + ".decision.bestOptionId", Json.Str(Json.Get(d, "bestOptionId", where), "bestOptionId"), dec.BestOptionId);
            ExpectList(r, where + ".decision.explanation", Json.Arr(Json.Get(d, "explanation", where), "explanation"), dec.Explanation);
            Expect(r, where + ".decision.commitTick", Json.Num(Json.Get(d, "commitTick", where), "commitTick"), dec.CommitTick);

            object acted = Json.Opt(e, "acted");
            Expect(r, where + ".acted.null", acted == null, res.Acted == null);
            if (acted != null && res.Acted != null)
            {
                Dictionary<string, object> a = Json.Obj(acted, "acted");
                Expect(r, where + ".acted.momentId", Json.Str(Json.Get(a, "momentId", where), "momentId"), res.Acted.MomentId);
                Expect(r, where + ".acted.actor", Json.Str(Json.Get(a, "actor", where), "actor"), res.Acted.Actor);
                Expect(r, where + ".acted.optionId", Json.OptStr(a, "optionId"), res.Acted.OptionId);
                Expect(r, where + ".acted.label", Json.Str(Json.Get(a, "label", where), "label"), res.Acted.Label);
                Expect(r, where + ".acted.commitTick", Json.Num(Json.Get(a, "commitTick", where), "commitTick"), res.Acted.CommitTick);
                CheckCommand(Json.Opt(a, "command") == null ? null : Json.Obj(Json.Get(a, "command", where), "command"), res.Acted.Command, where + ".acted.command", r);
            }
            object issued = Json.Opt(e, "issued");
            CheckCommand(issued == null ? null : Json.Obj(issued, "issued"), res.Issued, where + ".issued", r);
        }

        private static void CheckSettled(Dictionary<string, object> e, MomentRecord rec, TacticalSession session, string where, Result r)
        {
            Expect(r, where + ".momentId", Json.Str(Json.Get(e, "momentId", where), "momentId"), rec.Moment.Id);
            object ex = Json.Opt(e, "execution");
            Expect(r, where + ".execution.null", ex == null, rec.Execution == null);
            if (ex != null && rec.Execution != null)
            {
                Dictionary<string, object> x = Json.Obj(ex, "execution");
                Expect(r, where + ".execution.actor", Json.Str(Json.Get(x, "actor", where), "actor"), rec.Execution.Actor);
                Expect(r, where + ".execution.quality", Json.Num(Json.Get(x, "quality", where), "quality"), rec.Execution.Quality, Eps);
                Expect(r, where + ".execution.band", Json.Str(Json.Get(x, "band", where), "band"), rec.Execution.Band);
                Expect(r, where + ".execution.pressureAtCommit", Json.Num(Json.Get(x, "pressureAtCommit", where), "pressureAtCommit"), rec.Execution.PressureAtCommit, Eps);
                Expect(r, where + ".execution.fatigueAtCommit", Json.Num(Json.Get(x, "fatigueAtCommit", where), "fatigueAtCommit"), rec.Execution.FatigueAtCommit, Eps);
            }
            Dictionary<string, object> o = Json.Obj(Json.Get(e, "outcome", where), "outcome");
            Expect(r, where + ".outcome.result", Json.Str(Json.Get(o, "result", where), "result"), rec.Outcome.Result);
            Expect(r, where + ".outcome.summary", Json.Str(Json.Get(o, "summary", where), "summary"), rec.Outcome.Summary);
            ExpectList(r, where + ".outcome.eventIds", Json.Arr(Json.Get(o, "eventIds", where), "eventIds"), rec.Outcome.EventIds);
            Expect(r, where + ".outcome.resolvedTick", Json.Num(Json.Get(o, "resolvedTick", where), "resolvedTick"), rec.Outcome.ResolvedTick);
            ExpectList(r, where + ".feedback", Json.Arr(Json.Get(e, "feedback", where), "feedback"), session.FeedbackFor(rec));
        }
    }
}
