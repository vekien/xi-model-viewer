// Catalog of the xi-tools CLI flags each export command accepts, driving the
// tags-style args box in ExportModal (see ArgsInput.jsx).
//
// Mirrors the click definitions in xi-tools:
//   mesh  → src/xi/entity/mesh/xi_export.py  (`xi mesh export`)
//   pose  → src/xi/gear/xi_pose.py            (`xi gear pose`)
//   anim  → src/xi/entity/anim/xi_export.py  (`xi anim export`)
//   zone  → src/xi/zone/xi_export.py         (`xi zone export`)
//   fx    → src/xi/fx/xi_export.py           (`xi fx export`)
//   music → src/xi/audio/xi_music.py         (`xi audio music export`)
//   sfx   → src/xi/audio/xi_sfx.py           (`xi audio sfx export`)
//
// Only mesh, pose and zone are reachable from the dialog today — music/SFX decode
// to WAV in-app and anim/fx have no export entry point yet — but the catalog is
// keyed by type so those wire up with no extra work here.
//
// Each arg is `{ flag, kind, group, label, hint }` where `kind` is:
//   'flag'   — no value (`--all-parts`)
//   'value'  — needs a value (`--lod 2`)
//   'opt'    — value optional; bare flag is meaningful (`--mesh`)
// plus optional `values` (suggested completions), `defaultHint`, `conflicts`
// (flags dropped when this one is added), `managed` (owned by a dedicated
// control in the dialog, so it never shows up in the picker) and `quick` (a
// number: the arg also gets a checkbox under the args box, in that order — a
// value arg is ticked on with its `defaultHint`).

