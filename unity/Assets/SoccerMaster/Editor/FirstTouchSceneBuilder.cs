using System.IO;
using SoccerMaster.Core.Training;
using SoccerMaster.View;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.UI;

namespace SoccerMaster.Editor
{
    /// <summary>
    /// Builds Assets/SoccerMaster/Scenes/FirstTouch.unity from code so the scene is reproducible
    /// from a clean checkout: <c>Unity -batchmode -executeMethod SoccerMaster.Editor.FirstTouchSceneBuilder.Build -quit</c>.
    /// Geometry comes from FirstTouchDrill constants; nothing here reasons about soccer.
    /// </summary>
    public static class FirstTouchSceneBuilder
    {
        public const string ScenePath = "Assets/SoccerMaster/Scenes/FirstTouch.unity";

        [MenuItem("SoccerMaster/Build First Touch Scene")]
        public static void Build()
        {
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var camGo = new GameObject("Main Camera");
            camGo.tag = "MainCamera";
            var cam = camGo.AddComponent<Camera>();
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = new Color(0.07f, 0.10f, 0.14f);
            cam.orthographic = true;
            cam.orthographicSize = (float)FirstTouchDrill.AreaLength * 0.5f + 1f;
            camGo.transform.position = new Vector3((float)FirstTouchDrill.AreaLength * 0.5f, 30f, (float)FirstTouchDrill.AreaWidth * 0.5f);
            camGo.transform.rotation = Quaternion.Euler(90f, -90f, 0f);
            camGo.AddComponent<AudioListener>();

            var light = new GameObject("Sun").AddComponent<Light>();
            light.type = LightType.Directional;
            light.intensity = 1.1f;
            light.transform.rotation = Quaternion.Euler(55f, 25f, 0f);

            var field = GameObject.CreatePrimitive(PrimitiveType.Plane);
            field.name = "Field";
            field.transform.position = new Vector3((float)FirstTouchDrill.AreaLength * 0.5f, 0f, (float)FirstTouchDrill.AreaWidth * 0.5f);
            field.transform.localScale = new Vector3((float)FirstTouchDrill.AreaLength / 10f, 1f, (float)FirstTouchDrill.AreaWidth / 10f);
            Tint(field, new Color(0.19f, 0.50f, 0.24f));

            var ball = Primitive(PrimitiveType.Sphere, "Ball", 0.22f, Color.white);
            var player = Primitive(PrimitiveType.Capsule, "Player", 0.9f, new Color(0.10f, 0.16f, 0.36f));
            var defender = Primitive(PrimitiveType.Capsule, "Defender", 0.9f, new Color(0.92f, 0.92f, 0.92f));
            var gates = new Transform[FirstTouchDrill.Gates.Count];
            for (var i = 0; i < gates.Length; i++)
            {
                var g = GameObject.CreatePrimitive(PrimitiveType.Cube);
                g.name = "Gate " + FirstTouchDrill.Name(FirstTouchDrill.Gates[i].Id);
                Tint(g, new Color(1f, 0.85f, 0.25f));
                Object.DestroyImmediate(g.GetComponent<Collider>());
                gates[i] = g.transform;
            }

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
            bar.color = new Color(1f, 0.85f, 0.25f);
            bar.type = Image.Type.Filled;
            bar.fillMethod = Image.FillMethod.Horizontal;
            bar.fillAmount = 0f;
            var brt = bar.rectTransform;
            brt.anchorMin = new Vector2(0.1f, 1f);
            brt.anchorMax = new Vector2(0.9f, 1f);
            brt.pivot = new Vector2(0.5f, 1f);
            brt.anchoredPosition = new Vector2(0f, -110f);
            brt.sizeDelta = new Vector2(0f, 8f);

            var ctrlGo = new GameObject("FirstTouch");
            var ctrl = ctrlGo.AddComponent<FirstTouchController>();
            var so = new SerializedObject(ctrl);
            so.FindProperty("worldCamera").objectReferenceValue = cam;
            so.FindProperty("ball").objectReferenceValue = ball.transform;
            so.FindProperty("player").objectReferenceValue = player.transform;
            so.FindProperty("defender").objectReferenceValue = defender.transform;
            so.FindProperty("statusText").objectReferenceValue = status;
            so.FindProperty("windowBar").objectReferenceValue = bar;
            var arr = so.FindProperty("gateMarkers");
            arr.arraySize = gates.Length;
            for (var i = 0; i < gates.Length; i++) arr.GetArrayElementAtIndex(i).objectReferenceValue = gates[i];
            so.ApplyModifiedPropertiesWithoutUndo();

            Directory.CreateDirectory(Path.GetDirectoryName(ScenePath));
            if (!EditorSceneManager.SaveScene(scene, ScenePath))
                throw new IOException("failed to save " + ScenePath);
            AssetDatabase.Refresh();
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
            Debug.Log("[SoccerMaster] built " + ScenePath + " with " + scene.rootCount + " root objects");
        }

        private static GameObject Primitive(PrimitiveType type, string name, float size, Color color)
        {
            var go = GameObject.CreatePrimitive(type);
            go.name = name;
            go.transform.localScale = Vector3.one * size;
            Object.DestroyImmediate(go.GetComponent<Collider>());
            Tint(go, color);
            return go;
        }

        private static void Tint(GameObject go, Color color)
        {
            var r = go.GetComponent<Renderer>();
            var mat = new Material(Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard"));
            mat.color = color;
            r.sharedMaterial = mat;
        }
    }
}
