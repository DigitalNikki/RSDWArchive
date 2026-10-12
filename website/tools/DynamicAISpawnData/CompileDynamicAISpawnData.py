"""Compile resolved dynamic AI encounter areas from world AISpawnVolume exports."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any


HERE = Path(__file__).resolve().parent
TOOLS_DIR = HERE.parent
REPO_ROOT = HERE.parents[2]

if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

from map_calibration import (  # noqa: E402
    MAP_X_MAX,
    MAP_X_MIN,
    MAP_Y_MAX,
    MAP_Y_MIN,
    MAP_Z_MAX,
    MAP_Z_MIN,
    map_filter_meta,
)


INDENT = 2
JSON_ROOT_ENV_VAR = "RSDW_JSON_ROOT"
SOURCE_DIR_ENV_VAR = "RSDW_LOCATION_SOURCE_DIR"
DEFAULT_TARGET_VERSION_FOLDER = "0.11.0.3"
DEFAULT_OUTPUT = HERE / "DynamicAISpawnData.json"
DEFAULT_NPC_DATA = TOOLS_DIR / "NPCData" / "NPCData.json"
WORLD_GENERATED_RELATIVE = Path(
    "RSDragonwilds",
    "Content",
    "Maps",
    "World",
    "L_World",
    "_Generated_",
)
SPAWN_TIER_SETTINGS = {
    "Always": {
        "mode": "always",
        "quantityPerSquareMeter": None,
        "spawnIntervalSeconds": None,
        "creatureLimitPerPlayer": None,
    },
    "Plentiful": {
        "mode": "density",
        "quantityPerSquareMeter": 0.000100,
        "spawnIntervalSeconds": 30.0,
        "creatureLimitPerPlayer": 8,
    },
    "Common": {
        "mode": "density",
        "quantityPerSquareMeter": 0.000125,
        "spawnIntervalSeconds": 100.0,
        "creatureLimitPerPlayer": 10,
    },
    "Uncommon": {
        "mode": "density",
        "quantityPerSquareMeter": 0.000075,
        "spawnIntervalSeconds": 0.0,
        "creatureLimitPerPlayer": 6,
    },
    "Rare": {
        "mode": "density",
        "quantityPerSquareMeter": 0.000040,
        "spawnIntervalSeconds": 200.0,
        "creatureLimitPerPlayer": 4,
    },
    "Legendary": {
        "mode": "density",
        "quantityPerSquareMeter": 0.000010,
        "spawnIntervalSeconds": 1000.0,
        "creatureLimitPerPlayer": 1,
    },
    "Never": {
        "mode": "never",
        "quantityPerSquareMeter": None,
        "spawnIntervalSeconds": None,
        "creatureLimitPerPlayer": 0,
    },
}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_source_root(repo_root: Path) -> Path:
    for env_name in (SOURCE_DIR_ENV_VAR, JSON_ROOT_ENV_VAR):
        override = os.getenv(env_name, "").strip()
        if not override:
            continue
        candidate = Path(override)
        if (candidate / "RSDragonwilds").exists():
            return candidate.resolve()
        if (candidate / "json" / "RSDragonwilds").exists():
            return (candidate / "json").resolve()

    candidates: list[tuple[tuple[int, ...], Path]] = []
    for json_dir in repo_root.glob("*/json"):
        if not (json_dir / "RSDragonwilds").is_dir():
            continue
        version_name = json_dir.parent.name
        if not re.fullmatch(r"\d+(?:\.\d+)+", version_name):
            continue
        candidates.append((tuple(int(part) for part in version_name.split(".")), json_dir))
    if candidates:
        candidates.sort(key=lambda item: item[0], reverse=True)
        return candidates[0][1].resolve()

    fallback = repo_root / DEFAULT_TARGET_VERSION_FOLDER / "json"
    return fallback.resolve()


def derive_version_label(source_root: Path) -> str:
    version = source_root.parent.name
    return version if re.fullmatch(r"\d+(?:\.\d+)+", version) else "unknown"


def repo_display_path(path: Path, repo_root: Path) -> str:
    try:
        return str(path.resolve().relative_to(repo_root.resolve())).replace("\\", "/")
    except ValueError:
        return str(path.resolve()).replace("\\", "/")


def normalize_object_name(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if "'" in text:
        parts = text.split("'")
        if len(parts) >= 2:
            text = parts[1]
    return text or None


def normalize_blueprint_reference(value: Any) -> str | None:
    if isinstance(value, dict):
        for key in ("AssetPathName", "ObjectPath", "ObjectName"):
            result = normalize_blueprint_reference(value.get(key))
            if result:
                return result
        return None
    text = normalize_object_name(value)
    if not text:
        return None
    text = text.replace("\\", "/").rsplit("/", 1)[-1].split(".", 1)[0]
    return text.removesuffix("_C") or None


def humanize_blueprint(blueprint: str | None) -> str:
    if not blueprint:
        return "Unknown AI"
    value = blueprint.removeprefix("BP_AI_")
    value = re.sub(r"_Character(?:_|$)", "_", value)
    value = re.sub(r"_+", " ", value).strip()
    return value or blueprint


def enum_leaf(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return value.rsplit("::", 1)[-1]


def object_path_stem(object_path: str) -> str:
    package_path = re.sub(r"\.\d+$", "", object_path.strip())
    return PurePosixPath(package_path.replace("\\", "/")).name


def build_table_index(source_root: Path) -> dict[str, list[Path]]:
    table_index: dict[str, list[Path]] = defaultdict(list)
    content_root = source_root / "RSDragonwilds"
    for path in content_root.rglob("DT_AISpawnData*.json"):
        table_index[path.stem].append(path)
    return dict(table_index)


def direct_table_path(source_root: Path, object_path: str) -> Path | None:
    package_path = re.sub(r"\.\d+$", "", object_path.strip()).replace("\\", "/")
    if package_path.startswith("RSDragonwilds/"):
        return source_root / f"{package_path}.json"
    if package_path.startswith("/Game/"):
        relative = package_path.removeprefix("/Game/")
        return source_root / "RSDragonwilds" / "Content" / f"{relative}.json"
    if package_path.startswith("/"):
        mount, separator, relative = package_path[1:].partition("/")
        if separator and mount:
            return (
                source_root
                / "RSDragonwilds"
                / "Plugins"
                / "GameFeatures"
                / mount
                / "Content"
                / f"{relative}.json"
            )
    return None


def resolve_table_path(
    source_root: Path,
    table_index: dict[str, list[Path]],
    object_path: str,
) -> Path | None:
    direct = direct_table_path(source_root, object_path)
    if direct and direct.is_file():
        return direct

    candidates = table_index.get(object_path_stem(object_path), [])
    if len(candidates) == 1:
        return candidates[0]
    return None


def build_npc_index(npc_data_path: Path) -> dict[str, dict[str, str]]:
    payload = load_json(npc_data_path)
    npcs = payload.get("npcs", {}) if isinstance(payload, dict) else {}
    out: dict[str, dict[str, str]] = {}
    if not isinstance(npcs, dict):
        return out
    for npc_id, record in npcs.items():
        if not isinstance(record, dict):
            continue
        source = record.get("source", {})
        if not isinstance(source, dict):
            continue
        blueprint = source.get("characterBlueprint")
        if not isinstance(blueprint, str) or not blueprint:
            continue
        display_name = record.get("displayName")
        out[blueprint] = {
            "npcId": str(npc_id),
            "displayName": str(display_name or npc_id),
        }
    return out


def read_chance_modifiers(row: dict[str, Any]) -> list[str]:
    out: list[str] = []
    fast = row.get("ChanceModifiers_FAST")
    if isinstance(fast, list):
        for value in fast:
            modifier = enum_leaf(value)
            if modifier and modifier not in out:
                out.append(modifier)

    raw = row.get("ChanceModifiers")
    if isinstance(raw, list):
        for value in raw:
            if not isinstance(value, dict):
                continue
            object_name = normalize_object_name(value.get("ObjectName"))
            if object_name:
                modifier = object_name.removesuffix("_C")
                if modifier and modifier not in out:
                    out.append(modifier)
    return out


def compile_table(
    path: Path,
    repo_root: Path,
    npc_index: dict[str, dict[str, str]],
) -> tuple[dict[str, Any], int]:
    payload = load_json(path)
    export = next(
        (item for item in payload if isinstance(item, dict) and item.get("Type") == "DataTable"),
        None,
    ) if isinstance(payload, list) else None
    if not isinstance(export, dict):
        raise ValueError(f"No DataTable export in {path}")

    rows = export.get("Rows", {})
    if not isinstance(rows, dict):
        rows = {}

    encounters: list[dict[str, Any]] = []
    unresolved_npc_count = 0
    for row_name in sorted(rows):
        row = rows[row_name]
        if not isinstance(row, dict):
            continue
        members: list[dict[str, Any]] = []
        group = row.get("Group", [])
        if isinstance(group, list):
            for raw_member in group:
                if not isinstance(raw_member, dict):
                    continue
                blueprint = normalize_blueprint_reference(raw_member.get("AIClass"))
                npc = npc_index.get(blueprint or "")
                if blueprint and not npc:
                    unresolved_npc_count += 1
                ai_class = f"{blueprint}_C" if blueprint else None
                members.append(
                    {
                        "aiClass": ai_class,
                        "npcId": npc.get("npcId") if npc else None,
                        "displayName": npc.get("displayName") if npc else humanize_blueprint(blueprint),
                        "minQuantity": raw_member.get("MinQuantity"),
                        "maxQuantity": raw_member.get("MaxQuantity"),
                        "powerLevel": raw_member.get("PowerLevel"),
                        "spawnBehaviour": enum_leaf(raw_member.get("SpawnBehaviour")),
                        "behaviourModifiers": [
                            enum_leaf(value) or str(value)
                            for value in (raw_member.get("BehaviourModifiers") or [])
                        ],
                    }
                )

        encounters.append(
            {
                "row": row_name,
                "rarity": enum_leaf(row.get("Rarity")),
                "spreadRadius": row.get("SpreadRadius"),
                "despawnBehaviour": enum_leaf(row.get("DespawnBehaviour")),
                "chanceModifiers": read_chance_modifiers(row),
                "members": members,
            }
        )

    return (
        {
            "sourcePath": repo_display_path(path, repo_root),
            "encounters": encounters,
        },
        unresolved_npc_count,
    )


def collect_world_files(source_root: Path) -> list[Path]:
    generated_dir = source_root / WORLD_GENERATED_RELATIVE
    if not generated_dir.is_dir():
        raise FileNotFoundError(f"WorldPartition source not found: {generated_dir}")
    files = sorted(generated_dir.rglob("*.json"))
    main_package = generated_dir.parent.parent / "L_World.json"
    if main_package.is_file():
        files.append(main_package)
    return files


def is_in_map(location: dict[str, Any]) -> bool:
    try:
        x = float(location["X"])
        y = float(location["Y"])
        z = float(location["Z"])
    except (KeyError, TypeError, ValueError):
        return False
    return (
        MAP_X_MIN <= x <= MAP_X_MAX
        and MAP_Y_MIN <= y <= MAP_Y_MAX
        and MAP_Z_MIN <= z <= MAP_Z_MAX
    )


def clean_xyz(location: dict[str, Any]) -> dict[str, float]:
    return {
        "x": float(location["X"]),
        "y": float(location["Y"]),
        "z": float(location["Z"]),
    }


def calculate_bounds(cells: list[dict[str, float]]) -> tuple[dict[str, Any], dict[str, float]]:
    minimum = {axis: min(cell[axis] for cell in cells) for axis in ("x", "y", "z")}
    maximum = {axis: max(cell[axis] for cell in cells) for axis in ("x", "y", "z")}
    center = {axis: (minimum[axis] + maximum[axis]) / 2.0 for axis in ("x", "y", "z")}
    return {"min": minimum, "max": maximum}, center


def volume_table_reference(properties: dict[str, Any]) -> tuple[str | None, str | None]:
    reference = properties.get("SpawnTable")
    if not isinstance(reference, dict):
        return None, None
    object_path = reference.get("ObjectPath")
    object_name = normalize_object_name(reference.get("ObjectName"))
    if not isinstance(object_path, str) or not object_path:
        return object_name, None
    return object_name or object_path_stem(object_path), object_path


def compile_dynamic_spawns(
    source_root: Path,
    output_path: Path,
    npc_data_path: Path,
    repo_root: Path,
) -> dict[str, Any]:
    npc_index = build_npc_index(npc_data_path)
    table_index = build_table_index(source_root)
    source_volumes: list[tuple[dict[str, Any], Path]] = []

    for path in collect_world_files(source_root):
        text = path.read_text(encoding="utf-8")
        if '"Type": "AISpawnVolume"' not in text:
            continue
        payload = json.loads(text)
        if not isinstance(payload, list):
            continue
        for export in payload:
            if isinstance(export, dict) and export.get("Type") == "AISpawnVolume":
                source_volumes.append((export, path))

    table_paths: dict[str, Path] = {}
    unresolved_tables: list[dict[str, str | None]] = []
    prepared_volumes: list[dict[str, Any]] = []
    skipped_no_cells = 0
    skipped_out_of_bounds = 0
    source_cell_count = 0

    for export, source_path in source_volumes:
        properties = export.get("Properties", {})
        if not isinstance(properties, dict):
            properties = {}
        table_name, table_object_path = volume_table_reference(properties)
        if not table_name or not table_object_path:
            unresolved_tables.append(
                {"volume": str(export.get("Name")), "table": table_name, "objectPath": table_object_path}
            )
            continue
        table_path = resolve_table_path(source_root, table_index, table_object_path)
        if table_path is None:
            unresolved_tables.append(
                {"volume": str(export.get("Name")), "table": table_name, "objectPath": table_object_path}
            )
            continue
        table_paths[table_name] = table_path

        raw_cells = properties.get("Cells", [])
        if not isinstance(raw_cells, list) or not raw_cells:
            skipped_no_cells += 1
            continue
        source_cell_count += len(raw_cells)
        cells = [
            clean_xyz(cell["Location"])
            for cell in raw_cells
            if isinstance(cell, dict)
            and isinstance(cell.get("Location"), dict)
            and is_in_map(cell["Location"])
        ]
        if not cells:
            skipped_out_of_bounds += 1
            continue

        bounds, center = calculate_bounds(cells)
        extents = properties.get("GridCellExtents", {})
        grid_cell_extents = clean_xyz(extents) if isinstance(extents, dict) and is_xyz(extents) else None
        prepared_volumes.append(
            {
                "id": export.get("Name"),
                "sourcePath": repo_display_path(source_path, repo_root),
                "spawnTable": table_name,
                "tags": [str(tag) for tag in (properties.get("Tags") or [])],
                "gridCellExtents": grid_cell_extents,
                "center": center,
                "bounds": bounds,
                "cellCount": len(cells),
                "cells": cells,
            }
        )

    if unresolved_tables:
        detail = "\n".join(
            f"  {item['volume']}: {item['table']} ({item['objectPath']})"
            for item in unresolved_tables
        )
        raise RuntimeError(f"Could not resolve {len(unresolved_tables)} AISpawnVolume table reference(s):\n{detail}")

    referenced_table_names = sorted({volume["spawnTable"] for volume in prepared_volumes})
    tables: dict[str, Any] = {}
    unresolved_npc_count = 0
    for table_name in referenced_table_names:
        table_payload, unresolved = compile_table(table_paths[table_name], repo_root, npc_index)
        tables[table_name] = table_payload
        unresolved_npc_count += unresolved

    prepared_volumes.sort(key=lambda volume: str(volume.get("id", "")))
    encounter_count = sum(len(table["encounters"]) for table in tables.values())
    member_count = sum(
        len(encounter["members"])
        for table in tables.values()
        for encounter in table["encounters"]
    )
    payload = {
        "_meta": {
            "generatedBy": "website/tools/DynamicAISpawnData/CompileDynamicAISpawnData.py",
            "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
            "version": derive_version_label(source_root),
            "sourceRoot": str(source_root),
            "npcData": repo_display_path(npc_data_path, repo_root),
            "mapFilter": map_filter_meta(),
            "counts": {
                "sourceVolumes": len(source_volumes),
                "includedVolumes": len(prepared_volumes),
                "skippedNoCells": skipped_no_cells,
                "skippedOutOfBounds": skipped_out_of_bounds,
                "sourceCells": source_cell_count,
                "includedCells": sum(volume["cellCount"] for volume in prepared_volumes),
                "referencedTables": len(tables),
                "encounterRows": encounter_count,
                "groupMembers": member_count,
                "unresolvedNpcMembers": unresolved_npc_count,
            },
        },
        "spawnTierSettings": {
            "source": "RSDragonwilds/Config/DefaultDominionAISettings.ini",
            "interpretation": "Runtime density, cadence, and cap settings; not direct percentage odds.",
            "tiers": SPAWN_TIER_SETTINGS,
        },
        "tables": tables,
        "volumes": prepared_volumes,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=INDENT, ensure_ascii=False) + "\n", encoding="utf-8")
    return payload


def is_xyz(value: dict[str, Any]) -> bool:
    try:
        float(value["X"])
        float(value["Y"])
        float(value["Z"])
        return True
    except (KeyError, TypeError, ValueError):
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Compile resolved dynamic AI encounter areas.")
    parser.add_argument("--source-root", type=Path, default=None, help="Archive JSON root.")
    parser.add_argument("--npc-data", type=Path, default=DEFAULT_NPC_DATA, help="Compiled NPCData.json.")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUTPUT, help="Output DynamicAISpawnData.json.")
    args = parser.parse_args()

    source_root = (args.source_root or resolve_source_root(REPO_ROOT)).resolve()
    npc_data_path = args.npc_data.resolve()
    output_path = args.out.resolve()
    if not (source_root / "RSDragonwilds").is_dir():
        raise SystemExit(f"Archive JSON root not found: {source_root}")
    if not npc_data_path.is_file():
        raise SystemExit(f"NPCData.json not found: {npc_data_path}")

    print(f"[INFO] Dynamic AI source: {source_root}", flush=True)
    print(f"[INFO] NPC catalog: {npc_data_path}", flush=True)
    payload = compile_dynamic_spawns(source_root, output_path, npc_data_path, REPO_ROOT)
    counts = payload["_meta"]["counts"]
    print(f"[INFO] Wrote {output_path}", flush=True)
    print(
        "[INFO] "
        f"{counts['includedVolumes']} dynamic areas, "
        f"{counts['includedCells']} cells, "
        f"{counts['referencedTables']} tables, "
        f"{counts['encounterRows']} encounter rows",
        flush=True,
    )
    if counts["unresolvedNpcMembers"]:
        print(
            f"[WARN] {counts['unresolvedNpcMembers']} encounter member(s) used Blueprint fallback names.",
            flush=True,
        )


if __name__ == "__main__":
    main()
