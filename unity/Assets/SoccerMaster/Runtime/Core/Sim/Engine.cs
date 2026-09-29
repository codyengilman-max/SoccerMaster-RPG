using System;
using System.Collections.Generic;

namespace SoccerMaster.Core.Sim
{
    public sealed class TeamConfig
    {
        public Side Side;
        public string Name;
        public string ShortName;
        public List<SquadPlayer> Squad;
    }

    public sealed class MatchConfig
    {
        public string MatchId;
        public double Seed;
        public Rules Rules;
        public TeamConfig Home;
        public TeamConfig Away;
        /// <summary>The user's locked role; null for AI-vs-AI.</summary>
        public Controlled Controlled;
    }

    /// <summary>
    /// Port of src/sim/engine.ts. <see cref="Tick"/> is the only canonical state progression: it
    /// consumes queued commands, moves players under acceleration limits, rolls the ball, and records
    /// events. Nothing in here knows about presentation.
    /// </summary>
    public static class Engine
    {
        public const int DecisionIntervalTicks = 10;
        public const int RestartDelayTicks = 40;

        public static MatchState CreateMatch(MatchConfig cfg)
        {
            foreach (TeamConfig t in new[] { cfg.Home, cfg.Away })
            {
                if (t.Squad.Count != cfg.Rules.PlayersPerSide) throw new ArgumentException($"{Sides.Name(t.Side)} squad must have {cfg.Rules.PlayersPerSide} players");
                foreach (int r in Roles.Numbers)
                {
                    bool found = false;
                    foreach (SquadPlayer sp in t.Squad) if (sp.Role == r) { found = true; break; }
                    if (!found) throw new ArgumentException($"{Sides.Name(t.Side)} squad missing role {r}");
                }
            }
            if (cfg.Controlled != null)
            {
                TeamConfig team = cfg.Controlled.Side == Side.Home ? cfg.Home : cfg.Away;
                bool found = false;
                foreach (SquadPlayer sp in team.Squad) if (sp.Id == cfg.Controlled.PlayerId) { found = true; break; }
                if (!found) throw new ArgumentException("controlled player not in squad");
            }
            var players = new List<PlayerState>();
            Side kickoffSide = Side.Home;
            foreach (TeamConfig team in new[] { cfg.Home, cfg.Away })
            {
                foreach (SquadPlayer sp in team.Squad)
                {
                    Vec2D pos = Formation.KickoffPosition(cfg.Rules, team.Side, sp.Role, team.Side == kickoffSide);
                    players.Add(new PlayerState
                    {
                        Id = sp.Id,
                        Side = team.Side,
                        Role = sp.Role,
                        Name = sp.Name,
                        Attributes = sp.Attributes.Clone(),
                        Pos = pos,
                        Vel = Vec2D.Zero,
                        Fatigue = 0,
                        MoveTarget = pos,
                        TouchCooldown = 0,
                        Stunned = 0,
                        CommitUntilTick = 0,
                    });
                }
            }
            var rng = new Rng(cfg.Seed);
            return new MatchState
            {
                MatchId = cfg.MatchId,
                Rules = cfg.Rules,
                Seed = cfg.Seed,
                RngState = rng.Snapshot(),
                Home = new TeamInfo { Side = Side.Home, Name = cfg.Home.Name, ShortName = cfg.Home.ShortName },
                Away = new TeamInfo { Side = Side.Away, Name = cfg.Away.Name, ShortName = cfg.Away.ShortName },
                Players = players,
                Ball = new BallState
                {
                    Pos = new Vec2D(cfg.Rules.Length / 2, cfg.Rules.Width / 2),
                    Vel = Vec2D.Zero,
                    Status = BallStatus.Dead,
                },
                Phase = MatchPhase.Kickoff(kickoffSide),
                RestartTimer = RestartDelayTicks,
                Possession = null,
                Score = new Score(),
                Clock = new Clock { Tick = 0, TimeMs = 0, Half = 1, HalfTimeS = 0 },
                Controlled = cfg.Controlled,
            };
        }

        private static MatchEvent Emit(MatchState state, MatchEvent ev)
        {
            ev.Id = state.MatchId + ":" + state.Clock.Tick + ":" + state.EventSeq++;
            ev.Tick = state.Clock.Tick;
            state.Events.Add(ev);
            return ev;
        }

        public static bool IsFinished(MatchState state) => state.Phase.Kind == PhaseKind.FullTime;

