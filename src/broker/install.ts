// Dispatches to the right OS-specific broker installer. Only macOS and
// Windows are supported in this first pass -- see the plan this
// implements for why Linux isn't yet. Falls back to running without a
// broker (seed goes directly into the MCP client config, same as before
// this existed) wherever it's unsupported.

import { installBrokerMacos } from './install-macos.js';
import { installBrokerWindows } from './install-windows.js';

export interface BrokerInstallResult {
  socketPath: string;
  token: string;
}

export function brokerSupported(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32';
}

export function installBroker(seed: string, masterAddress: string): BrokerInstallResult {
  if (process.platform === 'darwin') {
    return installBrokerMacos(seed, masterAddress);
  }
  if (process.platform === 'win32') {
    return installBrokerWindows(seed, masterAddress);
  }
  throw new Error(`broker install is not supported on platform "${process.platform}"`);
}
