# Dynamic AI spawn data

`CompileDynamicAISpawnData.py` resolves the game's runtime AI encounter areas.
It joins three sources from the active archive dataset:

- `AISpawnVolume` exports in `L_World/_Generated_` and `L_World.json`;
- each volume's referenced `DT_AISpawnData*` table;
- `website/tools/NPCData/NPCData.json` for stable NPC IDs and display names.

The output, `DynamicAISpawnData.json`, keeps volumes and spawn tables normalized.
Volumes contain their in-bounds candidate cells, center, bounds, grid extents, tags,
and spawn-table name. Tables contain encounter rows, rarity, conditions, spread,
quantity, power level, and resolved AI members.

The output also includes the runtime spawn-tier settings from
`RSDragonwilds/Config/DefaultDominionAISettings.ini`: target density, configured
spawn interval, and per-player creature cap. Tiers are runtime constraints, not
direct percentage odds. The compiler constants should be checked against the
shipped INI whenever those settings change in a game update.

These are possible runtime encounter areas, not guaranteed simultaneous NPC
locations. The website presents them separately from fixed `BP_SpawnPoint_*`
actors.

Run it directly from the repository root:

```powershell
python .\website\tools\DynamicAISpawnData\CompileDynamicAISpawnData.py
```

The normal `website/updatewebsite.py` flow runs it after NPCData and before
LocationMap compilation.
