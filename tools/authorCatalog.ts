/*
 * Authoring source for the PROVISIONAL tactical catalog. Writes content/catalog/provisional-u11.json.
 * Usage: npm run catalog:build
 *
 * This is original prototype content written to demonstrate the recognition/grading system. It has
 * not been coach-reviewed (spec §16): every entry is `review.status = "provisional"`. Reviewed
 * situations can be added by editing the JSON directly or extending this file.
 */
import { writeFileSync } from "node:fs";
import type { CatalogAction, CatalogEntry, CatalogFile, Condition, Criterion, MomentCategory, PhaseOfPlay, Trigger } from "../src/tactics/catalog";
import { validateCatalog } from "../src/tactics/catalog";
import type { FieldRead } from "../src/tactics/features";
import type { RoleId } from "../src/sim/types";

const c = (f: keyof FieldRead, op: Condition["op"], v: number): Condition => ({ f, op, v });
const when = (conds: Condition[], add: number, why: string): Criterion => ({ when: conds, add, why });

function action(id: string, label: string, intent: CatalogAction["intent"], base: number, evalRules: Criterion[]): CatalogAction {
  return { id, label, intent, base, eval: evalRules };
}

// ---------------------------------------------------------------- shared actions
const A = {
  space: action("attack_space", "Attack the space", "attack_space", 0.6, [
    when([c("spaceAhead", ">", 0.5)], 0.5, "open space ahead of you"),
    when([c("pressure", ">", 0.7)], -0.3, "a defender is closing you down"),
    when([c("progressiveLanes", ">=", 2)], -0.1, "teammates were open further up"),
  ]),
  draw: action("draw_defender", "Draw the defender", "draw_defender", 0.35, [
    when([c("teammateRunAhead", "==", 1)], 0.5, "a teammate is running beyond: commit the defender, then release"),
    when([c("pressure", ">", 0.6)], -0.2, "already under pressure, little time to draw anyone"),
    when([c("nearestOppDist", ">", 10)], -0.3, "no defender close enough to draw"),
  ]),
  gap: action("through_gap", "Play through the gap", "through_gap", 0.5, [
    when([c("progressiveLanes", ">=", 1)], 0.4, "a forward lane is open"),
    when([c("teammateRunAhead", "==", 1)], 0.3, "a runner is timing a run"),
    when([c("bestPassScore", ">", 1.0)], 0.3, "the forward pass is on"),
  ]),
  switch: action("switch_play", "Switch the point of attack", "switch_play", 0.35, [
    when([c("spaceFarSide", ">", 0.6)], 0.6, "the far side is open"),
    when([c("spaceNearSide", ">", 0.6)], -0.3, "space near you is just as good, no need to switch"),
    when([c("pressure", ">", 0.7)], -0.2, "a long switch under pressure is risky"),
    when([c("pressure", ">", 0.5), c("spaceNearSide", "<", 0.4)], 0.3, "your side is overloaded: the spare player is on the far side"),
  ]),
  layoff: action("lay_off", "Lay it off to the arriving teammate", "recycle", 0.4, [
    when([c("pressure", ">", 0.6)], 0.4, "marked from behind: the first-time lay-off keeps it"),
    when([c("shotWindow", ">", 0.35)], -0.4, "the shot was open"),
    when([c("progressiveLanes", ">=", 1)], -0.2, "a forward option was on"),
    when([c("openLanes", "==", 0)], -0.3, "nobody had arrived to receive it"),
  ]),
  recycle: action("recycle", "Recycle possession", "recycle", 0.4, [
    when([c("pressure", ">", 0.6)], 0.4, "under pressure: keep the ball moving"),
    when([c("progressiveLanes", "==", 0)], 0.3, "nothing is on ahead"),
    when([c("progressiveLanes", ">=", 2)], -0.3, "forward options were open, recycling wastes them"),
    when([c("spaceAhead", ">", 0.6)], -0.2, "there was space to attack yourself"),
  ]),
  shoot: action("shoot", "Shoot", "shoot", 0.3, [
    when([c("shotWindow", ">", 0.35)], 0.6, "the goal is open"),
    when([c("distToGoal", "<", 14)], 0.4, "close range"),
    when([c("distToGoal", ">", 22)], -0.4, "long range: low chance"),
    when([c("shotWindow", "<", 0.15)], -0.5, "the shooting lane is blocked"),
  ]),
  hold: action("hold_ball", "Hold and shield", "hold_ball", 0.15, [
    when([c("pressure", ">", 0.8)], -0.3, "shielding under heavy pressure invites the tackle"),
    when([c("openLanes", "==", 0)], 0.3, "no passing option yet, buy time"),
  ]),
  touchForward: action("touch_forward", "First touch forward", "first_touch_forward", 0.4, [
    when([c("spaceAhead", ">", 0.5)], 0.5, "space to turn into"),
    when([c("pressure", ">", 0.6)], -0.5, "a defender arrives as the ball does"),
  ]),
  touchSafe: action("touch_safe", "Safe touch away from pressure", "first_touch_safe", 0.35, [
    when([c("pressure", ">", 0.6)], 0.5, "pressure is arriving: protect the ball first"),
    when([c("spaceAhead", ">", 0.6)], -0.3, "space ahead went unused"),
  ]),
  runBehind: action("run_behind", "Run behind the defence", "run_behind", 0.4, [
    when([c("spaceBehindLine", ">", 10)], 0.5, "space behind the defence"),
    when([c("onsideForRun", "==", 0)], -0.8, "you were beyond the last defender: offside"),
    when([c("carrierPressure", ">", 0.7)], -0.2, "the carrier is pressed and cannot find you"),
    when([c("spaceBehindLine", "<", 8)], -0.3, "the defence is deep, no room behind"),
  ]),
  overlap: action("overlap", "Overlap outside", "overlap", 0.4, [
    when([c("ballOnMyFlank", "==", 1)], 0.3, "the ball is on your side"),
    when([c("spaceNearSide", ">", 0.5)], 0.3, "the wide lane is free"),
    when([c("carrierPressure", ">", 0.7)], -0.1, "the carrier is pressed, the overlap may be late"),
  ]),
  underneath: action("support_underneath", "Support underneath", "support_underneath", 0.35, [
    when([c("carrierPressure", ">", 0.6)], 0.5, "the carrier needs a safe outlet"),
    when([c("carrierPressure", "<", 0.3)], -0.2, "the carrier has time: a forward option is worth more"),
  ]),
  width: action("hold_width", "Hold width", "hold_width", 0.3, [
    when([c("spaceNearSide", ">", 0.6)], 0.2, "staying wide keeps the lane open"),
    when([c("ballOnMyFlank", "==", 0)], 0.2, "stay available as the switch target"),
    when([c("spaceBehindLine", ">", 12)], -0.2, "there was room behind: a run was on"),
    when([c("secondNineOn", "==", 1)], -0.2, "the full back already held width: the far-post run was on"),
  ]),
  narrowInside: action("narrow_inside", "Narrow inside as the second striker", "narrow_inside", 0.3, [
    when([c("secondNineOn", "==", 1)], 0.5, "ball secured on the far side, width covered, far-post space open"),
    when([c("widthProvidedMyFlank", "==", 0)], -0.5, "nobody else holds width on your side: narrowing kills the switch"),
    when([c("restDefenseCount", "<", 3)], -0.3, "too few behind the ball to protect the counter"),
    when([c("carrierPressure", ">", 0.5)], -0.3, "the carrier is pressed: the ball is not secured on the far side"),
    when([c("farPostSpace", "<", 0.45)], -0.3, "the far-post space is crowded"),
  ]),
  shape: action("hold_position", "Hold position", "hold_position", 0.3, [
    when([c("theirPossession", "==", 1)], 0.1, "shape first when they have the ball"),
    when([c("carrierPressure", ">", 0.7)], -0.2, "your teammate needed help"),
  ]),
  press: action("press", "Press the carrier", "press", 0.4, [
    when([c("carrierDist", "<", 8)], 0.3, "you can reach them"),
    when([c("teammatePressing", "==", 1)], -0.4, "a teammate is already on them"),
    when([c("firstDefender", "==", 1)], 0.3, "you are the first defender"),
    when([c("carrierDistToOurGoal", "<", 20)], 0.2, "they are close to our goal"),
  ]),
  delay: action("delay", "Delay, stay goal-side", "delay", 0.35, [
    when([c("firstDefender", "==", 1)], 0.2, "you are the nearest defender"),
    when([c("oppRunnerNear", "==", 1)], 0.3, "runners behind you: slow them, do not dive in"),
    when([c("carrierDist", "<", 4)], 0.2, "close enough to slow them down"),
    when([c("secondDefender", "==", 1)], -0.2, "someone else is first: your job is cover"),
  ]),
  cover: action("cover", "Cover behind the presser", "cover", 0.35, [
    when([c("secondDefender", "==", 1)], 0.4, "you are second: cover the presser"),
    when([c("teammatePressing", "==", 1)], 0.3, "a teammate is pressing"),
    when([c("firstDefender", "==", 1)], -0.4, "you were nearest: someone must press"),
  ]),
  track: action("track_runner", "Track the runner", "track_runner", 0.35, [
    when([c("oppRunnerNear", "==", 1)], 0.6, "a runner is going past you"),
    when([c("firstDefender", "==", 1)], -0.2, "you were needed on the carrier"),
  ]),
  screen: action("screen_lane", "Screen the passing lane", "screen_lane", 0.3, [
    when([c("teammatePressing", "==", 1)], 0.4, "the carrier is pressed: cut the outlet"),
    when([c("carrierDist", "<", 5)], -0.2, "you were close enough to press yourself"),
  ]),
  drop: action("drop", "Drop off", "drop", 0.25, [
    when([c("oppRunnerNear", "==", 1)], 0.3, "runners threaten the space behind"),
    when([c("ballInOurBox", "==", 1)], 0.2, "protect the goal first"),
    when([c("carrierDistToOurGoal", ">", 35)], -0.2, "too deep too early"),
  ]),
  communicate: action("communicate", "Communicate and hand off", "communicate", 0.2, [
    when([c("teammatePressing", "==", 1)], 0.2, "a teammate has the carrier, organise around them"),
    when([c("firstDefender", "==", 1)], -0.3, "you were the closest: act, then talk"),
  ]),
  sweep: action("keeper_sweep", "Come and claim", "keeper_sweep", 0.4, [
    when([c("keeperCanSweep", "==", 1)], 0.6, "you reach it before any attacker"),
    when([c("keeperCanSweep", "==", 0)], -0.6, "an attacker gets there first: stay"),
  ]),
  line: action("keeper_hold_line", "Stay set", "keeper_hold_line", 0.35, [
    when([c("keeperCanSweep", "==", 0)], 0.3, "the ball is not yours to claim"),
    when([c("keeperCanSweep", "==", 1)], -0.2, "the ball was there to be claimed"),
  ]),
  short: action("keeper_short", "Build short", "keeper_distribute_short", 0.4, [
    when([c("nearestOppDist", ">", 12)], 0.3, "no press: build from the back"),
    when([c("openLanes", ">=", 2)], 0.3, "short options are open"),
    when([c("openLanes", "<=", 1)], -0.3, "short options are covered"),
  ]),
  long: action("keeper_long", "Go long", "keeper_distribute_long", 0.3, [
    when([c("openLanes", "<=", 1)], 0.4, "short options are covered"),
    when([c("spaceBehindLine", ">", 15)], 0.2, "space behind their line"),
    when([c("nearestOppDist", ">", 12)], -0.2, "no press: a long ball gives possession away"),
  ]),
  skipLines: action("keeper_skip_lines", "Skip the press: find the far midfielder", "keeper_distribute_long", 0.35, [
    when([c("openLanes", "<=", 1), c("nearestOppDist", "<", 12)], 0.4, "they press high and the short lanes are shut: play over them"),
    when([c("spaceBehindLine", "<", 10)], -0.2, "their line is deep: the long ball lands in a crowd"),
  ]),
  outlet: action("keeper_outlet", "Offer the outlet", "support_underneath", 0.35, [
    when([c("carrierPressure", ">", 0.6)], 0.5, "the carrier is pressed: they need you as the free player"),
    when([c("carrierPressure", "<", 0.3)], -0.2, "the carrier has time: stay home and keep the goal covered"),
    when([c("teammateCarrierDist", ">", 30)], -0.3, "too far from the ball to be a real option"),
  ]),
  organise: action("keeper_organise", "Organise the line", "communicate", 0.3, [
    when([c("teammatePressing", "==", 0), c("theirPossession", "==", 1)], 0.4, "nobody is on the carrier: tell the line who goes"),
    when([c("oppRunnerNear", "==", 1)], 0.2, "a runner is behind the line: call it early"),
    when([c("carrierDistToOurGoal", "<", 16)], -0.4, "too late to talk: the shot is coming"),
    when([c("ourPossession", "==", 1), c("carrierPressure", ">", 0.6)], -0.2, "your teammate needed an outlet, not instructions"),
  ]),
  stepUp: action("keeper_step_up", "Start high, sweep behind the line", "keeper_step_up", 0.3, [
    when([c("ourLineDepth", ">", 22)], 0.4, "your line is high: the space behind is yours to cover"),
    when([c("ballProgress", ">", 0.6)], 0.2, "the ball is far away: you have time to get back"),
    when([c("ourLineDepth", "<", 14)], -0.4, "the line is deep: there is no space behind it to sweep"),
    when([c("carrierDistToOurGoal", "<", 22)], -0.5, "they are already close: coming out opens the goal"),
  ]),
  setLine: action("keeper_set", "Stay set, goal covered", "keeper_hold_line", 0.35, [
    when([c("carrierDistToOurGoal", "<", 22)], 0.3, "a shot can come any moment: be set"),
    when([c("oppRunnerNear", "==", 1)], 0.2, "a runner is going behind: be ready for the ball in"),
    when([c("ourLineDepth", ">", 22), c("carrierDistToOurGoal", ">", 30)], -0.3, "the line is high and the ball is far: you could start higher"),
    when([c("carrierPressure", ">", 0.6), c("ourPossession", "==", 1)], -0.2, "your teammate needed an outlet"),
  ]),
  nearPost: action("keeper_near_post", "Protect the near post", "keeper_near_post", 0.3, [
    when([c("ballWide", ">", 0.7), c("carrierDistToOurGoal", "<", 18)], 0.5, "the ball is wide and close: the near post is the first shot"),
    when([c("ballWide", "<", 0.6)], -0.4, "the ball is central: leaving the middle opens the far side"),
    when([c("carrierDistToOurGoal", ">", 22)], -0.3, "too early: a cross from there needs you central"),
  ]),
  comeOut: action("keeper_come_out", "Come out and close them down", "press", 0.35, [
    when([c("carrierDist", "<", 9)], 0.4, "close enough to smother before they set the shot"),
    when([c("teammatePressing", "==", 1)], -0.4, "a defender is on them: stay big on your line"),
    when([c("carrierDist", ">", 12)], -0.4, "too far: you would be stranded halfway"),
  ]),
  stayBig: action("keeper_stay_big", "Stay big, make them beat you", "keeper_hold_line", 0.35, [
    when([c("teammatePressing", "==", 1)], 0.4, "a defender is delaying them: hold and be set"),
    when([c("carrierDist", ">", 10)], 0.2, "they are not close enough to smother"),
    when([c("carrierDist", "<", 7), c("teammatePressing", "==", 0)], -0.3, "they are alone and close: standing still gives them the angle"),
  ]),
  narrow: action("keeper_narrow", "Narrow the angle, stay up", "delay", 0.3, [
    when([c("carrierDist", ">=", 7), c("carrierDist", "<=", 12)], 0.4, "mid range: take a step out and take the angle away"),
    when([c("oppRunnerNear", "==", 1)], -0.3, "a runner is square: leaving the line opens the pass"),
  ]),
};

