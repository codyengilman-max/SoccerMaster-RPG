using System.IO;
using SoccerMaster.View;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace SoccerMaster.Editor
{
    /// <summary>
    /// (Re)writes Assets/SoccerMaster/Scenes/FirstTouch.unity: a single "FirstTouch" GameObject carrying
    /// <see cref="FirstTouchRig"/> (builds camera/field/HUD at runtime) and <see cref="FirstTouchController"/>.
    /// The committed scene has exactly this content, so a licensed Editor run of
    /// <c>Unity -batchmode -executeMethod SoccerMaster.Editor.FirstTouchSceneBuilder.Build -quit</c>
    /// only normalizes serialization; it never changes what the scene contains.
    /// </summary>
    public static class FirstTouchSceneBuilder
    {
        public const string ScenePath = "Assets/SoccerMaster/Scenes/FirstTouch.unity";

        [MenuItem("SoccerMaster/Build First Touch Scene")]
        public static void Build()
        {
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var go = new GameObject("FirstTouch");
            go.AddComponent<FirstTouchController>();
            go.AddComponent<FirstTouchRig>();

            Directory.CreateDirectory(Path.GetDirectoryName(ScenePath));
            if (!EditorSceneManager.SaveScene(scene, ScenePath))
                throw new IOException("failed to save " + ScenePath);
            AssetDatabase.Refresh();
            IosBuild.SyncSceneList();
            Debug.Log("[SoccerMaster] built " + ScenePath + " with " + scene.rootCount + " root objects");
        }
    }
}
