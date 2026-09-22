import { evaluateOnBall, lastDefenderLine, secondNineRead } from "../sim/ai";
import { speedForDistance } from "../sim/actions";
import { add, clamp, dist, scale, type Vec2 } from "../sim/geometry";
import {
  arrivalTime,
  distanceToGoal,
  laneReport,
  opponents,
  other,
  playerById,
  pressureAt,
  progress,
  shotWindow,
  spaceAt,
  teammates,
} from "../sim/perception";
import { attackingGoalX, defendingGoalX, inPenaltyArea } from "../sim/rules";
import { ROLE_BY_NUMBER, type MatchState, type PlayerState, type RoleId } from "../sim/types";

/**
 * Numeric read of the field from one player's point of view. Every catalog trigger and
 * evaluation criterion is a predicate over these names, so content never touches engine types.
 * Booleans are encoded 0/1. Distances in metres, times in seconds, "space"/"pressure" in 0..1.
 */
export interface FieldRead {
  hasBall: number;
  /** A teammate's pass is travelling to me. */
  receiving: number;
  ourPossession: number;
  theirPossession: number;
  looseBall: number;
  pressure: number;
  nearestOppDist: number;
  spaceAhead: number;
  spaceFarSide: number;
  spaceNearSide: number;
  /** 0 own goal line → 1 opponents' goal line, for me and for the ball. */
  progress: number;
  ballProgress: number;
  distToGoal: number;
  distToBall: number;
  /** Radians of unblocked goal-mouth from my position. */
  shotWindow: number;
  /** Passing options with a positive intercept margin. */
  openLanes: number;
  /** Open lanes that gain ground. */
  progressiveLanes: number;
  /** Best pass/carry/shoot scores from the engine's own evaluator (0 when not on the ball). */
  bestPassScore: number;
  bestCarryScore: number;
  bestShotScore: number;
  bestSwitchScore: number;
  /** Metres between the opponents' last defender line and their goal line. */
  spaceBehindLine: number;
  /** Am I level or behind the offside line (a run behind is legal right now)? */
  onsideForRun: number;
  /** A teammate is making a forward run into space beyond me. */
  teammateRunAhead: number;
  /** Ball is on my half of the pitch width (wide roles). */
  ballOnMyFlank: number;
  /** Distance from me to the opposing ball carrier (large when none). */
  carrierDist: number;
  /** I am the nearest defender to the opposing carrier. */
  firstDefender: number;
  /** I am the second-nearest defender. */
  secondDefender: number;
  /** A teammate is already pressing the carrier. */
  teammatePressing: number;
  /** An opponent without the ball is within 10 m and moving toward our goal. */
  oppRunnerNear: number;
  /** Distance of the opposing carrier to our goal. */
  carrierDistToOurGoal: number;
  /** Seconds since possession last changed hands (large when stable). */
  secondsSinceTurnover: number;
  /** Ball inside our own penalty area. */
  ballInOurBox: number;
  ballInTheirBox: number;
  /** Me: keeper-specific. */
  keeperCanSweep: number;
  /** Metres from our goal line to our deepest outfield defender (how high our back line is). */
  ourLineDepth: number;
  /** How far the ball sits from the pitch's centre line, 0 centre → 1 touchline. */
  ballWide: number;
  /** Metres between me and our own goal line. */
  distFromOwnGoalLine: number;
  /** Signed goal difference from my team's view. */
  scoreDiff: number;
  minute: number;
  /** Carrier (teammate) pressure when a teammate has the ball. */
  carrierPressure: number;
  /** Distance to the teammate carrier. */
  teammateCarrierDist: number;
  /** Wingers: a teammate (usually the outside back) already holds the wide lane on my flank past halfway. */
  widthProvidedMyFlank: number;
  /** Wingers: space (0..1) in the far-post / cutback half-space I would narrow into; 0 when not applicable. */
  farPostSpace: number;
  /** Outfield teammates behind the ball while we attack (rest defence). */
  restDefenseCount: number;
  /** Wingers: every second-9 condition holds — ball secured on the far flank, width provided, striker pinning, far-post space, rest defence. */
  secondNineOn: number;
}

export type FeatureName = keyof FieldRead;

