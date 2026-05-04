#!/usr/bin/env node
// runs on `pnpm install` via the `prepare` script. points git's hooksPath at
// `.husky/` (sibling of wallet-extension/) so versioned hooks just work without
// requiring devs to run `git config` manually after cloning.
//
// no-op (with a soft note) when:
//   - not inside a git repo (e.g. running from a tarball / npm pack)
//   - running in CI (hooks aren't useful there; CI runs the full suite directly)
//   - git CLI isn't installed
//
// keeps the local-dev surface clean and never fails the install.
//
// totally vibes-only operation. ✨ if it works, sweet. if not, your install still goes through.

import { execFileSync } from 'node:child_process';

const isCI = process.env.CI === 'true' || process.env.CI === '1';
if (isCI) {
  // no log spam in CI - this script intentionally does nothing here
  process.exit(0);
}

try {
  // verify we're in a git work tree first; refuse silently otherwise
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch {
  console.log('[chromatika] not a git repo - skipping hooksPath setup');
  process.exit(0);
}

try {
  // chromatika lives at <repo>/wallet-extension; .husky/ is a sibling at <repo>/.husky.
  // git resolves core.hooksPath relative to the worktree root, so `.husky` is correct
  // regardless of which subdir we ran `pnpm install` from.
  execFileSync('git', ['config', 'core.hooksPath', '.husky'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.log('[chromatika] git hooksPath -> .husky');
} catch (err) {
  console.warn(
    '[chromatika] could not set git hooksPath (is git installed?). pre-push hook will not run.',
    err instanceof Error ? err.message : err,
  );
}
