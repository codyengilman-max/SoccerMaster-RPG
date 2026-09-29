using System;
using System.Collections.Generic;
using SoccerMaster.Core.Serialization;

namespace SoccerMaster.Core.Tactics
{
    /// <summary>
    /// Port of src/tactics/catalog.ts. The catalog is content (content/catalog/*.json), validated on
    /// load; no situation-specific code lives in the engine or the view. Field names, operators and
    /// intents are kept as the exact web strings so the same JSON file drives both implementations.
    /// </summary>
    public sealed class Condition
    {
        public string Feature;
        public string Op;
        public double Value;

        public bool Holds(FieldRead read)
        {
            double x = read.Get(Feature);
            switch (Op)
            {
                case "<": return x < Value;
                case "<=": return x <= Value;
                case ">": return x > Value;
                case ">=": return x >= Value;
                case "==": return x == Value;
                case "!=": return x != Value;
                default: throw new InvalidOperationException($"unknown op {Op}");
            }
        }

        public static bool AllHold(FieldRead read, List<Condition> cs)
        {
            if (cs == null) return true;
            foreach (Condition c in cs) if (!c.Holds(read)) return false;
            return true;
        }
    }

    public sealed class Trigger
    {
        public List<Condition> All = new List<Condition>();
        public List<Condition> Any;

        public bool Fires(FieldRead read)
        {
            if (!Condition.AllHold(read, All)) return false;
            if (Any != null && Any.Count > 0)
            {
                bool any = false;
                foreach (Condition c in Any) if (c.Holds(read)) { any = true; break; }
                if (!any) return false;
            }
            return true;
        }
    }

    public sealed class Criterion
    {
        public List<Condition> When;
        public double Add;
        public string Why;
    }

    public sealed class CatalogAction
    {
        public string Id;
        public string Label;
        public string Intent;
        public double Base;
        public List<Criterion> Eval = new List<Criterion>();
    }

    public sealed class TestState
    {
        public string Label;
        public Dictionary<string, double> Read = new Dictionary<string, double>();
    }

    public sealed class CatalogEntry
    {
        public string Id;
        public string Role;
        public string MirrorOf;
        public string Category;
        public string Phase;
        public string Title;
        public Trigger Trigger = new Trigger();
        public List<string> Cues = new List<string>();
        public List<CatalogAction> Actions = new List<CatalogAction>();
        public List<string> Mistakes = new List<string>();
        public List<string> DifficultyFactors = new List<string>();
        public List<string> AgeGroups = new List<string>();
        public bool RequiresOffside;
        public string Continuation;
        public List<TestState> Positive = new List<TestState>();
        public List<TestState> Negative = new List<TestState>();
        public string ReviewStatus;
        public string ReviewNote;
    }

    public sealed class Catalog
    {
        public string Id;
        public double Version;
        public string ReviewStatus;
        public List<CatalogEntry> Entries = new List<CatalogEntry>();
        public Dictionary<string, List<CatalogEntry>> ByRole = new Dictionary<string, List<CatalogEntry>>();

        public CatalogEntry Find(string id)
        {
            foreach (CatalogEntry e in Entries) if (e.Id == id) return e;
            return null;
        }

        public List<CatalogEntry> ForRole(string role) => ByRole.TryGetValue(role, out List<CatalogEntry> l) ? l : new List<CatalogEntry>();

        public static readonly string[] Intents =
        {
            "attack_space", "draw_defender", "through_gap", "switch_play", "recycle", "shoot", "hold_ball",
            "first_touch_forward", "first_touch_safe", "run_behind", "overlap", "support_underneath", "hold_width",
            "narrow_inside", "hold_position", "press", "delay", "drop", "cover", "track_runner", "screen_lane",
            "communicate", "keeper_sweep", "keeper_hold_line", "keeper_distribute_short", "keeper_distribute_long",
            "keeper_step_up", "keeper_near_post",
        };

        public static readonly HashSet<string> DrawnIntents = new HashSet<string>
        {
            "attack_space", "draw_defender", "through_gap", "switch_play", "recycle", "shoot", "first_touch_forward",
            "first_touch_safe", "run_behind", "overlap", "support_underneath", "hold_width", "narrow_inside",
            "keeper_distribute_short", "keeper_distribute_long",
        };

        private static readonly string[] RoleIds = { "GK", "RB", "LB", "CB", "DM", "CM", "RW", "ST", "LW" };
        private static readonly string[] Categories = { "on_ball", "off_ball", "defending", "transition" };
        private static readonly string[] Ops = { "<", "<=", ">", ">=", "==", "!=" };

