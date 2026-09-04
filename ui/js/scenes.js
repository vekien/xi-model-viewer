/**
 * Saved scenes (Zone › Scenes): the placed actors of a zone as plain JSON in
 * localStorage, so an arrangement can be rebuilt later. The storage key is
 * the one the old "actor sets" used, so earlier saves carry over as scenes.
 *
 * A scene: { id, name, zone: { name, path }, savedAt, createdAt, actors: [SavedActor] }
 * SavedActor: { name, kind, entry, pack, pos, rot, scale, motion, playing,
 *               frame, loop, visible, fx, pcState } — `entry` is the NPC-list /
 *               character composer entry the actor was loaded from (paths etc.).
 */

const KEY = 'zoneActorSets';

export function loadScenes() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    const sets = Array.isArray(raw?.sets) ? raw.sets : [];
    return sets.filter((s) => s && s.id && s.name && Array.isArray(s.actors));
  } catch {
    return [];
  }
}

function writeScenes(sets) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ sets }));
    return true;
  } catch {
    return false;
  }
}

/** Strip an in-memory actor down to what a scene keeps. */
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
    frame: Number.isFinite(a.frame) ? a.frame : 0,
    loop: a.loop !== false,
    visible: a.visible !== false,
    fx: !!a.fx,
    // Camera Sequencer's Lock to Actor target (Place Lock Actor).
    lockTarget: !!a.lockTarget,
    pcState: a.pcState ? JSON.parse(JSON.stringify(a.pcState)) : null,
    light: a.light ? { ...a.light } : null,
  };
}

/**
 * What "the same actors" means for the unsaved-changes check: everything a
 * scene keeps except the animation frame, which moves on its own while a
 * clip plays. Works on stage actors and on saved ones alike.
 */
export function actorsFingerprint(actors) {
  return JSON.stringify((actors || []).map((a) => {
    const s = serializeActor(a);
    delete s.frame;
    return s;
  }));
}

function newId() {
  return `set-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Save (id given → overwrite that scene; else create). Returns the stored scene.
 */
export function saveScene({ id = null, name, zone, actors }) {
  const sets = loadScenes();
  const now = new Date().toISOString();
  const existing = id ? sets.find((s) => s.id === id) : null;
  const set = {
    id: existing?.id ?? newId(),
    name: String(name || '').trim() || existing?.name || 'Scene',
    zone: zone ? { name: zone.name ?? '', path: zone.path ?? '' } : (existing?.zone ?? null),
    savedAt: now,
    createdAt: existing?.createdAt ?? now,
    actors: (actors || []).map(serializeActor),
  };
  const next = existing ? sets.map((s) => (s.id === set.id ? set : s)) : [...sets, set];
  if (!writeScenes(next)) throw new Error('could not write to localStorage');
  return set;
}

/** Rename without touching the actors. Returns the updated list. */
export function renameScene(id, name) {
  const clean = String(name || '').trim();
  const sets = loadScenes().map((s) => (s.id === id && clean ? { ...s, name: clean } : s));
  writeScenes(sets);
  return sets;
}

export function deleteScene(id) {
  const sets = loadScenes().filter((s) => s.id !== id);
  writeScenes(sets);
  return sets;
}

/** "Scene 1", "Scene 2", … — one past the highest number already in use. */
export function nextSceneName(sets) {
  let max = 0;
  for (const s of sets || []) {
    const m = /^Scene (\d+)$/i.exec(String(s.name || '').trim());
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `Scene ${max + 1}`;
}
