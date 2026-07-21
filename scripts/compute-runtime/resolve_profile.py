#!/usr/bin/env python3
"""Create or normalize a non-secret remote connection profile JSON."""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
from pathlib import Path


def config_base_dirs() -> list[Path]:
    dirs: list[Path] = []
    if os.environ.get("LP_FLOW_DOCKING_CONFIG"):
        dirs.append(Path(os.environ["LP_FLOW_DOCKING_CONFIG"]))
    if os.environ.get("APPDATA"):
        dirs.append(Path(os.environ["APPDATA"]) / "LP-FlowDocking")
    if os.environ.get("USERPROFILE"):
        dirs.append(Path(os.environ["USERPROFILE"]) / ".config" / "lp-flow")
    if os.environ.get("HOME"):
        dirs.append(Path(os.environ["HOME"]) / ".config" / "lp-flow")
    seen: set[Path] = set()
    unique: list[Path] = []
    for item in dirs:
        resolved = item.expanduser().resolve()
        if resolved not in seen:
            seen.add(resolved)
            unique.append(resolved)
    return unique


def profile_candidates(name: str) -> list[Path]:
    safe = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in (name or "default"))
    return [path for base in config_base_dirs() for path in (base / "profiles" / f"{safe}.json", base / f"{safe}.json")]


