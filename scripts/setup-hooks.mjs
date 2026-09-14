/**
 * Points git at the tracked hooks in .githooks (pre-commit secret scan,
 * pre-push verify). Runs from `npm install` via the "prepare" script. Does
 * nothing when this is not a git checkout (Docker build, CI tarball) or git
 * is not installed, and never fails the install.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync(new URL('../.git', import.meta.url))) {
  try {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
    console.log('git hooks enabled: .githooks (pre-commit secret scan, pre-push verify)');
  } catch {
    // git not available: nothing to set up
  }
}
