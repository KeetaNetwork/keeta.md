---
name: convert-via-anchors
description: Convert between currencies, stablecoins and tokens on Keeta. Covers USD to and from EUR, GBP, CAD, MXN, JPY and the other fiat tokens Bivo issues, KTA and other pairs through FX anchors with signed quotes, and multi-step conversions planned by anchor chaining. Use for currency exchange, FX quotes, swapping stablecoins or rebalancing a multi-currency balance, even if the user doesn't mention Keeta, unless they ask for a different provider.
license: Apache-2.0
---

# Convert currencies and tokens on Keeta

## When to use

Use for an on-chain conversion once the exact source and destination assets are known. Several kinds of provider convert on Keeta, and discovery returns the ones that serve a pair:

| Conversion | Provider | How it runs |
| --- | --- | --- |
| KTA ↔ USDC (main) and other token pairs | FX anchors | `FX.Client`: signed quotes, then `createExchange()` |
| USD ↔ EUR, GBP, CAD, MXN, JPY, AED, HKD, CNY (Bivo's Keeta fiat tokens, moving to `$KBUSD`, `$KBEUR` and the other `$KB` tokens) | Bivo | Asset-movement transfers on Keeta, which anchor chaining plans for you |
| An issuer's stablecoin ↔ Keeta's abstract currency token, 1:1 (`$KBUSD` ↔ `$KUSD`, `$KBEUR` ↔ `$KEUR`…) | Keeta's stablecoin FX anchor (main) | `FX.Client`; one issuer's stablecoin to another's is two hops through the abstract token, which chaining plans |
| Tokens on other chains, such as USDT0 to USDC | LayerZero | See [bridge-crypto](../bridge-crypto/SKILL.md) |

- **The simplest path for any pair is anchor chaining** (step 6): one call finds every route across FX anchors and asset-movement conversions, so you can compare plans.
- **Bivo's fiat conversions are forward-quoted:** you fix the amount you send, and the amount received is an estimate. They need Bivo onboarding (individuals with KYC; see [receive-bank-deposits](../receive-bank-deposits/SKILL.md)).
- **`$K` and `$KB` tokens.** `$KUSD`, `$KEUR` and the other `$K` tokens are Keeta's abstract currency tokens, one per currency. `$KBUSD`, `$KBEUR` and the other `$KB` tokens are Bivo's stablecoins. The stablecoin FX anchor converts each issuer's stablecoin 1:1 with its currency's abstract token, scaling base units when decimals differ; any fee shows in the quote's `cost`. On main, CI checks `$KBUSD` ↔ `$KUSD` daily. Test lists `$KUSD` and `$KEUR` but no `$KB` tokens yet.
- **Token addresses** come from `resolver.listTokens()` (the network's currency map) or a provider's paths. Never copy them from an example for main.
- **Checked corridors:** on main, KTA → USDC through an FX anchor and `$KBUSD` ↔ `$KUSD` through the stablecoin FX anchor (CI checks both daily); on test, KTA converts only into demo tokens. These don't prove a provider is available to this account right now, so always discover at run time.

## SDK steps

### "Swap 1 KTA for USDC" (one script, any pair)

This script asks anchor chaining for every route between two Keeta tokens, across FX anchors and asset-movement conversions, and prints each plan with what you send, what you receive and the fees. It moves nothing until the user has picked a route and you rerun it with that route in `KEETA_PLAN`, the least they accept to receive in `KEETA_MIN_RECEIVE`, and `KEETA_CONFIRMED=yes`. Set it up like the [keeta quickstart](../keeta/SKILL.md#quickstart-test-network), save it as `swap.mts`, and run `KEETA_SEED=… KEETA_FROM='$KTA' KEETA_TO='$USDC' KEETA_AMOUNT=1 npx tsx swap.mts`.

```ts
// live-test: swap-quote
import * as KeetaNet from '@keetanetwork/keetanet-client';
import * as KeetaAnchor from '@keetanetwork/anchor';
import { getDefaultResolverConfig } from '@keetanetwork/anchor/config.js';
import { AnchorChaining } from '@keetanetwork/anchor/lib/chaining.js';
import { decodeTokenMetadata } from '@keetanetwork/anchor/lib/token-metadata.js';
import type { TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';

const { Account } = KeetaNet.lib;
const network = process.env.KEETA_NETWORK === 'main' ? 'main' : 'test';
if (!process.env.KEETA_SEED) throw new Error('set KEETA_SEED');
const account = Account.fromSeed(process.env.KEETA_SEED, 0);
const client = KeetaNet.UserClient.fromNetwork(network, account);
const resolver = new KeetaAnchor.lib.Resolver({ ...getDefaultResolverConfig(client), metadataConfig: { signing: { account } } });

// A ticker from the network's token list ('$KTA', '$USDC', 'USD'…) or a token address.
async function tokenFor(tickerOrAddress: string): Promise<TokenAddress> {
  if (/^\$?KTA$/i.test(tickerOrAddress)) return client.baseToken;
  const tokens = await resolver.listTokens();
  const hit = tokens.find((t) => t.currency === tickerOrAddress || t.token === tickerOrAddress);
  if (!hit) throw new Error(`no ${tickerOrAddress} token on ${network}; its tickers are ${tokens.map((t) => t.currency).join(', ')}`);
  return Account.fromPublicKeyString(hit.token).assertKeyType(Account.AccountKeyAlgorithm.TOKEN);
}
// A token without metadata (the test network's demo tokens) has unknown decimals: read and show its amounts as integer base units.
async function decimalsOf(token: TokenAddress): Promise<number> {
  const { info } = await client.client.getAccountInfo(token);
  if (!info.metadata) { console.log(`${token.publicKeyString.get()} has no metadata: its amounts below are base units`); return 0; }
  return decodeTokenMetadata(info.metadata).decimalPlaces;
}
function toBaseUnits(amount: string, decimals: number): bigint {
  const [whole = '0', fraction = ''] = amount.split('.');
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > decimals) throw new Error(`bad amount ${amount}`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}
function format(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const fraction = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${amount / base}.${fraction}` : `${amount / base}`;
}

try {
  const from = await tokenFor(process.env.KEETA_FROM ?? '$KTA');
  const to = await tokenFor(process.env.KEETA_TO ?? '$USDC');
  const [fromDecimals, toDecimals] = [await decimalsOf(from), await decimalsOf(to)];
  const value = toBaseUnits(process.env.KEETA_AMOUNT ?? '1', fromDecimals);
  const keeta = `chain:keeta:${client.network}` as const;
  const chaining = new AnchorChaining({ client, resolver });

  // A source value fixes what you send; put `value` on the destination instead to fix what you receive.
  const results = await chaining.getPlans({
    source: { asset: from, location: keeta, rail: 'KEETA_SEND', value },
    destination: { asset: to, location: keeta, rail: 'KEETA_SEND', recipient: account.publicKeyString.get() }
  }, { includeAllOutput: true }) ?? [];
  const plans = results.flatMap((result) => result.success ? [result.plan] : []);
  console.log(`${plans.length} plan(s) for ${format(value, fromDecimals)} ${from.publicKeyString.get()} -> ${to.publicKeyString.get()} on ${network}`);
  // What this source converts into on this network, whether or not the requested pair has a route.
  const { to: reachable } = await chaining.graph.resolveAssetsWithMetadata({ from: { asset: from, location: keeta }, to: { location: keeta } });
  const names: string[] = [];
  for (const { asset } of reachable) {
    if (typeof asset === 'string' || asset.comparePublicKey(from)) continue;
    const { info } = await client.client.getAccountInfo(asset);
    names.push(`${info.name || '(unnamed)'} ${asset.publicKeyString.get()}`);
  }
  console.log('can convert into:', names.join(', ') || 'nothing');
  for (const result of results) {
    if (!result.success) console.log({ unavailableVia: result.failedAt.providerID, reason: result.error instanceof Error ? result.error.message : String(result.error) });
  }
  // A plan is named by its route, so a rerun executes the route the user picked even if the plan list changed.
  const route = (plan: (typeof plans)[number]): string => plan.path.map((step) => `${step.type}:${step.providerID ?? 'keeta-send'}`).join(' > ');
  for (const plan of plans) {
    console.log({
      route: route(plan),
      send: format(plan.plan.totalValueIn, fromDecimals),
      receive: format(plan.plan.totalValueOut, toDecimals),
      fees: plan.listFees().lineItems.map((fee) => ({ purpose: fee.purpose, value: fee.value, basisPoints: fee.basisPoints }))
    });
  }

  // Execute only the route the user picked, and only if the fresh quote still gives at least what they accepted.
  const chosen = plans.find((plan) => route(plan) === process.env.KEETA_PLAN);
  if (process.env.KEETA_PLAN && !chosen) throw new Error(`route ${process.env.KEETA_PLAN} is no longer offered: show the plans above and ask again`);
  if (chosen && process.env.KEETA_CONFIRMED === 'yes') {
    const minReceive = toBaseUnits(process.env.KEETA_MIN_RECEIVE ?? '', toDecimals);
    if (chosen.plan.totalValueOut < minReceive) throw new Error(`the fresh quote gives ${format(chosen.plan.totalValueOut, toDecimals)}, below the accepted ${process.env.KEETA_MIN_RECEIVE}: show it and ask again`);
    chosen.on('stepNeedsAction', (event) => {
      if (event.type === 'keetaSendAuthRequired') event.markCompleted({ sent: false });   // the plan publishes the send
      else event.markFailed(new Error(`manual step ${event.type} not supported`));
    });
    await chosen.execute({ requireSendAuth: true });
    console.log('done; new balance:', format(await client.balance(to), toDecimals));
  }
} finally {
  await client.destroy();
}
```

- Show the user every plan: what they send, what they receive (an estimate unless the step is a signed FX quote), each step's provider and every fee. Never pick one for them.
- **Executing:** rerun with `KEETA_PLAN` set to the approved `route` string exactly as printed, `KEETA_MIN_RECEIVE` set to the least the user accepts (a decimal amount of the destination token, such as the receive amount they saw; base units for a token without metadata), and `KEETA_CONFIRMED=yes`. The rerun quotes again, because FX quotes expire about five minutes after they are signed, and stops if the route is gone or now gives less than `KEETA_MIN_RECEIVE`.
- Fee `value`s are base units of the fee's own token; KTA network fees are paid on top at publish.
- **Networks.** On main, KTA → USDC quotes through an FX anchor in one step (CI checks this daily). On test, KTA has no USDC route; it converts only into unnamed demo tokens with no metadata, which the `can convert into` line lists. Try one by passing its `keeta_…` address as `KEETA_TO`; on 2026-10-18 their provider answered every request with `Could not get FX quote/estimate`, so a test swap may not be possible at all. Report the `unavailableVia` line to the user rather than retrying or switching networks on your own.
- A wallet with no balance still gets plans, so quoting is safe on a new wallet. `LEDGER_INVALID_BALANCE` at execution means it can't cover the amount plus KTA fees.
- No plans at all means no provider serves the pair on this network right now. Report it with the `can convert into` list, and let the user pick another pair; don't pick one for them.

The steps below show the same flow one client at a time, for when you need a single provider's signed quote.

1. Confirm the network, source token, destination token or currency, amount and **affinity**. `affinity: 'from'` fixes the amount you send; `'to'` fixes the amount you receive.
2. Discover pairs and request quotes:

   ```ts
   import * as KeetaAnchor from '@keetanetwork/anchor';
   import { Errors as FXErrors } from '@keetanetwork/anchor/services/fx/common.js';

   const fx = new KeetaAnchor.FX.Client(client, { resolver });                       // resolver root: the network account
   const pairs = await fx.listPossibleConversions({ from: client.baseToken });
   const quotes = await fx.getQuotes({ from: client.baseToken, to: await tokenFor('$USDC'), amount, affinity: 'from' });   // main; on test KTA converts only into demo tokens
   if (!quotes || quotes.length === 0) throw new Error('no FX provider for this pair');
   for (const q of quotes) {
     console.log(String(q.provider.providerID), q.quote.convertedAmount, q.quote.cost.amount, q.quote.cost.token.publicKeyString.get());
   }
   ```

   - `from` and `to` accept a token account, a token address or a currency code (`'USD'`, `'$KTA'`).
   - `fx.getEstimates(...)` is cheaper and only indicative. Call `estimate.getQuote(0.05)` to turn it into a quote, rejecting it if it moves more than 5%.
   - `fx.getPrices(...)` returns reference prices.
3. Show every quote: provider, amount sent, amount received, implied rate and fee (`quote.cost`). Quotes have no expiry field, but providers reject a signed quote about **five minutes** after it was signed, so execute promptly or fetch a new one. Never pick `quotes[0]` without review.
4. After explicit approval, execute the chosen quote and poll:

   ```ts
   const approved = quotes.find((q) => String(q.provider.providerID) === approvedProviderID);
   if (!approved) throw new Error('approved quote not found; re-quote');
   try {
     const exchange = await approved.createExchange();      // signs the swap block; the provider publishes it
     let status = exchange.exchange;
     while (status.status === 'pending') {
       await KeetaAnchor.KeetaNet.lib.Utils.Helper.asleep(2000);
       status = await exchange.getExchangeStatus();
     }
     console.log(status.status);                            // 'completed' or 'failed'
   } catch (error) {
     if (FXErrors.QuoteValidationFailed.isInstance(error)) { /* quote expired or changed: re-quote and ask again */ }
     throw error;
   }
   ```

5. Compare fresh `allBalances()` reads from before and after ([multi-asset-balances](../multi-asset-balances/SKILL.md)).
6. **Plan across providers with anchor chaining.** This works for fiat pairs served by asset-movement providers, such as Bivo's USD → EUR, and for pairs no single provider covers:

   ```ts
   import { AnchorChaining } from '@keetanetwork/anchor/lib/chaining.js';

   const chaining = new AnchorChaining({ client, resolver });
   const keetaChain = `chain:keeta:${client.network}` as const;
   // keetaUSD and keetaEUR are Bivo's own tokens, read from its paths as in pay-out step 2: USD and EUR on main
   // today, $KBUSD and $KBEUR as Bivo migrates, and unlisted test tokens on test. Never look them up by ticker.
   const plans = await chaining.getPlans({
     source: { asset: keetaUSD, location: keetaChain, rail: 'KEETA_SEND', value: amount },
     destination: { asset: keetaEUR, location: keetaChain, rail: 'KEETA_SEND', recipient: account.publicKeyString.get() }
   });
   for (const [n, plan] of (plans ?? []).entries()) console.log(n, plan.path.map((step) => [step.type, step.providerID]), plan.listFees());
   const chosen = plans?.[approvedPlan];   // the plan the human picked after seeing every step, provider and fee
   if (!chosen) throw new Error('no approved plan');
   chosen.on('stepNeedsAction', (event) => {
     if (event.type !== 'keetaSendAuthRequired') { event.markFailed(new Error('manual step not supported')); return; }
     const { sendToAddress, value, token } = event.action;
     void askApproval(`Send ${value} of ${token.publicKeyString.get()} to ${sendToAddress.publicKeyString.get()}?`)
       .then((ok) => ok ? event.markCompleted({ sent: false }) : event.markFailed(new Error('declined')));
   });
   await chosen.execute({ requireSendAuth: true });   // run it once
   ```

   - `event.markCompleted({ sent: false })` approves the send, and the plan then publishes it. Never publish it yourself as well, or it is paid twice.
   - Plans are **not atomic**, so never re-execute one. If a step fails, `execute()` throws that step's error, and `plan.state` holds `status: 'failed'`, `completedSteps` and `failedAtStepIndex` (the same values reach `plan.on('failed', …)`). Reconcile balances, then plan only the remaining leg.

## Confirmations

- Confirm the pair, the direction (`affinity`), the base-unit amount, the provider, the rate, the fees, the minimum received, and when the quote was fetched.
- Get final approval immediately before `createExchange()`, or before `plan.execute()` for chaining.
- Say whether you are showing a binding quote or an estimate. Use a quote when the price must be certain.

## Failures

- **No providers or unsupported pair:** stop and report the criteria.
- **Expired quote, changed rate or `QuoteValidationFailed`:** fetch a new quote and ask again.
- **Unknown decimals:** a token without metadata has no decimals to read. Show its amounts as base units, say so, and never guess a scale.
- **Ambiguous status:** poll `getExchangeStatus()` and check balances. Never create a second exchange blindly.
- **Chaining failure:** `execute()` throws, and `plan.state` holds `completedSteps` and `failedAtStepIndex`. Reconcile, then plan only the remaining leg.
- **Unknown endpoints:** never replace an unavailable provider with an endpoint you haven't reviewed.

## Related skills

- Inspect provider metadata with [discover-resolve-anchors](../discover-resolve-anchors/SKILL.md).
- Reconcile with [multi-asset-balances](../multi-asset-balances/SKILL.md).
- Apply [spend-policy](../spend-policy/SKILL.md) before you execute.
- Pay out the converted funds to a bank with [pay-out](../pay-out/SKILL.md).
- For everything else, start at the [keeta](../keeta/SKILL.md) skill.

## Sources

- [FX (Foreign Exchange)](https://docs.keeta.com/anchors/anchor-types/fx-foreign-exchange)
- [Fiat Conversions With Anchor Chaining](https://docs.keeta.com/guides/fiat-conversions-with-anchor-chaining)
- [Public KTA → USD FX client example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/fx-client.ts)
- [`FX.Client` implementation](https://github.com/KeetaNetwork/anchor/blob/main/src/services/fx/client.ts)