        /// <summary>Parse and validate a catalog JSON document; throws with every validation error listed.</summary>
        public static Catalog Load(string json)
        {
            Catalog c = Parse(json);
            List<string> errors = Validate(c);
            if (errors.Count > 0) throw new FormatException($"Invalid tactical catalog {c.Id}:\n{string.Join("\n", errors)}");
            foreach (CatalogEntry e in c.Entries)
            {
                if (!c.ByRole.TryGetValue(e.Role, out List<CatalogEntry> list)) c.ByRole[e.Role] = list = new List<CatalogEntry>();
                list.Add(e);
            }
            return c;
        }

        public static Catalog Parse(string json)
        {
            var root = Json.Obj(Json.Parse(json), "catalog");
            var c = new Catalog
            {
                Id = Json.Str(Json.Get(root, "id", "catalog"), "catalog.id"),
                Version = Json.Num(Json.Get(root, "version", "catalog"), "catalog.version"),
                ReviewStatus = Json.Str(Json.Get(root, "reviewStatus", "catalog"), "catalog.reviewStatus"),
            };
            foreach (object ev in Json.Arr(Json.Get(root, "entries", "catalog"), "catalog.entries")) c.Entries.Add(ParseEntry(Json.Obj(ev, "entry")));
            return c;
        }

        private static CatalogEntry ParseEntry(Dictionary<string, object> o)
        {
            string w = "entry " + (Json.OptStr(o, "id") ?? "?");
            var e = new CatalogEntry
            {
                Id = Json.Str(Json.Get(o, "id", w), w + ".id"),
                Role = Json.Str(Json.Get(o, "role", w), w + ".role"),
                MirrorOf = Json.OptStr(o, "mirrorOf"),
                Category = Json.Str(Json.Get(o, "category", w), w + ".category"),
                Phase = Json.Str(Json.Get(o, "phase", w), w + ".phase"),
                Title = Json.Str(Json.Get(o, "title", w), w + ".title"),
                Continuation = Json.Str(Json.Get(o, "continuation", w), w + ".continuation"),
            };
            var trig = Json.Obj(Json.Get(o, "trigger", w), w + ".trigger");
            e.Trigger.All = ParseConditions(Json.Get(trig, "all", w + ".trigger"), w + ".trigger.all");
            if (trig.TryGetValue("any", out object anyV) && anyV != null) e.Trigger.Any = ParseConditions(anyV, w + ".trigger.any");
            e.Cues = Strings(Json.Get(o, "cues", w), w + ".cues");
            foreach (object av in Json.Arr(Json.Get(o, "actions", w), w + ".actions"))
            {
                var ao = Json.Obj(av, w + ".action");
                var a = new CatalogAction
                {
                    Id = Json.Str(Json.Get(ao, "id", w), w + ".action.id"),
                    Label = Json.Str(Json.Get(ao, "label", w), w + ".action.label"),
                    Intent = Json.Str(Json.Get(ao, "intent", w), w + ".action.intent"),
                    Base = Json.Num(Json.Get(ao, "base", w), w + ".action.base"),
                };
                foreach (object cv in Json.Arr(Json.Get(ao, "eval", w), w + ".action.eval"))
                {
                    var co = Json.Obj(cv, w + ".criterion");
                    var cr = new Criterion
                    {
                        Add = Json.Num(Json.Get(co, "add", w), w + ".criterion.add"),
                        Why = Json.Str(Json.Get(co, "why", w), w + ".criterion.why"),
                    };
                    if (co.TryGetValue("when", out object whenV) && whenV != null) cr.When = ParseConditions(whenV, w + ".criterion.when");
                    a.Eval.Add(cr);
                }
                e.Actions.Add(a);
            }
            e.Mistakes = Strings(Json.Get(o, "mistakes", w), w + ".mistakes");
            e.DifficultyFactors = Strings(Json.Get(o, "difficultyFactors", w), w + ".difficultyFactors");
            var restr = Json.Obj(Json.Get(o, "restrictions", w), w + ".restrictions");
            e.AgeGroups = Strings(Json.Get(restr, "ageGroups", w), w + ".restrictions.ageGroups");
            e.RequiresOffside = Json.OptBool(restr, "requiresOffside", false);
            var tests = Json.Obj(Json.Get(o, "tests", w), w + ".tests");
            e.Positive = ParseTests(Json.Get(tests, "positive", w), w + ".tests.positive");
            e.Negative = ParseTests(Json.Get(tests, "negative", w), w + ".tests.negative");
            var review = Json.Obj(Json.Get(o, "review", w), w + ".review");
            e.ReviewStatus = Json.Str(Json.Get(review, "status", w), w + ".review.status");
            e.ReviewNote = Json.OptStr(review, "note");
            return e;
        }