        /// <summary>Queue an external command for a player (consumed at their next decision).</summary>
        public static void IssueCommand(MatchState state, string playerId, PlayerCommand cmd, double accuracy = 1)
        {
            state.Commands[playerId] = new QueuedCommand { Command = cmd, Accuracy = Vec2D.Clamp(accuracy, 0, 1) };
            if (state.Awaiting == playerId) state.Awaiting = null;
        }

        /// <summary>Suspend AI decisions for a player until a command is issued (or <see cref="ResumeDecisions"/>).</summary>
        public static void SuspendDecisions(MatchState state, string playerId) => state.Awaiting = playerId;

        public static void ResumeDecisions(MatchState state) => state.Awaiting = null;

        /// <summary>Advance the simulation one tick (50 ms of simulated time). Mutates and returns state.</summary>
        public static MatchState Tick(MatchState state)
        {
            if (IsFinished(state)) return state;
            var rng = new Rng(0);
            rng.Restore(state.RngState);

            state.Clock.Tick++;
            if (state.Phase.Kind == PhaseKind.HalfTime)
            {
                state.RestartTimer--;
                if (state.RestartTimer <= 0) BeginKickoff(state, Side.Away);
                state.RngState = rng.Snapshot();
                return state;
            }
            if (state.Phase.Kind != PhaseKind.OpenPlay)
            {
                StepDeadBall(state, rng);
            }
            else
            {
                state.Clock.TimeMs += MatchState.TickS * 1000;
                state.Clock.HalfTimeS += MatchState.TickS;
            }

            StepPlayers(state, rng);
            if (state.Phase.Kind == PhaseKind.OpenPlay)
            {
                StepBall(state, rng);
                CheckOffsideAndBoundaries(state);
            }
            StepClock(state);
            state.RngState = rng.Snapshot();
            return state;
        }

        // ---------------------------------------------------------------- dead balls

        private static void BeginKickoff(MatchState state, Side side)
        {
            state.Phase = MatchPhase.Kickoff(side);
            state.RestartTimer = RestartDelayTicks;
            state.Ball.Status = BallStatus.Dead;
            state.Ball.Owner = null;
            state.Ball.Vel = Vec2D.Zero;
            state.Ball.Pos = new Vec2D(state.Rules.Length / 2, state.Rules.Width / 2);
            foreach (PlayerState p in state.Players)
            {
                p.Pos = Formation.KickoffPosition(state.Rules, p.Side, p.Role, p.Side == side);
                p.Vel = Vec2D.Zero;
                p.MoveTarget = p.Pos;
            }
            state.Possession = side;
        }

        private static Vec2D RestartSpot(MatchState state)
        {
            MatchPhase ph = state.Phase;
            Rules r = state.Rules;
            switch (ph.Kind)
            {
                case PhaseKind.Kickoff:
                    return new Vec2D(r.Length / 2, r.Width / 2);
                case PhaseKind.GoalKick:
                {
                    double gx = r.DefendingGoalX(ph.Side);
                    double x = gx == 0 ? r.GoalAreaDepth : r.Length - r.GoalAreaDepth;
                    return new Vec2D(x, r.Width / 2 + (ph.Side == Side.Home ? -1 : 1) * r.GoalAreaWidth * 0.3);
                }
                case PhaseKind.Corner:
                    return new Vec2D(ph.At.X < r.Length / 2 ? 0.3 : r.Length - 0.3, ph.At.Y < r.Width / 2 ? 0.3 : r.Width - 0.3);
                case PhaseKind.ThrowIn:
                    return new Vec2D(Vec2D.Clamp(ph.At.X, 0.5, r.Length - 0.5), ph.At.Y < r.Width / 2 ? 0.2 : r.Width - 0.2);
                case PhaseKind.FreeKick:
                    return new Vec2D(Vec2D.Clamp(ph.At.X, 1, r.Length - 1), Vec2D.Clamp(ph.At.Y, 1, r.Width - 1));
                default:
                    return new Vec2D(r.Length / 2, r.Width / 2);
            }
        }

        private static Side RestartSide(MatchState state) => state.Phase.HasSide ? state.Phase.Side : Side.Home;

        private static PlayerState ChooseTaker(MatchState state, Side side, Vec2D spot)
        {
            PhaseKind ph = state.Phase.Kind;
            var mates = Perception.Teammates(state, side);
            if (ph == PhaseKind.GoalKick)
            {
                foreach (PlayerState p in mates) if (p.Role == 1) return p;
                return Perception.Nearest(mates, spot);
            }
            if (ph == PhaseKind.Kickoff)
            {
                foreach (PlayerState p in mates) if (p.Role == 9) return p;
                return Perception.Nearest(mates, spot);
            }
            var outfield = new List<PlayerState>();
            foreach (PlayerState p in mates) if (p.Role != 1) outfield.Add(p);
            return Perception.Nearest(outfield, spot) ?? mates[0];
        }

