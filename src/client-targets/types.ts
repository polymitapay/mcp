// One entry per MCP host the wizard can target -- add a new host by adding
// one file here and one line in index.ts, never by adding a branch to
// setup-wizard.ts.

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface InstallResult {
  ok: boolean;
  // User-facing failure reason, e.g. "claude mcp add exited with code 1".
  reason?: string;
}

export interface ClientTarget {
  // Stable id, used to key a user's multiselect choice.
  id: string;
  // Human-facing name, e.g. "Claude Code", "Claude Desktop".
  displayName: string;

  // Is this host installed on this machine at all? Must never throw.
  isPresent(): boolean;
  // Does it already have polymitapay configured? Only meaningful once
  // isPresent() is true, but must still be safe to call regardless of it.
  // Must never throw.
  isConfigured(): boolean;

  // Absent entirely (not "returns false") for a target with no local
  // install path -- e.g. a future ChatGPT target whose setup is a remote
  // web UI, not a file this process can write. The wizard falls back to
  // manual instructions for any target missing this.
  install?(config: McpServerConfig): InstallResult;

  // Optional override for the fallback text shown when install is absent,
  // declined, or fails -- lets a host with no local config file describe
  // its own steps instead of the generic "paste this JSON" snippet.
  // Neither current target defines this.
  manualInstructions?(config: McpServerConfig): string;
}