        private static List<Condition> ParseConditions(object v, string where)
        {
            var list = new List<Condition>();
            foreach (object cv in Json.Arr(v, where))
            {
                var co = Json.Obj(cv, where);
                list.Add(new Condition
                {
                    Feature = Json.Str(Json.Get(co, "f", where), where + ".f"),
                    Op = Json.Str(Json.Get(co, "op", where), where + ".op"),
                    Value = Json.Num(Json.Get(co, "v", where), where + ".v"),
                });
            }
            return list;
        }

        private static List<TestState> ParseTests(object v, string where)
        {
            var list = new List<TestState>();
            foreach (object tv in Json.Arr(v, where))
            {
                var to = Json.Obj(tv, where);
                var t = new TestState { Label = Json.Str(Json.Get(to, "label", where), where + ".label") };
                foreach (KeyValuePair<string, object> kv in Json.Obj(Json.Get(to, "read", where), where + ".read"))
                    t.Read[kv.Key] = Json.Num(kv.Value, where + ".read." + kv.Key);
                list.Add(t);
            }
            return list;
        }

        private static List<string> Strings(object v, string where)
        {
            var list = new List<string>();
            foreach (object s in Json.Arr(v, where)) list.Add(Json.Str(s, where));
            return list;
        }

        private static void CheckConditions(List<Condition> cs, string where, List<string> errors)
        {
            if (cs == null) return;
            foreach (Condition c in cs)
            {
                if (Array.IndexOf(FieldRead.Names, c.Feature) < 0) errors.Add($"{where}: unknown feature \"{c.Feature}\"");
                if (Array.IndexOf(Ops, c.Op) < 0) errors.Add($"{where}: unknown op \"{c.Op}\"");
                if (double.IsNaN(c.Value)) errors.Add($"{where}: value must be a number");
            }
        }

        /// <summary>Same checks as the web validateCatalog: schema, unique ids, features, mirrors, own test states.</summary>
        public static List<string> Validate(Catalog file)
        {
            var errors = new List<string>();
            var ids = new HashSet<string>();
            foreach (CatalogEntry e in file.Entries)
            {
                string w = $"entry {e.Id}";
                if (!ids.Add(e.Id)) errors.Add($"{w}: duplicate id");
                if (Array.IndexOf(RoleIds, e.Role) < 0) errors.Add($"{w}: unknown role {e.Role}");
                if (Array.IndexOf(Categories, e.Category) < 0) errors.Add($"{w}: unknown category {e.Category}");
                CheckConditions(e.Trigger.All, $"{w} trigger.all", errors);
                CheckConditions(e.Trigger.Any, $"{w} trigger.any", errors);
                if (e.Actions.Count < 2) errors.Add($"{w}: needs at least two plausible actions");
                var actionIds = new HashSet<string>();
                foreach (CatalogAction a in e.Actions)
                {
                    if (!actionIds.Add(a.Id)) errors.Add($"{w}: duplicate action id {a.Id}");
                    if (Array.IndexOf(Intents, a.Intent) < 0) errors.Add($"{w} action {a.Id}: unknown intent {a.Intent}");
                    foreach (Criterion c in a.Eval) CheckConditions(c.When, $"{w} action {a.Id}", errors);
                }
                if (e.Cues.Count == 0) errors.Add($"{w}: scanning cues required");
                if (e.Positive.Count == 0 || e.Negative.Count == 0) errors.Add($"{w}: positive and negative test states required");
                foreach (TestState t in e.Positive)
                    if (!e.Trigger.Fires(FieldRead.WithDefaults(t.Read))) errors.Add($"{w}: positive test \"{t.Label}\" does not fire the trigger");
                foreach (TestState t in e.Negative)
                    if (e.Trigger.Fires(FieldRead.WithDefaults(t.Read))) errors.Add($"{w}: negative test \"{t.Label}\" fires the trigger");
            }
            foreach (CatalogEntry e in file.Entries)
            {
                if (e.MirrorOf == null) continue;
                CatalogEntry m = file.Find(e.MirrorOf);
                if (m == null) errors.Add($"entry {e.Id}: mirrorOf {e.MirrorOf} not found");
                else if (m.Category != e.Category) errors.Add($"entry {e.Id}: mirror category differs from {m.Id}");
            }
            return errors;
        }
    }
}
