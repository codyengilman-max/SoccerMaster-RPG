using System.Collections.Generic;
using System.Text;
using SoccerMaster.Core.Director;
using SoccerMaster.Core.Sim;
using SoccerMaster.Core.Tactics;
using UnityEngine;
using UnityEngine.UI;

namespace SoccerMaster.View
{
    /// <summary>
    /// Builds the TacticalMoment scene at runtime (camera, 9v9 field, 18 markers, ball, option paths,
    /// safe-area HUD with exactly four answer controls, feedback panel, next control, build identity)
    /// and mirrors <see cref="MatchRuntime"/> onto it every frame. Everything here is presentation:
    /// it reads runtime/canonical state and draws it; recognition, ranking and grading live in Core.
    /// Camera zoom and the fast-forward veil are the cinematic language of the loop, not game state.
    /// </summary>
    [DefaultExecutionOrder(-100)]
    [RequireComponent(typeof(TacticalMomentController))]
    public sealed class TacticalMomentRig : MonoBehaviour
    {
        public const int AnswerCount = 4;
        public const string AnswerName = "Answer";
        public const string NextName = "Next";
        public const string SkipName = "Skip";
        public const string NewMatchName = "NewMatch";
        public const string IdentityName = "BuildIdentity";

        public static readonly Color YouKit = new Color(0.10f, 0.16f, 0.36f);
        public static readonly Color YouKeeper = new Color(0.95f, 0.55f, 0.10f);
        public static readonly Color OppKit = new Color(0.93f, 0.93f, 0.93f);
        public static readonly Color OppKeeper = new Color(0.15f, 0.70f, 0.65f);
        public static readonly Color Grass = new Color(0.19f, 0.50f, 0.24f);
        public static readonly Color GrassBand = new Color(0.17f, 0.46f, 0.22f);
        public static readonly Color Lines = new Color(0.95f, 0.97f, 0.95f);
        public static readonly Color Backdrop = new Color(0.05f, 0.08f, 0.12f);
        public static readonly Color PanelColor = new Color(0.07f, 0.10f, 0.15f, 0.92f);
        public static readonly Color Veil = new Color(0.03f, 0.05f, 0.08f, 0.55f);
        public static readonly Color Accent = new Color(1f, 0.85f, 0.25f);
        public static readonly Color Muted = new Color(0.72f, 0.76f, 0.82f);
        public static readonly Color[] OptionColors =
        {
            new Color(1f, 0.85f, 0.25f), new Color(0.35f, 0.80f, 1f), new Color(0.55f, 0.95f, 0.55f), new Color(1f, 0.55f, 0.75f),
        };

        public const float WideMargin = 4f;
        public const float ZoomSize = 22f;
        public const float CameraLerp = 6f;

        public Camera Camera { get; private set; }
        public RectTransform SafeArea { get; private set; }
        public Button[] Answers { get; private set; }
        public Button Next { get; private set; }
        public Button Skip { get; private set; }
        public Button NewMatch { get; private set; }
        public Text Identity { get; private set; }
        public BuildIdentity Build { get; private set; }

        private TacticalMomentController _ctrl;
        private Transform[] _markers;
        private TextMesh[] _numbers;
        private Color[] _markerColors;
        private Transform _ball;
        private Transform _ring;
        private LineRenderer[] _paths;
        private Rect _lastSafe;

        private Text _score, _clock, _momentCount, _phaseLabel, _title, _question, _cues, _feedbackTitle, _feedbackBody, _finishedBody;
        private Text[] _answerLabels;
        private Image _timerBar, _leadInBar, _veil;
        private GameObject _questionPanel, _feedbackPanel, _veilPanel, _finishedPanel, _halfTimePanel;
        private Font _font;
        private Vector3 _camTarget;
        private float _camSize;

        private void Awake()
        {
            _ctrl = GetComponent<TacticalMomentController>();
            Build = BuildIdentity.Load();
            BuildScene();
        }

        private void LateUpdate()
        {
            ApplySafeArea();
            Mirror(Time.unscaledDeltaTime);
        }

        // ───────────────────────────── construction ─────────────────────────────

