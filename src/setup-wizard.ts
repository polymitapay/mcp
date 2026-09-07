// Interactive first-run setup -- only reachable when this package is run
// directly by a human in a real terminal (see index.ts: TTY + no
// POLYPAY_WALLET_SEED yet). An MCP client spawning this over stdio never
// has a TTY, so it always skips straight past this and into startServer()
// instead, exactly like today.

import {
  intro,
  outro,
  select,
  confirm,
  multiselect,
  password,
  text,
  note,
  spinner,
  log,
  isCancel,
  cancel,
} from '@clack/prompts';
import { styleText } from 'node:util';
import { Client, Wallet } from 'xrpl';
import { XRPL_TESTNET_WS_URL } from '@x402/xrpl';
import { DECIMAL_AMOUNT_RE } from './xrpl-payment-client.js';
import { CLIENT_TARGETS } from './client-targets/index.js';

type Network = 'testnet' | 'mainnet';
type WalletSource = 'existing' | 'new';

interface SpendLimitAnswers {
  maxPerCallXrp?: string;
  maxPerCallRlusd?: string;
  maxTotalXrp?: string;
  maxTotalRlusd?: string;
}

// A sentinel for the "go back" option in a select menu -- a string, not a
// Symbol: @clack/prompts already uses a unique symbol to mean "cancelled"
// (see isCancel), and a second symbol type here would collapse into that
// same widened `symbol` type and break checkCancel's generic inference.
const BACK = '__back__' as const;

function bail(): never {
  cancel('Setup cancelled -- nothing was saved.');
  process.exit(1);
}

// @clack/prompts returns a unique symbol on Ctrl+C/Esc instead of throwing --
// this narrows that away so every call site can just use the real value.
function checkCancel<T>(value: T | symbol): T {
  if (isCancel(value)) {
    bail();
  }
  return value as T;
}

// Network + wallet source, with "← Back" from the second step to the first --
// the only two steps that are select menus, so the only two worth a back
// option (see the plan this closes: pasting a seed wrong just means
// Ctrl+C and re-running).
async function chooseNetworkAndSource(): Promise<{
  network: Network;
  source: WalletSource;
}> {
  let step: 'network' | 'source' = 'network';
  let network: Network = 'testnet';

  for (;;) {
    if (step === 'network') {
      network = checkCancel(
        await select({
          message: 'Which network do you want to use?',
          options: [
            { value: 'testnet' as const, label: 'Testnet', hint: 'free, for trying this out' },
            { value: 'mainnet' as const, label: 'Mainnet', hint: 'real funds' },
          ],
        }),
      );
      step = 'source';
      continue;
    }

    const source = checkCancel(
      await select<WalletSource | typeof BACK>({
        message: 'Do you already have a wallet, or should I create one?',
        options: [
          { value: 'existing' as const, label: 'I already have one', hint: 'paste a seed' },
          {
            value: 'new' as const,
            label:
              network === 'testnet'
                ? 'Create a new testnet wallet for me'
                : 'Generate a new wallet for me',
            hint:
              network === 'testnet'
                ? 'funded automatically, free'
                : "you'll need to fund it yourself -- mainnet has no faucet",
          },
          { value: BACK, label: '← Back', hint: 'change the network' },
        ],
      }),
    );
    if (source === BACK) {
      step = 'network';
      continue;
    }
    return { network, source };
  }
}

async function resolveWallet(
  network: Network,
  source: WalletSource,
): Promise<{ seed: string; address: string }> {
  // A boxed, red note rather than log.warn() -- this is the one warning in
  // the whole flow the user must not skim past.
  note(
    styleText(
      'red',
      "This seed is a secret, like a password -- whoever has it can move funds from this wallet.\n\n" +
        "It ends up stored in plain text in your MCP client's local config file. That's " +
        "inherent to how this is built (it never sends your key anywhere, or holds your " +
        "funds for you) -- the tradeoff is that nothing else protects that file for you " +
        'either.\n\n' +
        (network === 'testnet'
          ? 'Testnet is free, worthless play money, so this is low-stakes.'
          : "Use a mainnet wallet with only small amounts you'd be comfortable losing."),
    ),
    'Security warning',
  );

  if (source === 'existing') {
    for (;;) {
      const input = checkCancel(
        await password({ message: 'Paste your XRPL wallet seed:' }),
      );
      try {
        const wallet = Wallet.fromSeed(input);
        return { seed: input, address: wallet.address };
      } catch {
        log.error("That doesn't look like a valid XRPL seed -- try again.");
      }
    }
  }

  if (network === 'mainnet') {
    const wallet = Wallet.generate();
    log.warn(
      `${wallet.address} has no funds yet -- send it real XRP before using it (mainnet has no faucet).`,
    );
    return { seed: wallet.seed!, address: wallet.address };
  }

  const s = spinner();
  s.start('Generating and funding a new testnet wallet...');
  const client = new Client(XRPL_TESTNET_WS_URL);
  await client.connect();
  const { wallet } = await client.fundWallet();
  await client.disconnect();
  s.stop(`Funded ${wallet.address} with free testnet XRP.`);
  return { seed: wallet.seed!, address: wallet.address };
}