// ---------------------------------------------------------------- entry helper
interface Draft {
  id: string;
  role: RoleId;
  mirrorOf?: string;
  category: MomentCategory;
  phase: PhaseOfPlay;
  title: string;
  trigger: Trigger;
  cues: string[];
  actions: CatalogAction[];
  mistakes: string[];
  difficultyFactors: string[];
  continuation: string;
  positive: Partial<FieldRead>;
  negative: Partial<FieldRead>;
  requiresOffside?: boolean;
}

function entry(d: Draft): CatalogEntry {
  const e: CatalogEntry = {
    id: d.id,
    role: d.role,
    category: d.category,
    phase: d.phase,
    title: d.title,
    trigger: d.trigger,
    cues: d.cues,
    actions: d.actions,
    mistakes: d.mistakes,
    difficultyFactors: d.difficultyFactors,
    restrictions: { ageGroups: ["U11", "U12"] },
    continuation: d.continuation,
    tests: {
      positive: [{ label: "typical", read: d.positive }],
      negative: [{ label: "not eligible", read: d.negative }],
    },
    review: { status: "provisional", note: "Prototype content, not coach-reviewed." },
  };
  if (d.mirrorOf !== undefined) e.mirrorOf = d.mirrorOf;
  if (d.requiresOffside !== undefined) e.restrictions.requiresOffside = d.requiresOffside;
  return e;
}

