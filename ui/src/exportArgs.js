// Catalog of the xi-tools CLI flags each export command accepts, driving the
// tags-style args box in ExportModal (see ArgsInput.jsx).
//
// Mirrors the click definitions in xi-tools:
//   mesh  → src/xi/entity/mesh/xi_export.py  (`xi mesh export`)
//   anim  → src/xi/entity/anim/xi_export.py  (`xi anim export`)
//   zone  → src/xi/zone/xi_export.py         (`xi zone export`)
//   fx    → src/xi/fx/xi_export.py           (`xi fx export`)
//   music → src/xi/audio/xi_music.py         (`xi audio music export`)
//   sfx   → src/xi/audio/xi_sfx.py           (`xi audio sfx export`)
//
// Only mesh and zone are reachable from the dialog today — music/SFX decode to
// WAV in-app and anim/fx have no export entry point yet — but the catalog is
// keyed by type so those wire up with no extra work here.
//
// Each arg is `{ flag, kind, group, label, hint }` where `kind` is:
//   'flag'   — no value (`--all-parts`)
//   'value'  — needs a value (`--lod 2`)
//   'opt'    — value optional; bare flag is meaningful (`--mesh`)
// plus optional `values` (suggested completions), `defaultHint`, `conflicts`
// (flags dropped when this one is added) and `managed` (owned by a dedicated
// control in the dialog, so it never shows up in the picker).

/** The `xi …` sub-command each type exports through. */
export const EXPORT_COMMANDS = {
  mesh: ['mesh', 'export'],
  zone: ['zone', 'export'],
  anim: ['anim', 'export'],
  fx: ['fx', 'export'],
  music: ['audio', 'music', 'export'],
  sfx: ['audio', 'sfx', 'export'],
};

const OUTPUT_DIR = {
  flag: '--output', kind: 'value', group: 'Output', managed: true,
  label: 'Output directory', hint: 'Set by the Export folder field below.',
};

const OUT_DIR = {
  flag: '--out', kind: 'value', group: 'Output', managed: true,
  label: 'Output directory', hint: 'Set by the Export folder field below.',
};

const FBX = {
  flag: '--fbx', kind: 'flag', group: 'Output', managed: true,
  label: 'Also write FBX', hint: 'Set by the Output type picker above.',
};

const ALPHA_SCALE = {
  flag: '--alpha-scale', kind: 'value', group: 'Textures',
  label: 'Texture alpha scale', defaultHint: '2.0',
  values: [
    { value: '1.0', label: 'raw FFXI alpha (faint)' },
    { value: '2.0', label: 'default — opaque texels fully opaque' },
    { value: '3.0', label: 'force more opacity' },
  ],
  hint: 'Multiply texture alpha before export, clamped to 255. FFXI stores alpha at half '
    + 'scale (0x80 = opaque), so 2.0 matches the game while keeping real cutouts.',
};