function validateOptionalDecimal(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return DECIMAL_AMOUNT_RE.test(value)
    ? undefined
    : 'Enter a plain decimal number (e.g. "5" or "1.5"), or leave blank for no limit.';
}

// Right after the security warning above -- the wallet is undefended by
// design (see resolveWallet), so this is the one concrete mitigation this
// package can actually offer: a hard ceiling on what it's allowed to spend.
async function promptSpendLimits(): Promise<SpendLimitAnswers> {
  const wantLimits = checkCancel(
    await confirm({
      message: 'Set spending limits for this wallet? (recommended)',
      initialValue: true,
    }),
  );
  if (!wantLimits) {
    return {};
  }

  const maxPerCallXrp = checkCancel(
    await text({
      message: 'Max XRP per call (blank = no limit)',
      placeholder: 'e.g. 5',
      defaultValue: '',
      validate: validateOptionalDecimal,
    }),
  );
  const maxPerCallRlusd = checkCancel(
    await text({
      message: 'Max RLUSD per call (blank = no limit)',
      placeholder: 'e.g. 2',
      defaultValue: '',
      validate: validateOptionalDecimal,
    }),
  );
  const maxTotalXrp = checkCancel(
    await text({
      message: 'Max total XRP for this run (resets on restart; blank = no limit)',
      placeholder: 'e.g. 20',
      defaultValue: '',
      validate: validateOptionalDecimal,
    }),
  );
  const maxTotalRlusd = checkCancel(
    await text({
      message: 'Max total RLUSD for this run (resets on restart; blank = no limit)',
      placeholder: 'e.g. 20',
      defaultValue: '',
      validate: validateOptionalDecimal,
    }),
  );

  return {
    maxPerCallXrp: maxPerCallXrp || undefined,
    maxPerCallRlusd: maxPerCallRlusd || undefined,
    maxTotalXrp: maxTotalXrp || undefined,
    maxTotalRlusd: maxTotalRlusd || undefined,
  };
}

