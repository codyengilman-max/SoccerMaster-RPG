using System;
using System.Collections.Generic;

namespace SoccerMaster.Core.Sim
{
    public sealed class SquadPlayer
    {
        public string Id;
        public string Name;
        public int Role;
        public Attributes Attributes;
    }

    /// <summary>Port of src/sim/squad.ts: deterministic nine-player squads with role emphasis.</summary>
    public static class Squad
    {
        private static double Boost(int role, string key)
        {
            switch (role)
            {
                case 1:
                    switch (key) { case "goalkeeping": return 30; case "positioning": return 8; case "shooting": return -15; case "dribbling": return -10; }
                    break;
                case 2:
                case 3:
                    switch (key) { case "pace": return 6; case "tackling": return 8; case "positioning": return 6; case "stamina": return 6; }
                    break;
                case 4:
                    switch (key) { case "tackling": return 10; case "positioning": return 10; case "strength": return 8; case "pace": return -3; }
                    break;
                case 6:
                    switch (key) { case "passing": return 8; case "awareness": return 8; case "tackling": return 6; case "positioning": return 6; }
                    break;
                case 8:
                    switch (key) { case "passing": return 10; case "awareness": return 8; case "firstTouch": return 6; case "stamina": return 6; }
                    break;
                case 7:
                case 11:
                    switch (key) { case "pace": return 10; case "dribbling": return 10; case "acceleration": return 8; }
                    break;
                case 9:
                    switch (key) { case "shooting": return 12; case "firstTouch": return 6; case "strength": return 6; case "positioning": return 4; }
                    break;
            }
            return 0;
        }

        /// <summary>
        /// Generate a 9-player squad; <paramref name="quality"/> (0..100) is the team's mean attribute
        /// level. Deterministic for a seed and bit-identical to the web generator (same RNG stream order).
        /// </summary>
        public static List<SquadPlayer> Generate(double seed, string idPrefix, double quality, IReadOnlyDictionary<int, string> names = null)
        {
            var rng = new Rng(seed);
            var squad = new List<SquadPlayer>();
            foreach (int role in Roles.Numbers)
            {
                var attrs = new Attributes();
                foreach (string k in Attributes.Keys)
                {
                    double b = quality + rng.Gaussian() * 8 + Boost(role, k) - (k == "goalkeeping" && role != 1 ? 25 : 0);
                    attrs.Set(k, JsMath.Round(Math.Min(100, Math.Max(5, b))));
                }
                string name = null;
                if (names != null) names.TryGetValue(role, out name);
                squad.Add(new SquadPlayer
                {
                    Id = idPrefix + "-" + role,
                    Name = name ?? (idPrefix.ToUpperInvariant() + " " + Roles.IdOf(role) + " #" + role),
                    Role = role,
                    Attributes = attrs,
                });
            }
            return squad;
        }
    }
}