        private static void StepDeadBall(MatchState state, Rng rng)
        {
            Vec2D spot = RestartSpot(state);
            Side side = RestartSide(state);
            state.Ball.Pos = spot;
            state.Ball.Vel = Vec2D.Zero;
            state.Ball.Status = BallStatus.Dead;
            PlayerState taker = ChooseTaker(state, side, spot);
            state.RestartTimer--;

            foreach (PlayerState p in state.Players)
            {
                if (p.Id == taker.Id)
                {
                    p.MoveTarget = spot;
                    continue;
                }
                bool inPoss = p.Side == side;
                Vec2D target = Formation.ShapePoint(state.Rules, p, spot, inPoss);
                if (state.Phase.Kind == PhaseKind.Kickoff) target = Formation.KickoffPosition(state.Rules, p.Side, p.Role, inPoss);
                if (!inPoss)
                {
                    double d = Vec2D.Dist(target, spot);
                    double minD = state.Phase.Kind == PhaseKind.Kickoff ? state.Rules.CenterCircleRadius : 6;
                    if (d < minD) target = Vec2D.Add(spot, Vec2D.Scale(Vec2D.Norm(Vec2D.Sub(target, spot)), minD));
                    if (state.Phase.Kind == PhaseKind.Kickoff)
                    {
                        double half = state.Rules.Length / 2;
                        target = new Vec2D(p.Side == Side.Home ? Math.Min(target.X, half - 0.5) : Math.Max(target.X, half + 0.5), target.Y);
                    }
                }
                p.MoveTarget = target;
            }

            if (state.RestartTimer <= 0 && Vec2D.Dist(taker.Pos, spot) < 1.2)
            {
                state.Ball.Status = BallStatus.Controlled;
                state.Ball.Owner = taker.Id;
                state.Ball.LastTouch = taker.Id;
                state.Ball.LastTouchSide = side;
                state.Possession = side;
                PhaseKind kind = state.Phase.Kind;
                Emit(state, new MatchEvent { Type = EventType.Restart, Restart = kind, Side = side, HasSide = true, Taker = taker.Id });
                if (kind == PhaseKind.Kickoff) Emit(state, new MatchEvent { Type = EventType.Kickoff, Side = side, HasSide = true });
                state.Phase = MatchPhase.OpenPlay();
                state.DecisionTimers[taker.Id] = DecisionIntervalTicks;
                foreach (PlayerState p in state.Players) p.Vel = Vec2D.Zero;
                rng.Next();
            }
            else if (state.RestartTimer <= 0)
            {
                if (Vec2D.Dist(taker.Pos, spot) > 8) taker.Pos = Vec2D.Add(spot, new Vec2D(0.8, 0));
            }
        }

        // ---------------------------------------------------------------- players

        private static void StepPlayers(MatchState state, Rng rng)
        {
            BallState ball = state.Ball;
            foreach (PlayerState p in state.Players)
            {
                if (p.TouchCooldown > 0) p.TouchCooldown--;
                if (p.Stunned > 0) p.Stunned--;
                int timer = (state.DecisionTimers.TryGetValue(p.Id, out int existing) ? existing : DecisionIntervalTicks) + 1;
                state.DecisionTimers[p.Id] = timer;
                state.Commands.TryGetValue(p.Id, out QueuedCommand external);
                bool onBall = ball.Status == BallStatus.Controlled && ball.Owner == p.Id && state.Phase.Kind == PhaseKind.OpenPlay;

                bool suspended = state.Awaiting == p.Id;
                if (onBall)
                {
                    if (external != null)
                    {
                        state.Commands.Remove(p.Id);
                        state.DecisionTimers[p.Id] = 0;
                        ExecuteOnBall(state, p, external.Command, rng, external.Accuracy);
                    }
                    else if (suspended)
                    {
                        // keep carrying toward the current target while the decision is pending
                    }
                    else if (timer >= DecisionIntervalTicks)
                    {
                        bool committed = state.Clock.Tick < p.CommitUntilTick;
                        bool pressed = committed && Perception.PressureAt(p.Pos, Perception.Opponents(state, p.Side)) > 0.9;
                        if (!committed || pressed)
                        {
                            state.DecisionTimers[p.Id] = 0;
                            ExecuteOnBall(state, p, Ai.DecideOnBall(state, p, rng), rng, 1);
                        }
                    }
                }
                else if (state.Phase.Kind == PhaseKind.OpenPlay && p.Stunned == 0)
                {
                    PlayerCommand cmd = external?.Command;
                    if (cmd != null && (cmd.Type == CommandType.Move || cmd.Type == CommandType.Press || cmd.Type == CommandType.Screen || cmd.Type == CommandType.Hold))
                    {
                        state.Commands.Remove(p.Id);
                        ApplyOffBall(state, p, cmd, rng);
                    }
                    else if (!suspended && timer >= 3)
                    {
                        state.DecisionTimers[p.Id] = 0;
                        ApplyOffBall(state, p, Ai.DecideOffBall(state, p), rng);
                    }
                }
                MovePlayer(state, p);
            }
        }