        private void BuildScene()
        {
            if (Camera != null) return;
            _font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            Rules rules = Rules.U11_9v9();
            var length = (float)rules.Length;
            var width = (float)rules.Width;

            Camera = Camera.main;
            if (Camera == null)
            {
                var camGo = new GameObject("Main Camera") { tag = "MainCamera" };
                Camera = camGo.AddComponent<Camera>();
                camGo.AddComponent<AudioListener>();
            }
            Camera.clearFlags = CameraClearFlags.SolidColor;
            Camera.backgroundColor = Backdrop;
            Camera.orthographic = true;
            _camSize = WideSize(length, width);
            _camTarget = new Vector3(length * 0.5f, 40f, width * 0.5f);
            Camera.orthographicSize = _camSize;
            Camera.transform.SetPositionAndRotation(_camTarget, Quaternion.Euler(90f, -90f, 0f));

            if (FindFirstObjectByType<Light>() == null)
            {
                var light = new GameObject("Sun").AddComponent<Light>();
                light.type = LightType.Directional;
                light.intensity = 1.1f;
                light.transform.rotation = Quaternion.Euler(55f, 25f, 0f);
            }

            BuildField(rules);
            BuildActors(rules);
            BuildHud();
        }

        private static float WideSize(float length, float width)
        {
            float aspect = Screen.height > 0 ? (float)Screen.width / Screen.height : 0.46f;
            return Mathf.Max(length * 0.5f + WideMargin, (width * 0.5f + WideMargin) / Mathf.Max(0.3f, aspect));
        }

        private void BuildField(Rules rules)
        {
            var length = (float)rules.Length;
            var width = (float)rules.Width;
            var root = new GameObject("Field").transform;

            var field = GameObject.CreatePrimitive(PrimitiveType.Plane);
            field.name = "Grass";
            field.transform.SetParent(root, false);
            field.transform.position = new Vector3(length * 0.5f, 0f, width * 0.5f);
            field.transform.localScale = new Vector3((length + 8f) / 10f, 1f, (width + 8f) / 10f);
            Tint(field, Grass);
            const int bands = 10;
            for (int i = 0; i < bands; i += 2)
            {
                var band = GameObject.CreatePrimitive(PrimitiveType.Cube);
                band.name = "Band";
                band.transform.SetParent(root, false);
                float x0 = length * i / bands;
                band.transform.position = new Vector3(x0 + length / bands * 0.5f, 0.005f, width * 0.5f);
                band.transform.localScale = new Vector3(length / bands, 0.01f, width);
                Destroy(band.GetComponent<Collider>());
                Tint(band, GrassBand);
            }

            void Line(string name, float x0, float z0, float x1, float z1)
            {
                var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
                go.name = name;
                go.transform.SetParent(root, false);
                Destroy(go.GetComponent<Collider>());
                var a = new Vector3(x0, 0.02f, z0);
                var b = new Vector3(x1, 0.02f, z1);
                go.transform.position = (a + b) * 0.5f;
                var d = b - a;
                go.transform.rotation = d.sqrMagnitude > 0 ? Quaternion.LookRotation(d, Vector3.up) : Quaternion.identity;
                go.transform.localScale = new Vector3(0.18f, 0.02f, d.magnitude + 0.18f);
                Tint(go, Lines);
            }

            Line("Touchline", 0, 0, length, 0);
            Line("Touchline", 0, width, length, width);
            Line("Goalline", 0, 0, 0, width);
            Line("Goalline", length, 0, length, width);
            Line("Halfway", length * 0.5f, 0, length * 0.5f, width);
            var pd = (float)rules.PenaltyAreaDepth;
            var pw = (float)rules.PenaltyAreaWidth;
            var gd = (float)rules.GoalAreaDepth;
            var gw = (float)rules.GoalAreaWidth;
            foreach (var end in new[] { 0f, length })
            {
                float dir = end == 0f ? 1f : -1f;
                Box("PenaltyArea", end, end + dir * pd, (width - pw) * 0.5f, (width + pw) * 0.5f);
                Box("GoalArea", end, end + dir * gd, (width - gw) * 0.5f, (width + gw) * 0.5f);
                var goal = GameObject.CreatePrimitive(PrimitiveType.Cube);
                goal.name = "Goal";
                goal.transform.SetParent(root, false);
                Destroy(goal.GetComponent<Collider>());
                goal.transform.position = new Vector3(end - dir * 0.6f, 0.4f, width * 0.5f);
                goal.transform.localScale = new Vector3(1.2f, 0.8f, (float)rules.GoalWidth);
                Tint(goal, Lines);
            }
            var circle = new GameObject("CentreCircle").AddComponent<LineRenderer>();
            circle.transform.SetParent(root, false);
            SetupLine(circle, Lines, 0.18f);
            circle.loop = true;
            const int segs = 48;
            circle.positionCount = segs;
            var r = (float)rules.CenterCircleRadius;
            for (int i = 0; i < segs; i++)
            {
                float a = i * Mathf.PI * 2f / segs;
                circle.SetPosition(i, new Vector3(length * 0.5f + Mathf.Cos(a) * r, 0.03f, width * 0.5f + Mathf.Sin(a) * r));
            }

            void Box(string name, float x0, float x1, float z0, float z1)
            {
                Line(name, x0, z0, x1, z0);
                Line(name, x0, z1, x1, z1);
                Line(name, x1, z0, x1, z1);
            }
        }

