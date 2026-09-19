// Gives the broker daemon its own, real, self-contained node_modules for
// the one runtime dependency it needs (`xrpl`) inside its vendor
// directory -- a real `npm install`, not a copy of this process's own
// node_modules. Copying was tried first and broke in practice: `xrpl`
// itself depends on packages like `eventemitter3` that this project's own
// package manager hoists to a sibling location, not nested inside
// node_modules/xrpl -- copying only the xrpl folder silently produced a
// daemon that crashed on startup with "Cannot find module 'eventemitter3'".
// A clean install sidesteps that regardless of how the *caller's*
// node_modules happens to be laid out (npm hoisting, pnpm's .pnpm store,
// etc.).

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

export function vendorRuntimeDependencies(destPackageRoot: string): void {
  const xrplVersion = (require('xrpl/package.json') as { version: string }).version;
  writeFileSync(
    join(destPackageRoot, 'package.json'),
    JSON.stringify(
      { name: 'polypay-broker-vendor', private: true, dependencies: { xrpl: xrplVersion } },
      null,
      2,
    ),
  );
  execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: destPackageRoot,
    stdio: 'inherit',
  });
}
