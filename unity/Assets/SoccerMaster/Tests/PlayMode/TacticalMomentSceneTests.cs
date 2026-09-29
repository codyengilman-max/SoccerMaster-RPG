using System.Collections;
using System.IO;
using NUnit.Framework;
using SoccerMaster.Core.Director;
using SoccerMaster.Core.Sim;
using SoccerMaster.View;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.TestTools;
using UnityEngine.UI;

namespace SoccerMaster.Tests.PlayMode
{
    /// <summary>
    /// Runs the real TacticalMoment scene: the rig must mirror canonical runtime state, expose exactly
    /// four touch answers that only route option ids into the runtime, show decision/execution/outcome
    /// feedback, and persist/restore the runtime through the versioned native save.
    /// </summary>
    public class TacticalMomentSceneTests
    {
        private const string SceneName = "TacticalMoment";
        private const float Deadline = 60f;

        [UnitySetUp]
        public IEnumerator LoadScene()
        {
            yield return SceneManager.LoadSceneAsync(SceneName, LoadSceneMode.Single);
            var ctrl = Object.FindFirstObjectByType<TacticalMomentController>();
            ctrl.DeleteSave();
            ctrl.NewMatch(7, "RW");
        }

        [UnityTearDown]
        public IEnumerator Cleanup()
        {
            var ctrl = Object.FindFirstObjectByType<TacticalMomentController>();
            if (ctrl != null) ctrl.DeleteSave();
            yield return null;
        }

        private static TacticalMomentController Controller()
        {
            var ctrl = Object.FindFirstObjectByType<TacticalMomentController>();
            Assert.That(ctrl, Is.Not.Null, "scene has no TacticalMomentController");
            Assert.That(ctrl.Runtime, Is.Not.Null, "controller did not start a match");
            return ctrl;
        }

        private static TacticalMomentRig Rig()
        {
            var rig = Object.FindFirstObjectByType<TacticalMomentRig>();
            Assert.That(rig, Is.Not.Null, "scene has no TacticalMomentRig");
            return rig;
        }

        private static IEnumerator WaitFor(System.Func<bool> done, string what)
        {
            var deadline = Time.realtimeSinceStartup + Deadline;
            while (!done() && Time.realtimeSinceStartup < deadline) yield return null;
            Assert.That(done(), Is.True, "timed out waiting for " + what);
        }

        [UnityTest]
        public IEnumerator SceneBuildsCameraFieldActorsAndSafeAreaHud()
        {
            var ctrl = Controller();
            var rig = Rig();
            yield return null;
            Assert.That(rig.Camera, Is.Not.Null);
            Assert.That(rig.Camera.orthographic, Is.True);
            Assert.That(GameObject.Find("Field"), Is.Not.Null);
            Assert.That(GameObject.Find("Ball"), Is.Not.Null);
            Assert.That(GameObject.Find("Players").transform.childCount, Is.EqualTo(ctrl.Runtime.State.Players.Count));

            Assert.That(rig.SafeArea, Is.Not.Null);
            var safe = Screen.safeArea;
            Assert.That(rig.SafeArea.anchorMin.x, Is.EqualTo(safe.xMin / Screen.width).Within(1e-3));
            Assert.That(rig.SafeArea.anchorMin.y, Is.EqualTo(safe.yMin / Screen.height).Within(1e-3));
            Assert.That(rig.SafeArea.anchorMax.x, Is.EqualTo(safe.xMax / Screen.width).Within(1e-3));
            Assert.That(rig.SafeArea.anchorMax.y, Is.EqualTo(safe.yMax / Screen.height).Within(1e-3));
            Assert.That(rig.SafeArea.GetComponentInParent<CanvasScaler>().referenceResolution, Is.EqualTo(new Vector2(390f, 844f)));

            Assert.That(rig.Answers.Length, Is.EqualTo(TacticalMomentRig.AnswerCount));
            Assert.That(rig.Answers.Length, Is.EqualTo(4));
            for (var i = 0; i < 4; i++)
            {
                Assert.That(rig.Answers[i].name, Is.EqualTo(TacticalMomentRig.AnswerName + " " + i));
                Assert.That(rig.Answers[i].GetComponent<Image>().raycastTarget, Is.True, "answer must be touch-hittable");
                Assert.That(rig.Answers[i].transform.IsChildOf(rig.SafeArea), Is.True, "answer outside the safe area");
            }
            Assert.That(rig.Next.transform.IsChildOf(rig.SafeArea), Is.True);
            Assert.That(rig.Identity.text, Is.EqualTo(rig.Build.Line));
            Assert.That(rig.Identity.text, Does.Contain(Application.unityVersion));
            Assert.That(rig.Identity.text, Does.Contain(rig.Build.ShortSha));
        }