const ON = [c("hasBall", "==", 1)];
const OFF = [c("ourPossession", "==", 1), c("hasBall", "==", 0), c("receiving", "==", 0)];
const DEF = [c("theirPossession", "==", 1)];

const entries: CatalogEntry[] = [];

// ---------------------------------------------------------------- goalkeeper
entries.push(
  entry({
    id: "GK_BUILD_01", role: "GK", category: "on_ball", phase: "build_up", title: "Distribution with time",
    trigger: { all: [...ON, c("nearestOppDist", ">=", 12)] },
    cues: ["Where are their forwards standing?", "Which full back is free?", "Is there space behind their line?"],
    actions: [A.short, A.long, A.switch, A.hold],
    mistakes: ["Kicking long every time regardless of the press", "Playing short into a covered full back"],
    difficultyFactors: ["Number of free short options", "Depth of their line"],
    continuation: "Team builds from the back or contests a long ball.",
    positive: { hasBall: 1, nearestOppDist: 20 }, negative: { hasBall: 1, nearestOppDist: 6 },
  }),
  entry({
    id: "GK_BUILD_02", role: "GK", category: "on_ball", phase: "build_up", title: "Play through the press",
    trigger: { all: [...ON, c("nearestOppDist", "<", 12), c("openLanes", ">=", 2)] },
    cues: ["Who is pressing and from where?", "Which short lane is still open?", "Is the long option worth the risk?"],
    actions: [A.short, A.long, A.switch, A.hold],
    mistakes: ["Forcing a short pass into the presser's path", "Holding until the presser arrives"],
    difficultyFactors: ["Speed of the press", "Open lanes remaining"],
    continuation: "Possession kept short, contested long, or lost near goal.",
    positive: { hasBall: 1, nearestOppDist: 7, openLanes: 2 }, negative: { hasBall: 1, nearestOppDist: 15, openLanes: 2 },
  }),
  entry({
    id: "GK_BUILD_03", role: "GK", category: "on_ball", phase: "build_up", title: "Pressed with the short lanes shut",
    trigger: { all: [...ON, c("nearestOppDist", "<", 12), c("openLanes", "<=", 1)] },
    cues: ["Are the full backs marked?", "Who is free two lines up?", "Is a switch to the far side on?"],
    actions: [A.skipLines, A.switch, A.short, A.hold],
    mistakes: ["Forcing the ball into a marked full back", "Hoofing it aimlessly when a far-side midfielder is free"],
    difficultyFactors: ["Distance to the presser", "Depth of their line"],
    continuation: "Press skipped into midfield, or the ball is contested or lost.",
    positive: { hasBall: 1, nearestOppDist: 7, openLanes: 0 }, negative: { hasBall: 1, nearestOppDist: 7, openLanes: 3 },
  }),
  entry({
    id: "GK_TRANS_01", role: "GK", category: "transition", phase: "transition", title: "Ball just claimed: restart the attack",
    trigger: { all: [...ON, c("secondsSinceTurnover", "<", 4), c("spaceBehindLine", ">", 20), c("nearestOppDist", ">=", 6)] },
    cues: ["Are they still pushed up?", "Which teammate is already facing forward?", "Is quick better than safe right now?"],
    actions: [A.long, A.short, A.switch, A.hold],
    mistakes: ["Slowing the game down when they are stretched", "Kicking it straight back to them"],
    difficultyFactors: ["Opponent recovery speed", "Space behind their line"],
    continuation: "Counter launched, possession settled, or the ball given straight back.",
    positive: { hasBall: 1, secondsSinceTurnover: 1, spaceBehindLine: 26, nearestOppDist: 10 }, negative: { hasBall: 1, secondsSinceTurnover: 1, spaceBehindLine: 12, nearestOppDist: 10 },
  }),
  entry({
    id: "GK_POS_01", role: "GK", category: "off_ball", phase: "build_up", title: "Team building in front of you",
    trigger: { all: [...OFF, c("ballProgress", "<", 0.5), c("teammateCarrierDist", "<", 35), c("secondsSinceTurnover", ">=", 5)] },
    cues: ["Is the carrier under pressure?", "Can they see you as the free player?", "Where is their striker standing?"],
    actions: [A.outlet, A.setLine, A.organise],
    mistakes: ["Hiding behind the striker when the carrier is pressed", "Wandering off the line while the ball is still in our half"],
    difficultyFactors: ["Carrier pressure", "Striker position"],
    continuation: "Back pass used, team progresses, or the ball is lost near your goal.",
    positive: { ourPossession: 1, ballProgress: 0.3, teammateCarrierDist: 20, secondsSinceTurnover: 30 },
    negative: { ourPossession: 1, ballProgress: 0.7, teammateCarrierDist: 20, secondsSinceTurnover: 30 },
  }),
  entry({
    id: "GK_POS_02", role: "GK", category: "off_ball", phase: "progression", title: "Team attacking: pick your starting position",
    trigger: { all: [...OFF, c("ballProgress", ">=", 0.5), c("secondsSinceTurnover", ">=", 5)] },
    cues: ["How high is your back line?", "How much space is behind it?", "Who is their quickest forward?"],
    actions: [A.stepUp, A.setLine, A.organise],
    mistakes: ["Standing on the line with the defence at halfway", "Coming so far out a long ball beats you"],
    difficultyFactors: ["Height of the back line", "Distance of the ball"],
    continuation: "Attack continues, or the ball turns over and your start position decides the counter.",
    positive: { ourPossession: 1, ballProgress: 0.7, ourLineDepth: 28, secondsSinceTurnover: 30 },
    negative: { ourPossession: 1, ballProgress: 0.3, ourLineDepth: 28, secondsSinceTurnover: 30 },
  }),
  entry({
    id: "GK_LINE_01", role: "GK", category: "defending", phase: "defending", title: "They have it in midfield",
    trigger: { all: [...DEF, c("carrierDistToOurGoal", ">=", 22), c("carrierDistToOurGoal", "<", 45), c("secondsSinceTurnover", ">=", 5)] },
    cues: ["Is anyone pressing the carrier?", "Is a runner going behind your line?", "How much space is between the line and you?"],
    actions: [A.organise, A.stepUp, A.setLine],
    mistakes: ["Silent while the line is disorganised", "Retreating to the line when the space behind the defence is yours"],
    difficultyFactors: ["Runner presence", "Line height"],
    continuation: "Attack slowed, ball in behind swept, or the carrier progresses.",
    positive: { theirPossession: 1, carrierDistToOurGoal: 32, secondsSinceTurnover: 30 },
    negative: { theirPossession: 1, carrierDistToOurGoal: 15, secondsSinceTurnover: 30 },
  }),
  entry({
    id: "GK_CROSS_01", role: "GK", category: "defending", phase: "defending", title: "Ball wide near your box",
    trigger: { all: [...DEF, c("carrierDistToOurGoal", "<", 30), c("ballWide", ">", 0.55)] },
    cues: ["Can they shoot from there or only cross?", "Who is at your far post?", "Is your defender showing them outside?"],
    actions: [A.nearPost, A.setLine, A.organise],
    mistakes: ["Hugging the near post for a ball that is going to be crossed", "Standing central when the shot from the angle is on"],
    difficultyFactors: ["Angle of the ball", "Distance to goal"],
    continuation: "Shot from the angle, cross delivered, or the ball is delayed.",
    positive: { theirPossession: 1, carrierDistToOurGoal: 16, ballWide: 0.8 },
    negative: { theirPossession: 1, carrierDistToOurGoal: 16, ballWide: 0.2 },
  }),
  entry({
    id: "GK_1V1_01", role: "GK", category: "defending", phase: "defending", title: "One against one",
    trigger: { all: [...DEF, c("carrierDistToOurGoal", "<", 16), c("teammatePressing", "==", 0), c("ballWide", "<=", 0.55)] },
    cues: ["How far away are they?", "Are they looking at the ball or at you?", "Is a defender recovering?"],
    actions: [A.comeOut, A.stayBig, A.narrow],
    mistakes: ["Diving in early and being rounded", "Staying rooted while they walk it closer"],
    difficultyFactors: ["Carrier distance", "Recovering defenders"],
    continuation: "Ball smothered, shot faced, or the attacker goes past.",
    positive: { theirPossession: 1, carrierDistToOurGoal: 10, carrierDist: 8, teammatePressing: 0, ballWide: 0.2 },
    negative: { theirPossession: 1, carrierDistToOurGoal: 10, carrierDist: 8, teammatePressing: 1, ballWide: 0.2 },
  }),
  entry({
    id: "GK_TRANS_02", role: "GK", category: "transition", phase: "transition", title: "Ball lost upfield: reset your start",
    trigger: { all: [...DEF, c("secondsSinceTurnover", "<", 5), c("carrierDistToOurGoal", ">", 25), c("ourLineDepth", ">", 18)] },
    cues: ["Is your line still high?", "Where is their quickest forward?", "Who is recovering?"],
    actions: [A.stepUp, A.setLine, A.organise],
    mistakes: ["Dropping to the line and leaving 20 metres in front of you", "Freezing while the defence sprints back"],
    difficultyFactors: ["Line height at the turnover", "Counter speed"],
    continuation: "Counter swept up, delayed, or a ball in behind arrives.",
    positive: { theirPossession: 1, secondsSinceTurnover: 2, carrierDistToOurGoal: 40, ourLineDepth: 30 },
    negative: { theirPossession: 1, secondsSinceTurnover: 2, carrierDistToOurGoal: 40, ourLineDepth: 12 },
  }),
  entry({
    id: "GK_SWEEP_01", role: "GK", category: "defending", phase: "defending", title: "Ball played in behind",
    trigger: { all: [c("looseBall", "==", 1), c("ballInOurBox", "==", 1), c("hasBall", "==", 0), c("receiving", "==", 0)] },
    cues: ["Who reaches the ball first?", "Where is the nearest attacker?", "Can a defender clear instead?"],
    actions: [A.sweep, A.line],
    mistakes: ["Coming late and getting stranded", "Staying rooted when the ball is yours"],
    difficultyFactors: ["Arrival-time margin", "Attacker proximity"],
    continuation: "Keeper claims, defender clears, or attacker reaches it first.",
    positive: { looseBall: 1, ballInOurBox: 1 }, negative: { looseBall: 1, ballInOurBox: 0 },
  }),
  entry({
    id: "GK_SHOT_01", role: "GK", category: "defending", phase: "defending", title: "Attacker closing on goal, defender on them",
    trigger: { all: [...DEF, c("carrierDistToOurGoal", "<", 22), c("teammatePressing", "==", 1)] },
    cues: ["Is the shot angle open?", "Is the defender delaying them or diving in?", "Can you narrow the angle safely?"],
    actions: [A.line, A.press, A.communicate],
    mistakes: ["Rushing out and opening the far post", "Standing still with no defender delaying"],
    difficultyFactors: ["Carrier speed", "Cover available"],
    continuation: "Shot, block, or the carrier is delayed.",
    positive: { theirPossession: 1, carrierDistToOurGoal: 15, carrierDist: 10, teammatePressing: 1 }, negative: { theirPossession: 1, carrierDistToOurGoal: 40 },
  }),
  entry({
    id: "GK_RECV_01", role: "GK", category: "on_ball", phase: "build_up", title: "Back pass under pressure",
    trigger: { all: [c("receiving", "==", 1)] },
    cues: ["Which side is the presser coming from?", "Where is your free defender?"],
    actions: [A.touchSafe, A.touchForward],
    mistakes: ["Touching toward the presser", "Taking too many touches"],
    difficultyFactors: ["Pressure at receipt", "Pass quality"],
    continuation: "Keeper controls and distributes or is pressed into an error.",
    positive: { receiving: 1 }, negative: { receiving: 0, hasBall: 1 },
  }),
);

