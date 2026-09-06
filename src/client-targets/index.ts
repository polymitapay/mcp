import { claudeCodeTarget } from './claude-code.js';
import { claudeDesktopTarget } from './claude-desktop.js';
import type { ClientTarget } from './types.js';

export const CLIENT_TARGETS: ClientTarget[] = [claudeCodeTarget, claudeDesktopTarget];

export type { ClientTarget, InstallResult, McpServerConfig } from './types.js';
