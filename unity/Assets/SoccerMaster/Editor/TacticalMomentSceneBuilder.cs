using System.IO;
using SoccerMaster.View;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace SoccerMaster.Editor
{
    /// <summary>
    /// (Re)writes Assets/SoccerMaster/Scenes/TacticalMoment.unity: one "TacticalMoment" GameObject carrying
    /// <see cref="TacticalMomentController"/> (match runtime + save/reload) and <see cref="TacticalMomentRig"/>
    /// (builds field, markers and safe-area HUD at runtime). Like the FirstTouch scene, all geometry lives in
    /// code so a licensed Editor run of
    /// <c>Unity -batchmode -executeMethod SoccerMaster.Editor.TacticalMomentSceneBuilder.Build -quit</c>
    /// only normalizes serialization.
    /// </summary>
    public static class TacticalMomentSceneBuilder
    {
        public const string ScenePath = "Assets/SoccerMaster/Scenes/TacticalMoment.unity";

        [MenuItem("SoccerMaster/Build Tactical Moment Scene")]
        public static void Build()
        {
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var go = new GameObject("TacticalMoment");
            go.AddComponent<TacticalMomentController>();
            go.AddComponent<TacticalMomentRig>();

            Directory.CreateDirectory(Path.GetDirectoryName(ScenePath));
            if (!EditorSceneManager.SaveScene(scene, ScenePath))
                throw new IOException("failed to save " + ScenePath);
            AssetDatabase.Refresh();
            IosBuild.SyncSceneList();
            Debug.Log("[SoccerMaster] built " + ScenePath + " with " + scene.rootCount + " root objects");
        }
    }
}