// ---------------------------------------------------------------- centre back
entries.push(
  entry({
    id: "CB_BUILD_01", role: "CB", category: "on_ball", phase: "build_up", title: "On the ball with time in build-up",
    trigger: { all: [...ON, c("progress", "<", 0.45), c("pressure", "<", 0.5)] },
    cues: ["Which midfielder is between the lines?", "Is the far side open?", "Can you carry into midfield?"],
    actions: [A.gap, A.space, A.switch, A.recycle],
    mistakes: ["Passing sideways when a forward lane is open", "Carrying into a crowd"],
    difficultyFactors: ["Number of open lanes", "Distance to the nearest presser"],
    continuation: "Team progresses through midfield or resets.",
    positive: { hasBall: 1, progress: 0.3, pressure: 0.2 }, negative: { hasBall: 1, progress: 0.3, pressure: 0.8 },
  }),
  entry({
    id: "CB_BUILD_02", role: "CB", category: "on_ball", phase: "build_up", title: "Pressed in your own half",
    trigger: { all: [...ON, c("progress", "<", 0.5), c("pressure", ">=", 0.5)] },
    cues: ["Where is the pressure coming from?", "Who is the safe outlet?", "Is there a gap behind the presser?"],
    actions: [A.recycle, A.gap, A.space, A.switch, A.hold],
    mistakes: ["Dribbling out of pressure near your own goal", "Holding until the tackle"],
    difficultyFactors: ["Pressure", "Time to decide"],
    continuation: "Pressure escaped or turnover near goal.",
    positive: { hasBall: 1, progress: 0.3, pressure: 0.8 }, negative: { hasBall: 1, progress: 0.3, pressure: 0.2 },
  }),
  entry({
    id: "CB_DEF_01", role: "CB", category: "defending", phase: "defending", title: "Runner attacking the space behind",
    trigger: { all: [...DEF, c("oppRunnerNear", "==", 1), c("firstDefender", "==", 0)] },
    cues: ["Where is the runner going?", "Who is pressing the carrier?", "Is the line holding?"],
    actions: [A.track, A.drop, A.press],
    mistakes: ["Stepping to the ball and releasing the runner", "Dropping so deep the carrier walks forward"],
    difficultyFactors: ["Runner speed", "Distance to the carrier"],
    continuation: "Runner tracked, ball played in behind, or attack slowed.",
    positive: { theirPossession: 1, oppRunnerNear: 1, firstDefender: 0 }, negative: { theirPossession: 1, oppRunnerNear: 0 },
  }),
  entry({
    id: "CB_DEF_02", role: "CB", category: "defending", phase: "defending", title: "Carrier running at you",
    trigger: { all: [...DEF, c("firstDefender", "==", 1), c("carrierDist", "<", 12)] },
    cues: ["Is there cover behind you?", "How fast are they moving?", "Which side do you want to send them?"],
    actions: [A.press, A.delay, A.communicate],
    mistakes: ["Diving in without cover", "Backing off into the box"],
    difficultyFactors: ["Cover available", "Carrier speed and space"],
    continuation: "Tackle, delay until cover, or the carrier goes past.",
    positive: { theirPossession: 1, firstDefender: 1, carrierDist: 8 }, negative: { theirPossession: 1, firstDefender: 0, carrierDist: 8 },
  }),
  entry({
    id: "CB_DEF_03", role: "CB", category: "defending", phase: "defending", title: "Cover the presser",
    trigger: { all: [...DEF, c("secondDefender", "==", 1), c("carrierDistToOurGoal", "<", 40)] },
    cues: ["Who is pressing?", "Where would the carrier go if they beat them?", "Any runner behind you?"],
    actions: [A.cover, A.press, A.track],
    mistakes: ["Both defenders pressing the same player", "Standing level with the presser"],
    difficultyFactors: ["Runner presence", "Presser distance"],
    continuation: "Presser beaten into cover, or ball won.",
    positive: { theirPossession: 1, secondDefender: 1, carrierDistToOurGoal: 30 }, negative: { theirPossession: 1, secondDefender: 0 },
  }),
  entry({
    id: "CB_OFF_01", role: "CB", category: "off_ball", phase: "build_up", title: "Support the build-up",
    trigger: { all: [...OFF, c("ballProgress", "<", 0.5), c("teammateCarrierDist", "<", 25)] },
    cues: ["Can the carrier see you?", "Is a forward pass on for them?", "Where is their striker?"],
    actions: [A.underneath, A.shape, A.runBehind],
    mistakes: ["Hiding behind their striker", "Pushing up and leaving the keeper without an outlet"],
    difficultyFactors: ["Carrier pressure", "Striker position"],
    continuation: "Outlet used or team progresses without you.",
    positive: { ourPossession: 1, ballProgress: 0.3, teammateCarrierDist: 15 }, negative: { ourPossession: 1, ballProgress: 0.7, teammateCarrierDist: 15 },
  }),
  entry({
    id: "CB_TRANS_01", role: "CB", category: "transition", phase: "transition", title: "Just won it back",
    trigger: { all: [...ON, c("secondsSinceTurnover", "<", 3)] },
    cues: ["Are they disorganised?", "Who is free immediately?", "Is the safe pass better than the quick one?"],
    actions: [A.gap, A.recycle, A.space, A.switch, A.hold],
    mistakes: ["Kicking it away straight back to them", "Slowing down when they are open"],
    difficultyFactors: ["Opponent recovery speed", "Immediate options"],
    continuation: "Counter started or possession settled.",
    positive: { hasBall: 1, secondsSinceTurnover: 1 }, negative: { hasBall: 1, secondsSinceTurnover: 20 },
  }),
);