const MESH_ARGS = [
  OUTPUT_DIR,
  FBX,
  {
    flag: '--all-parts', kind: 'flag', group: 'Sections',
    label: 'Merge all parts',
    hint: 'Merge ALL mesh sections into one GLB — correct for multi-part gear where separate '
      + 'sections are body parts, not LODs.',
  },
  {
    flag: '--lod', kind: 'value', group: 'Sections',
    label: 'Section index', defaultHint: '0',
    hint: 'Mesh section index to export (0 = first). Use --list-parts to see all sections.',
  },
  {
    flag: '--list-parts', kind: 'flag', group: 'Sections',
    label: 'List sections only',
    hint: 'Print every mesh section (index, name, size) to the console and exit — writes no file.',
  },
  {
    flag: '--anim', kind: 'value', group: 'Pose',
    label: 'Freeze-frame animation',
    hint: 'Pose the mesh by this animation (e.g. idl) before export, instead of the neutral bind pose.',
  },
  {
    flag: '--frame', kind: 'value', group: 'Pose', defaultHint: '0',
    label: 'Freeze-frame keyframe',
    hint: 'Keyframe index within --anim to pose at. Ignored unless --anim is given.',
  },
  {
    flag: '--no-weld', kind: 'flag', group: 'Geometry', conflicts: ['--weld'],
    label: "Don't weld vertices",
    hint: 'Preserve the original per-section splitting instead of welding by world position + UV.',
  },
  {
    flag: '--weld', kind: 'flag', group: 'Geometry', conflicts: ['--no-weld'],
    label: 'Weld vertices (default)',
    hint: 'Weld by world position + UV across all sections for a fully joined, Noesis-like mesh. '
      + 'On by default, so this flag is only worth adding for clarity.',
  },
  {
    flag: '--mesh-merge-dp', kind: 'value', group: 'Geometry', defaultHint: '4',
    label: 'Merge precision (dp)',
    values: [
      { value: '3', label: 'coarser — more merging' },
      { value: '4', label: 'default' },
      { value: '5', label: 'finer — less merging' },
    ],
    hint: 'Decimal places used when deduplicating vertices. Lower = more aggressive merging; '
      + 'below ~3 flattens the mesh.',
  },
  {
    flag: '--split-tex', kind: 'flag', group: 'Textures',
    label: 'Split texture',
    hint: 'Unmirror the skin into a stacked 2-up atlas (256x256 → 256x512) and remap the UVs so '
      + 'each mirror half samples its own copy — no overlapping UVs.',
  },
  ALPHA_SCALE,
  {
    flag: '--no-base', kind: 'flag', group: 'Source',
    label: 'Ignore .base backup',
    hint: 'Ignore any .base pristine backup and export from the live (edited) DAT instead.',
  },
];

const ZONE_ARGS = [
  OUTPUT_DIR,
  FBX,
  {
    flag: '--no-sky', kind: 'flag', group: 'Contents',
    label: 'Omit skybox',
    hint: 'Drop the skybox/celestial chunks (sun, moon, stars, clouds) that sit at the origin.',
  },
  {
    flag: '--no-vfx', kind: 'flag', group: 'Contents',
    label: 'Omit VFX / unplaced',
    hint: 'Drop every unplaced mesh — effect-placed VFX (water jets, light glows) and dead '
      + 'geometry. Only placed world geometry remains.',
  },
  {
    flag: '--no-subareas', kind: 'flag', group: 'Contents',
    label: 'Omit sub-areas',
    hint: 'Drop placements tagged with a sub-area id: shop and inn interiors, and in Ru’Aun a '
      + 'second low-detail copy of the sky. Included by default.',
  },
  {
    flag: '--with-collision-proxies', kind: 'flag', group: 'Contents',
    label: 'Include collision proxies',
    hint: 'Include collision-only placements (draw distance exactly 1.0) the client never renders — '
      + 'hitwall_*, kabe-atariyou, id_board*. Stacks invisible geometry on the zone.',
  },
  {
    flag: '--with-far-lod', kind: 'flag', group: 'Contents',
    label: 'Include far LOD copies',
    hint: 'Include m_/lnd_ far copies that stand in for richer geometry the zone also places, so '
      + 'the cheap copy ends up inside the detailed one.',
  },
  {
    flag: '--objects', kind: 'flag', group: 'Layout',
    label: 'Per-object files',
    hint: 'Write each mesh as its own .glb into a <stem>_objects/ folder (local space, at the '
      + 'origin) instead of one combined zone file.',
  },
  {
    flag: '--raw', kind: 'flag', group: 'Layout',
    label: 'Raw FFXI coords',
    hint: 'Omit the orientation-correction node — view-only; a raw export is not meant to be re-imported.',
  },
  {
    flag: '--right-handed', kind: 'flag', group: 'Layout',
    label: 'Right-handed geometry',
    hint: 'Bake the handedness flip into geometry for engines that drop negative node-scale '
      + '(Godot/Unreal) — un-mirrored and collidable.',
  },
  {
    flag: '--collision', kind: 'flag', group: 'Extras',
    label: 'Collision mesh',
    hint: 'Also dump the player-collision MZB to <stem>.collision.obj, in the same frame as the '
      + 'glb so it overlays the model.',
  },
  {
    flag: '--json', kind: 'flag', group: 'Extras',
    label: 'Zone metadata JSON',
    hint: 'Also write <stem>.zone.json: placements (full TRS + LOD + links), mesh list, textures, '
      + 'weather ambient sounds, companion DATs and sub-area interiors.',
  },
  ALPHA_SCALE,
  {
    flag: '--base', kind: 'flag', group: 'Source',
    label: 'Pristine base',
    hint: 'Export from the pristine original instead of your edited DAT — handy to regenerate a '
      + 'clean model after editing.',
  },
];

