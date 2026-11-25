from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from zipfile import ZipFile

from discover import discover


def jar(directory, name, main, version=None):
    with ZipFile(directory / name, "w") as archive:
        archive.writestr("META-INF/MANIFEST.MF", f"Manifest-Version: 1.0\nMain-Class: {main}\n")
        if version is not None:
            archive.writestr("version.json", f'{{"id": "{version}"}}')


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()

    def test_renamed_vanilla_jar_needs_no_generated_config(self):
        jar(self.root, "随便取的名字.jar", "net.minecraft.bundler.Main", "1.20.1")
        (profile,) = discover(self.root, False)
        (entry,) = profile["candidates"]
        self.assertEqual(entry["entry"], "随便取的名字.jar")
        self.assertEqual(entry["version"], "1.20.1")
        self.assertFalse(profile["eula"])

    def test_unrelated_jars_are_not_launch_entries(self):
        (self.root / "mods").mkdir()
        jar(self.root, "server.jar", "demo.ClientOnly")
        jar(self.root, "installer.jar", "net.minecraftforge.installer.SimpleInstaller")
        (self.root / "unix_args.txt").write_text("# server tuning notes\n-Xmx2G\n", encoding="utf-8")
        self.assertEqual(discover(self.root, False)[0]["candidates"], [])

    def test_fabric_standalone_and_manual_layouts(self):
        jar(self.root, "launcher.jar", "net.fabricmc.installer.ServerLauncher")
        jar(self.root, "manual.jar", "net.fabricmc.loader.impl.launch.server.FabricServerLauncher")
        result = {entry["entry"]: entry for entry in discover(self.root, False)[0]["candidates"]}
        self.assertEqual(result["launcher.jar"]["kind"], "fabric")
        self.assertEqual(result["launcher.jar"]["missing"], [])
        self.assertEqual(result["manual.jar"]["missing"], ["server.jar"])

    def test_loader_args_report_missing_local_libraries(self):
        for loader, kind in [("minecraftforge/forge", "forge"), ("neoforged/neoforge", "neoforge")]:
            with self.subTest(kind=kind):
                root = self.root / kind
                args = root / f"libraries/net/{loader}/1.2.3/unix_args.txt"
                args.parent.mkdir(parents=True)
                args.write_text("-p libraries/needed.jar\n--launchTarget " + kind + "server\n"
                                "--fml.mcVersion 1.20.1\n", encoding="utf-8")
                (entry,) = discover(root, False)[0]["candidates"]
                self.assertEqual(entry["entry"], args.relative_to(root).as_posix())
                self.assertEqual(entry["kind"], kind)
                self.assertEqual(entry["missing"], ["libraries/needed.jar"])

    def test_loader_args_can_launch_a_shim_jar(self):
        args = self.root / "libraries/net/minecraftforge/forge/example/unix_args.txt"
        args.parent.mkdir(parents=True)
        args.write_text("-XX:+UseCompactObjectHeaders -jar forge-shim.jar\n", encoding="utf-8")
        (entry,) = discover(self.root, False)[0]["candidates"]
        self.assertEqual(entry["kind"], "forge")
        self.assertEqual(entry["missing"], ["forge-shim.jar"])

    def test_finds_multiple_versions_in_a_nested_instance(self):
        root = self.root / "导入目录" / "实际服务端"
        root.mkdir(parents=True)
        jar(root, "first.jar", "net.minecraft.bundler.Main", "1.20.1")
        jar(root, "second.jar", "net.minecraft.bundler.Main", "1.21.1")
        (profile,) = discover(self.root, True)
        self.assertEqual(profile["dir"], str(root))
        self.assertEqual([entry["version"] for entry in profile["candidates"]], ["1.20.1", "1.21.1"])


if __name__ == "__main__":
    unittest.main()
