using SoccerMaster.Core.Training;
using UnityEngine;
using UnityEngine.UI;

namespace SoccerMaster.View
{
    /// <summary>
    /// Builds the first-touch scene rig (camera, light, 24x18 field, ball, players, gates, HUD) at runtime
    /// and binds it to the <see cref="FirstTouchController"/> on the same GameObject. Keeping the rig in code
    /// means the committed scene is a single GameObject and no geometry lives in hand-edited YAML.
    /// Everything here is presentation: sizes come from FirstTouchDrill constants, nothing reasons about soccer.
    /// </summary>
    [DefaultExecutionOrder(-100)]
    [RequireComponent(typeof(FirstTouchController))]
    public sealed class FirstTouchRig : MonoBehaviour
    {
        public static readonly Color YouKit = new Color(0.10f, 0.16f, 0.36f);
        public static readonly Color OppKit = new Color(0.92f, 0.92f, 0.92f);
        public static readonly Color Grass = new Color(0.19f, 0.50f, 0.24f);
        public static readonly Color GateColor = new Color(1f, 0.85f, 0.25f);
        public static readonly Color Backdrop = new Color(0.07f, 0.10f, 0.14f);

        public Camera Camera { get; private set; }

        private void Awake()
        {
            Build(GetComponent<FirstTouchController>());
        }

        /// <summary>Creates the rig objects and binds them to <paramref name="controller"/>. Idempotent per rig.</summary>
        public void Build(FirstTouchController controller)
        {
            if (Camera != null) return;

            var length = (float)FirstTouchDrill.AreaLength;
            var width = (float)FirstTouchDrill.AreaWidth;

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
            Camera.orthographicSize = length * 0.5f + 1f;
            Camera.transform.SetPositionAndRotation(new Vector3(length * 0.5f, 30f, width * 0.5f), Quaternion.Euler(90f, -90f, 0f));

            if (FindFirstObjectByType<Light>() == null)
            {
                var light = new GameObject("Sun").AddComponent<Light>();
                light.type = LightType.Directional;
                light.intensity = 1.1f;
                light.transform.rotation = Quaternion.Euler(55f, 25f, 0f);
            }

            var field = GameObject.CreatePrimitive(PrimitiveType.Plane);
            field.name = "Field";
            field.transform.position = new Vector3(length * 0.5f, 0f, width * 0.5f);
            field.transform.localScale = new Vector3(length / 10f, 1f, width / 10f);
            Tint(field, Grass);

            var ball = Primitive(PrimitiveType.Sphere, "Ball", 0.22f, Color.white);
            var player = Primitive(PrimitiveType.Capsule, "Player", 0.9f, YouKit);
            var defender = Primitive(PrimitiveType.Capsule, "Defender", 0.9f, OppKit);
            var gates = new Transform[FirstTouchDrill.Gates.Count];
            for (var i = 0; i < gates.Length; i++)
                gates[i] = Primitive(PrimitiveType.Cube, "Gate " + FirstTouchDrill.Name(FirstTouchDrill.Gates[i].Id), 1f, GateColor).transform;

            var canvasGo = new GameObject("HUD", typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
            var canvas = canvasGo.GetComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            var scaler = canvasGo.GetComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(390f, 844f);
            scaler.matchWidthOrHeight = 0.5f;

            var status = new GameObject("Status", typeof(Text)).GetComponent<Text>();
            status.transform.SetParent(canvasGo.transform, false);
            status.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            status.fontSize = 22;
            status.alignment = TextAnchor.UpperCenter;
            status.color = Color.white;
            var srt = status.rectTransform;
            srt.anchorMin = new Vector2(0f, 1f);
            srt.anchorMax = new Vector2(1f, 1f);
            srt.pivot = new Vector2(0.5f, 1f);
            srt.anchoredPosition = new Vector2(0f, -60f);
            srt.sizeDelta = new Vector2(0f, 40f);

            var bar = new GameObject("WindowBar", typeof(Image)).GetComponent<Image>();
            bar.transform.SetParent(canvasGo.transform, false);
            bar.color = GateColor;
            bar.type = Image.Type.Filled;
            bar.fillMethod = Image.FillMethod.Horizontal;
            bar.fillAmount = 0f;
            var brt = bar.rectTransform;
            brt.anchorMin = new Vector2(0.1f, 1f);
            brt.anchorMax = new Vector2(0.9f, 1f);
            brt.pivot = new Vector2(0.5f, 1f);
            brt.anchoredPosition = new Vector2(0f, -110f);
            brt.sizeDelta = new Vector2(0f, 8f);

            controller.Bind(Camera, ball.transform, player.transform, defender.transform, gates, status, bar);
        }

        private static GameObject Primitive(PrimitiveType type, string name, float size, Color color)
        {
            var go = GameObject.CreatePrimitive(type);
            go.name = name;
            go.transform.localScale = Vector3.one * size;
            Destroy(go.GetComponent<Collider>());
            Tint(go, color);
            return go;
        }

        /// <summary>Tints via a property block on the built-in default material so no shader has to survive build stripping.</summary>
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
