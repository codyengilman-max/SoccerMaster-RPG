using System;
using System.Collections.Generic;
using SoccerMaster.Core.Sim;

namespace SoccerMaster.Core.Tactics
{
    /// <summary>
    /// Port of src/tactics/features.ts: the numeric picture of the field from one player's point of
    /// view, read straight from canonical engine state. Catalog triggers and criteria reference these
    /// values by their web names, so <see cref="Get"/> and <see cref="Names"/> keep that vocabulary.
    /// </summary>
    public sealed class FieldRead
    {
        public double HasBall, Receiving, OurPossession, TheirPossession, LooseBall, Pressure, NearestOppDist,
            SpaceAhead, SpaceFarSide, SpaceNearSide, Progress, BallProgress, DistToGoal, DistToBall, ShotWindow,
            OpenLanes, ProgressiveLanes, BestPassScore, BestCarryScore, BestShotScore, BestSwitchScore,
            SpaceBehindLine, OnsideForRun, TeammateRunAhead, BallOnMyFlank, CarrierDist, FirstDefender,
            SecondDefender, TeammatePressing, OppRunnerNear, CarrierDistToOurGoal, SecondsSinceTurnover,
            BallInOurBox, BallInTheirBox, KeeperCanSweep, OurLineDepth, BallWide, DistFromOwnGoalLine, ScoreDiff,
            Minute, CarrierPressure, TeammateCarrierDist, WidthProvidedMyFlank, FarPostSpace, RestDefenseCount,
            SecondNineOn;

        public static readonly string[] Names =
        {
            "hasBall", "receiving", "ourPossession", "theirPossession", "looseBall", "pressure", "nearestOppDist",
            "spaceAhead", "spaceFarSide", "spaceNearSide", "progress", "ballProgress", "distToGoal", "distToBall",
            "shotWindow", "openLanes", "progressiveLanes", "bestPassScore", "bestCarryScore", "bestShotScore",
            "bestSwitchScore", "spaceBehindLine", "onsideForRun", "teammateRunAhead", "ballOnMyFlank", "carrierDist",
            "firstDefender", "secondDefender", "teammatePressing", "oppRunnerNear", "carrierDistToOurGoal",
            "secondsSinceTurnover", "ballInOurBox", "ballInTheirBox", "keeperCanSweep", "ourLineDepth", "ballWide",
            "distFromOwnGoalLine", "scoreDiff", "minute", "carrierPressure", "teammateCarrierDist",
            "widthProvidedMyFlank", "farPostSpace", "restDefenseCount", "secondNineOn",
        };

        public double Get(string name)
        {
            switch (name)
            {
                case "hasBall": return HasBall;
                case "receiving": return Receiving;
                case "ourPossession": return OurPossession;
                case "theirPossession": return TheirPossession;
                case "looseBall": return LooseBall;
                case "pressure": return Pressure;
                case "nearestOppDist": return NearestOppDist;
                case "spaceAhead": return SpaceAhead;
                case "spaceFarSide": return SpaceFarSide;
                case "spaceNearSide": return SpaceNearSide;
                case "progress": return Progress;
                case "ballProgress": return BallProgress;
                case "distToGoal": return DistToGoal;
                case "distToBall": return DistToBall;
                case "shotWindow": return ShotWindow;
                case "openLanes": return OpenLanes;
                case "progressiveLanes": return ProgressiveLanes;
                case "bestPassScore": return BestPassScore;
                case "bestCarryScore": return BestCarryScore;
                case "bestShotScore": return BestShotScore;
                case "bestSwitchScore": return BestSwitchScore;
                case "spaceBehindLine": return SpaceBehindLine;
                case "onsideForRun": return OnsideForRun;
                case "teammateRunAhead": return TeammateRunAhead;
                case "ballOnMyFlank": return BallOnMyFlank;
                case "carrierDist": return CarrierDist;
                case "firstDefender": return FirstDefender;
                case "secondDefender": return SecondDefender;
                case "teammatePressing": return TeammatePressing;
                case "oppRunnerNear": return OppRunnerNear;
                case "carrierDistToOurGoal": return CarrierDistToOurGoal;
                case "secondsSinceTurnover": return SecondsSinceTurnover;
                case "ballInOurBox": return BallInOurBox;
                case "ballInTheirBox": return BallInTheirBox;
                case "keeperCanSweep": return KeeperCanSweep;
                case "ourLineDepth": return OurLineDepth;
                case "ballWide": return BallWide;
                case "distFromOwnGoalLine": return DistFromOwnGoalLine;
                case "scoreDiff": return ScoreDiff;
                case "minute": return Minute;
                case "carrierPressure": return CarrierPressure;
                case "teammateCarrierDist": return TeammateCarrierDist;
                case "widthProvidedMyFlank": return WidthProvidedMyFlank;
                case "farPostSpace": return FarPostSpace;
                case "restDefenseCount": return RestDefenseCount;
                case "secondNineOn": return SecondNineOn;
                default: throw new ArgumentException($"unknown feature {name}");
            }
        }

