// Claude Code target: presence is a CLI check, but configured-state is read
// straight from ~/.claude.json rather than parsed out of `claude mcp list`
// (that command has no --json flag, so its output is the same undocumented
// human-formatted text the interactive CLI shows -- parsing that would be
// more brittle than parsing a plain JSON key, and costs a second spawn).

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClientTarget, InstallResult, McpServerConfig } from './types.js';

const SERVER_NAME = 'polymitapay';
const CONFIG_PATH = join(homedir(), '.claude.json');

function isPresent(): boolean {
  try {
    return spawnSync('claude', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

function isConfigured(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    return typeof parsed?.mcpServers?.[SERVER_NAME] === 'object';
  } catch {
    return false;
  }
}

function install(config: McpServerConfig): InstallResult {
  const envArgs = Object.entries(config.env).flatMap(([key, value]) => [
    '-e',
    `${key}=${value}`,
  ]);
  const result = spawnSync(
    'claude',
    ['mcp', 'add', SERVER_NAME, '-s', 'user', ...envArgs, '--', config.command, ...config.args],
    { stdio: 'inherit' },
  );
  if (result.status === 0) {
    return { ok: true };
  }
  return { ok: false, reason: 'claude mcp add exited with a non-zero status' };
}

export const claudeCodeTarget: ClientTarget = {
  id: 'claude-code',
  displayName: 'Claude Code',
  isPresent,
  isConfigured,
  install,
};