// ---------------------------------------------------------------- full backs (RB authored, LB mirrored)
function fullBack(role: RoleId, mirror: RoleId | null): CatalogEntry[] {
  const m = (id: string): string | undefined => (mirror ? id.replace(role, mirror) : undefined);
  const mk = (d: Draft): CatalogEntry => {
    const mid = m(d.id);
    return entry(mid ? { ...d, mirrorOf: mid } : d);
  };
  return [
    mk({
      id: `${role}_RECV_01`, role, category: "on_ball", phase: "build_up", title: "Receiving wide",
      trigger: { all: [c("receiving", "==", 1)] },
      cues: ["Is the winger ahead free?", "Where is the presser?", "Can you turn forward?"],
      actions: [A.touchForward, A.touchSafe],
      mistakes: ["Turning blind into the presser", "Safe touch when the touchline is wide open"],
      difficultyFactors: ["Pressure at receipt", "Space ahead"],
      continuation: "Full back turns forward or protects the ball.",
      positive: { receiving: 1 }, negative: { receiving: 0, hasBall: 1 },
    }),
    mk({
      id: `${role}_ON_01`, role, category: "on_ball", phase: "progression", title: "On the ball on the flank",
      trigger: { all: [...ON, c("progress", ">=", 0.3), c("receiving", "==", 0)] },
      cues: ["Is the winger ahead or inside?", "Is the far side open?", "Where is the nearest defender?"],
      actions: [A.space, A.gap, A.switch, A.recycle, A.draw],
      mistakes: ["Always the same pass down the line", "Ignoring an open switch"],
      difficultyFactors: ["Open lanes", "Far-side space", "Pressure"],
      continuation: "Attack progresses wide, switches, or resets.",
      positive: { hasBall: 1, progress: 0.5 }, negative: { hasBall: 1, progress: 0.2 },
    }),
    mk({
      id: `${role}_OFF_01`, role, category: "off_ball", phase: "progression", title: "Winger has the ball on your side",
      trigger: { all: [...OFF, c("ballOnMyFlank", "==", 1), c("ballProgress", ">", 0.5), c("teammateCarrierDist", "<", 20)] },
      cues: ["Is the outside lane free?", "Is the winger pressed?", "Who covers if you go?"],
      actions: [A.overlap, A.underneath, A.shape],
      mistakes: ["Overlapping into a covered lane", "Staying back while the winger is isolated"],
      difficultyFactors: ["Wide lane space", "Carrier pressure"],
      continuation: "Overlap used, support used, or shape kept.",
      positive: { ourPossession: 1, ballOnMyFlank: 1, ballProgress: 0.6, teammateCarrierDist: 10 }, negative: { ourPossession: 1, ballOnMyFlank: 0, ballProgress: 0.6, teammateCarrierDist: 10 },
    }),
    mk({
      id: `${role}_DEF_01`, role, category: "defending", phase: "defending", title: "Winger running at you",
      trigger: { all: [...DEF, c("firstDefender", "==", 1), c("carrierDist", "<", 10)] },
      cues: ["Is there cover inside?", "Are they faster than you?", "Which way do you show them?"],
      actions: [A.press, A.delay, A.cover],
      mistakes: ["Diving in and getting beaten outside", "Backing off to the byline"],
      difficultyFactors: ["Cover", "Carrier speed"],
      continuation: "Tackle, delay, or cross conceded.",
      positive: { theirPossession: 1, firstDefender: 1, carrierDist: 6 }, negative: { theirPossession: 1, firstDefender: 0, carrierDist: 6 },
    }),
    mk({
      id: `${role}_DEF_02`, role, category: "defending", phase: "defending", title: "Ball on the far side, runner near you",
      trigger: { all: [...DEF, c("ballOnMyFlank", "==", 0), c("oppRunnerNear", "==", 1)] },
      cues: ["Where is the far-side winger?", "Can a cross reach them?", "Is your line level?"],
      actions: [A.track, A.drop, A.shape],
      mistakes: ["Watching the ball and losing the runner", "Tucking in too far and leaving the winger free"],
      difficultyFactors: ["Runner timing", "Distance to the ball"],
      continuation: "Runner tracked or switch finds them.",
      positive: { theirPossession: 1, ballOnMyFlank: 0, oppRunnerNear: 1 }, negative: { theirPossession: 1, ballOnMyFlank: 1, oppRunnerNear: 1 },
    }),
    mk({
      id: `${role}_TRANS_01`, role, category: "transition", phase: "transition", title: "Ball lost on your flank",
      trigger: { all: [...DEF, c("secondsSinceTurnover", "<", 3), c("ballOnMyFlank", "==", 1), c("carrierDist", "<", 15)] },
      cues: ["Can you press before they settle?", "Who is behind you?", "Is a runner already going?"],
      actions: [A.press, A.delay, A.drop],
      mistakes: ["Sprinting at the carrier with nobody behind", "Retreating and giving a free run"],
      difficultyFactors: ["Cover", "Carrier composure"],
      continuation: "Counter-press wins it or recovery run.",
      positive: { theirPossession: 1, secondsSinceTurnover: 1, ballOnMyFlank: 1, carrierDist: 8 }, negative: { theirPossession: 1, secondsSinceTurnover: 30, ballOnMyFlank: 1, carrierDist: 8 },
    }),
  ];
}
entries.push(...fullBack("RB", null), ...fullBack("LB", "RB"));