        private static void ApplyOffBall(MatchState state, PlayerState p, PlayerCommand cmd, Rng rng)
        {
            switch (cmd.Type)
            {
                case CommandType.Move:
                    p.MoveTarget = cmd.Target;
                    break;
                case CommandType.Hold:
                    p.MoveTarget = p.Pos;
                    break;
                case CommandType.Press:
                {
                    PlayerState target = Perception.FindPlayer(state, cmd.TargetId);
                    if (target == null) break;
                    p.MoveTarget = target.Pos;
                    if (state.Ball.Owner == target.Id && Vec2D.Dist(p.Pos, target.Pos) < 1.3 && p.TouchCooldown == 0 && rng.Next() < 0.04 + 0.04 * (p.Attributes.Tackling / 100))
                    {
                        bool won = Actions.TackleSuccess(p, target, rng);
                        Emit(state, new MatchEvent { Type = EventType.Tackle, Player = p.Id, Victim = target.Id, Won = won });
                        p.TouchCooldown = 60;
                        if (won)
                        {
                            Vec2D away = Vec2D.Norm(Vec2D.Sub(p.Pos, target.Pos));
                            LooseBall(state, Vec2D.Add(p.Pos, Vec2D.Scale(away, 1.2)), Vec2D.Scale(away, 3), p);
                            target.Stunned = 8;
                            ChangePossession(state, p.Side, "tackle");
                        }
                        else
                        {
                            p.Stunned = 14;
                            p.TouchCooldown = 60;
                        }
                    }
                    break;
                }
                case CommandType.Screen:
                {
                    PlayerState from = Perception.FindPlayer(state, cmd.FromId);
                    PlayerState to = Perception.FindPlayer(state, cmd.ToId);
                    if (from != null && to != null) p.MoveTarget = Vec2D.Add(from.Pos, Vec2D.Scale(Vec2D.Sub(to.Pos, from.Pos), 0.4));
                    break;
                }
                default:
                    break;
            }
        }

        private static void MovePlayer(MatchState state, PlayerState p)
        {
            Rules r = state.Rules;
            bool carrying = state.Ball.Status == BallStatus.Controlled && state.Ball.Owner == p.Id;
            Vec2D toTarget = Vec2D.Sub(p.MoveTarget, p.Pos);
            double d = Vec2D.Len(toTarget);
            double desiredSpeed = d < 0.25 ? 0 : Math.Min(Perception.TopSpeed(p), d / MatchState.TickS);
            if (carrying) desiredSpeed *= 0.72 + 0.2 * (p.Attributes.Dribbling / 100);
            if (p.Stunned > 0) desiredSpeed *= 0.2;
            Vec2D desiredVel = Vec2D.Scale(Vec2D.Norm(toTarget), desiredSpeed);
            double accel = (3 + (p.Attributes.Acceleration / 100) * 3) * (1 - 0.25 * p.Fatigue);
            Vec2D dv = Vec2D.Sub(desiredVel, p.Vel);
            double maxDv = accel * MatchState.TickS * 2;
            p.Vel = Vec2D.Add(p.Vel, Vec2D.Len(dv) > maxDv ? Vec2D.Scale(Vec2D.Norm(dv), maxDv) : dv);
            double speed = Vec2D.Len(p.Vel);
            if (speed > Perception.TopSpeed(p)) p.Vel = Vec2D.Scale(p.Vel, Perception.TopSpeed(p) / speed);
            p.Pos = Vec2D.Add(p.Pos, Vec2D.Scale(p.Vel, MatchState.TickS));
            p.Pos = new Vec2D(Vec2D.Clamp(p.Pos.X, -1, r.Length + 1), Vec2D.Clamp(p.Pos.Y, -1, r.Width + 1));
            double stamina = p.Attributes.Stamina / 100;
            double e = speed / 6.8;
            double effort = e * e;
            p.Fatigue = Vec2D.Clamp(p.Fatigue + MatchState.TickS * (effort * 0.0032 * (1.5 - stamina) - 0.0009 * (0.5 + stamina)), 0, 1);
        }