        public void Set(string name, double v)
        {
            switch (name)
            {
                case "hasBall": HasBall = v; break;
                case "receiving": Receiving = v; break;
                case "ourPossession": OurPossession = v; break;
                case "theirPossession": TheirPossession = v; break;
                case "looseBall": LooseBall = v; break;
                case "pressure": Pressure = v; break;
                case "nearestOppDist": NearestOppDist = v; break;
                case "spaceAhead": SpaceAhead = v; break;
                case "spaceFarSide": SpaceFarSide = v; break;
                case "spaceNearSide": SpaceNearSide = v; break;
                case "progress": Progress = v; break;
                case "ballProgress": BallProgress = v; break;
                case "distToGoal": DistToGoal = v; break;
                case "distToBall": DistToBall = v; break;
                case "shotWindow": ShotWindow = v; break;
                case "openLanes": OpenLanes = v; break;
                case "progressiveLanes": ProgressiveLanes = v; break;
                case "bestPassScore": BestPassScore = v; break;
                case "bestCarryScore": BestCarryScore = v; break;
                case "bestShotScore": BestShotScore = v; break;
                case "bestSwitchScore": BestSwitchScore = v; break;
                case "spaceBehindLine": SpaceBehindLine = v; break;
                case "onsideForRun": OnsideForRun = v; break;
                case "teammateRunAhead": TeammateRunAhead = v; break;
                case "ballOnMyFlank": BallOnMyFlank = v; break;
                case "carrierDist": CarrierDist = v; break;
                case "firstDefender": FirstDefender = v; break;
                case "secondDefender": SecondDefender = v; break;
                case "teammatePressing": TeammatePressing = v; break;
                case "oppRunnerNear": OppRunnerNear = v; break;
                case "carrierDistToOurGoal": CarrierDistToOurGoal = v; break;
                case "secondsSinceTurnover": SecondsSinceTurnover = v; break;
                case "ballInOurBox": BallInOurBox = v; break;
                case "ballInTheirBox": BallInTheirBox = v; break;
                case "keeperCanSweep": KeeperCanSweep = v; break;
                case "ourLineDepth": OurLineDepth = v; break;
                case "ballWide": BallWide = v; break;
                case "distFromOwnGoalLine": DistFromOwnGoalLine = v; break;
                case "scoreDiff": ScoreDiff = v; break;
                case "minute": Minute = v; break;
                case "carrierPressure": CarrierPressure = v; break;
                case "teammateCarrierDist": TeammateCarrierDist = v; break;
                case "widthProvidedMyFlank": WidthProvidedMyFlank = v; break;
                case "farPostSpace": FarPostSpace = v; break;
                case "restDefenseCount": RestDefenseCount = v; break;
                case "secondNineOn": SecondNineOn = v; break;
                default: throw new ArgumentException($"unknown feature {name}");
            }
        }

        public FieldRead Clone() => (FieldRead)MemberwiseClone();

        /// <summary>The web NEUTRAL_READ: completes the catalog's partial test states.</summary>
        public static FieldRead Neutral() => new FieldRead
        {
            NearestOppDist = 15, SpaceAhead = 0.5, SpaceFarSide = 0.5, SpaceNearSide = 0.5, Progress = 0.5, BallProgress = 0.5,
            DistToGoal = 35, DistToBall = 20, SpaceBehindLine = 15, OnsideForRun = 1, CarrierDist = 999,
            CarrierDistToOurGoal = 999, SecondsSinceTurnover = 999, OurLineDepth = 20, BallWide = 0.3,
            DistFromOwnGoalLine = 35, Minute = 10, TeammateCarrierDist = 999,
        };

        public static FieldRead WithDefaults(Dictionary<string, double> partial)
        {
            FieldRead r = Neutral();
            foreach (KeyValuePair<string, double> kv in partial) r.Set(kv.Key, kv.Value);
            return r;
        }

        private static double B(bool v) => v ? 1 : 0;

