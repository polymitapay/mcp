# wallet-mcp-server

Lets your AI agent (Claude Code, Claude Desktop, or any other
MCP-compatible app) find and pay for tools from the PolyPay catalog on
its own — no coding required. Point it at a wallet and your agent can
ask for things in plain language; PolyPay handles finding a provider
and paying for it automatically, using the [x402](https://github.com/x402-foundation/x402)
payment protocol over the XRPL blockchain.

## What your agent can do with it

Once installed, your agent gets two abilities:

- **Search** the catalog — "find me a tool that summarizes text" and it
  gets back real matches, with their price.
- **Use** a tool it found — payment is signed and sent automatically,
  with the wallet you configure below. No approval popups, no manual
  signing.

## 1. Install (recommended: interactive setup)

Run this in a terminal:

```bash
npx @polymitapay/mcp
```

This walks you through everything in one go:
- pick testnet (free, for trying this out) or mainnet;
- get a wallet — generates and funds a free testnet wallet for you
  automatically, or lets you paste a seed you already have;
- shows the security warning below, in plain sight, before it asks for
  anything sensitive;
- offers to set spending limits (recommended — see "All settings"
  below);
- detects Claude Code and/or Claude Desktop on your machine and offers
  to install into whichever ones aren't set up yet.

Restart your MCP client afterward, and you're done.

## 2. Manual install (if the interactive setup can't reach your client)

Paste this into your MCP client's config (for Claude Desktop, that's
`claude_desktop_config.json`), filling in a wallet seed (see below for
where to get one, and the security note further down before you use a
real one):

```json
{
  "mcpServers": {
    "polymitapay": {
      "command": "npx",
      "args": ["-y", "@polymitapay/mcp"],
      "env": {
        "POLYPAY_WALLET_SEED": "s...",
        "POLYPAY_NETWORK": "testnet"
      }
    }
  }
}
```

Restart your MCP client, and you're done — no separate install step,
`npx` fetches the package on first run. For testing, the easiest way to
get a free seed is the
[XRPL testnet faucet](https://xrpl.org/resources/dev-tools/xrp-faucets) —
it generates a wallet and funds it with free test XRP (worth nothing
real) in one click. Testnet is a full copy of the XRPL network used
purely for testing, completely separate from the real network.

## ⚠️ Before you use a real wallet, read this

`POLYPAY_WALLET_SEED` is stored in plain text in your MCP client's local
config file on your computer. That's inherent to how this is built (it
never sends your key anywhere, or holds your funds for you — the
tradeoff is that nothing else can protect that file for you either), not
something a future update fixes.

**Practical rule: use a testnet wallet (free, worthless play money) while
you're trying this out, or a mainnet wallet with only small amounts you
could afford to lose.** Don't point this at a wallet holding funds you
can't afford to lose.

## All settings

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `POLYPAY_WALLET_SEED` | yes | — | The wallet seed from step 1 or 2 above. |
| `POLYPAY_NETWORK` | no | `testnet` | `testnet` (free, for trying this out) or `mainnet` (real funds). |
| `POLYPAY_API_URL` | no | `https://api.polymitapay.com` | Only relevant if you're running this against your own copy of PolyPay's backend, not the hosted one. |
| `POLYPAY_MAX_PER_CALL_XRP` | no | no limit | Refuses any single call priced above this many XRP. |
| `POLYPAY_MAX_PER_CALL_RLUSD` | no | no limit | Same, in RLUSD. |
| `POLYPAY_MAX_TOTAL_XRP` | no | no limit | Refuses further XRP payments once this many have been spent since the server started. Resets when it restarts. |
| `POLYPAY_MAX_TOTAL_RLUSD` | no | no limit | Same, in RLUSD. |

**Setting at least one spending limit is recommended**, especially on
mainnet — without one, your agent can spend without a ceiling. The
interactive setup (step 1 above) offers to configure these for you; if
you're editing the config by hand instead, add whichever of the four you
want directly to the `env` block.

A future setting, `POLYPAY_PROVIDERS`, will let you restrict which
providers your agent can see and pay — not built yet.

## For contributors

This section is for people working on `wallet-mcp-server` itself, not
for installing it.

`wallet-mcp-server` runs entirely on the end user's machine (that's the
point — it's non-custodial, nothing here ever touches a server you don't
control). At startup it fetches PolyPay's public catalog
(`GET /v1/catalog` on agent-rail, no account needed), opens one
auto-paying MCP connection per provider via `@x402/mcp`'s
`x402MCPClient` (handles the HTTP 402 → pay → retry flow on its own —
see `src/xrpl-payment-client.ts` for everything XRPL-specific: signing,
spend limits, RLUSD trust lines), and re-exposes all of it over its own
stdio MCP server as exactly two fixed tools — `polymitapay_search` and
`polymitapay_call` — instead of one tool per real provider tool, so a
large catalog never bloats every agent turn's context (see
`src/server.ts`). Installing into a specific MCP client (Claude Code,
Claude Desktop, more later) is handled by one small file per host under
`src/client-targets/`, each implementing the same interface (see
`src/client-targets/types.ts`) — adding a new client means adding a file
there, not touching `src/setup-wizard.ts` itself.

```bash
npm install
cp .env.example .env   # fill in POLYPAY_WALLET_SEED yourself
npm run dev              # tsx --env-file=.env src/index.ts (dev only)
npm run build             # tsc -> dist/
```

To exercise the interactive setup wizard itself (rather than the plain
server) while developing, temporarily comment out `POLYPAY_WALLET_SEED`
in `.env` and run `npm run dev` in a real terminal.