        // ---------------------------------------------------------------- on-ball execution

        private static void ExecuteOnBall(MatchState state, PlayerState p, PlayerCommand cmd, Rng rng, double intentAccuracy)
        {
            BallState ball = state.Ball;
            switch (cmd.Type)
            {
                case CommandType.Pass:
                {
                    KickResult k = Actions.Kick(state, p, cmd.Target, false, rng, intentAccuracy);
                    string receiver = cmd.Receiver;
                    ReleaseBall(state, p, k.Velocity);
                    ball.PassTarget = receiver;
                    ball.PassFrom = p.Id;
                    SnapshotOffside(state, p.Side);
                    Emit(state, new MatchEvent { Type = EventType.Pass, From = p.Id, To = receiver, Target = cmd.Target, HasTarget = true, Side = p.Side, HasSide = true, Error = k.Error });
                    break;
                }
                case CommandType.Shoot:
                {
                    KickResult k = Actions.Kick(state, p, cmd.Target, true, rng, intentAccuracy);
                    ReleaseBall(state, p, k.Velocity);
                    ball.PassTarget = null;
                    ball.PassFrom = p.Id;
                    bool onTarget = ShotOnTarget(state, p.Side, p.Pos, k.Velocity);
                    Emit(state, new MatchEvent { Type = EventType.Shot, Player = p.Id, Target = cmd.Target, HasTarget = true, OnTarget = onTarget, Side = p.Side, HasSide = true, Error = k.Error });
                    state.PendingShot = new PendingShot { Shooter = p.Id, Side = p.Side, OnTarget = onTarget };
                    break;
                }
                case CommandType.Carry:
                {
                    Vec2D from = p.Pos;
                    Vec2D target = Vec2D.Add(p.Pos, Vec2D.Scale(Vec2D.Norm(cmd.Direction), cmd.Distance));
                    p.MoveTarget = new Vec2D(Vec2D.Clamp(target.X, 0.3, state.Rules.Length - 0.3), Vec2D.Clamp(target.Y, 0.3, state.Rules.Width - 0.3));
                    double carrySpeed = Perception.TopSpeed(p) * 0.8;
                    p.CommitUntilTick = state.Clock.Tick + (int)Math.Ceiling(cmd.Distance / carrySpeed / MatchState.TickS);
                    Emit(state, new MatchEvent { Type = EventType.Carry, Player = p.Id, FromPos = from, ToPos = p.MoveTarget });
                    break;
                }
                case CommandType.Hold:
                    p.MoveTarget = p.Pos;
                    p.CommitUntilTick = state.Clock.Tick + 10;
                    break;
                case CommandType.FirstTouch:
                case CommandType.Move:
                    p.MoveTarget = cmd.Type == CommandType.Move ? cmd.Target : Vec2D.Add(p.Pos, Vec2D.Scale(Vec2D.Norm(cmd.Direction), 2));
                    break;
                default:
                    break;
            }
        }

        private static void ReleaseBall(MatchState state, PlayerState p, Vec2D velocity)
        {
            BallState ball = state.Ball;
            ball.Status = BallStatus.Loose;
            ball.Owner = null;
            ball.Vel = velocity;
            ball.Pos = Vec2D.Add(p.Pos, Vec2D.Scale(Vec2D.Norm(velocity), 0.5));
            ball.LastTouch = p.Id;
            ball.LastTouchSide = p.Side;
            p.TouchCooldown = Actions.KickCooldownTicks;
            Vec2D dir = Vec2D.Norm(velocity);
            foreach (PlayerState o in state.Players)
            {
                if (o.Side == p.Side || o.TouchCooldown > 0) continue;
                Vec2D rel = Vec2D.Sub(o.Pos, p.Pos);
                double d = Vec2D.Len(rel);
                if (d > 2.2) continue;
                double cos = d > 1e-6 ? (rel.X * dir.X + rel.Y * dir.Y) / d : 1;
                if (cos < 0.85) o.TouchCooldown = 6;
            }
        }

