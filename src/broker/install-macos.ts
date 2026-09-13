// macOS installer for the broker daemon: copies this package's own
// already-running code to a fixed, versioned location outside of npx's
// cache, then registers it as a launchd user agent so it starts with the
// user's session and keeps running independently of whatever `npx -y`
// fetches for the MCP server package itself on its next restart.

import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { brokerDir, socketPath } from './protocol.js';
import { generateToken, writeCredentials } from './store.js';
import { vendorRuntimeDependencies } from './vendor-deps.js';
import { OWN_VERSION, PACKAGE_ROOT } from '../version.js';

const LABEL = 'com.polypay.broker';

function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function vendorDir(): string {
  return join(brokerDir(), 'vendor', OWN_VERSION);
}

function writePlist(daemonPath: string): void {
  const logPath = join(brokerDir(), 'broker.log');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${daemonPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`;
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(plistPath(), plist);
}

// Installs (or re-installs, on a version bump) the broker as a persistent
// launchd user agent, with fresh credentials. Returns what the MCP client
// config needs to talk to it -- the seed itself never appears in that
// config once this succeeds.
export function installBrokerMacos(
  seed: string,
  masterAddress: string,
): { socketPath: string; token: string } {
  mkdirSync(brokerDir(), { recursive: true });

  // Only dist/ + package.json, not the whole PACKAGE_ROOT -- copying
  // everything would also drag along dev-only files (e.g. a local .env
  // with its own seed) when run from a source checkout, and node_modules
  // isn't reliably *inside* PACKAGE_ROOT anyway (npx/npm can hoist
  // dependencies above it). vendorRuntimeDependencies() below handles the
  // one dependency the daemon actually needs (xrpl) correctly regardless
  // of that layout. A full copy, not a symlink -- this becomes the stable
  // artifact a future `npx -y` refetch of the main package can never
  // silently replace. Re-running setup after a version bump copies the
  // new one into its own versioned folder; old versions' folders are
  // harmless leftovers, not worth cleaning up in this first pass.
  const dest = vendorDir();
  mkdirSync(dest, { recursive: true });
  cpSync(join(PACKAGE_ROOT, 'dist'), join(dest, 'dist'), { recursive: true });
  vendorRuntimeDependencies(dest);

  const token = generateToken();
  writeCredentials({ seed, masterAddress, token });

  const daemonPath = join(dest, 'dist', 'broker', 'daemon.js');
  writePlist(daemonPath);

  // Idempotent: unload first (ignoring failure -- expected on a first
  // install, nothing was loaded yet), then load fresh so a re-install
  // actually picks up the new plist/vendor path instead of leaving an
  // old version running alongside it.
  try {
    execFileSync('launchctl', ['unload', plistPath()], { stdio: 'ignore' });
  } catch {
    // Not previously loaded -- expected on a first install.
  }
  execFileSync('launchctl', ['load', '-w', plistPath()], { stdio: 'inherit' });

  return { socketPath: socketPath(), token };
}