        private void BuildActors(Rules rules)
        {
            int n = rules.PlayersPerSide * 2;
            _markers = new Transform[n];
            _numbers = new TextMesh[n];
            _markerColors = new Color[n];
            var root = new GameObject("Players").transform;
            for (int i = 0; i < n; i++)
            {
                var marker = GameObject.CreatePrimitive(PrimitiveType.Capsule);
                marker.name = "Player " + i;
                marker.transform.SetParent(root, false);
                marker.transform.localScale = new Vector3(1.4f, 0.9f, 1.4f);
                Destroy(marker.GetComponent<Collider>());
                _markers[i] = marker.transform;

                var label = new GameObject("Number").AddComponent<TextMesh>();
                label.transform.SetParent(marker.transform, false);
                label.transform.localPosition = new Vector3(0f, 1.2f, 0f);
                label.transform.localRotation = Quaternion.Euler(90f, -90f, 0f);
                label.transform.localScale = new Vector3(1f / 1.4f, 1f / 0.9f, 1f / 1.4f);
                label.font = _font;
                label.fontSize = 48;
                label.characterSize = 0.06f;
                label.anchor = TextAnchor.MiddleCenter;
                label.alignment = TextAlignment.Center;
                label.color = Color.white;
                label.GetComponent<MeshRenderer>().sharedMaterial = _font.material;
                _numbers[i] = label;
            }

            var ring = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            ring.name = "YouRing";
            ring.transform.localScale = new Vector3(2.6f, 0.02f, 2.6f);
            Destroy(ring.GetComponent<Collider>());
            Tint(ring, Accent);
            _ring = ring.transform;

            var ball = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            ball.name = "Ball";
            ball.transform.localScale = Vector3.one * 0.6f;
            Destroy(ball.GetComponent<Collider>());
            Tint(ball, Color.white);
            _ball = ball.transform;

            _paths = new LineRenderer[AnswerCount];
            for (int i = 0; i < AnswerCount; i++)
            {
                var lr = new GameObject("OptionPath " + i).AddComponent<LineRenderer>();
                SetupLine(lr, OptionColors[i], 0.35f);
                lr.positionCount = 2;
                lr.enabled = false;
                _paths[i] = lr;
            }
        }