// ---------------------------------------------------------------- defensive midfielder
entries.push(
  entry({
    id: "DM_ON_01", role: "DM", category: "on_ball", phase: "progression", title: "On the ball in midfield with time",
    trigger: { all: [...ON, c("progress", ">=", 0.3), c("progress", "<=", 0.7), c("pressure", "<", 0.5)] },
    cues: ["Which forward is between the lines?", "Is the far side open?", "Can you carry into the gap?"],
    actions: [A.gap, A.switch, A.space, A.recycle],
    mistakes: ["Slow sideways passes when a forward is free", "Carrying into traffic"],
    difficultyFactors: ["Open lanes", "Far-side space"],
    continuation: "Team progresses or switches.",
    positive: { hasBall: 1, progress: 0.5, pressure: 0.1 }, negative: { hasBall: 1, progress: 0.5, pressure: 0.9 },
  }),
  entry({
    id: "DM_ON_02", role: "DM", category: "on_ball", phase: "progression", title: "Pressed in midfield",
    trigger: { all: [...ON, c("pressure", ">=", 0.5)] },
    cues: ["Which side is free?", "Who is the safe outlet?", "Is there a gap behind the presser?"],
    actions: [A.recycle, A.gap, A.switch, A.hold, A.space],
    mistakes: ["Turning into the presser", "Holding too long"],
    difficultyFactors: ["Pressure", "Time"],
    continuation: "Pressure escaped or ball lost centrally.",
    positive: { hasBall: 1, pressure: 0.8 }, negative: { hasBall: 1, pressure: 0.2 },
  }),
  entry({
    id: "DM_RECV_01", role: "DM", category: "on_ball", phase: "build_up", title: "Receiving with your back to play",
    trigger: { all: [c("receiving", "==", 1)] },
    cues: ["Did you scan before the ball arrived?", "Is the presser behind you?", "Which way is open?"],
    actions: [A.touchForward, A.touchSafe],
    mistakes: ["Turning blind", "Always playing it back"],
    difficultyFactors: ["Pressure from behind", "Space ahead"],
    continuation: "Turn forward or protect and recycle.",
    positive: { receiving: 1 }, negative: { receiving: 0 },
  }),
  entry({
    id: "DM_OFF_01", role: "DM", category: "off_ball", phase: "progression", title: "Carrier is pressed, offer support",
    trigger: { all: [...OFF, c("carrierPressure", ">", 0.5), c("teammateCarrierDist", "<", 20)] },
    cues: ["Which angle can the carrier see?", "Is the forward option better?", "Who covers if you go?"],
    actions: [A.underneath, A.shape, A.runBehind],
    mistakes: ["Standing behind a defender", "Running away from a pressed carrier"],
    difficultyFactors: ["Carrier pressure", "Angle available"],
    continuation: "Outlet used or carrier finds another option.",
    positive: { ourPossession: 1, carrierPressure: 0.7, teammateCarrierDist: 10 }, negative: { ourPossession: 1, carrierPressure: 0.1, teammateCarrierDist: 10 },
  }),
  entry({
    id: "DM_DEF_01", role: "DM", category: "defending", phase: "defending", title: "Screen in front of the defence",
    trigger: { all: [...DEF, c("carrierDist", ">=", 5), c("carrierDist", "<", 20), c("teammatePressing", "==", 1)] },
    cues: ["Which pass hurts most?", "Who is pressing?", "Is a runner going past you?"],
    actions: [A.screen, A.cover, A.press],
    mistakes: ["Chasing the ball and opening the middle", "Screening a harmless lane"],
    difficultyFactors: ["Number of dangerous receivers", "Presser distance"],
    continuation: "Lane cut, cover provided, or ball played through.",
    positive: { theirPossession: 1, carrierDist: 10, teammatePressing: 1 }, negative: { theirPossession: 1, carrierDist: 10, teammatePressing: 0 },
  }),
  entry({
    id: "DM_TRANS_01", role: "DM", category: "transition", phase: "transition", title: "Turnover in midfield",
    trigger: { all: [...DEF, c("secondsSinceTurnover", "<", 3), c("carrierDist", "<", 15)] },
    cues: ["Can you win it back immediately?", "Who is behind you?", "Is the carrier facing you?"],
    actions: [A.press, A.delay, A.drop],
    mistakes: ["Everyone chasing", "Nobody pressing"],
    difficultyFactors: ["Cover", "Carrier orientation"],
    continuation: "Counter-press or recovery shape.",
    positive: { theirPossession: 1, secondsSinceTurnover: 1, carrierDist: 8 }, negative: { theirPossession: 1, secondsSinceTurnover: 30, carrierDist: 8 },
  }),
);