        [UnityTest]
        public IEnumerator MirrorsCanonicalPositionsAndAdvancesRoutinePlayFast()
        {
            var ctrl = Controller();
            var rig = Rig();
            yield return null;
            yield return null;
            var rt = ctrl.Runtime;
            var view = rt.View();
            var ball = GameObject.Find("Ball").transform;
            Assert.That(ball.position.x, Is.EqualTo((float)view.BallPos.X).Within(1e-4));
            Assert.That(ball.position.z, Is.EqualTo((float)view.BallPos.Y).Within(1e-4));
            var players = GameObject.Find("Players").transform;
            for (var i = 0; i < players.childCount; i++)
            {
                Assert.That(players.GetChild(i).position.x, Is.EqualTo((float)view.Pos[i].X).Within(1e-4));
                Assert.That(players.GetChild(i).position.z, Is.EqualTo((float)view.Pos[i].Y).Within(1e-4));
            }
            var t0 = Time.realtimeSinceStartup;
            var tick0 = rt.State.Clock.Tick;
            yield return new WaitForSecondsRealtime(0.5f);
            if (rt.Phase == RuntimePhase.Routine)
            {
                var elapsedMs = (Time.realtimeSinceStartup - t0) * 1000.0;
                var simMs = (rt.State.Clock.Tick - tick0) * MatchState.TickMs;
                Assert.That(simMs, Is.GreaterThan(elapsedMs * 3), "routine play must run well above real time");
            }
            Assert.That(rt.State.Clock.Tick, Is.GreaterThan(tick0), "match did not advance with frame time");
            Assert.That(GameObject.Find("HUD").transform.Find("Veil").gameObject.activeSelf, Is.EqualTo(rt.Phase == RuntimePhase.Routine));
        }

        [UnityTest]
        public IEnumerator QuestionShowsFourAnswersArmedOnlyAfterSettleAndRoutesTheTapCanonically()
        {
            var ctrl = Controller();
            var rig = Rig();
            var rt = ctrl.Runtime;
            var panel = GameObject.Find("HUD").transform.Find("SafeArea/QuestionPanel").gameObject;
            Assert.That(panel.activeSelf, Is.False, "question panel visible before any moment");

            yield return WaitFor(() => rt.Phase == RuntimePhase.Question, "first frozen question");
            var m = rt.Active.Moment;
            var frozenTick = rt.State.Clock.Tick;
            rig.Mirror(0f);
            Assert.That(panel.activeSelf, Is.True);
            Assert.That(m.Options.Count, Is.EqualTo(4));
            for (var i = 0; i < 4; i++)
            {
                Assert.That(rig.Answers[i].gameObject.activeSelf, Is.True);
                Assert.That(rig.Answers[i].interactable, Is.False, "answers armed before the picture settled");
                Assert.That(rig.Answers[i].GetComponentInChildren<Text>().text, Is.EqualTo(m.Options[i].Label));
                Assert.That(rig.Answers[i].GetComponentInChildren<Text>().text, Does.Not.Contain(m.Options[i].Score.ToString("F2")), "ranking leaked into the label");
            }
            Assert.That(ctrl.Choose(0), Is.False, "tap accepted before the answers armed");
            Assert.That(rt.Phase, Is.EqualTo(RuntimePhase.Question));

            yield return WaitFor(() => rt.Phase == RuntimePhase.Timer, "answers to arm");
            Assert.That(rt.State.Clock.Tick, Is.EqualTo(frozenTick), "canonical clock moved while the picture was frozen");
            rig.Mirror(0f);
            for (var i = 0; i < 4; i++) Assert.That(rig.Answers[i].interactable, Is.True);
            Assert.That(GameObject.Find("HUD").transform.Find("SafeArea/TimerBar").gameObject.activeSelf, Is.True);

            var chosen = m.Options[1];
            rig.Answers[1].onClick.Invoke();
            Assert.That(rt.Phase, Is.EqualTo(RuntimePhase.Resolving));
            Assert.That(rt.Active.Result.Acted.Actor, Is.EqualTo("user"));
            Assert.That(rt.Active.Result.Acted.OptionId, Is.EqualTo(chosen.Id));
            Assert.That(rt.Active.Result.Acted.CommitTick, Is.EqualTo(frozenTick));
            rig.Mirror(0f);
            Assert.That(panel.activeSelf, Is.False, "answers still shown after the tap");

            yield return WaitFor(() => rt.Phase == RuntimePhase.Feedback, "feedback");
            rig.Mirror(0f);
            var feedback = GameObject.Find("HUD").transform.Find("SafeArea/FeedbackPanel");
            Assert.That(feedback.gameObject.activeSelf, Is.True);
            var body = feedback.Find("FeedbackBody").GetComponent<Text>().text;
            var r = rt.Active.Record;
            Assert.That(body, Does.Contain("Decision: " + r.Decision.Band));
            Assert.That(body, Does.Contain("Execution: " + r.Execution.Band));
            Assert.That(body, Does.Contain("Outcome: " + r.Outcome.Summary));
            Assert.That(rig.Next.gameObject.activeInHierarchy, Is.True);

            rig.Next.onClick.Invoke();
            Assert.That(rt.Phase, Is.Not.EqualTo(RuntimePhase.Feedback));
            rig.Mirror(0f);
            Assert.That(feedback.gameObject.activeSelf, Is.False);
        }