        private void BuildHud()
        {
            var canvasGo = new GameObject("HUD", typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
            var canvas = canvasGo.GetComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            var scaler = canvasGo.GetComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(390f, 844f);
            scaler.matchWidthOrHeight = 0.5f;
            if (FindFirstObjectByType<UnityEngine.EventSystems.EventSystem>() == null)
            {
                var es = new GameObject("EventSystem", typeof(UnityEngine.EventSystems.EventSystem));
                es.AddComponent<UnityEngine.InputSystem.UI.InputSystemUIInputModule>();
            }

            // Fast-forward veil sits under the safe area so it covers the whole screen.
            _veilPanel = Panel("Veil", canvasGo.transform, Veil, Vector2.zero, Vector2.one, Vector2.zero, Vector2.zero);
            _veil = _veilPanel.GetComponent<Image>();
            _veil.raycastTarget = false;
            var veilText = Label("VeilText", _veilPanel.transform, "FAST FORWARD  ▶▶", 20, Muted, TextAnchor.MiddleCenter);
            Stretch(veilText.rectTransform, new Vector2(0f, 0.55f), new Vector2(1f, 0.62f));

            SafeArea = new GameObject("SafeArea", typeof(RectTransform)).GetComponent<RectTransform>();
            SafeArea.SetParent(canvasGo.transform, false);
            Stretch(SafeArea, Vector2.zero, Vector2.one);

            // Top HUD: score · clock · moment counter · phase.
            var top = Panel("TopBar", SafeArea, PanelColor, new Vector2(0f, 1f), new Vector2(1f, 1f), new Vector2(0f, -96f), new Vector2(0f, 0f));
            _score = Label("Score", top.transform, "YOU 0 – 0 OPP", 24, Color.white, TextAnchor.MiddleLeft);
            Stretch(_score.rectTransform, new Vector2(0f, 0.5f), new Vector2(0.6f, 1f), new Vector2(16f, 0f), new Vector2(0f, -6f));
            _clock = Label("Clock", top.transform, "00:00 · 1st", 18, Muted, TextAnchor.MiddleRight);
            Stretch(_clock.rectTransform, new Vector2(0.5f, 0.5f), new Vector2(1f, 1f), new Vector2(0f, 0f), new Vector2(-16f, -6f));
            _momentCount = Label("MomentCount", top.transform, "MOMENT 0 OF ~18", 14, Accent, TextAnchor.MiddleLeft);
            Stretch(_momentCount.rectTransform, new Vector2(0f, 0f), new Vector2(0.6f, 0.5f), new Vector2(16f, 6f), new Vector2(0f, 0f));
            _phaseLabel = Label("Phase", top.transform, "FAST FORWARD", 14, Muted, TextAnchor.MiddleRight);
            Stretch(_phaseLabel.rectTransform, new Vector2(0.4f, 0f), new Vector2(1f, 0.5f), new Vector2(0f, 6f), new Vector2(-16f, 0f));
            _timerBar = Bar("TimerBar", SafeArea, Accent, -100f);
            _leadInBar = Bar("LeadInBar", SafeArea, Muted, -100f);

            // Question panel: title, question, four answers, cues.
            _questionPanel = Panel("QuestionPanel", SafeArea, PanelColor, new Vector2(0f, 0f), new Vector2(1f, 0f), new Vector2(0f, 0f), new Vector2(0f, 400f));
            _title = Label("Title", _questionPanel.transform, "", 15, Accent, TextAnchor.MiddleLeft);
            Stretch(_title.rectTransform, new Vector2(0f, 1f), new Vector2(1f, 1f), new Vector2(16f, -34f), new Vector2(-16f, -10f));
            _question = Label("Question", _questionPanel.transform, "", 19, Color.white, TextAnchor.UpperLeft);
            _question.horizontalOverflow = HorizontalWrapMode.Wrap;
            Stretch(_question.rectTransform, new Vector2(0f, 1f), new Vector2(1f, 1f), new Vector2(16f, -90f), new Vector2(-16f, -36f));
            Answers = new Button[AnswerCount];
            _answerLabels = new Text[AnswerCount];
            for (int i = 0; i < AnswerCount; i++)
            {
                int index = i;
                float top0 = -96f - i * 62f;
                Answers[i] = ButtonControl(AnswerName + " " + i, _questionPanel.transform, "", OptionColors[i], out _answerLabels[i]);
                Stretch(((RectTransform)Answers[i].transform), new Vector2(0f, 1f), new Vector2(1f, 1f), new Vector2(16f, top0 - 54f), new Vector2(-16f, top0));
                Answers[i].onClick.AddListener(() => _ctrl.Choose(index));
            }
            _cues = Label("Cues", _questionPanel.transform, "", 13, Muted, TextAnchor.UpperLeft);
            _cues.horizontalOverflow = HorizontalWrapMode.Wrap;
            Stretch(_cues.rectTransform, new Vector2(0f, 0f), new Vector2(1f, 0f), new Vector2(16f, 8f), new Vector2(-16f, 52f));

            // Feedback panel: decision / execution / outcome + next.
            _feedbackPanel = Panel("FeedbackPanel", SafeArea, PanelColor, new Vector2(0f, 0f), new Vector2(1f, 0f), new Vector2(0f, 0f), new Vector2(0f, 300f));
            _feedbackTitle = Label("FeedbackTitle", _feedbackPanel.transform, "", 17, Accent, TextAnchor.MiddleLeft);
            Stretch(_feedbackTitle.rectTransform, new Vector2(0f, 1f), new Vector2(1f, 1f), new Vector2(16f, -40f), new Vector2(-16f, -10f));
            _feedbackBody = Label("FeedbackBody", _feedbackPanel.transform, "", 15, Color.white, TextAnchor.UpperLeft);
            _feedbackBody.horizontalOverflow = HorizontalWrapMode.Wrap;
            Stretch(_feedbackBody.rectTransform, new Vector2(0f, 0f), new Vector2(1f, 1f), new Vector2(16f, 76f), new Vector2(-16f, -44f));
            Next = ButtonControl(NextName, _feedbackPanel.transform, "NEXT MOMENT  ▶", Accent, out _);
            Stretch((RectTransform)Next.transform, new Vector2(0f, 0f), new Vector2(1f, 0f), new Vector2(16f, 12f), new Vector2(-16f, 66f));
            Next.onClick.AddListener(() => _ctrl.Continue());

            // Lead-in skip.
            Skip = ButtonControl(SkipName, SafeArea, "SKIP  ▶▶", Muted, out _);
            Stretch((RectTransform)Skip.transform, new Vector2(0.55f, 0f), new Vector2(1f, 0f), new Vector2(0f, 40f), new Vector2(-16f, 88f));
            Skip.onClick.AddListener(() => _ctrl.SkipLeadIn());

            _halfTimePanel = Panel("HalfTime", SafeArea, PanelColor, new Vector2(0f, 0.45f), new Vector2(1f, 0.55f), Vector2.zero, Vector2.zero);
            var ht = Label("HalfTimeText", _halfTimePanel.transform, "HALF TIME", 28, Color.white, TextAnchor.MiddleCenter);
            Stretch(ht.rectTransform, Vector2.zero, Vector2.one);

            _finishedPanel = Panel("Finished", SafeArea, PanelColor, new Vector2(0f, 0f), new Vector2(1f, 0f), new Vector2(0f, 0f), new Vector2(0f, 260f));
            var ft = Label("FinishedTitle", _finishedPanel.transform, "FULL TIME", 26, Accent, TextAnchor.MiddleLeft);
            Stretch(ft.rectTransform, new Vector2(0f, 1f), new Vector2(1f, 1f), new Vector2(16f, -50f), new Vector2(-16f, -10f));
            _finishedBody = Label("FinishedBody", _finishedPanel.transform, "", 15, Color.white, TextAnchor.UpperLeft);
            _finishedBody.horizontalOverflow = HorizontalWrapMode.Wrap;
            Stretch(_finishedBody.rectTransform, new Vector2(0f, 0f), new Vector2(1f, 1f), new Vector2(16f, 76f), new Vector2(-16f, -54f));
            NewMatch = ButtonControl(NewMatchName, _finishedPanel.transform, "PLAY ANOTHER MATCH", Accent, out _);
            Stretch((RectTransform)NewMatch.transform, new Vector2(0f, 0f), new Vector2(1f, 0f), new Vector2(16f, 12f), new Vector2(-16f, 66f));
            NewMatch.onClick.AddListener(() =>
            {
                _ctrl.DeleteSave();
                _ctrl.NewMatch(_ctrl.Seed + 1, _ctrl.RoleId);
            });

            Identity = Label(IdentityName, SafeArea, Build.Line, 11, new Color(0.6f, 0.65f, 0.72f, 0.9f), TextAnchor.LowerLeft);
            Identity.raycastTarget = false;
            Stretch(Identity.rectTransform, new Vector2(0f, 0f), new Vector2(1f, 0f), new Vector2(8f, 2f), new Vector2(-8f, 18f));

            _questionPanel.SetActive(false);
            _feedbackPanel.SetActive(false);
            _finishedPanel.SetActive(false);
            _halfTimePanel.SetActive(false);
            Skip.gameObject.SetActive(false);
        }

        // ───────────────────────────── mirroring ─────────────────────────────

        /// <summary>Redraw from the runtime. Public so headless/PlayMode tests can force a frame.</summary>
        public void Mirror(float realDt)
        {
            MatchRuntime rt = _ctrl.Runtime;
            if (rt == null) return;
            MatchState s = rt.State;
            FieldView view = rt.View();
            string youId = s.Controlled?.PlayerId;
            int youIndex = -1;

            for (int i = 0; i < _markers.Length && i < s.Players.Count; i++)
            {
                PlayerState p = s.Players[i];
                _markers[i].position = ToWorld(view.Pos[i], 0.45f);
                bool keeper = p.Role == 1;
                Color kit = p.Side == Side.Home ? (keeper ? YouKeeper : YouKit) : (keeper ? OppKeeper : OppKit);
                if (_markerColors[i] != kit)
                {
                    _markerColors[i] = kit;
                    Tint(_markers[i].gameObject, kit);
                }
                _numbers[i].text = p.Role.ToString();
                _numbers[i].color = p.Side == Side.Home ? Color.white : new Color(0.1f, 0.12f, 0.16f);
                if (p.Id == youId) youIndex = i;
            }
            _ball.position = ToWorld(view.BallPos, 0.3f);
            if (youIndex >= 0) _ring.position = ToWorld(view.Pos[youIndex], 0.02f);

            DrawPaths(rt, view, youIndex);
            MoveCamera(rt, view, youIndex, realDt);
            DrawHud(rt, view);
        }

        private void DrawPaths(MatchRuntime rt, FieldView view, int youIndex)
        {
            ActiveMoment a = rt.Active;
            bool showAll = rt.QuestionOpen;
            bool showChosen = a != null && (rt.Phase == RuntimePhase.Resolving || rt.Phase == RuntimePhase.Feedback) && a.Result?.Acted != null;
            for (int i = 0; i < _paths.Length; i++)
            {
                LineRenderer lr = _paths[i];
                TacticalOption opt = a != null && i < a.Moment.Options.Count ? a.Moment.Options[i] : null;
                bool visible = opt != null && youIndex >= 0 && (showAll || (showChosen && a.Result.Acted.OptionId == opt.Id));
                if (visible)
                {
                    Vec2D from = view.Pos[youIndex];
                    Vec2D? to = Endpoint(rt.State, opt.Command, from);
                    visible = to.HasValue;
                    if (visible)
                    {
                        lr.SetPosition(0, ToWorld(from, 0.08f));
                        lr.SetPosition(1, ToWorld(to.Value, 0.08f));
                    }
                }
                lr.enabled = visible;
            }
        }

        /// <summary>Where a command's intent points on the field, for drawing only (null for hold/no-target intents).</summary>
        public static Vec2D? Endpoint(MatchState s, PlayerCommand cmd, Vec2D from)
        {
            if (cmd == null) return null;
            switch (cmd.Type)
            {
                case CommandType.Pass:
                case CommandType.Shoot:
                case CommandType.Move:
                case CommandType.FirstTouch:
                    return cmd.Target;
                case CommandType.Carry:
                    return Vec2D.Add(from, Vec2D.Scale(cmd.Direction, cmd.Distance));
                case CommandType.Press:
                    return Find(s, cmd.TargetId)?.Pos;
                case CommandType.Screen:
                    return Find(s, cmd.ToId)?.Pos;
                default:
                    return null;
            }
        }

        private static PlayerState Find(MatchState s, string id)
        {
            if (id == null) return null;
            foreach (PlayerState p in s.Players) if (p.Id == id) return p;
            return null;
        }

        private void MoveCamera(MatchRuntime rt, FieldView view, int youIndex, float dt)
        {
            Rules rules = rt.State.Rules;
            var length = (float)rules.Length;
            var width = (float)rules.Width;
            float wide = WideSize(length, width);
            Vector3 centre = new Vector3(length * 0.5f, 40f, width * 0.5f);
            float size = wide;
            Vector3 target = centre;
            if (youIndex >= 0 && rt.Phase != RuntimePhase.Routine && rt.Phase != RuntimePhase.HalfTime && rt.Phase != RuntimePhase.Finished)
            {
                Vec2D focus = Vec2D.Lerp(view.Pos[youIndex], view.BallPos, 0.35);
                float t = rt.Phase == RuntimePhase.LeadIn ? Mathf.SmoothStep(0f, 1f, (float)rt.LeadInProgress()) : 1f;
                size = Mathf.Lerp(wide, ZoomSize, t);
                float aspect = Camera.aspect;
                float halfW = size * aspect;
                float x = Mathf.Clamp((float)focus.X, halfW - WideMargin, length - halfW + WideMargin);
                float z = Mathf.Clamp((float)focus.Y, size * 0.35f - WideMargin, width - size * 0.35f + WideMargin);
                if (halfW * 2f >= length + WideMargin) x = length * 0.5f;
                target = Vector3.Lerp(centre, new Vector3(x, 40f, z), t);
            }
            float k = 1f - Mathf.Exp(-CameraLerp * Mathf.Max(0f, dt));
            _camSize = Mathf.Lerp(_camSize, size, k);
            _camTarget = Vector3.Lerp(_camTarget, target, k);
            Camera.orthographicSize = _camSize;
            Camera.transform.position = _camTarget;
        }

        private void DrawHud(MatchRuntime rt, FieldView view)
        {
            MatchState s = rt.State;
            _score.text = $"YOU {s.Score.Home} – {s.Score.Away} OPP";
            _clock.text = $"{ClockText(view.TimeMs)} · {(s.Clock.Half >= 2 ? "2nd" : "1st")}";
            int done = rt.Session.Records.Count;
            int current = rt.Active != null ? done + 1 : done;
            _momentCount.text = $"MOMENT {Mathf.Max(current, rt.Active != null ? 1 : 0)} OF ~{PacingConfig.DirectRange[1]}";
            _phaseLabel.text = PhaseText(rt.Phase);

            bool routine = rt.Phase == RuntimePhase.Routine;
            _veilPanel.SetActive(routine);
            _halfTimePanel.SetActive(rt.Phase == RuntimePhase.HalfTime);
            Skip.gameObject.SetActive(rt.Phase == RuntimePhase.LeadIn);
            _leadInBar.gameObject.SetActive(rt.Phase == RuntimePhase.LeadIn);
            _leadInBar.fillAmount = (float)rt.LeadInProgress();
            _timerBar.gameObject.SetActive(rt.QuestionOpen);
            _timerBar.fillAmount = 1f - (float)rt.TimerProgress();

            bool question = rt.QuestionOpen;
            _questionPanel.SetActive(question);
            if (question)
            {
                TacticalMoment m = rt.Active.Moment;
                _title.text = $"{m.Title.ToUpperInvariant()}  ·  {m.Difficulty?.Band?.ToUpperInvariant() ?? ""}{(m.Major ? "  ·  BIG MOMENT" : "")}";
                _question.text = MatchRuntime.QuestionFor(m);
                bool armed = rt.Phase == RuntimePhase.Timer;
                for (int i = 0; i < AnswerCount; i++)
                {
                    TacticalOption o = i < m.Options.Count ? m.Options[i] : null;
                    Answers[i].gameObject.SetActive(o != null);
                    Answers[i].interactable = o != null && armed;
                    if (o != null) _answerLabels[i].text = o.Label;
                }
                _cues.text = m.Cues.Count > 0 ? "Read: " + string.Join(" · ", m.Cues) : (armed ? "" : "Camera settling…");
            }

            bool feedback = rt.Phase == RuntimePhase.Feedback && rt.Active?.Record != null;
            _feedbackPanel.SetActive(feedback);
            if (feedback) FillFeedback(rt.Active);

            bool finished = rt.Phase == RuntimePhase.Finished;
            _finishedPanel.SetActive(finished);
            if (finished) _finishedBody.text = Summary(rt);
        }

        private void FillFeedback(ActiveMoment a)
        {
            MomentRecord r = a.Record;
            DecisionRecord d = r.Decision;
            ExecutionRecord x = r.Execution;
            OutcomeRecord o = r.Outcome;
            string decision = d.Quality.HasValue ? $"{d.Band} ({Mathf.RoundToInt((float)(d.Quality.Value * 100))})" : d.Band;
            _feedbackTitle.text = $"{r.Moment.Title.ToUpperInvariant()}  ·  {(o != null ? o.Result.ToUpperInvariant() : "…")}";
            var sb = new StringBuilder();
            sb.Append("Decision: ").Append(decision);
            if (r.Acted != null) sb.Append("  ·  by ").Append(r.Acted.Actor);
            sb.Append('\n');
            sb.Append("Execution: ").Append(x != null ? $"{x.Band} ({Mathf.RoundToInt((float)(x.Quality * 100))})" : "—").Append('\n');
            sb.Append("Outcome: ").Append(o != null ? o.Summary : "—");
            if (a.Feedback != null)
                foreach (string line in a.Feedback) sb.Append('\n').Append("• ").Append(line);
            _feedbackBody.text = sb.ToString();
        }

        private static string Summary(MatchRuntime rt)
        {
            int n = rt.Session.Records.Count, graded = 0, success = 0;
            double q = 0;
            foreach (MomentRecord r in rt.Session.Records)
            {
                if (r.Decision?.Quality != null) { graded++; q += r.Decision.Quality.Value; }
                if (r.Outcome?.Result == "success") success++;
            }
            string avg = graded > 0 ? Mathf.RoundToInt((float)(q / graded * 100)).ToString() : "—";
            return $"YOU {rt.State.Score.Home} – {rt.State.Score.Away} OPP\n{n} moments · {graded} decided · average decision {avg} · {success} came off";
        }

        public static string ClockText(double timeMs)
        {
            int total = Mathf.Max(0, Mathf.FloorToInt((float)(timeMs / 1000)));
            return $"{total / 60:00}:{total % 60:00}";
        }

        public static string PhaseText(RuntimePhase p)
        {
            switch (p)
            {
                case RuntimePhase.Routine: return "FAST FORWARD";
                case RuntimePhase.LeadIn: return "WATCH";
                case RuntimePhase.Question: return "READ";
                case RuntimePhase.Timer: return "DECIDE";
                case RuntimePhase.Resolving: return "PLAY";
                case RuntimePhase.Feedback: return "FEEDBACK";
                case RuntimePhase.HalfTime: return "HALF TIME";
                default: return "FULL TIME";
            }
        }

        public static Vector3 ToWorld(Vec2D p, float height = 0f) => new Vector3((float)p.X, height, (float)p.Y);

        // ───────────────────────────── ui helpers ─────────────────────────────

        private void ApplySafeArea()
        {
            Rect safe = Screen.safeArea;
            if (safe == _lastSafe || Screen.width == 0 || Screen.height == 0) return;
            _lastSafe = safe;
            SafeArea.anchorMin = new Vector2(safe.xMin / Screen.width, safe.yMin / Screen.height);
            SafeArea.anchorMax = new Vector2(safe.xMax / Screen.width, safe.yMax / Screen.height);
            SafeArea.offsetMin = Vector2.zero;
            SafeArea.offsetMax = Vector2.zero;
        }

        private static void Stretch(RectTransform rt, Vector2 anchorMin, Vector2 anchorMax) => Stretch(rt, anchorMin, anchorMax, Vector2.zero, Vector2.zero);

        private static void Stretch(RectTransform rt, Vector2 anchorMin, Vector2 anchorMax, Vector2 offsetMin, Vector2 offsetMax)
        {
            rt.anchorMin = anchorMin;
            rt.anchorMax = anchorMax;
            rt.offsetMin = offsetMin;
            rt.offsetMax = offsetMax;
        }

        private static GameObject Panel(string name, Transform parent, Color color, Vector2 anchorMin, Vector2 anchorMax, Vector2 offsetMin, Vector2 offsetMax)
        {
            var go = new GameObject(name, typeof(Image));
            go.transform.SetParent(parent, false);
            go.GetComponent<Image>().color = color;
            Stretch((RectTransform)go.transform, anchorMin, anchorMax, offsetMin, offsetMax);
            return go;
        }

        private Text Label(string name, Transform parent, string text, int size, Color color, TextAnchor anchor)
        {
            var t = new GameObject(name, typeof(Text)).GetComponent<Text>();
            t.transform.SetParent(parent, false);
            t.font = _font;
            t.fontSize = size;
            t.color = color;
            t.alignment = anchor;
            t.text = text;
            t.raycastTarget = false;
            return t;
        }

        private Image Bar(string name, Transform parent, Color color, float y)
        {
            var bar = new GameObject(name, typeof(Image)).GetComponent<Image>();
            bar.transform.SetParent(parent, false);
            bar.color = color;
            bar.type = Image.Type.Filled;
            bar.fillMethod = Image.FillMethod.Horizontal;
            bar.fillAmount = 0f;
            bar.raycastTarget = false;
            Stretch(bar.rectTransform, new Vector2(0f, 1f), new Vector2(1f, 1f), new Vector2(16f, y - 6f), new Vector2(-16f, y));
            bar.gameObject.SetActive(false);
            return bar;
        }

        private Button ButtonControl(string name, Transform parent, string text, Color accent, out Text label)
        {
            var go = new GameObject(name, typeof(Image), typeof(Button));
            go.transform.SetParent(parent, false);
            var img = go.GetComponent<Image>();
            img.color = new Color(0.13f, 0.18f, 0.26f, 1f);
            var btn = go.GetComponent<Button>();
            var colors = btn.colors;
            colors.highlightedColor = new Color(0.20f, 0.27f, 0.38f);
            colors.pressedColor = accent;
            colors.disabledColor = new Color(0.13f, 0.18f, 0.26f, 0.5f);
            btn.colors = colors;
            var stripe = Panel("Stripe", go.transform, accent, new Vector2(0f, 0f), new Vector2(0f, 1f), new Vector2(0f, 0f), new Vector2(6f, 0f));
            stripe.GetComponent<Image>().raycastTarget = false;
            label = Label("Label", go.transform, text, 16, Color.white, TextAnchor.MiddleLeft);
            label.horizontalOverflow = HorizontalWrapMode.Wrap;
            Stretch(label.rectTransform, Vector2.zero, Vector2.one, new Vector2(18f, 4f), new Vector2(-12f, -4f));
            return btn;
        }

        private static void SetupLine(LineRenderer lr, Color color, float width)
        {
            lr.useWorldSpace = true;
            lr.startWidth = width;
            lr.endWidth = width;
            lr.material = new Material(Shader.Find("Sprites/Default"));
            lr.startColor = color;
            lr.endColor = color;
            lr.numCapVertices = 4;
        }

        /// <summary>Tints via a property block on the default material so no shader has to survive build stripping.</summary>
        private static void Tint(GameObject go, Color color)
        {
            var r = go.GetComponent<Renderer>();
            var block = new MaterialPropertyBlock();
            block.SetColor("_Color", color);
            block.SetColor("_BaseColor", color);
            r.SetPropertyBlock(block);
        }
    }
}
