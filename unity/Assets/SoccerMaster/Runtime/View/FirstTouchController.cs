using System.Collections.Generic;
using SoccerMaster.Core.Sim;
using SoccerMaster.Core.Training;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.UI;

namespace SoccerMaster.View
{
    /// <summary>
    /// Scene adapter for <see cref="FirstTouchDrill"/> (port of src/training/firstTouch.ts).
    /// The drill owns every decision, execution and outcome; this component only forwards
    /// wall-clock time and raw touch points into it and mirrors its state onto transforms/UI.
    /// Drill coordinates are yards on a 24x18 area; world X = drill x, world Z = drill y.
    /// </summary>
    public sealed class FirstTouchController : MonoBehaviour
    {
        [Header("Drill")]
        [SerializeField] private int seed = 7;
        [SerializeField] private int reps = 6;
        [SerializeField] private bool accessible;
        [SerializeField] private bool autoStart = true;

        [Header("Scene bindings")]
        [SerializeField] private Camera worldCamera;
        [SerializeField] private Transform ball;
        [SerializeField] private Transform player;
        [SerializeField] private Transform defender;
        [SerializeField] private Transform[] gateMarkers = new Transform[3];
        [SerializeField] private Text statusText;
        [SerializeField] private Image windowBar;

        private readonly List<Vec2D> _stroke = new List<Vec2D>(64);
        private bool _pointerDown;
        private FirstTouchDrill _drill;

        public FirstTouchDrill Drill => _drill;
        public IReadOnlyList<DrillEvent> LastEvents { get; private set; } = new List<DrillEvent>();
        public int TotalEvents { get; private set; }

        public void StartDrill(int drillSeed, int drillReps, bool accessibleMode)
        {
            seed = drillSeed;
            reps = drillReps;
            accessible = accessibleMode;
            _drill = new FirstTouchDrill(seed, reps, accessible);
            _stroke.Clear();
            _pointerDown = false;
            TotalEvents = 0;
            Mirror();
        }

        /// <summary>Attach scene objects (normally from <see cref="FirstTouchRig"/>) and mirror the current state onto them.</summary>
        public void Bind(Camera camera, Transform ballT, Transform playerT, Transform defenderT, Transform[] gates, Text status, Image bar)
        {
            worldCamera = camera;
            ball = ballT;
            player = playerT;
            defender = defenderT;
            gateMarkers = gates ?? new Transform[0];
            statusText = status;
            windowBar = bar;
            Mirror();
        }

        private void Awake()
        {
            if (worldCamera == null) worldCamera = Camera.main;
            if (autoStart) StartDrill(seed, reps, accessible);
        }

        private void Update()
        {
            if (_drill == null) return;
            ReadPointer();
            Advance(Time.unscaledDeltaTime * 1000.0);
        }

        /// <summary>Advance the canonical drill by real milliseconds (the drill applies its own slow-motion scale).</summary>
        public void Advance(double realDtMs)
        {
            if (_drill == null) return;
            var events = _drill.Step(realDtMs);
            LastEvents = events;
            TotalEvents += events.Count;
            Mirror();
        }

        /// <summary>Feed a completed touch path (drill yards). Taps and drawings both route through the drill's readers.</summary>
        public RepRecord SubmitStroke(IReadOnlyList<Vec2D> points)
        {
            if (_drill == null || points.Count == 0) return null;
            var read = points.Count == 1
                ? FirstTouchDrill.ReadTap(points[0])
                : FirstTouchDrill.ReadDraw(points);
            if (read.Gate == null) return null;
            var rec = _drill.CommitGate(read.Gate.Value, read.Accuracy);
            Mirror();
            return rec;
        }

        /// <summary>Convert a screen pixel to drill yards by intersecting the camera ray with the field plane (y = 0).</summary>
        public bool ScreenToDrill(Vector2 screen, out Vec2D drillPoint)
        {
            drillPoint = default;
            if (worldCamera == null) return false;
            var ray = worldCamera.ScreenPointToRay(screen);
            var plane = new Plane(Vector3.up, Vector3.zero);
            if (!plane.Raycast(ray, out var enter)) return false;
            var hit = ray.GetPoint(enter);
            drillPoint = new Vec2D(hit.x, hit.z);
            return true;
        }

        public static Vector3 ToWorld(Vec2D p, float height = 0f) => new Vector3((float)p.X, height, (float)p.Y);

        private void ReadPointer()
        {
            var pointer = Pointer.current;
            if (pointer == null) return;
            var pressed = pointer.press.isPressed;
            if (pressed)
            {
                if (ScreenToDrill(pointer.position.ReadValue(), out var p))
                {
                    if (!_pointerDown) _stroke.Clear();
                    if (_stroke.Count == 0 || Vec2D.Dist(_stroke[_stroke.Count - 1], p) > 0.05)
                        _stroke.Add(p);
                }
                _pointerDown = true;
            }
            else if (_pointerDown)
            {
                _pointerDown = false;
                if (_stroke.Count > 0) SubmitStroke(new List<Vec2D>(_stroke));
                _stroke.Clear();
            }
        }

        private void Mirror()
        {
            if (_drill == null) return;
            if (ball != null) ball.position = ToWorld(_drill.BallPos, 0.11f);
            if (player != null) player.position = ToWorld(_drill.Player);
            if (defender != null) defender.position = ToWorld(_drill.DefenderPos);
            for (var i = 0; i < gateMarkers.Length && i < FirstTouchDrill.Gates.Count; i++)
            {
                if (gateMarkers[i] == null) continue;
                var g = FirstTouchDrill.Gates[i];
                gateMarkers[i].position = ToWorld(g.Center, 0.01f);
                var span = Vec2D.Sub(g.B, g.A);
                gateMarkers[i].rotation = Quaternion.LookRotation(new Vector3((float)span.X, 0f, (float)span.Y), Vector3.up);
                gateMarkers[i].localScale = new Vector3(0.15f, 0.02f, (float)Vec2D.Len(span));
            }
            if (windowBar != null) windowBar.fillAmount = (float)_drill.WindowProgress;
            if (statusText != null) statusText.text = StatusLine();
        }

        private string StatusLine()
        {
            var d = _drill;
            var rep = Mathf.Clamp(d.Index + 1, 1, d.Reps);
            switch (d.Phase)
            {
                case Phase.Window:
                    return $"Rep {rep}/{d.Reps}  READ  {d.WindowLimitMs - d.WindowOpenMs:0}ms";
                case Phase.Resolve:
                    return $"Rep {rep}/{d.Reps}  {FirstTouchDrill.Name(d.Current.Decision)} / {FirstTouchDrill.Name(d.Current.Execution)}";
                case Phase.Between:
                    return $"Rep {rep}/{d.Reps}  {FirstTouchDrill.Name(d.Current.Outcome)}";
                case Phase.Done:
                {
                    var s = d.Summarize();
                    return $"DONE  reads {FirstTouchDrill.Name(s.Reads)}  touch {FirstTouchDrill.Name(s.Touch)}  through {s.Through}/{s.Reps}";
                }
                default:
                    return $"Rep {rep}/{d.Reps}  serve";
            }
        }
    }
}
