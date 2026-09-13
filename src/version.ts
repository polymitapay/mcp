// This package's own version + install root, read from its own
// package.json at runtime -- shared by setup-wizard.ts (to pin the exact
// version in generated MCP client configs) and the broker installers (to
// know what to copy to a stable on-disk location).

import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const packageJsonPath = require.resolve('../package.json');

export const PACKAGE_ROOT: string = dirname(packageJsonPath);
export const OWN_VERSION: string = (require(packageJsonPath) as { version: string }).version;
