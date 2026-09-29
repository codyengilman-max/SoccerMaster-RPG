using System;

namespace SoccerMaster.Core.Sim
{
    /// <summary>
    /// Flattened, engine-facing rules (port of src/sim/rules.ts). Coordinates: x along length
    /// [0,length], y along width [0,width]. Home attacks +x, away attacks -x.
    /// </summary>
    public sealed class Rules
    {
        public string Id;
        public string Label;
        public string ReviewStatus;
        public int PlayersPerSide;
        public double Length;
        public double Width;
        public double GoalWidth;
        public double GoalAreaDepth;
        public double GoalAreaWidth;
        public double PenaltyAreaDepth;
        public double PenaltyAreaWidth;
        public double PenaltySpotDistance;
        public double CenterCircleRadius;
        public bool BuildOutLine;
        public bool Offside;
        public bool HeadingAllowed;
        public int Halves;
        public double HalfLengthSeconds;
        public bool GoalkeeperPuntAllowed;

        /// <summary>content/rules/u11-9v9.json flattened exactly as rulesFromFile does (values unverified, see the JSON note).</summary>
        public static Rules U11_9v9() => new Rules
        {
            Id = "u11-9v9",
            Label = "U11 9v9 (provisional)",
            ReviewStatus = "unverified",
            PlayersPerSide = 9,
            Length = 70,
            Width = 45,
            GoalWidth = 6.4,
            GoalAreaDepth = 5,
            GoalAreaWidth = 15,
            PenaltyAreaDepth = 12,
            PenaltyAreaWidth = 30,
            PenaltySpotDistance = 9,
            CenterCircleRadius = 7,
            BuildOutLine = true,
            Offside = true,
            HeadingAllowed = false,
            Halves = 2,
            HalfLengthSeconds = 30 * 60,
            GoalkeeperPuntAllowed = false,
        };

        public Rules Clone() => (Rules)MemberwiseClone();

        public static int AttackDir(Side side) => side == Side.Home ? 1 : -1;

        public double AttackingGoalX(Side side) => side == Side.Home ? Length : 0;
        public double DefendingGoalX(Side side) => side == Side.Home ? 0 : Length;

        public Vec2D GoalCenter(double goalLineX) => new Vec2D(goalLineX, Width / 2);

        public void GoalPosts(double goalLineX, out Vec2D a, out Vec2D b)
        {
            double half = GoalWidth / 2;
            a = new Vec2D(goalLineX, Width / 2 - half);
            b = new Vec2D(goalLineX, Width / 2 + half);
        }

        public bool InPenaltyArea(double goalLineX, Vec2D p)
        {
            bool depthOk = goalLineX == 0 ? p.X <= PenaltyAreaDepth : p.X >= Length - PenaltyAreaDepth;
            return depthOk && Math.Abs(p.Y - Width / 2) <= PenaltyAreaWidth / 2;
        }

        public bool InGoalArea(double goalLineX, Vec2D p)
        {
            bool depthOk = goalLineX == 0 ? p.X <= GoalAreaDepth : p.X >= Length - GoalAreaDepth;
            return depthOk && Math.Abs(p.Y - Width / 2) <= GoalAreaWidth / 2;
        }

        public double BuildOutLineX(double goalLineX)
        {
            double paEdge = goalLineX == 0 ? PenaltyAreaDepth : Length - PenaltyAreaDepth;
            return (paEdge + Length / 2) / 2;
        }

        public bool OnField(Vec2D p) => p.X >= 0 && p.X <= Length && p.Y >= 0 && p.Y <= Width;
    }
}