        /// <summary>Port of readField(state, p).</summary>
        public static FieldRead Read(MatchState state, PlayerState p)
        {
            Rules rules = state.Rules;
            BallState ball = state.Ball;
            List<PlayerState> opps = Perception.Opponents(state, p.Side);
            var mates = new List<PlayerState>();
            foreach (PlayerState m in Perception.Teammates(state, p.Side)) if (m.Id != p.Id) mates.Add(m);
            int dir = p.Side == Side.Home ? 1 : -1;
            var forward = new Vec2D(dir, 0);
            bool hasBall = ball.Status == BallStatus.Controlled && ball.Owner == p.Id;
            bool ourPossession = state.Possession == p.Side && ball.Status != BallStatus.Loose;
            bool theirPossession = state.Possession == Sides.Other(p.Side) && ball.Status == BallStatus.Controlled;

            double nearestOpp = double.PositiveInfinity;
            foreach (PlayerState o in opps) nearestOpp = Math.Min(nearestOpp, Vec2D.Dist(o.Pos, p.Pos));
            double farY = p.Pos.Y < rules.Width / 2 ? rules.Width * 0.8 : rules.Width * 0.2;
            double nearY = p.Pos.Y < rules.Width / 2 ? rules.Width * 0.2 : rules.Width * 0.8;

            int openLanes = 0, progressiveLanes = 0;
            double myProgress = Perception.Progress(rules, p.Side, p.Pos);
            foreach (PlayerState m in mates)
            {
                double d = Vec2D.Dist(p.Pos, m.Pos);
                if (d < 3 || d > 40) continue;
                LaneReport lane = Perception.LaneReport(p.Pos, m.Pos, Actions.SpeedForDistance(d), opps);
                if (lane.Margin > 0.15)
                {
                    openLanes++;
                    if (Perception.Progress(rules, p.Side, m.Pos) > myProgress + 0.05) progressiveLanes++;
                }
            }

            double bestPass = 0, bestCarry = 0, bestShot = 0, bestSwitch = 0;
            if (hasBall)
            {
                foreach (OnBallOption o in Ai.EvaluateOnBall(state, p))
                {
                    if (o.Kind == OptionKind.Pass) bestPass = Math.Max(bestPass, o.Score);
                    else if (o.Kind == OptionKind.Switch) bestSwitch = Math.Max(bestSwitch, o.Score);
                    else if (o.Kind == OptionKind.Carry) bestCarry = Math.Max(bestCarry, o.Score);
                    else if (o.Kind == OptionKind.Shoot) bestShot = Math.Max(bestShot, o.Score);
                }
            }

            double lineX = Ai.LastDefenderLine(state, Sides.Other(p.Side));
            double theirGoalX = rules.AttackingGoalX(p.Side);
            double ourGoalX = rules.DefendingGoalX(p.Side);
            double spaceBehindLine = Math.Abs(theirGoalX - lineX);
            bool onsideForRun = dir > 0 ? p.Pos.X <= lineX + 0.3 : p.Pos.X >= lineX - 0.3;
            bool teammateRunAhead = false;
            foreach (PlayerState m in mates)
            {
                if (m.Role != 1 && m.Vel.X * dir > 2 && (m.Pos.X - p.Pos.X) * dir > 2 &&
                    Perception.SpaceAt(Vec2D.Add(m.Pos, Vec2D.Scale(forward, 5)), opps) > 0.4)
                {
                    teammateRunAhead = true;
                    break;
                }
            }

            PlayerState carrier = theirPossession && ball.Owner != null ? Perception.FindPlayer(state, ball.Owner) : null;
            PlayerState teammateCarrier = ourPossession && ball.Owner != null && ball.Owner != p.Id ? Perception.FindPlayer(state, ball.Owner) : null;
            var defenders = new List<PlayerState>();
            foreach (PlayerState m in Perception.Teammates(state, p.Side)) if (m.Role != 1) defenders.Add(m);
            bool firstDefender = false, secondDefender = false, teammatePressing = false;
            if (carrier != null)
            {
                var byDist = new List<PlayerState>(defenders);
                Vec2D cpos = carrier.Pos;
                JsMath.StableSort(byDist, (a, c) => Vec2D.Dist(a.Pos, cpos).CompareTo(Vec2D.Dist(c.Pos, cpos)));
                firstDefender = byDist.Count > 0 && byDist[0].Id == p.Id;
                secondDefender = byDist.Count > 1 && byDist[1].Id == p.Id;
                foreach (PlayerState m in mates)
                {
                    if (m.Role != 1 && Vec2D.Dist(m.Pos, carrier.Pos) < 3) { teammatePressing = true; break; }
                }
            }
            bool oppRunnerNear = false;
            foreach (PlayerState o in opps)
            {
                if (o.Role != 1 && (carrier == null || o.Id != carrier.Id) && Vec2D.Dist(o.Pos, p.Pos) < 10 && o.Vel.X * -dir > 1.5)
                {
                    oppRunnerNear = true;
                    break;
                }
            }

            double secondsSinceTurnover = 999;
            for (int i = state.Events.Count - 1; i >= 0; i--)
            {
                MatchEvent e = state.Events[i];
                if (e.Type == EventType.PossessionChange)
                {
                    secondsSinceTurnover = (state.Clock.Tick - e.Tick) * 0.05;
                    break;
                }
            }

            bool keeperCanSweep = false;
            if (p.Role == 1 && ball.Status == BallStatus.Loose && rules.InPenaltyArea(ourGoalX, ball.Pos))
            {
                double minOpp = double.PositiveInfinity;
                foreach (PlayerState o in opps) minOpp = Math.Min(minOpp, Perception.ArrivalTime(o, ball.Pos));
                keeperCanSweep = Perception.ArrivalTime(p, ball.Pos) < minOpp;
            }

            double ourLineDepth = Math.Abs(Ai.LastDefenderLine(state, p.Side) - ourGoalX);
            SecondNineRead nine = Ai.SecondNineRead(state, p);
            int my = p.Side == Side.Home ? state.Score.Home : state.Score.Away;
            int theirs = p.Side == Side.Home ? state.Score.Away : state.Score.Home;

            return new FieldRead
            {
                HasBall = B(hasBall),
                Receiving = B(ball.Status == BallStatus.Loose && ball.PassTarget == p.Id),
                OurPossession = B(ourPossession),
                TheirPossession = B(theirPossession),
                LooseBall = B(ball.Status == BallStatus.Loose),
                Pressure = Perception.PressureAt(p.Pos, opps),
                NearestOppDist = nearestOpp,
                SpaceAhead = Perception.SpaceAt(Vec2D.Add(p.Pos, Vec2D.Scale(forward, 6)), opps),
                SpaceFarSide = Perception.SpaceAt(new Vec2D(p.Pos.X + dir * 4, farY), opps),
                SpaceNearSide = Perception.SpaceAt(new Vec2D(p.Pos.X + dir * 4, nearY), opps),
                Progress = myProgress,
                BallProgress = Perception.Progress(rules, p.Side, ball.Pos),
                DistToGoal = Perception.DistanceToGoal(rules, p.Side, p.Pos),
                DistToBall = Vec2D.Dist(p.Pos, ball.Pos),
                ShotWindow = Perception.ShotWindow(rules, p.Side, p.Pos, opps),
                OpenLanes = openLanes,
                ProgressiveLanes = progressiveLanes,
                BestPassScore = bestPass,
                BestCarryScore = bestCarry,
                BestShotScore = bestShot,
                BestSwitchScore = bestSwitch,
                SpaceBehindLine = spaceBehindLine,
                OnsideForRun = B(onsideForRun),
                TeammateRunAhead = B(teammateRunAhead),
                BallOnMyFlank = B(JsMath.Sign(ball.Pos.Y - rules.Width / 2) == JsMath.Sign(p.Pos.Y - rules.Width / 2)),
                CarrierDist = carrier != null ? Vec2D.Dist(carrier.Pos, p.Pos) : 999,
                FirstDefender = B(firstDefender),
                SecondDefender = B(secondDefender),
                TeammatePressing = B(teammatePressing),
                OppRunnerNear = B(oppRunnerNear),
                CarrierDistToOurGoal = carrier != null ? Math.Abs(carrier.Pos.X - ourGoalX) : 999,
                SecondsSinceTurnover = secondsSinceTurnover,
                BallInOurBox = B(rules.InPenaltyArea(ourGoalX, ball.Pos)),
                BallInTheirBox = B(rules.InPenaltyArea(theirGoalX, ball.Pos)),
                KeeperCanSweep = B(keeperCanSweep),
                OurLineDepth = ourLineDepth,
                BallWide = Vec2D.Clamp(Math.Abs(ball.Pos.Y - rules.Width / 2) / (rules.Width / 2), 0, 1),
                DistFromOwnGoalLine = Math.Abs(p.Pos.X - ourGoalX),
                ScoreDiff = my - theirs,
                Minute = state.Clock.TimeMs / 60000,
                CarrierPressure = teammateCarrier != null ? Perception.PressureAt(teammateCarrier.Pos, opps) : 0,
                TeammateCarrierDist = teammateCarrier != null ? Vec2D.Dist(teammateCarrier.Pos, p.Pos) : 999,
                WidthProvidedMyFlank = B(nine.WidthProvided),
                FarPostSpace = nine.FarPostSpace,
                RestDefenseCount = nine.RestDefense,
                SecondNineOn = B(nine.On),
            };
        }
    }
}