// ---------------------------------------------------------------- central midfielder
entries.push(
  entry({
    id: "CM_ON_01", role: "CM", category: "on_ball", phase: "progression", title: "On the ball between the lines",
    trigger: { all: [...ON, c("progress", ">", 0.45), c("pressure", "<", 0.6)] },
    cues: ["Is the striker moving?", "Is a winger free far side?", "Is a defender stepping to you?"],
    actions: [A.gap, A.space, A.draw, A.switch, A.recycle, A.shoot],
    mistakes: ["Rushing the pass before the run develops", "Not shooting when the lane opens"],
    difficultyFactors: ["Runner timing", "Shot window", "Lanes"],
    continuation: "Chance created, switch, or possession kept.",
    positive: { hasBall: 1, progress: 0.6, pressure: 0.2 }, negative: { hasBall: 1, progress: 0.6, pressure: 0.9 },
  }),
  entry({
    id: "CM_ON_02", role: "CM", category: "on_ball", phase: "progression", title: "Pressed in possession",
    trigger: { all: [...ON, c("pressure", ">=", 0.6)] },
    cues: ["Where is the free teammate?", "Is there a gap behind the presser?", "Is the spare player on the far side?"],
    actions: [A.recycle, A.gap, A.switch, A.hold, A.space],
    mistakes: ["Turning into pressure", "Forcing a pass through bodies"],
    difficultyFactors: ["Pressure", "Time"],
    continuation: "Pressure escaped or turnover.",
    positive: { hasBall: 1, pressure: 0.8 }, negative: { hasBall: 1, pressure: 0.2 },
  }),
  entry({
    id: "CM_RECV_01", role: "CM", category: "on_ball", phase: "progression", title: "Receiving in midfield",
    trigger: { all: [c("receiving", "==", 1)] },
    cues: ["Scan: who is behind you?", "Which side is open?"],
    actions: [A.touchForward, A.touchSafe],
    mistakes: ["Stopping the ball dead under pressure", "Touching into the presser"],
    difficultyFactors: ["Pressure", "Pass speed"],
    continuation: "Turn forward or protect.",
    positive: { receiving: 1 }, negative: { receiving: 0 },
  }),
  entry({
    id: "CM_OFF_01", role: "CM", category: "off_ball", phase: "progression", title: "Third-player support",
    trigger: { all: [...OFF, c("teammateCarrierDist", "<", 18)] },
    cues: ["Is the carrier pressed?", "Is there room behind their line?", "Which angle is open?"],
    actions: [A.underneath, A.runBehind, A.shape],
    mistakes: ["Standing in a defender's shadow", "Running offside"],
    difficultyFactors: ["Carrier pressure", "Space behind"],
    continuation: "Combination, run behind, or shape.",
    positive: { ourPossession: 1, teammateCarrierDist: 10 }, negative: { ourPossession: 1, teammateCarrierDist: 30 },
  }),
  entry({
    id: "CM_DEF_01", role: "CM", category: "defending", phase: "defending", title: "Press or hold",
    trigger: { all: [...DEF, c("carrierDist", "<", 12), c("firstDefender", "==", 1)] },
    cues: ["Is the carrier facing you?", "Who covers behind?", "Which lane would they use?"],
    actions: [A.press, A.delay, A.screen],
    mistakes: ["Pressing with the lane behind wide open", "Standing off a carrier who has time"],
    difficultyFactors: ["Cover", "Carrier orientation"],
    continuation: "Ball won, carrier delayed, or lane played.",
    positive: { theirPossession: 1, carrierDist: 8, firstDefender: 1 }, negative: { theirPossession: 1, carrierDist: 8, firstDefender: 0 },
  }),
  entry({
    id: "CM_TRANS_01", role: "CM", category: "transition", phase: "transition", title: "Won it in midfield",
    trigger: { all: [...ON, c("secondsSinceTurnover", "<", 3)] },
    cues: ["Are they disorganised?", "Is the striker ready to run?", "Is a shot on?", "Is the far side open?"],
    actions: [A.gap, A.space, A.switch, A.recycle, A.shoot],
    mistakes: ["Slowing the counter", "Blasting a hopeful shot"],
    difficultyFactors: ["Opponent recovery", "Runner timing"],
    continuation: "Counter or possession.",
    positive: { hasBall: 1, secondsSinceTurnover: 1 }, negative: { hasBall: 1, secondsSinceTurnover: 20 },
  }),
);

// ---------------------------------------------------------------- wingers (RW authored, LW mirrored)
function winger(role: RoleId, mirror: RoleId | null): CatalogEntry[] {
  const m = (id: string): string | undefined => (mirror ? id.replace(role, mirror) : undefined);
  const mk = (d: Draft): CatalogEntry => {
    const mid = m(d.id);
    return entry(mid ? { ...d, mirrorOf: mid } : d);
  };
  return [
    mk({
      id: `${role}_ON_01`, role, category: "on_ball", phase: "final_third", title: "1v1 wide",
      trigger: { all: [...ON, c("progress", ">", 0.5), c("nearestOppDist", "<", 6)] },
      cues: ["Which foot is the defender on?", "Is the full back overlapping?", "Is the cutback on?", "Is the far winger free?"],
      actions: [A.space, A.draw, A.gap, A.switch, A.recycle, A.shoot],
      mistakes: ["Dribbling into two defenders", "Passing away a winnable 1v1"],
      difficultyFactors: ["Defender distance", "Support arriving"],
      continuation: "Beat the defender, combine, or reset.",
      positive: { hasBall: 1, progress: 0.7, nearestOppDist: 3 }, negative: { hasBall: 1, progress: 0.7, nearestOppDist: 10 },
    }),
    mk({
      id: `${role}_ON_02`, role, category: "on_ball", phase: "final_third", title: "Ball wide with time",
      trigger: { all: [...ON, c("progress", ">", 0.5), c("nearestOppDist", ">=", 6)] },
      cues: ["Is the striker making a run?", "Is the far winger free?", "Can you drive at the box?"],
      actions: [A.space, A.gap, A.switch, A.shoot],
      mistakes: ["Waiting until the defender arrives", "Crossing to nobody"],
      difficultyFactors: ["Runner timing", "Far-side space"],
      continuation: "Chance, switch, or possession.",
      positive: { hasBall: 1, progress: 0.7, nearestOppDist: 9 }, negative: { hasBall: 1, progress: 0.3, nearestOppDist: 9 },
    }),
    mk({
      id: `${role}_BUILD_01`, role, category: "on_ball", phase: "progression", title: "Ball wide in your own half",
      trigger: { all: [...ON, c("progress", "<=", 0.5), c("secondsSinceTurnover", ">=", 3)] },
      cues: ["Is the full back behind you free?", "Is the pass inside on, or is the lane closed?", "Is the far side open?", "Is the defender jumping to press?"],
      actions: [A.gap, A.space, A.switch, A.recycle, A.draw],
      mistakes: ["Turning into the touchline with a defender closing", "Forcing it inside through bodies when the reset is free"],
      difficultyFactors: ["Pressure", "Inside lane", "Far-side space"],
      continuation: "Progressed, switched, or possession kept.",
      positive: { hasBall: 1, progress: 0.35, pressure: 0.5 }, negative: { hasBall: 1, progress: 0.8, pressure: 0.5 },
    }),
    mk({
      id: `${role}_TRANS_01`, role, category: "transition", phase: "transition", title: "Won it wide",
      trigger: { all: [...ON, c("secondsSinceTurnover", "<", 3)] },
      cues: ["Is their full back out of position?", "Is the striker ready to run?", "Is the far side open?"],
      actions: [A.space, A.gap, A.switch, A.recycle, A.shoot],
      mistakes: ["Slowing the counter with an extra touch", "Running into the recovering defender"],
      difficultyFactors: ["Opponent recovery", "Runner timing"],
      continuation: "Counter or possession.",
      positive: { hasBall: 1, secondsSinceTurnover: 1 }, negative: { hasBall: 1, secondsSinceTurnover: 20 },
    }),
    mk({
      id: `${role}_OFF_01`, role, category: "off_ball", phase: "progression", title: "Ball on the far side",
      trigger: { all: [...OFF, c("ballOnMyFlank", "==", 0)] },
      cues: ["Is the far-side defender watching the ball?", "Is a switch possible?", "Is there room behind?", "Is the full back already giving width, and is the far post open?"],
      actions: [A.width, A.narrowInside, A.runBehind, A.underneath],
      mistakes: ["Drifting inside and closing the switch", "Running offside early", "Narrowing when nobody else holds width"],
      difficultyFactors: ["Switch availability", "Space behind", "Width cover from the full back"],
      continuation: "Switch found, far-post run, run behind, or shape.",
      positive: { ourPossession: 1, ballOnMyFlank: 0 }, negative: { ourPossession: 1, ballOnMyFlank: 1 },
    }),
    mk({
      id: `${role}_OFF_02`, role, category: "off_ball", phase: "progression", title: "Ball on your side, room behind",
      trigger: { all: [...OFF, c("ballOnMyFlank", "==", 1), c("spaceBehindLine", ">", 8), c("teammateCarrierDist", "<", 25)] },
      cues: ["Are you onside?", "Can the carrier see you?", "Where is the space?"],
      actions: [A.runBehind, A.underneath, A.width],
      mistakes: ["Going too early", "Coming short when the run is on"],
      difficultyFactors: ["Offside line", "Carrier pressure"],
      continuation: "Ball in behind or support angle.",
      positive: { ourPossession: 1, ballOnMyFlank: 1, spaceBehindLine: 15, teammateCarrierDist: 12 }, negative: { ourPossession: 1, ballOnMyFlank: 1, spaceBehindLine: 4, teammateCarrierDist: 12 },
    }),
    mk({
      id: `${role}_DEF_01`, role, category: "defending", phase: "defending", title: "Their full back has the ball",
      trigger: { all: [...DEF, c("carrierDist", "<", 12)] },
      cues: ["Can you press and cut inside?", "Who is behind you?", "Is the pass inside more dangerous?"],
      actions: [A.press, A.screen, A.drop],
      mistakes: ["Pressing from inside and opening the line", "Not tracking back"],
      difficultyFactors: ["Carrier distance", "Inside lane"],
      continuation: "Press, screen, or recover.",
      positive: { theirPossession: 1, carrierDist: 8 }, negative: { theirPossession: 1, carrierDist: 30 },
    }),
    mk({
      id: `${role}_RECV_01`, role, category: "on_ball", phase: "progression", title: "Receiving on the flank",
      trigger: { all: [c("receiving", "==", 1)] },
      cues: ["Is the defender tight?", "Can you take it on the half-turn?"],
      actions: [A.touchForward, A.touchSafe],
      mistakes: ["Letting the ball run to the defender", "Stopping it dead"],
      difficultyFactors: ["Pressure", "Pass quality"],
      continuation: "Face forward or protect.",
      positive: { receiving: 1 }, negative: { receiving: 0 },
    }),
  ];
}
entries.push(...winger("RW", null), ...winger("LW", "RW"));