        private static void LooseBall(MatchState state, Vec2D pos, Vec2D vel, PlayerState toucher)
        {
            BallState ball = state.Ball;
            ball.Status = BallStatus.Loose;
            ball.Owner = null;
            ball.Pos = pos;
            ball.Vel = vel;
            ball.PassTarget = null;
            ball.PassFrom = null;
            if (toucher != null)
            {
                ball.LastTouch = toucher.Id;
                ball.LastTouchSide = toucher.Side;
                toucher.TouchCooldown = 4;
            }
        }

        private static void ChangePossession(MatchState state, Side to, string reason)
        {
            if (state.Possession != to)
            {
                state.Possession = to;
                Emit(state, new MatchEvent { Type = EventType.PossessionChange, ToSide = to, Reason = reason });
            }
        }

        private static bool ShotOnTarget(MatchState state, Side side, Vec2D from, Vec2D vel)
        {
            double gx = state.Rules.AttackingGoalX(side);
            if (Math.Abs(vel.X) < 1e-6) return false;
            double t = (gx - from.X) / vel.X;
            if (t <= 0) return false;
            double y = from.Y + vel.Y * t;
            state.Rules.GoalPosts(gx, out Vec2D a, out Vec2D b);
            return y > a.Y && y < b.Y;
        }

        // ---------------------------------------------------------------- ball

        private static void StepBall(MatchState state, Rng rng)
        {
            BallState ball = state.Ball;
            if (ball.Status == BallStatus.Controlled && !string.IsNullOrEmpty(ball.Owner))
            {
                PlayerState owner = Perception.PlayerById(state, ball.Owner);
                Vec2D facing = Vec2D.Len(owner.Vel) > 0.3 ? Vec2D.Norm(owner.Vel) : Vec2D.Norm(Vec2D.Sub(owner.MoveTarget, owner.Pos));
                ball.Pos = Vec2D.Add(owner.Pos, Vec2D.Scale(facing, 0.45));
                ball.Vel = owner.Vel;
                return;
            }
            if (ball.Status != BallStatus.Loose) return;

            double speed = Vec2D.Len(ball.Vel);
            if (speed > 0)
            {
                double newSpeed = Math.Max(0, speed - Actions.BallFriction * MatchState.TickS);
                ball.Vel = Vec2D.Scale(ball.Vel, newSpeed / speed);
            }
            Vec2D prev = ball.Pos;
            ball.Pos = Vec2D.Add(ball.Pos, Vec2D.Scale(ball.Vel, MatchState.TickS));

            foreach (Side side in new[] { Side.Home, Side.Away })
            {
                double gx = state.Rules.AttackingGoalX(side);
                bool crossed = side == Side.Home ? prev.X <= gx && ball.Pos.X > gx : prev.X >= gx && ball.Pos.X < gx;
                if (crossed)
                {
                    state.Rules.GoalPosts(gx, out Vec2D a, out Vec2D b);
                    double t = (gx - prev.X) / (ball.Pos.X - prev.X);
                    double y = prev.Y + (ball.Pos.Y - prev.Y) * t;
                    if (y > a.Y && y < b.Y && ball.LastTouchSide.HasValue)
                    {
                        ScoreGoal(state, side);
                        return;
                    }
                }
            }

            var candidates = new List<PlayerState>();
            double reach = Actions.ControlRadius + Vec2D.Len(ball.Vel) * MatchState.TickS * 0.5;
            foreach (PlayerState p in state.Players)
            {
                if (p.TouchCooldown == 0 && p.Stunned == 0 && Vec2D.Dist(p.Pos, ball.Pos) <= reach) candidates.Add(p);
            }
            PlayerState receiver = Perception.Nearest(candidates, ball.Pos);
            if (receiver == null) return;

            if (state.PendingShot != null && receiver.Role == 1 && receiver.Side != state.PendingShot.Side)
            {
                PlayerState shooter = Perception.PlayerById(state, state.PendingShot.Shooter);
                double dOff = Vec2D.Dist(receiver.Pos, ball.Pos);
                double chance = Actions.SaveChance(receiver, speed, Vec2D.Dist(shooter.Pos, ball.Pos), dOff);
                bool saved = rng.Next() < chance;
                if (saved)
                {
                    Emit(state, new MatchEvent { Type = EventType.Save, Keeper = receiver.Id, Shooter = shooter.Id });
                    if (rng.Next() < 0.65)
                    {
                        ControlBall(state, receiver);
                    }
                    else
                    {
                        LooseBall(state, ball.Pos, Vec2D.Scale(new Vec2D(receiver.Side == Side.Home ? 1 : -1, rng.Gaussian()), 6), receiver);
                    }
                    ChangePossession(state, receiver.Side, "save");
                    state.PendingShot = null;
                    return;
                }
                receiver.TouchCooldown = 8;
                state.PendingShot = null;
                return;
            }

            PlayerState passer = string.IsNullOrEmpty(ball.PassFrom) ? null : Perception.PlayerById(state, ball.PassFrom);
            bool isInterception = ball.LastTouchSide.HasValue && receiver.Side != ball.LastTouchSide.Value;
            state.Commands.TryGetValue(receiver.Id, out QueuedCommand queued);
            PlayerCommand cmd = queued?.Command;
            Vec2D? touchDir = cmd != null && cmd.Type == CommandType.FirstTouch ? cmd.Direction : Vec2D.Sub(receiver.MoveTarget, receiver.Pos);
            if (cmd != null && cmd.Type == CommandType.FirstTouch) state.Commands.Remove(receiver.Id);

            if (!isInterception && state.OffsideSnapshot != null && state.OffsideSnapshot.Side == receiver.Side && state.OffsideSnapshot.OffsidePlayers.Contains(receiver.Id))
            {
                Emit(state, new MatchEvent { Type = EventType.Offside, Player = receiver.Id, Side = receiver.Side, HasSide = true });
                state.OffsideSnapshot = null;
                state.Phase = MatchPhase.FreeKick(Sides.Other(receiver.Side), receiver.Pos, "offside");
                state.RestartTimer = RestartDelayTicks;
                ball.Status = BallStatus.Dead;
                ball.Owner = null;
                ball.Vel = Vec2D.Zero;
                ChangePossession(state, Sides.Other(receiver.Side), "offside");
                return;
            }

            (Vec2D offset, bool clean) touch = Actions.FirstTouch(state, receiver, speed, touchDir.HasValue && Vec2D.Len(touchDir.Value) > 0.1 ? touchDir : null, rng);
            if (isInterception && passer != null)
            {
                Emit(state, new MatchEvent { Type = EventType.Interception, Player = receiver.Id, From = passer.Id });
                ChangePossession(state, receiver.Side, "interception");
            }
            else if (isInterception)
            {
                Emit(state, new MatchEvent { Type = EventType.Recovery, Player = receiver.Id });
                ChangePossession(state, receiver.Side, "recovery");
            }
            else
            {
                Emit(state, new MatchEvent { Type = EventType.Receive, Player = receiver.Id, From = passer?.Id, Clean = touch.clean });
            }
            state.PendingShot = null;
            state.OffsideSnapshot = null;
            if (touch.clean)
            {
                ControlBall(state, receiver);
            }
            else
            {
                LooseBall(state, Vec2D.Add(receiver.Pos, touch.offset), Vec2D.Scale(Vec2D.Norm(touch.offset), 2.5), receiver);
            }
        }

