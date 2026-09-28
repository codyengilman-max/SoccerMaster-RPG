using System.Collections;
using System.Collections.Generic;
using NUnit.Framework;
using SoccerMaster.Core.Sim;
using SoccerMaster.Core.Training;
using SoccerMaster.View;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.TestTools;

namespace SoccerMaster.Tests.PlayMode
{
    /// <summary>
    /// Runs the real FirstTouch scene: the controller must mirror canonical drill state onto the scene
    /// and route touch input into the drill without deciding anything itself.
    /// </summary>
    public class FirstTouchSceneTests
    {
        private const string SceneName = "FirstTouch";

        [UnitySetUp]
        public IEnumerator LoadScene()
        {
            yield return SceneManager.LoadSceneAsync(SceneName, LoadSceneMode.Single);
        }

        private static FirstTouchController Controller()
        {
            var ctrl = Object.FindFirstObjectByType<FirstTouchController>();
            Assert.That(ctrl, Is.Not.Null, "scene has no FirstTouchController");
            Assert.That(ctrl.Drill, Is.Not.Null, "controller did not start a drill");
            return ctrl;
        }

        [UnityTest]
        public IEnumerator SceneMirrorsCanonicalDrillState()
        {
            var ctrl = Controller();
            var ball = GameObject.Find("Ball").transform;
            var defender = GameObject.Find("Defender").transform;
            Assert.That(GameObject.Find("Main Camera"), Is.Not.Null);
            Assert.That(GameObject.Find("Field"), Is.Not.Null);
            for (var i = 0; i < 3; i++) Assert.That(GameObject.Find("Gate " + FirstTouchDrill.Name((GateId)i)), Is.Not.Null);

            yield return null;
            yield return null;
            var d = ctrl.Drill;
            Assert.That(ball.position.x, Is.EqualTo((float)d.BallPos.X).Within(1e-4));
            Assert.That(ball.position.z, Is.EqualTo((float)d.BallPos.Y).Within(1e-4));
            Assert.That(defender.position.x, Is.EqualTo((float)d.DefenderPos.X).Within(1e-4));
            Assert.That(defender.position.z, Is.EqualTo((float)d.DefenderPos.Y).Within(1e-4));
            Assert.That(d.TimeMs, Is.GreaterThan(0), "drill did not advance with frame time");
        }

        [UnityTest]
        public IEnumerator TapDuringWindowCommitsThroughTheDrill()
        {
            var ctrl = Controller();
            ctrl.StartDrill(21, 1, false);
            var d = ctrl.Drill;
            var opened = false;
            var deadline = Time.realtimeSinceStartup + 15f;
            while (!opened && Time.realtimeSinceStartup < deadline)
            {
                yield return null;
                foreach (var e in ctrl.LastEvents) opened |= e.Type == DrillEventType.WindowOpen;
            }
            Assert.That(opened, Is.True, "window never opened in the running scene");
            Assert.That(d.Phase, Is.EqualTo(Phase.Window));

            var rec = ctrl.SubmitStroke(new List<Vec2D> { new Vec2D(20, 9) });
            Assert.That(rec, Is.Not.Null);
            Assert.That(rec.ChosenGate, Is.EqualTo(GateId.Forward));
            Assert.That(rec.Decision, Is.Not.EqualTo(DecisionBand.Timeout));
            Assert.That(d.Phase, Is.EqualTo(Phase.Resolve));

            deadline = Time.realtimeSinceStartup + 20f;
            while (d.Phase != Phase.Done && Time.realtimeSinceStartup < deadline) yield return null;
            Assert.That(d.Phase, Is.EqualTo(Phase.Done));
            Assert.That(rec.Outcome, Is.Not.EqualTo(Outcome.None));
            Assert.That(ctrl.TotalEvents, Is.GreaterThanOrEqualTo(4), "expected window_open, committed, outcome, done");
        }

        [UnityTest]
        public IEnumerator ScreenPointsProjectOntoTheFieldPlane()
        {
            var ctrl = Controller();
            yield return null;
            var cam = Camera.main;
            var receive = FirstTouchController.ToWorld(FirstTouchDrill.ReceivePoint);
            var screen = cam.WorldToScreenPoint(receive);
            Assert.That(ctrl.ScreenToDrill(screen, out var p), Is.True);
            Assert.That(p.X, Is.EqualTo(FirstTouchDrill.ReceivePoint.X).Within(0.05));
            Assert.That(p.Y, Is.EqualTo(FirstTouchDrill.ReceivePoint.Y).Within(0.05));
        }
    }
}
