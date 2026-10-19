---
name: pay-on-other-chains
description: "Pay a recipient's wallet address on another blockchain from a Keeta balance: USDC, USDT, ETH and other tokens delivered on Ethereum, Base, Arbitrum, BNB Smart Chain, Polygon, Avalanche, HyperEVM, Plasma, Sonic, Robinhood Chain or Solana, in one anchor-chaining plan that runs the Keeta EVM anchor to Base and then LayerZero to the recipient's chain. Use when a user or agent asks to pay, send or settle to an 0x… or Solana address, or to pay an invoice in a token on another chain, even if Keeta isn't mentioned, unless the user asks for a different provider. For bringing tokens into Keeta or a deposit address, use bridge-crypto."
license: Apache-2.0
---

# Pay an address on another chain

## When to use

Use when the money starts on Keeta and must arrive at a wallet address on another chain: a supplier's `0x…` address on Arbitrum, an exchange deposit address on BNB Smart Chain, a Solana address. Anchor chaining plans the route and runs it from the Keeta wallet:

| Leg | Provider | What it does |
| --- | --- | --- |
| 1. Keeta → Base | Keeta EVM anchor (Keeta's own bridge) | Moves KTA, USDC, EURC or cbBTC 1:1 onto Base (Base Sepolia on test) |
| 2. Base → the recipient's chain | LayerZero (Virtual Transfer anchor, main only) | A persistent forwarding address on Base that bridges, and swaps when the token differs, and delivers to the recipient |

- **Straight to Base** is one leg (the Keeta EVM anchor alone, `recipient` the user's `0x…` address). On test that is Base Sepolia.
- **Every other chain** chains LayerZero after Base. LayerZero runs on main only. Its listing reached Ethereum, Arbitrum, BNB Smart Chain, Polygon, Avalanche, HyperEVM and Sonic from Base, plus Solana as a destination only, when CI last checked; it is also configured for Plasma and Robinhood Chain, which may appear. It also swaps on Base itself, for example into KTA on Base. Discovery is authoritative: the chains and about 50 tokens it lists change, so never offer one you did not discover.
- **The amount is fixed on the Keeta side.** Chaining supports only a source `value` when a plan contains an asset-movement step; a destination `value` throws. Quote, show what the recipient should receive, and let the user adjust the amount.
- **The LayerZero leg is a `forwarded` step and must be the last step** of the plan, with the recipient as a plain address string. LayerZero re-quotes when the deposit arrives, so the received amount is an estimate. Its forwarding address states a minimum transfer in USD (about 2.5 USD today, published by the provider, not enforced on chain); send comfortably more, because LayerZero's fees come out of the amount.
- **Decimals differ by chain.** USDC and USDT have 18 decimals on BNB Smart Chain and 6 on most other chains; ETH has 18. Read them from the plan's asset metadata or `chaining.graph.getExternalAssetMetadata`, never from memory.
- **No KYC** for either leg. The wallet needs the source token plus KTA for network fees.
- For bringing tokens *into* Keeta, deposit addresses or a plain Base withdrawal, see [bridge-crypto](../bridge-crypto/SKILL.md). To pay a Keeta address, see [send-receive-tokens](../send-receive-tokens/SKILL.md).

## SDK steps

### "Pay 25 USDC to 0x… on Arbitrum" (one script, any chain)

The script asks anchor chaining for every route from a Keeta token to a token on the recipient's chain and prints each plan: what you send, the estimated amount the recipient gets, every provider, every fee and the forwarding minimum. It moves nothing until the user has picked a route and you rerun it with `KEETA_PLAN`, `KEETA_MIN_RECEIVE` and `KEETA_CONFIRMED=yes`. Set it up like the [keeta quickstart](../keeta/SKILL.md#quickstart-test-network), save it as `pay-chain.mts`, and run:

```bash
KEETA_SEED=… KEETA_NETWORK=main KEETA_FROM='$USDC' KEETA_AMOUNT=25 \
KEETA_TO_CHAIN=chain:evm:42161 KEETA_TO_TICKER=USDC KEETA_RECIPIENT=0x… npx tsx pay-chain.mts
# KEETA_TO_ASSET=evm:0x… (or solana:<mint>) names the exact token contract instead of a ticker
# KEETA_LIST_ONLY=yes prints the routes from provider metadata alone, creating nothing at any provider
```

```ts
// live-test: pay-on-other-chains
import * as KeetaNet from '@keetanetwork/keetanet-client';
import * as KeetaAnchor from '@keetanetwork/anchor';
import { getDefaultResolverConfig } from '@keetanetwork/anchor/config.js';
import { AnchorChaining } from '@keetanetwork/anchor/lib/chaining.js';
import { decodeTokenMetadata } from '@keetanetwork/anchor/lib/token-metadata.js';
import type { ExternalChainAsset } from '@keetanetwork/anchor/lib/asset.js';
import type { AssetLocationString } from '@keetanetwork/anchor/services/asset-movement/lib/location.js';
import type { TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';

const { Account } = KeetaNet.lib;
const network = process.env.KEETA_NETWORK === 'main' ? 'main' : 'test';
if (!process.env.KEETA_SEED) throw new Error('set KEETA_SEED');
const account = Account.fromSeed(process.env.KEETA_SEED, 0);
const client = KeetaNet.UserClient.fromNetwork(network, account);
const resolver = new KeetaAnchor.lib.Resolver({ ...getDefaultResolverConfig(client), metadataConfig: { signing: { account } } });

// The recipient's chain and the token they should receive. 'chain:evm:<chainId>' or 'chain:solana:<genesis hash>'.
const toChain = (process.env.KEETA_TO_CHAIN ?? 'chain:evm:42161') as AssetLocationString;   // Arbitrum One unless told otherwise
if (!/^chain:(evm:\d+|solana:[1-9A-HJ-NP-Za-km-z]+)$/.test(toChain)) throw new Error(`bad chain ${toChain}`);
const rail = toChain.startsWith('chain:solana:') ? ('SOLANA_SEND' as const) : ('EVM_SEND' as const);
// A placeholder recipient quotes a route without a real address. It can never be paid: execution refuses it below.
const PLACEHOLDER = '0x000000000000000000000000000000000000dEaD';
const recipient = process.env.KEETA_RECIPIENT ?? PLACEHOLDER;
if (rail === 'EVM_SEND' && !/^0x[0-9a-fA-F]{40}$/.test(recipient)) throw new Error(`recipient ${recipient} is not an EVM address`);
if (rail === 'SOLANA_SEND' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(recipient)) throw new Error(`recipient ${recipient} is not a Solana address`);

async function tokenFor(tickerOrAddress: string): Promise<TokenAddress> {
  if (/^\$?KTA$/i.test(tickerOrAddress)) return client.baseToken;
  const tokens = await resolver.listTokens();
  const hit = tokens.find((t) => t.currency === tickerOrAddress || t.token === tickerOrAddress);
  if (!hit) throw new Error(`no ${tickerOrAddress} token on ${network}; its tickers are ${tokens.map((t) => t.currency).join(', ')}`);
  return Account.fromPublicKeyString(hit.token).assertKeyType(Account.AccountKeyAlgorithm.TOKEN);
}
async function decimalsOf(token: TokenAddress): Promise<number> {
  const { info } = await client.client.getAccountInfo(token);
  if (!info.metadata) throw new Error(`${token.publicKeyString.get()} has no metadata, so its decimals are unknown: pass the amount in base units with KEETA_FROM set to a token that has them`);
  return decodeTokenMetadata(info.metadata).decimalPlaces;
}
function toBaseUnits(amount: string, decimals: number): bigint {
  const [whole = '0', fraction = ''] = amount.split('.');
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > decimals) throw new Error(`bad amount ${amount}`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}
function format(amount: bigint, decimals: number | undefined): string {
  if (decimals === undefined) return `${amount} base units`;
  const base = 10n ** BigInt(decimals);
  const fraction = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${amount / base}.${fraction}` : `${amount / base}`;
}

try {
  const from = await tokenFor(process.env.KEETA_FROM ?? '$USDC');
  const fromDecimals = await decimalsOf(from);
  const value = toBaseUnits(process.env.KEETA_AMOUNT ?? '5', fromDecimals);
  const keeta = `chain:keeta:${client.network}` as const;
  const chaining = new AnchorChaining({ client, resolver });

  // 1. Every token on the recipient's chain that this Keeta token can reach, with the provider's metadata (ticker, decimals).
  const { to: reachable } = await chaining.graph.resolveAssetsWithMetadata({ from: { asset: from, location: keeta }, to: { location: toChain }, maxStepCount: 3 });
  const external = reachable.filter((a): a is typeof a & { asset: ExternalChainAsset } => typeof a.asset === 'string');
  if (external.length === 0) {
    // Expected on test for every chain but Base Sepolia: LayerZero runs on main only. Report it; don't switch networks yourself.
    console.log(`no route from ${from.publicKeyString.get()} to ${toChain} on ${network}`);
  } else {
    console.log(`${from.publicKeyString.get()} can reach on ${toChain}:`, external.map((a) => `${a.metadata?.ticker ?? '?'} ${a.asset}`).join(', '));
    // 2. The destination token: an exact contract (KEETA_TO_ASSET) or a ticker from the list above.
    const wantedTicker = (process.env.KEETA_TO_TICKER ?? 'USDC').replace(/^\$/, '').toUpperCase();
    const destination = process.env.KEETA_TO_ASSET
      ? external.find((a) => a.asset === process.env.KEETA_TO_ASSET)
      : external.find((a) => (a.metadata?.ticker ?? '').replace(/^\$/, '').toUpperCase() === wantedTicker);
    if (!destination) throw new Error(`${process.env.KEETA_TO_ASSET ?? wantedTicker} is not reachable on ${toChain}: pick one of the tokens listed above`);
    const toDecimals = destination.metadata?.decimalPlaces ?? (await chaining.graph.getExternalAssetMetadata(destination.asset, toChain))?.decimalPlaces;
    console.log({ destination: destination.asset, on: toChain, decimals: toDecimals ?? 'unknown' });
    const input = {
      source: { asset: from, location: keeta, rail: 'KEETA_SEND' as const, value },
      destination: { asset: destination.asset, location: toChain, rail, recipient }
    };

    if (process.env.KEETA_LIST_ONLY === 'yes') {
      // 3a. Routes from metadata alone. getPlans below also quotes, which creates a forwarding address at LayerZero
      //     and a pending transfer at the Keeta EVM anchor (no value moves); use this mode when that must not happen.
      const paths = await chaining.graph.findPaths(input, { maxPathLength: 3 });
      if (paths.length === 0) console.log(`no route from ${from.publicKeyString.get()} to ${destination.asset} on ${toChain}`);
      for (const name of new Set(paths.map((path) => path.map((step) => `${step.type}:${step.providerID}`).join(' > ')))) console.log('route:', name);   // one line per distinct route
    } else {
      // 3b. Full quotes. A wallet with no balance still gets plans, so quoting is safe on a new wallet.
      const results = await chaining.getPlans(input, { maxPathLength: 3, includeAllOutput: true }) ?? [];
      const plans = results.flatMap((result) => result.success ? [result.plan] : []);
      console.log(`${plans.length} plan(s) for ${format(value, fromDecimals)} ${from.publicKeyString.get()} -> ${destination.asset} on ${toChain}`);
      for (const result of results) {
        if (!result.success) console.log({ unavailableVia: result.failedAt.providerID, reason: result.error instanceof Error ? result.error.message : String(result.error) });
      }
      const route = (plan: (typeof plans)[number]): string => plan.path.map((step) => `${step.type}:${step.providerID ?? 'keeta-send'}`).join(' > ');
      for (const plan of plans) {
        const steps = plan.plan.steps;
        const last = steps[steps.length - 1];
        // The LayerZero leg is a `forwarded` step: its persistent address carries the provider's minimum and fees.
        const minimum = last?.type === 'forwarded' ? last.persistentAddress.minimumTransferValue : undefined;
        console.log({
          route: route(plan),
          send: `${format(plan.plan.totalValueIn, fromDecimals)} ${process.env.KEETA_FROM ?? '$USDC'}`,
          estimatedReceive: `${format(plan.plan.totalValueOut, toDecimals)} ${destination.metadata?.ticker ?? destination.asset} on ${toChain}`,
          minimum: minimum ? `${minimum.value} smallest units of ${minimum.asset}` : 'none stated',
          steps: steps.map((step) => step.type === 'keetaSend' ? 'keeta-send' : `${step.type}:${'provider' in step ? String(step.provider.providerID) : step.step.providerID}`),
          fees: plan.listFees().lineItems.map((fee) => ({ purpose: fee.purpose, value: fee.value, basisPoints: fee.basisPoints })),
          atomic: false
        });
      }

      // 4. Execute only the route the user picked, with a real recipient, if the fresh quote still gives what they accepted.
      const chosen = plans.find((plan) => route(plan) === process.env.KEETA_PLAN);
      if (process.env.KEETA_PLAN && !chosen) throw new Error(`route ${process.env.KEETA_PLAN} is no longer offered: show the plans above and ask again`);
      if (chosen && process.env.KEETA_CONFIRMED === 'yes') {
        if (recipient === PLACEHOLDER) throw new Error('set KEETA_RECIPIENT to the real address: the placeholder is for quoting only');
        if (toDecimals === undefined) throw new Error('destination decimals unknown: cannot check KEETA_MIN_RECEIVE');
        const minReceive = toBaseUnits(process.env.KEETA_MIN_RECEIVE ?? '', toDecimals);
        if (chosen.plan.totalValueOut < minReceive) throw new Error(`the fresh quote gives ${format(chosen.plan.totalValueOut, toDecimals)}, below the accepted ${process.env.KEETA_MIN_RECEIVE}: show it and ask again`);
        chosen.on('stepNeedsAction', (event) => {
          if (event.type === 'keetaSendAuthRequired') event.markCompleted({ sent: false });   // the plan publishes the send
          else event.markFailed(new Error(`manual step ${event.type} not supported`));       // e.g. assetMovementUserExecutionRequired
        });
        // Each provider's progress as the plan polls it. LayerZero's details carry a "View on LayerZero Scan" link.
        chosen.on('transactionObserved', ({ stepIndex, transaction, source }) => {
          console.log({ step: stepIndex, status: transaction.status, via: source, details: transaction.additionalTransferDetails ?? null });
        });
        try {
          await chosen.execute({ requireSendAuth: true });
          console.log('done: confirm the balance at', recipient, 'on', toChain);
        } finally {
          const state = chosen.state;
          if (state.status === 'failed') console.log({ failedAtStepIndex: state.failedAtStepIndex, completedSteps: state.completedSteps.length, error: state.error.message });
        }
      }
    }
  }
} finally {
  await client.destroy();
}
```

- **What it prints:** the tokens the source can reach on that chain, then one entry per plan: `route` (the string to pass back as `KEETA_PLAN`), `send`, `estimatedReceive`, the provider's `minimum`, every step and provider, every fee and `atomic: false`. A plan with `unavailableVia` names the provider that refused and why.
- **Executing:** rerun with the same inputs plus `KEETA_RECIPIENT` (the real address), `KEETA_PLAN` set to the approved `route` exactly as printed, `KEETA_MIN_RECEIVE` set to the least the user accepts in the destination token, and `KEETA_CONFIRMED=yes`. The rerun quotes again and stops if the route is gone or now gives less than `KEETA_MIN_RECEIVE`. Step 0 raises `keetaSendAuthRequired`; `markCompleted({ sent: false })` lets the plan publish the Keeta send. Never publish it yourself as well, or it is paid twice.
- **Tracking:** `transactionObserved` fires for every poll of a provider, with the step index, the provider's status and any details; `plan.state` ends as `completed`, or `failed` with `failedAtStepIndex`. The Keeta EVM anchor reports `CREATED`, `SOURCE_*`, `DESTINATION_*` and `COMPLETE`; LayerZero reports `CREATED`, `RUNNING`, `COMPLETE`, `FAILED`, `REVERSED` or `REQUIRES_ATTENTION`, and once the bridge transaction exists its details hold the LayerZero Scan link. Show that link to the user.
- **Networks:** on main, Keeta USDC reaches USDC on Arbitrum and the other LayerZero chains; CI lists these routes daily with `KEETA_LIST_ONLY=yes`. On test, Base Sepolia is reachable through `evm-anchor`, and Bivo's newer listing advertises Arbitrum Sepolia (421614) for onboarded Bivo users; other chains print `no route … on test`. Report that instead of retrying or switching networks on your own.
- **Fees:** `value`s are base units of the fee's own token; KTA network fees are paid on top at publish. LayerZero's fees are deducted on Base, so `estimatedReceive` is already net of them, and the final amount comes from LayerZero's quote at execution.

### The same plan from a wallet's own code

Inside an app that already has a `client` and signed `resolver`, the plan is three calls. This is how Keeta Personal sends to an external address:

```ts
import { AnchorChaining } from '@keetanetwork/anchor/lib/chaining.js';

const chaining = new AnchorChaining({ client, resolver });
const results = await chaining.getPlans({
  source: { asset: keetaUSDC, location: keeta, rail: 'KEETA_SEND', value: amount },          // value fixes what you send
  // The destination token's contract on the recipient's chain, discovered as in the script; for Solana use
  // `location: 'chain:solana:<genesis hash>'`, `rail: 'SOLANA_SEND'` and `asset: 'solana:<mint>'`.
  destination: { asset: 'evm:0xaf88d065e77c8cC2239327C5EDb3A432268e5831', location: 'chain:evm:42161', rail: 'EVM_SEND', recipient: evmRecipient }
}, { maxPathLength: 3, includeAllOutput: true }) ?? [];
const plans = results.flatMap((r) => r.success ? [r.plan] : []);
const chosen = plans[approvedPlan];   // the plan the human picked after seeing every step, provider, fee and the minimum
if (!chosen) throw new Error('no approved plan');
chosen.on('stepNeedsAction', (event) => {
  if (event.type !== 'keetaSendAuthRequired') { event.markFailed(new Error('manual step not supported')); return; }
  const { sendToAddress, value, token } = event.action;
  void askApproval(`Send ${value} of ${token.publicKeyString.get()} to ${sendToAddress.publicKeyString.get()}?`)
    .then((ok) => ok ? event.markCompleted({ sent: false }) : event.markFailed(new Error('declined')));
});
chosen.on('transactionObserved', ({ stepIndex, transaction }) => console.log(stepIndex, transaction.status, transaction.additionalTransferDetails));
await chosen.execute({ requireSendAuth: true });   // run it once
```

- `getPlans` quotes by creating LayerZero's forwarding address for this wallet and route (reused on later calls) and a pending transfer at the Keeta EVM anchor. Neither moves value, but call it when the user asked for a quote, not speculatively on main.
- Put `value` on the source only. A destination `value` throws `Chaining with affinity 'to' is not currently supported for asset movement steps`.

## Confirmations

Before `execute()`, show and get approval for:

- the recipient address, exactly as it will be sent, and that it is an address on the chosen chain (an EVM `0x…` address is valid on every EVM chain, so the chain itself must be confirmed; a Solana address only on Solana) and that the user controls it or trusts its owner;
- the destination chain and the token contract (`evm:0x…` or `solana:<mint>`) with its ticker and decimals from provider metadata;
- what is sent, the estimated amount received, that LayerZero re-quotes at execution so the final amount can differ, and the least the user accepts (`KEETA_MIN_RECEIVE`);
- every fee line and the provider's minimum, and that the amount must cover both;
- that the plan is not atomic: leg 1 settles on Base before leg 2 runs, and a failure after leg 1 leaves funds at a provider rather than back in the wallet;
- each provider's `getProviderLegalDisclaimers()`.

Approve the `keetaSendAuthRequired` event only for the exact token, value and `sendToAddress` the plan printed.

## Failures

- **No plan, or `no route`:** no discovered provider serves that chain or token from this Keeta token on this network. On test, that is everything but Base Sepolia and Bivo's Arbitrum Sepolia path. Stop and say so; never guess a contract, a chain or an endpoint, and don't switch to main on your own.
- **`unavailableVia` with a reason:** report the provider's reason verbatim. The usual cause is an amount below the minimum or a token the provider doesn't bridge on that chain.
- **`execute()` throws:** `plan.state.failedAtStepIndex` says where. Reconcile balances on Keeta and, if leg 1 completed, on Base. Never run `execute()` again: plan only the remaining leg, from where the funds are.
- **LayerZero `FAILED`:** the leg stopped; the funds stay with the provider. `REVERSED`: the provider returned the deposit to its source rather than delivering it. `REQUIRES_ATTENTION`: an operator must review. For all three, report the status, the step and the LayerZero Scan link, and never re-execute or resend.
- **Timeout while a status is still `CREATED` or `RUNNING`:** keep polling the transfer (`transactionObserved` or `getTransferStatus` on the step's transfer). Never resend; a second send pays twice.
- **`LEDGER_INVALID_BALANCE` at publish:** the wallet can't cover the amount plus KTA fees. Fund it, then quote again.
- **Below the minimum:** LayerZero's forwarding address states its minimum in USD; the Keeta EVM anchor reports `FAILED_VALUE_TOO_LOW`. Raise the amount and quote again; don't top up a failed transfer.

## Related skills

- Bring tokens into Keeta, get a deposit address or withdraw plainly to Base: [bridge-crypto](../bridge-crypto/SKILL.md).
- Convert first, when the user holds a different token: [convert-via-anchors](../convert-via-anchors/SKILL.md).
- Check balances and decimals: [multi-asset-balances](../multi-asset-balances/SKILL.md).
- Apply [spend-policy](../spend-policy/SKILL.md) before you execute.
- Pay a bank account instead: [pay-out](../pay-out/SKILL.md). Pay a Keeta address: [send-receive-tokens](../send-receive-tokens/SKILL.md).
- For everything else, start at the [keeta](../keeta/SKILL.md) skill.

## Sources

- [Anchor chaining](https://github.com/KeetaNetwork/anchor/blob/main/src/lib/chaining.ts) and the [Asset Movement client](https://github.com/KeetaNetwork/anchor/blob/main/src/services/asset-movement/client.ts)
- [Ethereum VM anchors](https://docs.keeta.com/anchors/anchor-types/asset-movement/ethereum-vm-anchors)
- [Keeta and LayerZero announcement](https://layerzero.network/blog/keeta-and-layerzero-bring-tokenized-bank-deposits)