/** The `xi …` sub-command each type exports through. */
export const EXPORT_COMMANDS = {
  mesh: ['mesh', 'export'],
  pose: ['gear', 'pose'],
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

// `xi gear pose` merges the whole worn set onto one skeleton. The DAT list and the
// per-hand weapon flags are built from the loaded character, so they are `managed`
// and never appear in the picker — what is left is how to pose and cull it.
const POSE_ARGS = [
  OUTPUT_DIR,
  FBX,
  {
    flag: '--main', kind: 'value', group: 'Weapons', managed: true,
    label: 'Main-hand weapon', hint: 'Taken from the equipped main-hand slot.',
  },
  {
    flag: '--sub', kind: 'value', group: 'Weapons', managed: true,
    label: 'Off-hand weapon', hint: 'Taken from the equipped off-hand slot.',
  },
  {
    flag: '--ranged', kind: 'value', group: 'Weapons', managed: true,
    label: 'Ranged weapon', hint: 'Taken from the equipped ranged slot.',
  },
  {
    flag: '--name', kind: 'value', group: 'Output', managed: true,
    label: 'File stem', hint: 'Named after the character.',
  },
  {
    flag: '--keep-hidden', kind: 'flag', group: 'Occlusion',
    label: 'Keep hidden geometry',
    hint: 'Merge every piece, including the skin and hair the worn gear covers. Off by default: '
      + 'the export drops what the game hides — bare wrists under sleeves, hair under a helm, '
      + 'shins under boots — so nothing pokes through in the DCC.',
  },
  {
    flag: '--anim-dat', kind: 'value', group: 'Pose', managed: true,
    label: 'Motion DATs', hint: 'The loaded motion packs, which carry the clip’s upper-body layers.',
  },
  {
    flag: '--draw-ranged', kind: 'flag', group: 'Weapons', managed: true,
    label: 'Draw the ranged weapon',
    hint: 'Added when the current action holds the bow; otherwise the game hides it and so does '
      + 'the export.',
  },
  {
    flag: '--anim', kind: 'value', group: 'Pose', defaultHint: 'idl',
    label: 'Pose animation',
    hint: 'Clip to freeze the pose at — seeded from what the viewport is playing. Pass an '
      + 'empty value for the neutral bind pose.',
  },
  {
    flag: '--frame', kind: 'value', group: 'Pose', defaultHint: '0',
    label: 'Pose keyframe',
    hint: 'Keyframe index within --anim, seeded from the frame on screen.',
  },
  {
    flag: '--all-frames', kind: 'flag', group: 'Pose', managed: true,
    label: 'Whole animation',
    hint: 'Set by the Contents picker: embed the whole clip instead of one frame.',
  },
  {
    flag: '--no-weld', kind: 'flag', group: 'Geometry', conflicts: ['--weld'],
    label: "Don't weld vertices",
    hint: 'Preserve per-section splitting instead of welding by world position + UV.',
  },
  {
    flag: '--mesh-merge-dp', kind: 'value', group: 'Geometry', defaultHint: '4',
    label: 'Merge precision (dp)',
    hint: 'Decimal places used when deduplicating vertices. Lower = more aggressive merging.',
  },
  {
    flag: '--split-tex', kind: 'flag', group: 'Textures',
    label: 'Split texture',
    hint: 'Unmirror the skin into a stacked 2-up atlas and remap the UVs so each mirror half '
      + 'samples its own copy.',
  },
  ALPHA_SCALE,
  {
    flag: '--skeleton', kind: 'value', group: 'Source',
    label: 'Skeleton DAT',
    hint: 'Rig onto this skeleton instead of the first source that has one (the race body).',
  },
];

const ZONE_ARGS = [
  OUTPUT_DIR,
  FBX,
  {
    flag: '--no-sky', kind: 'flag', quick: 1, group: 'Contents',
    label: 'Omit skybox',
    hint: 'Drop the skybox/celestial chunks (sun, moon, stars, clouds) that sit at the origin.',
  },
  {
    flag: '--no-vfx', kind: 'flag', quick: 2, group: 'Contents',
    label: 'Omit VFX / unplaced',
    hint: 'Drop every unplaced mesh — effect-placed VFX (water jets, light glows) and dead '
      + 'geometry. Only placed world geometry remains.',
  },
  {
    flag: '--no-subareas', kind: 'flag', quick: 4, group: 'Contents',
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
    hint: 'Write each mesh as its own .glb straight into the output folder (local space, at the '
      + 'origin) instead of one combined zone file.',
  },
  {
    flag: '--raw', kind: 'flag', group: 'Layout',
    label: 'Raw FFXI coords',
    hint: 'Omit the orientation-correction node — view-only; a raw export is not meant to be re-imported.',
  },
  {
    flag: '--right-handed', kind: 'flag', quick: 8, group: 'Layout',
    label: 'Right-handed (engines)',
    hint: 'Export for Unreal/Godot/Unity. Bakes the handedness flip into geometry (engines drop '
      + 'the negative node-scale, mirroring the zone and breaking collision) AND flips winding to '
      + 'CCW-front. FFXI terrain is clockwise-front and two-sided; a single-sided engine culls it, '
      + 'so the ground looks black from above and only lights from below. This makes it render '
      + 'right-side-up and lit. Pair with Weld UV seams for connected terrain.',
  },
  {
    flag: '--unreal', kind: 'flag', quick: 9, group: 'Layout', conflicts: ['--right-handed', '--opaque'],
    label: 'Unreal preset',
    hint: 'One flag for Unreal Engine: right-handed, opaque materials, FBX, and raw vertex colours '
      + '(written linear) for the zone material to apply FFXI’s ×2. Also drops hidden duplicate '
      + 'triangles the game never shows. Use with Omit skybox and Omit VFX, then follow '
      + 'xi-tools/unreal-engine for the import settings, materials and setup script.',
  },
  {
    flag: '--no-weld', kind: 'flag', group: 'Geometry', conflicts: ['--weld'],
    label: "Don't weld vertices",
    hint: 'Keep the original per-triangle vertices instead of welding coincident corners into a '
      + 'shared, indexed mesh. Welding is on by default.',
  },
  {
    flag: '--weld', kind: 'flag', group: 'Geometry', conflicts: ['--no-weld'],
    label: 'Weld vertices (default)',
    hint: 'Weld coincident corners by position + UV + baked colour into one indexed, joined mesh '
      + '(like Noesis). On by default, so this flag is only worth adding for clarity.',
  },
  {
    flag: '--weld-seams', kind: 'flag', quick: 7, group: 'Geometry', conflicts: ['--no-weld'],
    label: 'Weld UV seams (FBX)',
    hint: 'Also fuse the UV-seam splits the default weld leaves on tiled terrain. Needs FBX output: '
      + 'the merge runs in Blender, which stores UVs per face-corner, so the geometry connects with '
      + 'the texture intact (a GLB can’t do this). Welds per material, so FFXI’s blended '
      + 'ground overlays are kept, not deleted. Merge radius follows Merge precision (dp).',
  },
  {
    flag: '--mesh-merge-dp', kind: 'value', group: 'Geometry', defaultHint: '4',
    label: 'Merge precision (dp)',
    values: [
      { value: '3', label: 'coarser — more merging' },
      { value: '4', label: 'default' },
      { value: '5', label: 'finer — less merging' },
    ],
    hint: 'Decimal places used when deduplicating vertices (4 = 0.0001 units). Lower = more '
      + 'aggressive merging.',
  },
  {
    flag: '--alpha-split-mesh', kind: 'flag', group: 'Geometry',
    label: 'Alpha split mesh (test)',
    hint: 'Write two FBX files: the opaque base and the blended ground overlays split off and '
      + 'lifted, so they stop z-fighting. Its auto-smooth draws shading creases across terrain; for '
      + 'Unreal, the Unreal preset plus the xi-tools/unreal-engine materials is the better route.',
  },
  {
    flag: '--decal-offset', kind: 'value', group: 'Geometry', defaultHint: '0.00001',
    label: 'Decal lift',
    hint: 'How far Alpha split mesh lifts each overlay off its surface, in FFXI units (~metres). '
      + 'Raise it if overlays far from the zone centre still z-fight.',
  },
  {
    flag: '--decal-smooth-angle', kind: 'value', group: 'Geometry', defaultHint: '45',
    label: 'Decal smoothing angle',
    hint: 'Auto-smooth angle in degrees for Alpha split mesh (45–60 is typical).',
  },
  {
    flag: '--collision', kind: 'flag', quick: 5, group: 'Extras',
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
  { ...ALPHA_SCALE, quick: 6 },
  {
    flag: '--opaque', kind: 'flag', quick: 3, group: 'Textures',
    label: 'Opaque materials',
    hint: 'Write non-blend materials as OPAQUE instead of MASK. Many zone textures carry junk alpha '
      + 'the client ignores, which under MASK clips whole floors and walls into a checkerboard in '
      + 'Blender. Real alpha-blend submeshes stay BLEND and foliage stays MASK.',
  },
  {
    flag: '--vertex-color', kind: 'value', group: 'Textures', defaultHint: 'baked',
    label: 'Vertex colour mode',
    values: [
      { value: 'baked', label: 'default — ×2 folded in, for viewers without shaders' },
      { value: 'raw', label: 'DAT colours + vertex alpha, for engines (Unreal preset)' },
    ],
    hint: 'Where FFXI’s baked-lighting ×2 lives. baked folds it into the colours and clamps, so '
      + 'Blender or a glTF viewer shows the in-game look. raw keeps the untouched colours for an '
      + 'engine material to multiply — otherwise bright tiles clamp to white once the engine '
      + 'lights them.',
  },
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
    flag: '--split-anim', kind: 'flag', group: 'Layout', managed: true,
    label: 'Every animation as its own file',
    hint: 'Set by the checkbox in the dialog: export every track in the DAT as a separate '
      + 'file named after it (idl0, wlk0, …) instead of the one --anim clip.',
  },
  {
    flag: '--categories', kind: 'flag', group: 'Layout', managed: true,
    label: 'Race / category / action folders',
    hint: 'Set by the checkbox in the dialog: lay the output out as '
      + '<race>/<category>/<action>/ (hume_male/sword/fast_blade/) instead of the ROM path.',
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
  pose: POSE_ARGS,
  zone: ZONE_ARGS,
  anim: ANIM_ARGS,
  fx: FX_ARGS,
  music: audioArgs('tracks', 'music###'),
  sfx: audioArgs('effects', 'seNNNNNN'),
};

/** Order groups appear in the picker; anything unlisted sorts last, in place. */
const GROUP_ORDER = ['Sections', 'Contents', 'Layout', 'Occlusion', 'Weapons', 'Pose', 'Geometry', 'Textures', 'Extras',
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

/** Args that get a checkbox under the args box, in their `quick` order. */
export function quickArgs(type) {
  return (ARG_CATALOG[type] ?? [])
    .filter((a) => a.quick && !a.managed)
    .sort((a, b) => a.quick - b.quick);
}

/** The token a quick checkbox adds: the bare flag, or a value arg at its default. */
export const quickToken = (arg) => (
  arg.kind === 'value' && arg.defaultHint ? `${arg.flag} ${arg.defaultHint}` : arg.flag
);

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

/** How `anim export` lays its files out, read off the arg tokens. */
export function animLayout(tokens) {
  const flags = new Set((tokens ?? []).map(tokenFlag));
  return { split: flags.has('--split-anim'), categories: flags.has('--categories') };
}
