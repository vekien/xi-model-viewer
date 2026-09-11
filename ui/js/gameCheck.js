// Is this folder an FFXI install? Shared by Settings and the first-run wizard
// so both judge a browsed folder by exactly the same rule.

import { backend } from './backend.js';

/** Badge look per check state, for `.xi-status`. */
export const GAME_CHECK = {
  checking: { cls: 'busy', icon: 'progress_activity' },
  ok: { cls: 'ok', icon: 'check_circle' },
  warn: { cls: 'warn', icon: 'warning' },
  missing: { cls: 'err', icon: 'error' },
};

/**
 * Does this folder exist, and does it look like an FFXI install? A folder that
 * merely exists opens no DAT, so `ok` wants the ROM tree (or FFXiMain.dll) —
 * anything else is a warning, not a refusal, since odd layouts do exist.
 *
 * @returns {Promise<{ state: 'ok'|'warn'|'missing', message: string }>}
 */
export async function checkGamePath(path) {
  let entries;
  try {
    entries = await backend.listDir(path);
  } catch {
    return { state: 'missing', message: `Folder not found: ${path}` };
  }
  const names = new Set((entries || []).map((e) => String(e?.name || '').toLowerCase()));
  if (names.has('rom') || names.has('ffximain.dll')) {
    return { state: 'ok', message: 'FINAL FANTASY XI install found.' };
  }
  return {
    state: 'warn',
    message: 'Folder found, but no ROM folder or FFXiMain.dll inside — is this the install root?',
  };
}