        [UnityTest]
        public IEnumerator SavesAtomicallyAndResumesATimerAsAFrozenQuestion()
        {
            var ctrl = Controller();
            var rt = ctrl.Runtime;
            yield return WaitFor(() => rt.Phase == RuntimePhase.Timer, "armed question");
            var momentId = rt.Active.Moment.Id;
            var tick = rt.State.Clock.Tick;
            var left = rt.TimerRemaining();

            Assert.That(ctrl.Save(), Is.True, ctrl.LastSaveError);
            Assert.That(File.Exists(ctrl.SavePath), Is.True);
            Assert.That(File.Exists(ctrl.SavePath + ".tmp"), Is.False, "temp file left behind");
            var bytes = File.ReadAllText(ctrl.SavePath);
            Assert.That(bytes, Does.Contain("\"format\":\"" + MatchSave.Format + "\""));

            Assert.That(ctrl.TryLoad(), Is.True, ctrl.LastSaveError);
            Assert.That(ctrl.RestoredFromSave, Is.True);
            var restored = ctrl.Runtime;
            Assert.That(restored, Is.Not.SameAs(rt));
            Assert.That(restored.Phase, Is.EqualTo(RuntimePhase.Question), "a saved timer must resume frozen");
            Assert.That(restored.Active.Moment.Id, Is.EqualTo(momentId));
            Assert.That(restored.State.Clock.Tick, Is.EqualTo(tick));
            Assert.That(restored.TimerRemaining(), Is.EqualTo(left).Within(1e-9));
            Assert.That(ctrl.Armed, Is.False);
            yield return WaitFor(() => ctrl.Armed, "restored question to re-arm");
            Assert.That(restored.Phase, Is.EqualTo(RuntimePhase.Timer));

            // A corrupt slot is rejected without touching the valid bytes; a fresh match is started instead.
            ctrl.Save();
            var valid = File.ReadAllText(ctrl.SavePath);
            File.WriteAllText(ctrl.SavePath, valid.Replace("\"version\":" + MatchSave.Version, "\"version\":" + (MatchSave.Version + 1)));
            Assert.That(ctrl.TryLoad(), Is.False);
            Assert.That(ctrl.LastSaveError, Does.Contain("unsupported"));
            Assert.That(ctrl.Runtime, Is.SameAs(restored), "rejected save replaced the running match");
        }
    }
}