def read_profile_file(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and isinstance(data.get("profiles"), dict):
        default_name = data.get("default_profile") or data.get("defaultProfile") or next(iter(data["profiles"]), "")
        if not default_name or default_name not in data["profiles"]:
            raise SystemExit(f"No usable profile found in {path}")
        profile = dict(data["profiles"][default_name])
        profile.setdefault("profile_name", default_name)
        return profile
    if not isinstance(data, dict):
        raise SystemExit(f"Profile file must contain a JSON object: {path}")
    return data


def load_named_profile(name: str) -> dict:
    for candidate in profile_candidates(name or "default"):
        if candidate.exists():
            return read_profile_file(candidate)
    locations = " or ".join(str(path) for path in config_base_dirs()) or "<no config dirs>"
    raise SystemExit(f'Profile "{name or "default"}" was not found. Use --profile-path, --profile-json, or create it under {locations}')


def pick(source: dict, *keys: str, default: str = ""):
    for key in keys:
        value = source.get(key)
        if value not in (None, ""):
            return value
    return default


def assert_token(value: str, label: str) -> None:
    if value and (value.startswith("-") or not re.fullmatch(r"[A-Za-z0-9_.-]+", value)):
        raise SystemExit(f"{label} has invalid characters: {value}")


def assert_host(value: str) -> None:
    if value and (value.startswith("-") or not re.fullmatch(r"[A-Za-z0-9_.:-]+", value)):
        raise SystemExit(f"host has invalid characters: {value}")


def assert_posix_absolute(value: str, label: str) -> None:
    if not value.startswith("/"):
        raise SystemExit(f"{label} must be an absolute POSIX path")
    parts = [part for part in value.split("/") if part]
    if "." in parts or ".." in parts:
        raise SystemExit(f"{label} must not contain . or .. path segments")


def validate_ssh_command(value: str) -> None:
    if not value:
        return
    parts = shlex.split(value)
    if not parts or Path(parts[0]).name.lower() not in {"ssh", "ssh.exe"}:
        raise SystemExit("ssh_command must start with ssh or ssh.exe")
    target = ""
    index = 1
    while index < len(parts):
        part = parts[index]
        if part == "-p":
            index += 1
            if index >= len(parts) or not parts[index].isdigit():
                raise SystemExit("ssh_command -p requires a numeric port")
        elif part == "-l":
            index += 1
            if index >= len(parts):
                raise SystemExit("ssh_command -l requires a username")
            assert_token(parts[index], "ssh_command -l user")
        elif part.startswith("-"):
            raise SystemExit(f"ssh_command option is not allowed in execution profiles: {part}")
        else:
            if target:
                raise SystemExit("ssh_command must contain exactly one remote target")
            if not re.fullmatch(r"[A-Za-z0-9_.@:-]+", part):
                raise SystemExit(f"ssh_command target has invalid characters: {part}")
            target = part
        index += 1
    if not target:
        raise SystemExit("ssh_command must include a remote target")


def normalize_profile(raw: dict, overrides: dict) -> dict:
    source = {**raw, **{key: value for key, value in overrides.items() if value not in (None, "")}}
    profile_name = str(pick(source, "profile_name", "profileName", "name")).strip()
    username = str(pick(source, "username")).strip()
    ssh_alias = str(pick(source, "ssh_alias", "sshAlias", "host_alias", "hostAlias")).strip()
    ssh_command = str(pick(source, "ssh_command", "sshCommand")).strip()
    host = str(pick(source, "host")).strip()
    remote_work_root = str(pick(source, "remote_work_root", "remoteWorkRoot")).rstrip("/")
    missing = []
    if not profile_name:
        missing.append("profile_name")
    if not username:
        missing.append("username")
    if not remote_work_root:
        missing.append("remote_work_root")
    if not (ssh_alias or ssh_command or host):
        missing.append("ssh_alias or ssh_command or host")
    if missing:
        raise SystemExit(f"Missing required profile fields: {', '.join(missing)}")
    assert_token(profile_name, "profile_name")
    assert_token(str(pick(source, "profile_ref", "profileRef", default=profile_name)).strip(), "profile_ref")
    assert_token(username, "username")
    assert_token(ssh_alias, "ssh_alias")
    assert_host(host)
    validate_ssh_command(ssh_command)
    assert_posix_absolute(remote_work_root, "remote_work_root")
    remote_home = str(pick(source, "remote_home", "remoteHome")).rstrip("/")
    if remote_home:
        assert_posix_absolute(remote_home, "remote_home")
    profile = {
        "profile_name": profile_name,
        "profile_ref": str(pick(source, "profile_ref", "profileRef", default=profile_name)).strip(),
        "ssh_alias": ssh_alias,
        "ssh_command": ssh_command,
        "host_alias": ssh_alias,
        "host": host,
        "port": pick(source, "port", default=None),
        "username": username,
        "remote_home": remote_home,
        "remote_work_root": remote_work_root,
        "shared_software_policy": str(pick(source, "shared_software_policy", "sharedSoftwarePolicy", default="read_only")),
        "gpu_policy": str(pick(source, "gpu_policy", "gpuPolicy", default="check_before_use")),
        "micromamba": str(pick(source, "micromamba")).rstrip("/"),
        "docking_env": str(pick(source, "docking_env", "dockingEnv")),
        "boltz_env": str(pick(source, "boltz_env", "boltzEnv")),
        "boltz_weights_readonly": str(pick(source, "boltz_weights_readonly", "boltzWeightsReadonly")).rstrip("/"),
        "boltz_writable_cache": str(pick(source, "boltz_writable_cache", "boltzWritableCache")).rstrip("/"),
        "matcha_checkout": str(pick(source, "matcha_checkout", "matchaCheckout")).rstrip("/"),
        "matcha_python": str(pick(source, "matcha_python", "matchaPython")).rstrip("/"),
        "matcha_checkpoints": str(pick(source, "matcha_checkpoints", "matchaCheckpoints")).rstrip("/"),
        "gnina": str(pick(source, "gnina", "gnina_path", "gninaPath")).rstrip("/"),
        "smina": str(pick(source, "smina", "smina_path", "sminaPath")).rstrip("/"),
        "obabel": str(pick(source, "obabel", "obabel_path", "obabelPath")).rstrip("/"),
        "gromacs": str(pick(source, "gromacs", "gmx", "gromacs_path", "gromacsPath", "gmx_path", "gmxPath")).rstrip("/"),
        "ld_library_path": str(pick(source, "ld_library_path", "ldLibraryPath", "gromacs_ld_library_path", "gromacsLdLibraryPath")),
        "mdtools_env": str(pick(source, "mdtools_env", "mdtoolsEnv")).rstrip("/"),
        "acpype": str(pick(source, "acpype", "acpype_path", "acpypePath")).rstrip("/"),
        "antechamber": str(pick(source, "antechamber", "antechamber_path", "antechamberPath")).rstrip("/"),
        "parmchk2": str(pick(source, "parmchk2", "parmchk2_path", "parmchk2Path")).rstrip("/"),
        "tleap": str(pick(source, "tleap", "tleap_path", "tleapPath")).rstrip("/"),
    }
    if profile["port"] in ("", None):
        profile["port"] = None
    return profile


def build_profile(args: argparse.Namespace) -> dict:
    if args.profile_json:
        raw = json.loads(args.profile_json)
    elif args.profile_path:
        raw = read_profile_file(args.profile_path.expanduser().resolve())
    else:
        raw = load_named_profile(args.profile_name or os.environ.get("LP_FLOW_DOCKING_PROFILE", "default"))
    overrides = vars(args)
    return normalize_profile(raw, overrides)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile-name")
    parser.add_argument("--profile-path", type=Path)
    parser.add_argument("--profile-json")
    parser.add_argument("--ssh-alias")
    parser.add_argument("--ssh-command")
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    parser.add_argument("--username")
    parser.add_argument("--remote-home")
    parser.add_argument("--remote-work-root")
    parser.add_argument("--micromamba")
    parser.add_argument("--docking-env")
    parser.add_argument("--boltz-env")
    parser.add_argument("--boltz-weights-readonly")
    parser.add_argument("--boltz-writable-cache")
    parser.add_argument("--matcha-checkout")
    parser.add_argument("--matcha-python")
    parser.add_argument("--matcha-checkpoints")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()

    profile = build_profile(args)
    text = json.dumps(profile, indent=2, ensure_ascii=False)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text + "\n", encoding="utf-8")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
