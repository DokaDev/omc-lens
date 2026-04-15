#!/usr/bin/env node
/**
 * SessionStart hook — notifies when a newer omc-lens release exists on GitHub.
 *
 * Reuses checkLensVersion() from src/data/version-check.mjs, which handles
 * its own 6-hour cache + 5-second timeout and never throws. On any failure
 * this hook silently exits so session start is never blocked.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOTIFY_SCRIPT = join(__dirname, 'lib', 'show-notification.applescript');

/**
 * Fire a native macOS notification via the shared AppleScript helper.
 * Title and body are passed as argv so no AppleScript string escaping
 * is required in the caller. Silent no-op on non-darwin or any failure.
 */
function macNotify(title, body) {
  if (process.platform !== 'darwin') return;
  try {
    execFile('osascript', [NOTIFY_SCRIPT, title, body], () => {});
  } catch {
    // swallow — never block session start on notification failure
  }
}

async function main() {
  try {
    const { checkLensVersion, checkOmcVersion } = await import(
      join(__dirname, '..', 'src', 'data', 'version-check.mjs')
    );

    // Run both checks in parallel; each has its own 6-hour cache.
    const [lens, omc] = await Promise.all([
      checkLensVersion().catch(() => null),
      checkOmcVersion().catch(() => null),
    ]);

    const lensAvailable = lens?.updateAvailable && lens.remote;
    const omcAvailable = omc?.updateAvailable && omc.remote;

    // Stdout banners — OMC first, then omc-lens. Kept separate so Claude
    // can parse each cleanly from the SessionStart context injection.
    if (omcAvailable) {
      process.stdout.write(
        '\n[OMC UPDATE AVAILABLE]\n\n' +
        `A new version of oh-my-claudecode is available: v${omc.remote}` +
        (omc.local ? ` (current: v${omc.local})` : '') +
        '\n\nTo update, run: omc update\n',
      );
    }
    if (lensAvailable) {
      process.stdout.write(
        '\n[OMC-LENS UPDATE AVAILABLE]\n\n' +
        `A new version of omc-lens is available: v${lens.remote}` +
        (lens.local ? ` (current: v${lens.local})` : '') +
        '\n\nTo update, run inside Claude Code:\n' +
        '  /plugin marketplace update omc-lens\n' +
        '  /plugin update omc-lens@omc-lens\n' +
        '  /reload-plugins\n',
      );
    }

    // Consolidate the macOS notification: one popup when both have updates,
    // otherwise keep the per-app title so the popup is specific. OMC is
    // listed first because it is the upstream dependency.
    const fmt = (v, cur) => `v${v}${cur ? ` (current v${cur})` : ''}`;
    if (omcAvailable && lensAvailable) {
      macNotify(
        'Updates available',
        `OMC ${fmt(omc.remote, omc.local)}\nOMC Lens HUD ${fmt(lens.remote, lens.local)}`,
      );
    } else if (omcAvailable) {
      macNotify('OMC update available', fmt(omc.remote, omc.local));
    } else if (lensAvailable) {
      macNotify('OMC Lens HUD update available', fmt(lens.remote, lens.local));
    }
  } catch {
    // Never block session start
  }
}

main();
