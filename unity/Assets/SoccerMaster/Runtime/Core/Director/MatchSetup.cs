using System;
using System.Collections.Generic;
using SoccerMaster.Core.Sim;

namespace SoccerMaster.Core.Director
{
    /// <summary>
    /// The one match configuration the native slice plays: two generated 9-player squads, the user
    /// locked into one home role — exactly the setup the web fixture generator
    /// (tools/nativeTacticsFixtures.ts) uses, so a native match with the same seed and role is the
    /// same match the parity fixtures replay.
    /// </summary>
    public static class MatchSetup
    {
        public const double DefaultQuality = 55;

        public static MatchConfig Official(int seed, string roleId, double quality = DefaultQuality)
        {
            List<SquadPlayer> home = Squad.Generate(seed * 7 + 1, "H", quality);
            List<SquadPlayer> away = Squad.Generate(seed * 7 + 2, "A", quality);
            int roleNumber = RoleNumber(roleId);
            SquadPlayer me = null;
            foreach (SquadPlayer sp in home) if (sp.Role == roleNumber) { me = sp; break; }
            if (me == null) throw new ArgumentException($"role {roleId} missing from generated squad");
            return new MatchConfig
            {
                MatchId = $"native-{seed}-{roleId}",
                Seed = seed,
                Rules = Rules.U11_9v9(),
                Home = new TeamConfig { Side = Side.Home, Name = "SoccerMaster", ShortName = "YOU", Squad = home },
                Away = new TeamConfig { Side = Side.Away, Name = "Opponents", ShortName = "OPP", Squad = away },
                Controlled = new Controlled { Side = Side.Home, PlayerId = me.Id },
            };
        }

        public static int RoleNumber(string roleId)
        {
            foreach (int n in Roles.Numbers) if (Roles.IdOf(n) == roleId) return n;
            throw new ArgumentException("unknown role " + roleId);
        }
    }
}