export async function runSetupWizard(): Promise<void> {
  intro('PolymitaPay MCP setup');

  const { network, source } = await chooseNetworkAndSource();
  const { seed, address } = await resolveWallet(network, source);
  log.info(`Wallet address: ${address}`);

  const spendLimits = await promptSpendLimits();

  const mcpServerConfig = {
    command: 'npx',
    args: ['-y', '@polymitapay/mcp'],
    env: {
      POLYPAY_WALLET_SEED: seed,
      POLYPAY_NETWORK: network,
      ...(spendLimits.maxPerCallXrp ? { POLYPAY_MAX_PER_CALL_XRP: spendLimits.maxPerCallXrp } : {}),
      ...(spendLimits.maxPerCallRlusd
        ? { POLYPAY_MAX_PER_CALL_RLUSD: spendLimits.maxPerCallRlusd }
        : {}),
      ...(spendLimits.maxTotalXrp ? { POLYPAY_MAX_TOTAL_XRP: spendLimits.maxTotalXrp } : {}),
      ...(spendLimits.maxTotalRlusd ? { POLYPAY_MAX_TOTAL_RLUSD: spendLimits.maxTotalRlusd } : {}),
    },
  };

  // Detect+check every known host independently -- order-independent, and
  // never re-prompt for one that's already configured.
  const statuses = CLIENT_TARGETS.map((target) => {
    const present = target.isPresent();
    return { target, present, configured: present && target.isConfigured() };
  });

  for (const { target, present, configured } of statuses) {
    if (present && configured) {
      log.info(`${target.displayName} already has this configured.`);
    }
  }

  // Anything actually present on this machine that we can either show as
  // "already done" or offer to auto-install.
  const presentTargets = statuses.filter((s) => s.present);
  const pickable = presentTargets.filter((s) => s.configured || s.target.install);
  const installed = new Set<string>();
  const failed = new Set<string>();

  if (pickable.length === 1 && !pickable[0].configured) {
    const { target } = pickable[0];
    const install = checkCancel(
      await confirm({
        message: `${target.displayName} is installed -- add this server to it automatically?`,
      }),
    );
    if (install) {
      const result = target.install!(mcpServerConfig);
      if (result.ok) {
        log.success(`Added to ${target.displayName}.`);
        installed.add(target.id);
      } else {
        failed.add(target.id);
        log.error(`Automatic setup for ${target.displayName} failed: ${result.reason}`);
      }
    }
  } else if (pickable.length > 1) {
    // Loop back to the selection instead of falling through on "No" --
    // declining the confirmation means "let me pick again," not "give up."
    // Already-configured targets show up checked and locked (purely
    // informational, can't be toggled off); only the still-unconfigured
    // ones start unchecked and are actually pickable.
    for (;;) {
      const chosenIds = checkCancel(
        await multiselect({
          message: 'Add this server automatically to any of these?',
          options: pickable.map((s) => ({
            value: s.target.id,
            label: s.target.displayName,
            hint: s.configured ? 'already configured' : undefined,
            disabled: s.configured,
          })),
          initialValues: pickable.filter((s) => s.configured).map((s) => s.target.id),
        }),
      );
      const chosen = pickable.filter((s) => !s.configured && chosenIds.includes(s.target.id));

      if (chosen.length === 0) {
        // Nothing new picked -- leave it for a future run, nothing to confirm.
        break;
      }

      // A separate, explicit confirmation naming every target about to
      // change -- the one place the user sees, in plain language, exactly
      // what's about to be written before anything is.
      const proceed = checkCancel(
        await confirm({
          message: `This will add polymitapay to: ${chosen
            .map((s) => s.target.displayName)
            .join(', ')}. Continue?`,
        }),
      );
      if (!proceed) continue;

      for (const { target } of chosen) {
        const result = target.install!(mcpServerConfig);
        if (result.ok) {
          log.success(`Added to ${target.displayName}.`);
          installed.add(target.id);
        } else {
          failed.add(target.id);
          log.error(`Automatic setup for ${target.displayName} failed: ${result.reason}`);
        }
      }
      break;
    }
  }

  // A manual fallback is only worth showing for a host with no auto-install
  // path at all, or where auto-install was actually attempted and failed --
  // never for a host the user simply didn't pick this run (they can just
  // rerun setup for that later, nothing to nag about).
  const manualNeeded = statuses.filter((s) => {
    if (s.present && s.configured) return false;
    if (installed.has(s.target.id)) return false;
    if (!s.target.install) return true;
    return failed.has(s.target.id);
  });

  // A concrete, copy-pasteable first prompt -- someone who just finished
  // this wizard has two new tools and no idea what to do with them.
  // Deliberately generic (not tied to any one provider) since this wizard
  // runs against whatever catalog the user's POLYPAY_API_URL points at.
  const tryItPrompt = styleText(
    'green',
    'Search PolymitaPay for something that says hello, and use it.',
  );

  if (manualNeeded.length === 0) {
    note(tryItPrompt, 'Try this in your agent, after restarting it');
    outro("Restart your MCP client and you're set.");
    return;
  }

  for (const s of manualNeeded) {
    if (s.target.manualInstructions) {
      note(s.target.manualInstructions(mcpServerConfig), s.target.displayName);
    }
  }

  if (manualNeeded.some((s) => !s.target.manualInstructions)) {
    // Plain console.log, not note()/log.* -- those wrap every line in a
    // bordered box, and copy-pasting from a terminal picks up the border
    // characters along with the JSON.
    console.log("\nPaste this into your MCP client's config:\n");
    console.log(JSON.stringify({ mcpServers: { polymitapay: mcpServerConfig } }, null, 2));
    console.log('');
  }

  note(tryItPrompt, 'Try this in your agent, after restarting it');
  outro("Restart your MCP client when you're done.");
}
