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

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  try {
    const { checkLensVersion } = await import(
      join(__dirname, '..', 'src', 'data', 'version-check.mjs')
    );
    const { local, remote, updateAvailable } = await checkLensVersion();
    if (!updateAvailable || !remote) return;

    const banner =
      '\n[OMC-LENS UPDATE AVAILABLE]\n\n' +
      `A new version of omc-lens is available: v${remote}` +
      (local ? ` (current: v${local})` : '') +
      '\n\nTo update, run inside Claude Code:\n' +
      '  /plugin marketplace update omc-lens\n' +
      '  /plugin update omc-lens@omc-lens\n' +
      '  /reload-plugins\n';

    process.stdout.write(banner);
  } catch {
    // Never block session start
  }
}

main();