const ANIM_ARGS = [
  OUTPUT_DIR,
  {
    flag: '--anim', kind: 'value', group: 'Clip', defaultHint: 'idl',
    label: 'Animation name',
    hint: 'Animation name (idl, wlk, run, etc.).',
  },
  {
    flag: '--fbx', kind: 'flag', group: 'Output',
    label: 'Also write FBX',
    hint: 'Also convert to an animated .fbx via Blender (bakes the motion and, unless --no-tex, '
      + 'the textures).',
  },
  {
    flag: '--no-tex', kind: 'flag', group: 'Output',
    label: 'Skip textures',
    hint: 'Skip decoding the DAT textures for a geometry-only export.',
  },
  {
    flag: '--race', kind: 'value', group: 'Skeleton',
    label: 'Base race',
    values: ['HumeMale', 'HumeFemale', 'ElvaanMale', 'ElvaanFemale', 'TaruMale', 'TaruFemale',
      'Mithra', 'Galka'].map((v) => ({ value: v })),
    hint: 'Base race skeleton / mesh for animation-only DATs. Auto-detected from the DAT id; pass '
      + 'to override. In bulk mode this restricts the export to one race.',
  },
  {
    flag: '--skeleton-dat', kind: 'value', group: 'Skeleton',
    label: 'Explicit skeleton DAT',
    hint: 'Base skeleton DAT (ROM path or file path). Overrides --race when the DAT has no '
      + 'skeleton of its own.',
  },
  {
    flag: '--mesh', kind: 'opt', group: 'Skeleton',
    label: 'Attach a body mesh',
    hint: 'Bare --mesh = the race’s naked body. --mesh ID,ID,ID,ID,ID,ID = a look of gear model '
      + 'ids for face,head,body,hands,legs,feet. Also accepts DAT path(s) or a race name.',
  },
  {
    flag: '--category', kind: 'value', group: 'Bulk mode',
    label: 'Motion categories',
    values: ['movement', 'emote', 'dance', 'action', 'fishing', 'battle', 'dwMain', 'dwOff',
      'weaponSkill'].map((v) => ({ value: v })),
    hint: 'No-DAT bulk mode only: restrict to these motion categories (comma-separated).',
  },
  {
    flag: '--skip-existing', kind: 'flag', group: 'Bulk mode',
    label: 'Skip existing',
    hint: 'No-DAT bulk mode: skip clips whose output file already exists (resume a long run).',
  },
  {
    flag: '--limit', kind: 'value', group: 'Bulk mode',
    label: 'Stop after N DATs',
    hint: 'No-DAT bulk mode: stop after this many DATs (for testing).',
  },
];

const FX_ARGS = [OUT_DIR];