export const FEATURE_NAMES: readonly FeatureName[] = [
  "hasBall",
  "receiving",
  "ourPossession",
  "theirPossession",
  "looseBall",
  "pressure",
  "nearestOppDist",
  "spaceAhead",
  "spaceFarSide",
  "spaceNearSide",
  "progress",
  "ballProgress",
  "distToGoal",
  "distToBall",
  "shotWindow",
  "openLanes",
  "progressiveLanes",
  "bestPassScore",
  "bestCarryScore",
  "bestShotScore",
  "bestSwitchScore",
  "spaceBehindLine",
  "onsideForRun",
  "teammateRunAhead",
  "ballOnMyFlank",
  "carrierDist",
  "firstDefender",
  "secondDefender",
  "teammatePressing",
  "oppRunnerNear",
  "carrierDistToOurGoal",
  "secondsSinceTurnover",
  "ballInOurBox",
  "ballInTheirBox",
  "keeperCanSweep",
  "ourLineDepth",
  "ballWide",
  "distFromOwnGoalLine",
  "scoreDiff",
  "minute",
  "carrierPressure",
  "teammateCarrierDist",
  "widthProvidedMyFlank",
  "farPostSpace",
  "restDefenseCount",
  "secondNineOn",
];

const b = (v: boolean): number => (v ? 1 : 0);

export function roleOf(p: PlayerState): RoleId {
  return ROLE_BY_NUMBER[p.role];
}

