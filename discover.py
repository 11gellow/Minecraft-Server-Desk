"""Identify installed Minecraft Java launch targets without executing pack files."""
import json
import os
from pathlib import Path
import re
import shlex
import sys
import zipfile

LOADER_PATH = re.compile(r"net/(minecraftforge/forge|neoforged/neoforge)/([^/]+)/unix_args\.txt$")


def jar_candidate(jar):
    try:
        with zipfile.ZipFile(jar) as archive:
            manifest = archive.read("META-INF/MANIFEST.MF").decode("utf-8", "replace") if (
                "META-INF/MANIFEST.MF" in archive.namelist()) else ""
            manifest = re.sub(r"\r?\n ", "", manifest)
            entry_match = re.search(r"(?im)^Main-Class:\s*([^\s]+)", manifest)
            main = entry_match.group(1) if entry_match else ""
            names = set(archive.namelist())
            if "fabricmc" in main.lower() and "server" in main.lower():
                candidate = {"kind": "fabric", "entry": jar.name, "missing": []}
                match = re.search(r"fabric-server-mc\.(.+?)-loader\.([^-]+)", jar.name)
                if match:
                    candidate.update(version=match[1], loaderVersion=match[2])
                if main.endswith("FabricServerLauncher"):
                    properties = read_properties(jar.parent / "fabric-server-launcher.properties")
                    expected = properties.get("serverJar", "server.jar")
                    if not (jar.parent / expected).is_file():
                        candidate["missing"].append(expected)
                return candidate
            if main in ("net.minecraft.bundler.Main", "net.minecraft.server.Main",
                        "net.minecraft.server.MinecraftServer") or (
                    main == "org.bukkit.craftbukkit.Main" and "version.json" in names) or (
                    main.startswith(("net.minecraftforge.", "net.neoforged."))
                    and ("server" in main.lower() or "shim" in main.lower())):
                kind = ("neoforge" if main.startswith("net.neoforged.") else
                        "forge" if main.startswith("net.minecraftforge.") else "jar")
                candidate = {"kind": kind, "entry": jar.name, "missing": []}
                if "version.json" in names:
                    try:
                        version = json.loads(archive.read("version.json"))
                        candidate["version"] = version.get("id") or version.get("name")
                    except (ValueError, AttributeError):
                        pass
                return candidate
    except (OSError, zipfile.BadZipFile, KeyError, RuntimeError):
        return None
    return None


def read_properties(path):
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return {}
    return {key.strip(): value.strip() for line in lines if "=" in line and not line.lstrip().startswith("#")
            for key, value in [line.split("=", 1)]}


def argument_candidate(root, args):
    relative = args.relative_to(root).as_posix()
    contents = args.read_text(encoding="utf-8", errors="replace")
    try:
        tokens = shlex.split(contents, comments=True)
    except ValueError:
        return None

    match = LOADER_PATH.search(relative)
    pairs = list(zip(tokens, tokens[1:]))
    target = next((value.lower().replace("_", "") for flag, value in pairs
                   if flag == "--launchTarget"), "")
    jar = next((value for flag, value in pairs if flag == "-jar" and value.lower().endswith(".jar")), None)
    if target in ("forgeserver", "neoforgeserver"):
        kind = "neoforge" if target == "neoforgeserver" else "forge"
    elif match and jar:
        kind = "neoforge" if match[1].startswith("neoforged/") else "forge"
    else:
        return None

    missing = set()
    if jar and not (root / jar).is_file():
        missing.add(jar)
    for token in tokens:
        for value in token.split("=", 1)[-1].split(":"):
            if value.startswith("libraries/") and not (root / value).exists():
                missing.add(value)
    if not (root / "user_jvm_args.txt").is_file():
        run_script = root / "run.sh"
        if run_script.is_file() and "@user_jvm_args.txt" in run_script.read_text(errors="replace"):
            missing.add("user_jvm_args.txt")
    candidate = {"kind": kind, "entry": relative, "missing": sorted(missing)}
    loader_version = next((value for flag, value in pairs if flag.lower() in
                           ("--fml.forgeversion", "--fml.neoforgeversion")), None)
    if loader_version:
        candidate["loaderVersion"] = loader_version
    elif match:
        candidate["loaderVersion"] = match[2]
    version = re.search(r"--fml\.(?:mcVersion|minecraftVersion)\s+([^\s]+)", contents)
    if version:
        candidate["version"] = version[1]
    return candidate


def inspect(root):
    candidates = []
    paths = [root / "unix_args.txt"]
    for loader in ("net/minecraftforge/forge", "net/neoforged/neoforge"):
        paths.extend((root / "libraries" / loader).glob("*/unix_args.txt"))
    for path in paths:
        if path.is_file():
            candidate = argument_candidate(root, path)
            if candidate:
                candidates.append(candidate)
    for path in sorted(root.iterdir()):
        if path.is_file() and path.suffix.lower() == ".jar":
            candidate = jar_candidate(path)
            if candidate:
                if candidate["kind"] in ("forge", "neoforge") and any(
                        item["kind"] == candidate["kind"] and item["entry"].endswith(".txt")
                        for item in candidates):
                    continue
                candidates.append(candidate)
    run_script = root / "run.sh"
    if not candidates and run_script.is_file():
        contents = run_script.read_text(errors="replace")
        for path in re.findall(r"@([^ \t\r\n\"']*unix_args\.txt)", contents):
            if not (root / path).is_file():
                candidates.append({"entry": path, "kind": "neoforge" if "neoforge" in path else "forge",
                                   "missing": [path]})
    runtime_paths = [root / name / "bin/java" for name in ("java", "jre", "jdk", "runtime")]
    runtime_paths.extend(sorted(root.glob("runtime*/bin/java")))
    java = next((str(path) for path in runtime_paths if path.is_file() and os.access(path, os.X_OK)), "java")
    if run_script.is_file():
        contents = run_script.read_text(errors="replace")
        declared = [root / name for name in re.findall(r"(?:^|\s)(?:\./)?([\w./-]+/bin/java)\s", contents)
                    if not name.startswith("/")]
        java = next((str(path) for path in declared if path.is_file() and os.access(path, os.X_OK)), java)
    properties = read_properties(root / "server.properties")
    return {"dir": str(root), "name": root.name, "java": java,
            "port": properties.get("server-port", "25565"), "address": properties.get("server-ip", ""),
            "eula": read_properties(root / "eula.txt").get("eula") == "true", "candidates": candidates}


def discover(root, nested):
    if not root.is_dir():
        raise ValueError("目录不存在或不可访问")
    direct = inspect(root)
    if direct["candidates"] or not nested:
        return [direct]
    ignored = {"mods", "config", "libraries", "logs", "world", "backups", "cache", "plugins",
               "defaultconfigs", "kubejs", "runtime", "jre", "jdk"}
    found = []
    pending = [(root, 0)]
    visited = 0
    while pending and visited < 150:
        parent, depth = pending.pop(0)
        if depth == 2:
            continue
        for child in sorted(parent.iterdir()):
            if child.name in ignored or child.name.startswith((".", "runtime")) or child.is_symlink():
                continue
            if child.is_dir() and os.access(child, os.R_OK | os.X_OK):
                visited += 1
                item = inspect(child)
                if item["candidates"]:
                    found.append(item)
                elif depth == 0:
                    pending.append((child, 1))
                if visited >= 150:
                    break
    return found or [direct]


if __name__ == "__main__":
    try:
        print(json.dumps(discover(Path(sys.argv[1]).resolve(strict=True), sys.argv[2] == "nested")))
    except (OSError, ValueError) as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
