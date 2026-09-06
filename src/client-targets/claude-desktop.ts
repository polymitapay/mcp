// Claude Desktop target: no CLI exists for this app, so presence and
// configured-state are both read straight off its config file. There's no
// official Linux build today, so any platform besides darwin/win32 resolves
// to no config dir -- isPresent() is then always false and the target
// silently excludes itself everywhere, no special-casing needed elsewhere.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClientTarget, InstallResult, McpServerConfig } from './types.js';

const SERVER_NAME = 'polymitapay';

function configDir(): string | null {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude');
  }
  if (process.platform === 'win32') {
    return process.env.APPDATA ? join(process.env.APPDATA, 'Claude') : null;
  }
  return null;
}

function configPath(): string | null {
  const dir = configDir();
  return dir ? join(dir, 'claude_desktop_config.json') : null;
}

function isPresent(): boolean {
  const dir = configDir();
  return dir !== null && existsSync(dir);
}

function readConfig(): Record<string, unknown> {
  const path = configPath();
  if (!path || !existsSync(path)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

function isConfigured(): boolean {
  const parsed = readConfig() as { mcpServers?: Record<string, unknown> };
  return typeof parsed.mcpServers?.[SERVER_NAME] === 'object';
}

function install(config: McpServerConfig): InstallResult {
  const path = configPath();
  if (!path) {
    return { ok: false, reason: 'no Claude Desktop config path on this platform' };
  }
  try {
    const parsed = readConfig() as { mcpServers?: Record<string, unknown> };
    parsed.mcpServers ??= {};
    parsed.mcpServers[SERVER_NAME] = config;
    writeFileSync(path, JSON.stringify(parsed, null, 2));
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export const claudeDesktopTarget: ClientTarget = {
  id: 'claude-desktop',
  displayName: 'Claude Desktop',
  isPresent,
  isConfigured,
  install,
};
