// Windows installer for the broker daemon: same idea as install-macos.ts
// (copy this package's own code to a fixed location, run it as a
// persistent service independent of npx's cache) using Task Scheduler
// instead of launchd.

import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { brokerDir, socketPath } from './protocol.js';
import { generateToken, writeCredentials } from './store.js';
import { vendorRuntimeDependencies } from './vendor-deps.js';
import { OWN_VERSION, PACKAGE_ROOT } from '../version.js';

const TASK_NAME = 'PolypayBroker';

function vendorDir(): string {
  return join(brokerDir(), 'vendor', OWN_VERSION);
}

export function installBrokerWindows(
  seed: string,
  masterAddress: string,
): { socketPath: string; token: string } {
  mkdirSync(brokerDir(), { recursive: true });

  // See install-macos.ts's comment on this same shape: only dist/ +
  // package.json, not the whole PACKAGE_ROOT, plus vendorRuntimeDependencies
  // for the one dependency (xrpl) the daemon actually needs.
  const dest = vendorDir();
  mkdirSync(dest, { recursive: true });
  cpSync(join(PACKAGE_ROOT, 'dist'), join(dest, 'dist'), { recursive: true });
  vendorRuntimeDependencies(dest);

  const token = generateToken();
  writeCredentials({ seed, masterAddress, token });

  const daemonPath = join(dest, 'dist', 'broker', 'daemon.js');
  // /f overwrites a task from a previous install (e.g. a version bump);
  // /rl limited keeps this a standard-user task, no elevation prompt;
  // /sc onlogon means it restarts on every login, not just once now.
  execFileSync(
    'schtasks',
    [
      '/create',
      '/tn',
      TASK_NAME,
      '/tr',
      `"${process.execPath}" "${daemonPath}"`,
      '/sc',
      'onlogon',
      '/rl',
      'limited',
      '/f',
    ],
    { stdio: 'inherit' },
  );

  // Start it now too, not just at next login -- the broker needs to be
  // ready before this same setup run finishes.
  execFileSync('schtasks', ['/run', '/tn', TASK_NAME], { stdio: 'inherit' });

  return { socketPath: socketPath(), token };
}