// ---------------------------------------------------------------- striker
entries.push(
  entry({
    id: "ST_ON_01", role: "ST", category: "on_ball", phase: "final_third", title: "On the ball near goal",
    trigger: { all: [...ON, c("distToGoal", "<", 20)] },
    cues: ["Is the shot open?", "Is a teammate better placed?", "Is the defender committed?"],
    actions: [A.shoot, A.gap, A.space, A.draw, A.layoff],
    mistakes: ["Shooting through a wall", "Passing when the shot is open"],
    difficultyFactors: ["Shot window", "Support"],
    continuation: "Shot, combination, or reset.",
    positive: { hasBall: 1, distToGoal: 12 }, negative: { hasBall: 1, distToGoal: 30 },
  }),
  entry({
    id: "ST_ON_02", role: "ST", category: "on_ball", phase: "progression", title: "Back to goal",
    trigger: { all: [...ON, c("distToGoal", ">=", 20), c("pressure", ">", 0.4)] },
    cues: ["Who is arriving underneath?", "Can you turn?", "Is a winger running?", "Is the far winger free?"],
    actions: [A.recycle, A.hold, A.space, A.gap, A.switch],
    mistakes: ["Turning into the defender", "Holding until dispossessed"],
    difficultyFactors: ["Pressure", "Support timing"],
    continuation: "Lay-off, turn, or ball lost.",
    positive: { hasBall: 1, distToGoal: 25, pressure: 0.7 }, negative: { hasBall: 1, distToGoal: 25, pressure: 0.1 },
  }),
  entry({
    id: "ST_OFF_01", role: "ST", category: "off_ball", phase: "progression", title: "Room behind the defence",
    trigger: { all: [...OFF, c("spaceBehindLine", ">", 8)] },
    cues: ["Are you onside?", "Can the carrier play it?", "Which side is the space?"],
    actions: [A.runBehind, A.underneath, A.shape],
    mistakes: ["Standing still on the line", "Running offside"],
    difficultyFactors: ["Offside line", "Carrier readiness"],
    continuation: "Ball in behind or support.",
    positive: { ourPossession: 1, spaceBehindLine: 15 }, negative: { ourPossession: 1, spaceBehindLine: 4 },
  }),
  entry({
    id: "ST_OFF_02", role: "ST", category: "off_ball", phase: "progression", title: "Defence sitting deep",
    trigger: { all: [...OFF, c("spaceBehindLine", "<=", 8)] },
    cues: ["Can you drop and link?", "Is a winger free wide?", "Can you pull a defender out?"],
    actions: [A.underneath, A.runBehind, A.width],
    mistakes: ["Running into a packed line", "Hiding behind defenders"],
    difficultyFactors: ["Deep block", "Support"],
    continuation: "Link play or hold shape.",
    positive: { ourPossession: 1, spaceBehindLine: 5 }, negative: { ourPossession: 1, spaceBehindLine: 15 },
  }),
  entry({
    id: "ST_RECV_01", role: "ST", category: "on_ball", phase: "final_third", title: "Receiving near goal",
    trigger: { all: [c("receiving", "==", 1)] },
    cues: ["Where is the defender?", "Can you set the shot with one touch?"],
    actions: [A.touchForward, A.touchSafe],
    mistakes: ["Taking a heavy touch toward the keeper", "Touching back into the defender"],
    difficultyFactors: ["Pressure", "Angle"],
    continuation: "Shot set up or ball protected.",
    positive: { receiving: 1 }, negative: { receiving: 0 },
  }),
  entry({
    id: "ST_DEF_01", role: "ST", category: "defending", phase: "defending", title: "Their centre back has the ball",
    trigger: { all: [...DEF, c("carrierDist", "<", 12), c("carrierDistToOurGoal", ">", 40)] },
    cues: ["Can you press without opening the middle?", "Which pass do they want?", "Are teammates pressing with you?"],
    actions: [A.press, A.screen, A.delay],
    mistakes: ["Pressing alone", "Standing off a comfortable carrier"],
    difficultyFactors: ["Team pressing", "Carrier composure"],
    continuation: "Ball won high, lane cut, or possession continues.",
    positive: { theirPossession: 1, carrierDist: 8, carrierDistToOurGoal: 55 }, negative: { theirPossession: 1, carrierDist: 8, carrierDistToOurGoal: 20 },
  }),
  entry({
    id: "ST_TRANS_01", role: "ST", category: "transition", phase: "transition", title: "Won it high",
    trigger: { all: [...ON, c("secondsSinceTurnover", "<", 3), c("distToGoal", "<", 30)] },
    cues: ["Is the keeper set?", "Is the shot open?", "Is a teammate better placed?"],
    actions: [A.shoot, A.space, A.gap, A.layoff, A.switch],
    mistakes: ["Panicking the shot", "Extra touch that lets the defence recover"],
    difficultyFactors: ["Keeper position", "Recovering defenders"],
    continuation: "Shot or quick attack.",
    positive: { hasBall: 1, secondsSinceTurnover: 1, distToGoal: 20 }, negative: { hasBall: 1, secondsSinceTurnover: 20, distToGoal: 20 },
  }),
);

const file: CatalogFile = { id: "provisional-u11", version: 1, reviewStatus: "provisional", entries };
const errors = validateCatalog(file);
if (errors.length > 0) {
  console.error(errors.join("\n"));
  throw new Error(`catalog invalid: ${errors.length} problems`);
}
writeFileSync(new URL("../content/catalog/provisional-u11.json", import.meta.url), JSON.stringify(file, null, 2) + "\n");
console.log(`wrote ${entries.length} provisional entries`);