export function readField(state: MatchState, p: PlayerState): FieldRead {
  const rules = state.rules;
  const ball = state.ball;
  const opps = opponents(state, p.side);
  const mates = teammates(state, p.side).filter((m) => m.id !== p.id);
  const dir = p.side === "home" ? 1 : -1;
  const forward: Vec2 = { x: dir, y: 0 };
  const hasBall = ball.status === "controlled" && ball.owner === p.id;
  const ourPossession = state.possession === p.side && ball.status !== "loose";
  const theirPossession = state.possession === other(p.side) && ball.status === "controlled";

  const nearestOpp = opps.reduce<number>((m, o) => Math.min(m, dist(o.pos, p.pos)), Infinity);
  const farY = p.pos.y < rules.width / 2 ? rules.width * 0.8 : rules.width * 0.2;
  const nearY = p.pos.y < rules.width / 2 ? rules.width * 0.2 : rules.width * 0.8;

  let openLanes = 0;
  let progressiveLanes = 0;
  const myProgress = progress(rules, p.side, p.pos);
  for (const m of mates) {
    const d = dist(p.pos, m.pos);
    if (d < 3 || d > 40) continue;
    const lane = laneReport(p.pos, m.pos, speedForDistance(d), opps);
    if (lane.margin > 0.15) {
      openLanes++;
      if (progress(rules, p.side, m.pos) > myProgress + 0.05) progressiveLanes++;
    }
  }

  let bestPass = 0;
  let bestCarry = 0;
  let bestShot = 0;
  let bestSwitch = 0;
  if (hasBall) {
    for (const o of evaluateOnBall(state, p)) {
      if (o.kind === "pass") bestPass = Math.max(bestPass, o.score);
      else if (o.kind === "switch") bestSwitch = Math.max(bestSwitch, o.score);
      else if (o.kind === "carry") bestCarry = Math.max(bestCarry, o.score);
      else if (o.kind === "shoot") bestShot = Math.max(bestShot, o.score);
    }
  }

  const lineX = lastDefenderLine(state, other(p.side));
  const theirGoalX = attackingGoalX(rules, p.side);
  const ourGoalX = defendingGoalX(rules, p.side);
  const spaceBehindLine = Math.abs(theirGoalX - lineX);
  const onsideForRun = dir > 0 ? p.pos.x <= lineX + 0.3 : p.pos.x >= lineX - 0.3;
  const teammateRunAhead = mates.some(
    (m) => m.role !== 1 && (m.vel.x * dir) > 2 && (m.pos.x - p.pos.x) * dir > 2 && spaceAt(add(m.pos, scale(forward, 5)), opps) > 0.4,
  );

  const carrier = theirPossession && ball.owner ? playerById(state, ball.owner) : null;
  const teammateCarrier = ourPossession && ball.owner && ball.owner !== p.id ? playerById(state, ball.owner) : null;
  const defenders = teammates(state, p.side).filter((m) => m.role !== 1);
  let firstDefender = false;
  let secondDefender = false;
  let teammatePressing = false;
  if (carrier) {
    const byDist = [...defenders].sort((a, c) => dist(a.pos, carrier.pos) - dist(c.pos, carrier.pos));
    firstDefender = byDist[0]?.id === p.id;
    secondDefender = byDist[1]?.id === p.id;
    teammatePressing = mates.some((m) => m.role !== 1 && dist(m.pos, carrier.pos) < 3);
  }
  const oppRunnerNear = opps.some(
    (o) => o.role !== 1 && o.id !== carrier?.id && dist(o.pos, p.pos) < 10 && (o.vel.x * -dir) > 1.5,
  );

  let lastTurnoverTick = -Infinity;
  for (let i = state.events.length - 1; i >= 0; i--) {
    const e = state.events[i];
    if (e && e.type === "possession_change") {
      lastTurnoverTick = e.tick;
      break;
    }
  }
  const secondsSinceTurnover = Number.isFinite(lastTurnoverTick) ? (state.clock.tick - lastTurnoverTick) * 0.05 : 999;

  const keeperCanSweep =
    p.role === 1 && ball.status === "loose" && inPenaltyArea(rules, ourGoalX, ball.pos) && arrivalTime(p, ball.pos) < Math.min(...opps.map((o) => arrivalTime(o, ball.pos)));

  const ourLineDepth = Math.abs(lastDefenderLine(state, p.side) - ourGoalX);

  const nine = secondNineRead(state, p);

  const my = p.side === "home" ? state.score.home : state.score.away;
  const theirs = p.side === "home" ? state.score.away : state.score.home;

  return {
    hasBall: b(hasBall),
    receiving: b(ball.status === "loose" && ball.passTarget === p.id),
    ourPossession: b(ourPossession),
    theirPossession: b(theirPossession),
    looseBall: b(ball.status === "loose"),
    pressure: pressureAt(p.pos, opps),
    nearestOppDist: nearestOpp,
    spaceAhead: spaceAt(add(p.pos, scale(forward, 6)), opps),
    spaceFarSide: spaceAt({ x: p.pos.x + dir * 4, y: farY }, opps),
    spaceNearSide: spaceAt({ x: p.pos.x + dir * 4, y: nearY }, opps),
    progress: myProgress,
    ballProgress: progress(rules, p.side, ball.pos),
    distToGoal: distanceToGoal(rules, p.side, p.pos),
    distToBall: dist(p.pos, ball.pos),
    shotWindow: shotWindow(rules, p.side, p.pos, opps),
    openLanes,
    progressiveLanes,
    bestPassScore: bestPass,
    bestCarryScore: bestCarry,
    bestShotScore: bestShot,
    bestSwitchScore: bestSwitch,
    spaceBehindLine,
    onsideForRun: b(onsideForRun),
    teammateRunAhead: b(teammateRunAhead),
    ballOnMyFlank: b(Math.sign(ball.pos.y - rules.width / 2) === Math.sign(p.pos.y - rules.width / 2)),
    carrierDist: carrier ? dist(carrier.pos, p.pos) : 999,
    firstDefender: b(firstDefender),
    secondDefender: b(secondDefender),
    teammatePressing: b(teammatePressing),
    oppRunnerNear: b(oppRunnerNear),
    carrierDistToOurGoal: carrier ? Math.abs(carrier.pos.x - ourGoalX) : 999,
    secondsSinceTurnover,
    ballInOurBox: b(inPenaltyArea(rules, ourGoalX, ball.pos)),
    ballInTheirBox: b(inPenaltyArea(rules, theirGoalX, ball.pos)),
    keeperCanSweep: b(keeperCanSweep),
    ourLineDepth,
    ballWide: clamp(Math.abs(ball.pos.y - rules.width / 2) / (rules.width / 2), 0, 1),
    distFromOwnGoalLine: Math.abs(p.pos.x - ourGoalX),
    scoreDiff: my - theirs,
    minute: state.clock.timeMs / 60000,
    carrierPressure: teammateCarrier ? pressureAt(teammateCarrier.pos, opps) : 0,
    teammateCarrierDist: teammateCarrier ? dist(teammateCarrier.pos, p.pos) : 999,
    widthProvidedMyFlank: b(nine.widthProvided),
    farPostSpace: nine.farPostSpace,
    restDefenseCount: nine.restDefense,
    secondNineOn: b(nine.on),
  };
}