        private static void ControlBall(MatchState state, PlayerState p)
        {
            BallState ball = state.Ball;
            ball.Status = BallStatus.Controlled;
            ball.Owner = p.Id;
            ball.Vel = p.Vel;
            ball.Pos = Vec2D.Add(p.Pos, Vec2D.Scale(Vec2D.Norm(Vec2D.Sub(ball.Pos, p.Pos)), 0.45));
            ball.LastTouch = p.Id;
            ball.LastTouchSide = p.Side;
            ball.PassTarget = null;
            ball.PassFrom = null;
            state.DecisionTimers[p.Id] = 0;
            p.CommitUntilTick = state.Clock.Tick + 24;
            ChangePossession(state, p.Side, "control");
        }

        private static void ScoreGoal(MatchState state, Side side)
        {
            string scorerId = state.Ball.LastTouch;
            PlayerState scorer = string.IsNullOrEmpty(scorerId) ? null : Perception.PlayerById(state, scorerId);
            if (side == Side.Home) state.Score.Home++; else state.Score.Away++;
            string assist = state.PendingShot != null && scorer != null && scorer.Side == side ? LastPassFrom(state, scorer.Id) : null;
            Emit(state, new MatchEvent { Type = EventType.Goal, Scorer = scorer != null ? scorer.Id : "unknown", Side = side, HasSide = true, Assist = assist });
            state.PendingShot = null;
            BeginKickoff(state, Sides.Other(side));
        }

        private static string LastPassFrom(MatchState state, string scorerId)
        {
            for (int i = state.Events.Count - 1; i >= 0 && i > state.Events.Count - 40; i--)
            {
                MatchEvent e = state.Events[i];
                if (e.Type == EventType.Receive && e.Player == scorerId) return e.From;
                if (e.Type == EventType.PossessionChange) return null;
            }
            return null;
        }

