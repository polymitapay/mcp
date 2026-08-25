# wallet-mcp-server

Lets your AI agent (Claude Desktop, or any other MCP-compatible app) find
and pay for tools from the PolyPay catalog on its own — no coding
required. You paste one block of config, and from then on your agent can
ask for things in plain language and PolyPay handles finding a provider
and paying for it automatically, using the [x402](https://github.com/x402-foundation/x402)
payment protocol over the XRPL blockchain.

## What your agent can do with it

Once installed, your agent gets two abilities:

- **Search** the catalog — "find me a tool that summarizes text" and it
  gets back real matches, with their price.
- **Use** a tool it found — payment is signed and sent automatically,
  with the wallet you configure below. No approval popups, no manual
  signing.

## 1. Get a wallet (for testing, this takes two minutes)

This package needs an XRPL wallet's **seed** (a secret string, similar to
a password, that lets it sign payments for you). If you don't have one
yet, the easiest way to get a free one for testing is the
[XRPL testnet faucet](https://xrpl.org/resources/dev-tools/xrp-faucets) —
it generates a wallet and funds it with free test XRP (worth nothing
real) in one click. Testnet is a full copy of the XRPL network used
purely for testing, completely separate from the real network.

For real usage later (mainnet, real funds), use a real XRPL wallet and
only fund it with what you're comfortable using here — see the security
note below before you do that.

## 2. Install

Paste this into your MCP client's config (for Claude Desktop, that's
`claude_desktop_config.json`), filling in the seed from step 1:

```json
{
  "mcpServers": {
    "polypay": {
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
`npx` fetches the package on first run.

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
| `POLYPAY_WALLET_SEED` | yes | — | The wallet seed from step 1. |
| `POLYPAY_NETWORK` | no | `testnet` | `testnet` (free, for trying this out) or `mainnet` (real funds). |
| `POLYPAY_API_URL` | no | `http://localhost:3000` | Only relevant if you're running this against your own copy of PolyPay's backend, not the hosted one. |

A future setting, `POLYPAY_PROVIDERS`, will let you restrict which
providers your agent can see and pay — not built yet, see `PLAN.md`.

## For contributors

This section is for people working on `wallet-mcp-server` itself, not
for installing it — see `PLAN.md` for the architecture and design
decisions behind it.

```bash
npm install
cp .env.example .env   # fill in POLYPAY_WALLET_SEED yourself
npm run dev              # tsx src/index.ts, reads .env via dotenv (dev only)
npm run build             # tsc -> dist/
```
