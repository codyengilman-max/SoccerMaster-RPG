SoccerMaster RPG — Standalone Build Specification v1.1

Target repository: codyengilman-max/SoccerMaster-RPG
Reported initial commit: 5b36d3b
Status: Implementation brief; unresolved design choices must remain explicitly marked.

1. Independent project requirements

Build SoccerMaster RPG as a completely new, independent game.

* Use this specification and subsequent materials explicitly supplied for this new project.
* Do not read, copy, import or depend on the previous SoccerMaster repository, engine, branches, pull requests, execution packets or Devin instructions.
* Implement the simulation, story systems and presentation independently.
* Preserve the gameplay requirements described here without retrieving older implementations.
* Record missing requirements and proposed defaults in spec/OPEN_QUESTIONS.md.
* Work through pull requests. Do not merge or deploy without approval.
* Keep the project proprietary; do not add an open-source project license.

Save this document as spec/SOCCERMASTER_RPG_STANDALONE_V1_1.md.

Revision note (approved with the match-system audit, PR #18): official matches are answer-only decision moments. The AI engine simulates the whole match; the user experiences 12–18 meaningful direct-involvement moments and selects one displayed answer per moment. Sections 9–16, 21–25 below are canonical for that model and supersede the earlier continuous-control, drawing-based description. Drawing-based execution is retained only for training drills and minigames outside official matches.

2. The game we are building

SoccerMaster combines an accurate soccer simulation with an engaging, character-driven RPG.

The player develops from a recreational soccer background into a club player, starting at U11 and progressing through U16.

Influence	Application
Score! Hero	One decisive choice per moment, framed cinematically; in official matches the choice is an answer selection, in training drills it may be a drawn gesture
Max Payne	Short cinematic lead-in that freezes at the instant of decision
Kingdom Hearts	Friendship, attachment, discovery and meaningful reunions
Final Fantasy	Cinematic presentation, memorable characters and seasonal story arcs
The Sims	School, home, relationships and everyday activities
Outer Banks / Bend It Like Beckham / Happy Gilmore	Youthful adventure, family pressure, soccer ambition and humor

These are creative references. Use original characters, assets, dialogue, interface designs and audio.

The story gives players a reason to return. Soccer accuracy gives their decisions meaning.

3. Start screen and player creation

Required flow:

1. Start screen.
2. Select boys’ or girls’ campaign.
3. Create the player.
4. Select a playing position.
5. Begin the U11 opening story.

Initial soccer format:

* 9v9
* 1-3-2-3 formation
* Positions 1, 2, 3, 4, 6, 8, 7, 9 and 11

The selected position remains locked throughout the match. The user does not switch control between teammates.

Distinguish positional responsibility from fixed coordinates: a winger can move inside or recover while still being the winger.

The career ends at U16. Later-age match formats require a separate explicit ruleset; do not assume the initial 9v9 format defines every season.

Both campaigns need meaningful authored differences without using gender to determine soccer ability or personality.

4. Opening: your best friend brings you into club soccer

The player has played recreational soccer for the last couple of years.

Their best friend already plays for FC Batavia and invites them to a Thursday training.

Required opening sequence:

1. Kick a ball around with the friend after school.
2. Receive the invitation.
3. Choose a response expressing curiosity, uncertainty, ambition or the desire to play together.
4. Discuss attending with a parent.
5. Arrive at training, where the friend waits near the parking lot.
6. Meet Coach Code.
7. Participate in a playable introductory activity.
8. Discuss joining afterward.

The first response expresses a feeling; it does not permanently assign a personality class.

The Thursday visit is an introductory event, separate from the recurring weekly schedule.

The friendship becomes a continuing story thread. The two players may develop at different rates, compete for opportunities, make other friends or choose different clubs.

The invitation creates history and affection, not an obligation to stay together forever.

5. Coach Code and the supporting cast

Coach Code is:

* Strict, loud, passionate and demanding.
* Detail-oriented and committed to teaching.
* Kind and compassionate.
* Capable of humor, listening and admitting mistakes.
* Willing to hold players accountable.
* Not someone who holds grudges when players leave.

Avoid making every conversation a motivational speech or correction.

Parents have their own concerns about commitment, school, money, playing time and the player’s happiness. They can be insightful or mistaken.

Teammates need independent goals and arcs:

Want → obstacle → decision → consequence → change.

Every recurring character needs a persistent identity, relationships, memories and limits on what they know.

Characters who play soccer must map to actual roster identities. Dialogue cannot describe a friend participating in a match where they were absent.

Names, friend positions and detailed cast biographies remain proposals until reviewed.

6. World and story structure

The setting suggests the Phoenix area without explicitly naming the city.

Recurring places include:

* Home and the family car.
* School and a familiar lunch spot.
* Training fields.
* An informal park or soccer space.
* Tournament accommodation and common areas.

Locations should contain optional interactions and activities, not just mandatory dialogue.

Each season needs a central question and authored emotional milestones. For U11, the guiding question is:

Can this new team become something worth believing in—and will the people building it stay together as new opportunities appear?

Include shared jokes, friendly competitions, celebrations, disappointments and quiet moments.

Approximate season-level editorial targets:

* 30% reward or triumph
* 15% concentrated adversity
* 55% everyday life, connection, discovery and humor

These guide writing. They must never force a match result.

7. Weekly gameplay

The regular week includes:

* School scenes and responsibilities.
* Three team trainings.
* Optional home skill work.
* Family and friend interactions.
* Recovery, hobbies and minigames.
* One league match per active league week.
* Tournament fixtures when scheduled.
* Match-grounded postgame reactions.

Define explicit calendar slots, activity durations, attendance rules and day advancement.

Handle missed events, postponed conversations, conflicting fixtures and weeks with no eligible story scene.

Texts and phone interactions should respect the story’s school phone restrictions.

Rest and friendship can be appropriate choices. Do not make maximum training the universal best life strategy.

8. Playable training and real-world assignments

Team training should include independently implemented:

* 1v1.
* 2v2.
* 3v2.
* Other small-sided activities appropriate to the learning objective.

Training must teach recognizable soccer decisions involving space, pressure, support, timing and transitions.

Home assignments follow:

Watch an approved real demonstration → practise away from the screen → report observations → revisit the learning.

Activities can include juggling, first touch, passing and dribbling.

Do not fabricate video links. Track self-reported practice separately from verified gameplay performance.

The prototype must include at least one enjoyable optional activity with the friend, so the experience offers more than dialogue and matches.

9. Full-match structure

SoccerMaster is a cinematic soccer-intelligence RPG. The AI match engine simulates the complete match in the background; the user experiences only the selected character’s meaningful direct involvements.

Every completed match presents 12–18 meaningful direct-involvement moments for the selected position. This is a hard player-facing range for the completed match. Moments emerge when the live simulation produces eligible conditions; they are never authored puzzles.

* Outfield players: moments are primarily first-touch decisions — the situation freezes at the character’s first controlled touch (or the instant before it) and asks what the situation requires.
* Goalkeepers (explicit exception): a direct involvement also includes receiving a backpass, distribution selection, playing through or over pressure, claim/punch/hold decisions, starting position against a developing attack, one-versus-one positioning, sweeper-keeper decisions, cross management, rebound control and communication that directly determines the keeper’s next action. A cross, sweep or one-versus-one counts even when the best decision is positioning, holding or delaying rather than touching the ball. Do not fabricate unrealistic keeper touches to reach the count; adjust scenario selection and match-event generation so the keeper receives 12–18 authentic decisions.

The player-facing flow of one moment:

1. Routine AI play is skipped; the match clock advances accurately through the skipped simulation.
2. A short cinematic lead-in shows the developing situation: the ball travelling, teammate and defender movement, pressure and available space.
3. The selected character receives or makes first contact with the ball (or, for the keeper, reaches the decision point).
4. The action freezes.
5. A question and multiple-choice answers appear. The answers are generated from the role and the live state (§10, §16).
6. A visible 15-second real-time timer starts only after the freeze and after the question and answers are fully visible (and after any accessibility read-aloud has finished). Pausing stops the timer. The user may answer early.
7. The user selects one answer. This selection is the entire player action.
8. The engine grades the decision, then the character and engine execute the selected action automatically.
9. The immediate consequence plays cinematically; brief feedback follows.
10. Background simulation resumes and the experience jumps to the next meaningful moment.

Timeout: if the timer expires, the moment is recorded as a timeout (no decision). No user decision grade is awarded. The engine selects the character’s action so the simulated match continues, and that engine-selected action is graded separately from the player. The presentation must state clearly that the character acted because the player did not choose; the engine’s action is never presented as the player’s decision. The story may remember repeated hesitation, but a single timeout must not create an excessive punishment.

Duration: a completed match should take five to seven real minutes (preferred); four to eight minutes is acceptable; eight minutes is the hard maximum under normal settings. Do not add artificial waiting, longer cinematics or feedback screens merely to lengthen a match. Report median, minimum and maximum completion times across benchmark matches.

Possession, positioning, score, fatigue and consequences carry forward between moments: the match is one continuous deterministic simulation, not 12–18 disconnected puzzles.

10. Tactical choice comes before execution

Golden moments must ask what the situation requires.

They must not simply instruct the player to pass, dribble or shoot.

Depending on the field state, plausible choices might involve:

* Attacking available space.
* Drawing a defender.
* Playing through a gap.
* Switching the point of attack (only when the far-side route exists in the state; see §15).
* Recycling possession or laying the ball off.
* Supporting underneath.
* Holding width or position.
* Narrowing inside as a temporary second 9 (opposite winger only, contextual; see §15).
* Tracking a runner.
* Covering a teammate.
* Screening a passing lane.
* Pressing, delaying or dropping.
* Communicating or handing off responsibility.

Options must be generated from the selected role and current state. Do not show a static responsibilities menu.

Present multiple credible alternatives without labeling the best answer before selection. Answer order must not reveal the engine’s ranking.

Answer-set rule: every displayed answer must be available in the current state (it instantiates to a valid command at that tick), and the engine’s own highest-scoring action for the character must never be omitted from the answers without an explicit, documented reason (§16).

11. Execution is automatic in official matches

Selecting one of the displayed answers is the only gameplay input during an official-match moment. There is no manual player movement, pass aiming, shot aiming, power meter, first-touch timing, dribbling input, reflex test, button combination, action-execution input or direct control after the answer is chosen.

Selected answer	What happens
Pass / switch / lay-off	The engine plays the pass to the receiver or space the answer named, using the character’s attributes and the pressure at commit
Carry / attack space	The engine drives the carry along the instantiated direction and distance
Shoot	The engine takes the shot at the instantiated target
First touch	The engine performs the directional touch
Off-ball movement, hold, screen, delay, communicate	The engine issues the movement or positioning command

Execution quality is resolved by the engine from attributes, pressure and timing (§13); the user does not perform it.

Drawing-based (Score! Hero-inspired) controls remain available only for training drills and minigames outside official matches, where they teach technique rather than decide match results. Their preview/commit/cancel behaviour and accessible alternative continue to apply there.

12. Cinematic lead-in and freeze

Each moment opens with a short cinematic lead-in replayed from the real simulation: defenders stepping and recovering, teammates moving, passing windows opening or closing, pressure and space changing, the ball travelling. This is real simulation state, never decorative animation over frozen calculations.

At the decision point the action freezes (or enters near-frozen dramatic slow motion). The question and answers are generated from that frozen state, and the 15-second timer begins only once they are fully visible (§9).

After the answer is selected, the engine re-instantiates the chosen intent against the current state and executes it. If the intent has become unavailable, the moment records that explicitly and the engine continues with a plausible default; the user is never asked to execute manually.

Specify:

* Lead-in length and what it must show.
* Freeze behaviour and timer start.
* Timer expiration (timeout semantics, §9).
* Pause behaviour.
* What happens if an intended action becomes unavailable.
* How accessibility read-aloud and reduced motion interact with the timer.

Major moments should receive stronger cinematic emphasis while preserving the information needed to decide.

13. Decision quality, execution and outcome

Store and evaluate these separately:

Layer	Meaning
Decision quality	How suitable the intention was relative to available alternatives
Execution	How the player performed it given attributes, pressure and timing
Outcome	What actually happened

A good decision can fail. A poor decision can succeed.

Execution is resolved by the engine from the character’s attributes and the pressure at commit; a failed execution must not automatically become evidence of poor tactical understanding.

A timeout produces no decision grade. The engine-selected action taken on timeout is graded and recorded separately and is never attributed to the player.

Feedback should explain the relevant field conditions rather than simply reward successful outcomes.

Match evidence should carry more importance than training evidence in soccer assessment. Exact weights remain an implementation proposal requiring review.

14. Tactical coverage and difficulty

Include on-ball, off-ball, defending and transition decisions.

For outfield players the 12–18 moments are overwhelmingly on-ball, first-touch situations; off-ball, defending and transition decisions appear where the role and state make them meaningful. For goalkeepers the mix follows the direct-involvement definition in §9 (distribution, backpasses, claims, sweeps, one-versus-ones, positioning, communication).

Difficulty should arise from:

* Clarity of the best available action.
* Number and quality of alternatives.
* Pressure and decision time.
* Scanning demand.
* Spatial complexity.
* Off-ball information.
* Consequences of the decision.

Include easy, medium and hard reads.

Do not manufacture unrelated situations to meet a quota. Record coverage shortfalls and tune the simulation and recognition system.

15. Independent soccer simulation

Build a stateful simulation supporting:

* Player and ball movement.
* Receiving and directional first touches.
* Passing, carrying, shooting and interception.
* Pressure, cover and support.
* Ball-relative team shape.
* Available space and arrival timing.
* Continuous possession changes and transitions.
* Goalkeeper involvement.
* Restarts.
* Offside and configurable competition rules.
* Player attributes and fatigue.
* Reproducible seeded runs for debugging.

Attacking methodology:

Attack space first. If necessary, draw defenders. Find the spare player on the opposite side and switch the point of attack when the far side offers the better next state. The opposite winger may narrow or become a temporary second 9 when the context supports it. Recognize pressure before receiving. Separate decision quality from execution and outcome.

Support context-appropriate overlaps, underlaps, slips, third-player combinations, runs behind, support underneath and recovery movements.

Movement distances must vary with the state.

Canonical soccer-logic implementation (this repository):

* `readField` (src/tactics/features.ts) computes the live field read — pressure, lanes, space near/far side, receiving state, keeper context, second-9 context — from the deterministic match state.
* `evaluateOnBall` (src/sim/ai.ts) is the engine’s own scored list of on-ball options (carry, pass, switch, shoot, hold) for the player on the ball; the AI plays from the same list.
* `instantiateIntent` (src/tactics/intents.ts) turns a catalog intent into a concrete command for the current state or returns null when the state does not support it.
* `scoreAction` (src/tactics/recognition.ts) scores each instantiated catalog action from the read and the entry’s conditional criteria; grading compares the chosen action against those scores (src/tactics/grading.ts).
* Deterministic match-state evaluation and continuation live in src/sim/engine.ts.

There is no separately named “HGA” or “Decision Utility” system in this repository. Where earlier material used those terms, they describe the concept above: a state-derived score of each plausible action, computed by the existing pipeline. Do not introduce such a named system unless it is actually implemented and tested.

Switch of play (`switch_play`) must be available whenever pressure has overloaded the current side, the opposite-side player is available, the passing route is technically possible, the character has sufficient awareness of the option and the switch produces a better next state than forcing the crowded side. It is scored from the actual state and is not the automatic best answer in every wide situation; when no far-side route exists the intent instantiates to null and is not displayed.

Winger narrowing / second 9 (`narrow_inside`, `secondNineRead` in src/sim/ai.ts) is a contextual movement intent, not a permanent winger behaviour. The opposite winger may narrow into the far half-space only when the ball is secured on the other flank (carrier not pressed, attacking phase), width on the winger’s flank is already provided by an outside back or another teammate, the striker pins the central defenders, the far-post / cutback space is open and rest defence remains protected. The ball-side winger never narrows, so both wingers are never forced inside. The same predicate drives the AI wingers’ off-ball movement and the catalog answer, so the space is real rather than authored. Thresholds are the `SECOND_NINE` constants.

Define age and competition rules explicitly. Verify applicable heading, offside, field and restart rules from current primary sources before presenting a ruleset as accurate.

16. Tactical catalog requirement

The full game requires at least 40 situations per position: 360 entries minimum.

This brief does not contain the full catalog. Do not retrieve an older project’s catalog or label provisional content as approved.

Each entry needs:

* Stable ID and role.
* Phase of play.
* Eligibility and trigger conditions.
* Scanning cues.
* Plausible actions.
* Conditional evaluation criteria.
* Common mistakes.
* Difficulty factors.
* Age and rules restrictions.
* Expected continuation.
* Positive and negative test states.
* Coaching-review status.

Identify left/right mirrors explicitly.

Answer-set integrity (tested in tests/tactics/answerSet.test.ts):

* Every displayed answer must instantiate to a valid command in the state it was shown in; answers that do not exist in the state are removed before display.
* When the character is on the ball, the engine’s highest-scoring `evaluateOnBall` option must be reproducible from the displayed answers. Any deliberate omission must be listed with its soccer reason in `DOCUMENTED_EXCLUSIONS` (src/tactics/exclusions.ts); undocumented omissions fail the test suite. Current exclusion: the goalkeeper is never offered a carry.
* `switch_play` is shown only when the engine has that exact far-side route; `narrow_inside` only when the second-9 read is on.

For the prototype, independently author a small provisional set that demonstrates the system. Keep content separate from implementation so reviewed situations can be added without rewriting the engine.

17. League and tournament scheduling

Provide:

* One league game per active league week.
* Three or four tournament entries per season.
* Tournament opportunities influenced by team results.
* Suitable events for developing teams as well as strong teams.

Working tournament names:

Inspiration	Game name
Surf Cup	Pacific Wave Cup
Dallas Cup	Lone Star International Cup
State championships	Desert State Championships
Tuzos Challenge	Tuzona Challenge
RSL Holiday Classic	Royal Holiday Classic
Rush Cup	Desert Rush Invitational
Presidents Cup	Presidential Cup
Rising Cup	Valley Rising Cup

Rules:

* Pacific Wave Cup and Lone Star International Cup are major out-of-state events.
* Neither is available before U13.
* State-championship qualification depends on league results.
* Numerical qualification thresholds are configurable proposals.
* Qualification uses records available at registration cutoff.
* Tournament fixtures do not count as league results.
* Duplicate result submissions must not alter standings twice.
* Calendar conflicts require explicit resolution.
* Actual imported fixtures and generated schedules must be distinguishable.

The proposed starting model is three suitable tournament entries with an earned fourth.

These are fictional game eligibility rules, not claims about real events.

18. Clubs, tryouts and transfers

Start at FC Batavia.

Five other clubs take inspiration from RSL AZ, Phoenix Rising, Tuzos, SC del Sol and Next Level, with fictional names to be finalized.

* First transfer opportunity follows U11.
* Tryouts occur in mid-May each year.
* Offers depend on explicit roster capacity, eligibility and evidence.
* Transfers require player acceptance.
* Recruiting promises must be tracked separately from delivered opportunities.
* Friendships can continue across clubs.

Batavia’s long-term strength is coaching and development. Do not guarantee championships or force the simulation to produce a breakthrough result.

Other clubs need credible attractions and varied consequences. Leaving Batavia is not automatically a wrong choice.

19. Progression

Track separately:

* Technical development.
* Tactical understanding.
* Physical attributes.
* Wellbeing and recovery.
* School commitments.
* Relationships.
* Responsibilities.
* Opportunities and pathway access.

Relationships can unlock conversations, shared activities or support. They must not directly award passing accuracy.

Define unlock requirements explicitly. Do not imply development merely through changing dialogue.

The six-season journey should show growing independence and changing challenges, rather than repeat the same year with different labels.

20. Story rules and AI

Authored rules control consequences.

AI may express approved facts and choice meanings through contextual dialogue. It may not independently:

* Invent match results.
* Change tactical grades.
* Award roster positions.
* Transfer players.
* Modify attributes.
* Create unauthorized binding promises.
* Reveal information a character does not know.

Each consequential choice needs:

* Eligibility.
* Immediate effects.
* Delayed triggers.
* Repair options.
* Expiration conditions.

Use authored fallback scenes when AI is unavailable. Reject stale responses and prevent duplicate effects.

The first playable milestone must work without live AI.

21. Graphics and presentation

Use a modern Final Fantasy-inspired visual direction:

* Cinematic lighting.
* Expressive, age-appropriate characters.
* Semi-realistic stylization.
* Detailed soccer environments.
* Warm natural light.
* Refined navy-and-cyan interface.
* Clear typography and touch controls.

Maintain a consistent world across school, home, training and matches.

During tactical play, keep the ball, relevant players, pressure and available space readable. Cinematic effects must support the decision.

First visual review should cover:

1. Start screen.
2. Best-friend invitation.
3. Weekly hub.
4. Training.
5. Cinematic decision moment: lead-in, freeze, question and answers, 15-second timer.

Propose measurable mobile performance targets and demonstrate them on representative phones.

22. Technical structure and persistence

Separate responsibility for:

* Soccer simulation.
* Tactical recognition and grading.
* Answer selection and timer (official matches); gesture input (training only).
* Rendering and camera.
* Calendar and competitions.
* Rosters and transfers.
* Story consequences.
* Character knowledge.
* Optional AI dialogue.
* Save/load.

Use stable event IDs and versioned saves.

Save data must preserve identities, fixtures, standings, commitments, pending consequences and progression.

Technology choice is Devin’s proposal. Explain how the selected stack fits the new project’s Cloudflare configuration.

23. First playable milestone

Build a connected prototype containing:

* Start flow and both campaigns.
* Position selection and match role lock.
* Best-friend invitation.
* Parent conversation.
* Thursday training visit.
* One full regular week.
* Three playable training activities.
* One optional activity with the friend.
* One complete simulated match presented as 12–18 direct-involvement moments: cinematic lead-in, freeze, 15-second multiple-choice decision, automatic execution, skipped routine play.
* Postgame scenes responding to actual match evidence.
* Save/resume.
* A calendar preview showing different tournament eligibility paths.

This is the first milestone, not completion of six seasons or the full tactical catalog.

24. Acceptance checks

Demonstrate that:

1. No dependency on the previous project exists.
2. The selected role remains locked throughout a match.
3. Story characters map consistently to roster identities.
4. The cinematic lead-in replays real simulation state and the frozen decision state is the live state.
5. The selected answer is executed against the field state at commit; unavailable intents are recorded explicitly.
6. Selecting the answer is the whole tactical moment; no manual execution input exists or is graded.
7. Decision quality, execution and outcome remain separate.
8. Play continues from the actual outcome without resetting.
9. Tactical triggers reject unsuitable states.
10. Moment coverage and difficulty are measurable.
11. Saves preserve pending story consequences and competition records.
12. Duplicate events cannot apply effects twice.
13. U11/U12 cannot enter either major national event.
14. State qualification uses league evidence available at the cutoff.
15. Different first-week commitments produce meaningfully different later interactions or opportunities, even with identical match scores.
16. The prototype remains playable without AI.
17. Answer selection, the 15-second timer, pause and accessibility read-aloud function on mobile; the timer starts only after the answers are visible.
18. Tactical information remains readable during cinematic presentation.
19. Every displayed answer is available in the state, and the engine’s highest-scoring option is never omitted without a documented exclusion.
20. Completed matches present 12–18 direct-involvement moments and finish in five to seven real minutes (four to eight acceptable, eight hard maximum).
21. A timeout records no decision, the engine’s action is graded separately, and the presentation says the character acted because the player did not choose.

Software tests alone do not establish soccer accuracy. Provisional tactical content requires coaching review.

25. Devin’s execution instruction

Add this specification and the implementation plan through a PR. Reconcile spec/OPEN_QUESTIONS.md against it, then begin the first playable milestone.

Keep proposed defaults, missing content and unfinished features visible.

Official matches are answer-only: cinematic lead-in, freeze, 15-second multiple-choice decision, automatic execution, skipped routine play, 12–18 meaningful direct-involvement moments in five to seven minutes. Drawing survives only in training. Build everything independently within SoccerMaster-RPG.