        private static void SnapshotOffside(MatchState state, Side side)
        {
            if (!state.Rules.Offside)
            {
                state.OffsideSnapshot = null;
                return;
            }
            double line = Ai.LastDefenderLine(state, Sides.Other(side));
            double ballX = state.Ball.Pos.X;
            double half = state.Rules.Length / 2;
            var snap = new OffsideSnapshot { Side = side };
            foreach (PlayerState p in Perception.Teammates(state, side))
            {
                if (state.Ball.LastTouch == p.Id) continue;
                bool inOppHalf = side == Side.Home ? p.Pos.X > half : p.Pos.X < half;
                bool beyondBall = side == Side.Home ? p.Pos.X > ballX : p.Pos.X < ballX;
                bool beyondLine = side == Side.Home ? p.Pos.X > line + 0.05 : p.Pos.X < line - 0.05;
                if (inOppHalf && beyondBall && beyondLine) snap.OffsidePlayers.Add(p.Id);
            }
            state.OffsideSnapshot = snap;
        }

        // ---------------------------------------------------------------- boundaries & clock

        private static void CheckOffsideAndBoundaries(MatchState state)
        {
            if (state.Phase.Kind != PhaseKind.OpenPlay) return;
            BallState ball = state.Ball;
            Rules r = state.Rules;
            Vec2D p = ball.Pos;
            Side lastSide = ball.LastTouchSide ?? Side.Home;
            Side restartFor = Sides.Other(lastSide);
            MatchPhase phase = null;
            if (p.Y < 0 || p.Y > r.Width)
            {
                phase = MatchPhase.ThrowIn(restartFor, new Vec2D(Vec2D.Clamp(p.X, 0, r.Length), p.Y < 0 ? 0 : r.Width));
            }
            else if (p.X < 0 || p.X > r.Length)
            {
                double goalLineX = p.X < 0 ? 0 : r.Length;
                Side defender = goalLineX == 0 ? Side.Home : Side.Away;
                if (lastSide == defender) phase = MatchPhase.Corner(Sides.Other(defender), new Vec2D(goalLineX, p.Y));
                else phase = MatchPhase.GoalKick(defender);
            }
            if (phase != null)
            {
                Emit(state, new MatchEvent { Type = EventType.OutOfPlay, Restart = phase.Kind, Side = restartFor, HasSide = true });
                state.Phase = phase;
                state.RestartTimer = RestartDelayTicks;
                ball.Status = BallStatus.Dead;
                ball.Owner = null;
                ball.Vel = Vec2D.Zero;
                ball.Pos = new Vec2D(Vec2D.Clamp(p.X, 0, r.Length), Vec2D.Clamp(p.Y, 0, r.Width));
                state.PendingShot = null;
                ChangePossession(state, phase.HasSide ? phase.Side : restartFor, PhaseKinds.Name(phase.Kind));
            }
        }

        private static void StepClock(MatchState state)
        {
            Rules r = state.Rules;
            if (state.Phase.Kind == PhaseKind.FullTime || state.Phase.Kind == PhaseKind.HalfTime) return;
            if (state.Clock.HalfTimeS >= r.HalfLengthSeconds && state.Phase.Kind == PhaseKind.OpenPlay)
            {
                if (state.Clock.Half >= r.Halves)
                {
                    state.Phase = MatchPhase.FullTime();
                    state.Ball.Status = BallStatus.Dead;
                    Emit(state, new MatchEvent { Type = EventType.FullTime, Home = state.Score.Home, Away = state.Score.Away });
                }
                else
                {
                    state.Clock.Half++;
                    state.Clock.HalfTimeS = 0;
                    state.Phase = MatchPhase.HalfTime();
                    state.RestartTimer = RestartDelayTicks;
                    state.Ball.Status = BallStatus.Dead;
                    state.Ball.Owner = null;
                    Emit(state, new MatchEvent { Type = EventType.HalfTime });
                }
            }
        }

        /// <summary>Run a whole match with AI on both sides (test/benchmark helper).</summary>
        public static MatchState RunHeadless(MatchConfig cfg, Action<MatchState> observer = null, int maxTicks = 200_000)
        {
            MatchState state = CreateMatch(cfg);
            while (!IsFinished(state) && state.Clock.Tick < maxTicks)
            {
                Tick(state);
                observer?.Invoke(state);
            }
            return state;
        }
    }
}
