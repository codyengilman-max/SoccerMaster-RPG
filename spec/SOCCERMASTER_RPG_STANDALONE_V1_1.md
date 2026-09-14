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

This version restores drawing-based execution and supersedes the instruction to remove it.

2. The game we are building

SoccerMaster combines an accurate soccer simulation with an engaging, character-driven RPG.

The player develops from a recreational soccer background into a club player, starting at U11 and progressing through U16.

Influence	Application
Score! Hero	Direct drawing interaction for passes, shots and supported movement
Max Payne	Dramatic slow motion while the field continues moving
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

Each full match targets 18–25 meaningful tactical decision moments for the selected position.

These are the Golden Situations. They emerge when the live simulation produces eligible conditions.

The match remains continuous:

1. Ordinary play unfolds.
2. A meaningful situation emerges.
3. The camera focuses and play slows almost to a freeze.
4. Players continue moving slowly.
5. The user reads the situation and makes a tactical choice.
6. Where appropriate, the user draws the intended execution.
7. The simulation resolves the action.
8. Play continues from that outcome.

Selecting “Pass” and drawing the pass are two parts of one moment—not two scored decisions.

Do not turn the match into 18–25 disconnected puzzles. Possession, positioning, score, fatigue and consequences carry forward.

Routine passages may use accelerated presentation, but the user must be able to understand what happened.

10. Tactical choice comes before execution

Golden moments must ask what the situation requires.

They must not simply instruct the player to pass, dribble or shoot.

Depending on the field state, plausible choices might involve:

* Attacking available space.
* Drawing a defender.
* Playing through a gap.
* Switching the point of attack.
* Recycling possession.
* Supporting underneath.
* Holding width or position.
* Tracking a runner.
* Covering a teammate.
* Screening a passing lane.
* Pressing, delaying or dropping.
* Communicating or handing off responsibility.

Options must be generated from the selected role and current state. Do not show a static responsibilities menu.

Present multiple credible alternatives without labeling the best answer before selection.

11. Score! Hero-inspired execution controls

Keep the drawing component.

Selected action	Execution interaction
Pass	Draw toward a teammate or intended receiving space
Dribble	Direct the intended carry
Shoot	Draw toward the intended goal target
First touch	Direct the intended receiving touch
Off-ball run	Draw the intended movement into space
Hold, screen, delay or communicate	Use a suitable contextual control; drawing is not mandatory

A drawing communicates intent. It does not guarantee the ball or player follows the exact line successfully.

Proposed initial interaction:

* Preview while the finger is down.
* Commit on release.
* Provide a cancel gesture.
* Provide an accessible alternative to drawing.

The preview should show intended execution without revealing guaranteed success or the correct tactical answer.

A practical first implementation may translate gestures into supported simulation actions. Do not promise unrestricted freehand physics without implementing and testing it.

12. Max Payne-style moving slow motion

During tactical moments:

* Defenders continue stepping and recovering.
* Teammates continue moving.
* Passing windows can open or close.
* Pressure and space continue changing.
* The ball continues according to the simulation state.

This movement must be real simulation movement.

The engine evaluates execution against the state when the action is committed, not the state when the moment began.

Specify:

* Slow-motion time behavior.
* Decision-window expiration.
* Cancellation.
* What happens if an intended action becomes unavailable.
* How accessible input alternatives handle time pressure.

Do not use decorative defender animation over frozen calculations.

Major moments should receive stronger cinematic emphasis while preserving the information needed to decide.

13. Decision quality, execution and outcome

Store and evaluate these separately:

Layer	Meaning
Decision quality	How suitable the intention was relative to available alternatives
Execution	How the player performed it given attributes, pressure and timing
Outcome	What actually happened

A good decision can fail. A poor decision can succeed.

A shaky drawing must not automatically become evidence of poor tactical understanding.

Feedback should explain the relevant field conditions rather than simply reward successful outcomes.

Match evidence should carry more importance than training evidence in soccer assessment. Exact weights remain an implementation proposal requiring review.

14. Tactical coverage and difficulty

Include on-ball, off-ball, defending and transition decisions.

The target mix is approximately 10–14 on-ball moments, with remaining moments drawn from other responsibilities where appropriate to the role. Goalkeeper and other role-specific distributions may need different tuning.

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

Attack space first. If necessary, draw defenders. Switch the point of attack when the opposite side offers the better opportunity.

Support context-appropriate overlaps, underlaps, slips, third-player combinations, runs behind, support underneath and recovery movements.

Movement distances must vary with the state.

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
5. Moving slow-motion tactical moment with drawing interaction.

Propose measurable mobile performance targets and demonstrate them on representative phones.

22. Technical structure and persistence

Separate responsibility for:

* Soccer simulation.
* Tactical recognition and grading.
* Gesture input.
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
* One continuous simulated match with tactical recognition, moving slow motion and drawing execution.
* Postgame scenes responding to actual match evidence.
* Save/resume.
* A calendar preview showing different tournament eligibility paths.

This is the first milestone, not completion of six seasons or the full tactical catalog.

24. Acceptance checks

Demonstrate that:

1. No dependency on the previous project exists.
2. The selected role remains locked throughout a match.
3. Story characters map consistently to roster identities.
4. Slow motion advances the real simulation.
5. Gesture commitment uses the current field state.
6. Choice and drawing count as one tactical moment.
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
17. Drawing, cancellation and accessible alternatives function on mobile.
18. Tactical information remains readable during cinematic presentation.

Software tests alone do not establish soccer accuracy. Provisional tactical content requires coaching review.

25. Devin’s execution instruction

Add this specification and the implementation plan through a PR. Reconcile spec/OPEN_QUESTIONS.md against it, then begin the first playable milestone.

Keep proposed defaults, missing content and unfinished features visible.

Retain Score! Hero-inspired drawing. Retain Max Payne-style moving slow motion. Retain 18–25 meaningful tactical moments. Build everything independently within SoccerMaster-RPG.