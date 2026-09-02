/**
 * Saved actor sets (Actors › Manage Actor Sets): the placed actors of a zone
 * as plain JSON in localStorage, so a scene can be rebuilt later.
 *
 * A set: { id, name, zone: { name, path }, savedAt, actors: [SavedActor] }
 * SavedActor: { name, kind, entry, pack, pos, rot, scale, motion, playing,
 *               loop, visible, pcState } — `entry` is the NPC-list / character
 *               composer entry the actor was loaded from (paths etc.).
 */

const KEY = 'zoneActorSets';

export function loadActorSets() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    const sets = Array.isArray(raw?.sets) ? raw.sets : [];
    return sets.filter((s) => s && s.id && s.name && Array.isArray(s.actors));
  } catch {
    return [];
  }
}

function writeActorSets(sets) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ sets }));
    return true;
  } catch {
    return false;
  }
}

/** Strip an in-memory actor down to what a set keeps. */
export function serializeActor(a) {
  return {
    name: a.name,
    kind: a.kind ?? null,
    entry: a.entry ? JSON.parse(JSON.stringify(a.entry)) : null,
    pack: a.pack ?? null,
    pos: [a.pos[0], a.pos[1], a.pos[2]],
    rot: a.rot ? Array.from(a.rot) : null,
    scale: a.scale ?? 1,
    motion: a.motion ? { kind: a.motion.kind, id: a.motion.id } : null,
    playing: a.playing !== false,
    loop: a.loop !== false,
    visible: a.visible !== false,
    pcState: a.pcState ? JSON.parse(JSON.stringify(a.pcState)) : null,
    light: a.light ? { ...a.light } : null,
  };
}

/**
 * Save (id given → overwrite that set; else create). Returns the stored set.
 */
export function saveActorSet({ id = null, name, zone, actors }) {
  const sets = loadActorSets();
  const now = new Date().toISOString();
  const existing = id ? sets.find((s) => s.id === id) : null;
  const set = {
    id: existing?.id ?? `set-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: String(name || '').trim() || existing?.name || 'Actor set',
    zone: zone ? { name: zone.name ?? '', path: zone.path ?? '' } : (existing?.zone ?? null),
    savedAt: now,
    createdAt: existing?.createdAt ?? now,
    actors: actors.map(serializeActor),
  };
  const next = existing ? sets.map((s) => (s.id === set.id ? set : s)) : [...sets, set];
  if (!writeActorSets(next)) throw new Error('could not write to localStorage');
  return set;
}

export function deleteActorSet(id) {
  const sets = loadActorSets().filter((s) => s.id !== id);
  writeActorSets(sets);
  return sets;
}