const audioArgs = (what, numbered) => [
  OUT_DIR,
  {
    flag: '--root', kind: 'value', group: 'Selection',
    label: 'Sound root',
    values: [{ value: 'sound' }, { value: 'sound2' }, { value: 'sound3' }, { value: 'sound4' }],
    hint: 'Limit to one sound root (e.g. sound3). Default: all.',
  },
  {
    flag: '--limit', kind: 'value', group: 'Selection',
    label: 'Stop after N files',
    hint: 'Stop after N files.',
  },
  {
    flag: '--no-loops', kind: 'flag', group: 'Decoding', conflicts: ['--loops'],
    label: 'No loop chunk',
    hint: `Skip the WAV smpl loop chunk that looped ${what} normally get.`,
  },
  {
    flag: '--loops', kind: 'flag', group: 'Decoding', conflicts: ['--no-loops'],
    label: 'Loop chunk (default)',
    hint: `Embed a WAV smpl loop chunk for looped ${what}. On by default.`,
  },
  {
    flag: '--native-only', kind: 'flag', group: 'Decoding',
    label: 'Native codecs only',
    hint: 'Decode only ADPCM/PCM natively; skip ATRAC3 entirely.',
  },
  {
    flag: '--vgmstream', kind: 'value', group: 'Decoding',
    label: 'vgmstream-cli path',
    hint: 'Path to vgmstream-cli for ATRAC3 (else auto-detected).',
  },
  {
    flag: '--numbered', kind: 'flag', group: 'Naming',
    label: 'Numbered filenames',
    hint: `Mirror the source tree (${numbered}) instead of human-readable names.`,
  },
];

export const ARG_CATALOG = {
  mesh: MESH_ARGS,
  zone: ZONE_ARGS,
  anim: ANIM_ARGS,
  fx: FX_ARGS,
  music: audioArgs('tracks', 'music###'),
  sfx: audioArgs('effects', 'seNNNNNN'),
};

/** Order groups appear in the picker; anything unlisted sorts last, in place. */
const GROUP_ORDER = ['Sections', 'Contents', 'Layout', 'Pose', 'Geometry', 'Textures', 'Extras',
  'Clip', 'Skeleton', 'Selection', 'Decoding', 'Naming', 'Bulk mode', 'Source', 'Output'];

/** Args offered in the picker for `type`, minus the ones the dialog owns. */
export function pickableArgs(type) {
  const all = ARG_CATALOG[type] ?? [];
  const shown = all.filter((a) => !a.managed);
  return [...shown].sort((a, b) => {
    const ga = GROUP_ORDER.indexOf(a.group);
    const gb = GROUP_ORDER.indexOf(b.group);
    return (ga < 0 ? GROUP_ORDER.length : ga) - (gb < 0 ? GROUP_ORDER.length : gb);
  });
}

export function findArg(type, flag) {
  return (ARG_CATALOG[type] ?? []).find((a) => a.flag === flag);
}

/** `"--lod 2"` → `{ flag: '--lod', value: '2' }`. Value keeps its inner spaces. */
export function splitToken(token) {
  const t = String(token ?? '').trim();
  const at = t.search(/[\s=]/);
  if (at < 0) return { flag: t, value: '' };
  return { flag: t.slice(0, at), value: t.slice(at + 1).trim() };
}

export const tokenFlag = (token) => splitToken(token).flag;

/** Token list → flat argv, so `["--lod 2"]` becomes `["--lod", "2"]`. */
export function tokensToArgv(tokens) {
  const out = [];
  for (const token of tokens ?? []) {
    const { flag, value } = splitToken(token);
    if (!flag) continue;
    out.push(flag);
    if (value) out.push(value);
  }
  return out;
}

/**
 * Add `token`, replacing any existing token for the same flag and dropping the
 * flags it conflicts with (`--weld` ⇄ `--no-weld`).
 */
export function addToken(type, tokens, token) {
  const t = String(token ?? '').trim();
  if (!t) return tokens;
  const { flag } = splitToken(t);
  const drop = new Set([flag, ...(findArg(type, flag)?.conflicts ?? [])]);
  const kept = tokens.filter((x) => !drop.has(tokenFlag(x)));
  const at = tokens.findIndex((x) => tokenFlag(x) === flag);
  // Replacing in place keeps the row from jumping to the end when a value changes.
  if (at < 0) return [...kept, t];
  const idx = kept.length - (tokens.length - at - 1);
  return [...kept.slice(0, idx), t, ...kept.slice(idx)];
}

export function removeFlag(tokens, flag) {
  return tokens.filter((x) => tokenFlag(x) !== flag);
}

export function tokenValue(tokens, flag) {
  const hit = (tokens ?? []).find((x) => tokenFlag(x) === flag);
  return hit === undefined ? null : splitToken(hit).value;
}
