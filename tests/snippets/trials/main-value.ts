// networks: main-funded
// Trial "main-value": real value on the main network, with the dedicated trial account from the
// KEETA_MAIN_TRIAL_SEED secret (skipped when the secret is absent, as on fork pull requests).
// Built from the skills: send-receive-tokens (send, verify), convert-via-anchors (swap script with route
// and minimum receive) and multi-asset-balances. The user's requests stand in as:
//   "Send 0.01 KTA to my other account and have it send it all back."
//   "Swap 0.5 KTA to USDC, then swap the USDC back to KTA."
// Guards: the send round trip must end exactly where it started less the two network fees, and the
// whole run fails if the account ends more than MAX_LOSS KTA poorer (the swaps add the provider's spread).
import * as KeetaNet from '@keetanetwork/keetanet-client';
import * as KeetaAnchor from '@keetanetwork/anchor';
import { getDefaultResolverConfig } from '@keetanetwork/anchor/config.js';
import { AnchorChaining } from '@keetanetwork/anchor/lib/chaining.js';
import { decodeTokenMetadata } from '@keetanetwork/anchor/lib/token-metadata.js';
import type { TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';

const { Account } = KeetaNet.lib;
const network = 'main';
if (process.env.KEETA_NETWORK !== 'main') throw new Error('main-value runs on main only');
if (process.env.KEETA_CONFIRMED !== 'yes') throw new Error('main-value moves value: set KEETA_CONFIRMED=yes');
if (!process.env.KEETA_SEED) throw new Error('set KEETA_SEED');
const account = Account.fromSeed(process.env.KEETA_SEED, 0);
const other = Account.fromSeed(process.env.KEETA_SEED, 1);
const client = KeetaNet.UserClient.fromNetwork(network, account);
const otherClient = KeetaNet.UserClient.fromNetwork(network, other);
const resolver = new KeetaAnchor.lib.Resolver({ ...getDefaultResolverConfig(client), metadataConfig: { signing: { account } } });
const explorer = 'https://explorer.keeta.com';
const MIN_BALANCE = '1';     // KTA the account must hold to run
const MAX_LOSS = '0.1';      // KTA the whole run may cost in fees and spread

const watchdog = setTimeout(() => { console.log('FAILED: trial exceeded 9 minutes'); process.exit(3); }, 9 * 60_000);
watchdog.unref();
function step(title: string) { console.log(`\n== ${title} ==`); }

// --- helpers copied from convert-via-anchors "Swap 1 KTA for USDC" ---
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
async function nameOf(token: TokenAddress): Promise<string> {
  const { info } = await client.client.getAccountInfo(token);
  return info.name || '(unnamed)';
}

// Every balance, keyed by token address (multi-asset-balances).
async function balances(): Promise<Map<string, { token: TokenAddress; balance: bigint }>> {
  const held = await client.allBalances({ account });
  const map = new Map<string, { token: TokenAddress; balance: bigint }>();
  for (const { token, balance } of held) map.set(token.publicKeyString.get(), { token, balance });
  const kta = client.baseToken.publicKeyString.get();
  if (!map.has(kta)) map.set(kta, { token: client.baseToken, balance: 0n });
  return map;
}

async function quote(chaining: AnchorChaining, from: TokenAddress, to: TokenAddress, value: bigint, fromDecimals: number, toDecimals: number) {
  const keeta = `chain:keeta:${client.network}` as const;
  const results = await chaining.getPlans({
    source: { asset: from, location: keeta, rail: 'KEETA_SEND', value },
    destination: { asset: to, location: keeta, rail: 'KEETA_SEND', recipient: account.publicKeyString.get() }
  }, { includeAllOutput: true }) ?? [];
  const plans = results.flatMap((result) => result.success ? [result.plan] : []);
  console.log(`${plans.length} plan(s) for ${format(value, fromDecimals)} ${await nameOf(from)} (${from.publicKeyString.get()}) -> ${await nameOf(to)} (${to.publicKeyString.get()}) on ${network}`);
  for (const result of results) {
    if (!result.success) console.log({ unavailableVia: result.failedAt.providerID, reason: result.error instanceof Error ? result.error.message : String(result.error) });
  }
  const summaries: { plan: number; send: string; receive: string; steps: string[]; fees: { purpose: string; value: unknown; basisPoints: unknown }[] }[] = [];
  for (const [n, plan] of plans.entries()) {
    const summary = {
      plan: n,
      send: format(plan.plan.totalValueIn, fromDecimals),
      receive: format(plan.plan.totalValueOut, toDecimals),
      steps: plan.path.map((step) => `${step.type}:${step.providerID ?? 'keeta-send'}`),
      fees: plan.listFees().lineItems.map((fee) => ({ purpose: String(fee.purpose), value: fee.value, basisPoints: fee.basisPoints }))
    };
    console.log(summary);
    summaries.push(summary);
  }
  return { plans, summaries };
}


// Poll until `read()` returns something other than `before` (send-receive-tokens: verify, don't assume).
async function waitForChange(read: () => Promise<bigint>, before: bigint, what: string): Promise<bigint> {
  for (let attempt = 0; attempt < 24; attempt++) {           // up to 2 minutes
    const now = await read();
    if (now !== before) return now;
    await KeetaNet.lib.Utils.Helper.asleep(5_000);
  }
  throw new Error(`${what} did not change within 2 minutes`);
}

// Quote, pick the best route, execute it once and return what arrived (convert-via-anchors).
async function swap(chaining: AnchorChaining, from: TokenAddress, to: TokenAddress, value: bigint, fromDecimals: number, toDecimals: number): Promise<bigint> {
  const { plans, summaries } = await quote(chaining, from, to, value, fromDecimals, toDecimals);
  if (plans.length === 0) throw new Error(`no route from ${from.publicKeyString.get()} to ${to.publicKeyString.get()} on main`);
  let pick = 0;
  for (const n of plans.keys()) if (plans[n].plan.totalValueOut > plans[pick].plan.totalValueOut) pick = n;
  const chosen = plans[pick];
  const minReceive = chosen.plan.totalValueOut * 95n / 100n;   // the user accepts up to 5% slippage
  console.log('executing', summaries[pick].steps.join(' > '), `min receive ${format(minReceive, toDecimals)}`);
  chosen.on('stepNeedsAction', (event) => {
    if (event.type !== 'keetaSendAuthRequired') { event.markFailed(new Error(`manual step ${event.type} not supported`)); return; }
    const { value: sendValue, token } = event.action;
    if (!token.comparePublicKey(from) || sendValue > value) { event.markFailed(new Error('send differs from the confirmed plan; declined')); return; }
    event.markCompleted({ sent: false });   // the plan publishes the send
  });
  // When the destination is KTA, the KTA network fee on our send also lands in this balance, so allow for it.
  const feeSlack = to.comparePublicKey(client.baseToken) ? toBaseUnits('0.001', toDecimals) : 0n;
  const before = await client.balance(to);
  await chosen.execute({ requireSendAuth: true });
  let received = 0n;
  for (let attempt = 0; attempt < 24; attempt++) {           // up to 2 minutes for the provider to pay out
    received = (await client.balance(to)) - before;
    if (received + feeSlack >= minReceive) break;
    await KeetaNet.lib.Utils.Helper.asleep(5_000);
  }
  console.log(`received ${format(received < 0n ? 0n : received, toDecimals)} (${received} base units, net of any KTA fee)`);
  if (received + feeSlack < minReceive) throw new Error(`received ${received} base units within 2 minutes, below the accepted minimum ${minReceive}`);
  return received;
}

let startKta = 0n;
try {
  const kta = client.baseToken;
  const ktaDecimals = await decimalsOf(kta);
  step('wallet');
  console.log('Account:', `${explorer}/account/${account.publicKeyString.get()}`);
  startKta = await client.balance(kta);
  console.log('KTA:', format(startKta, ktaDecimals));
  if (startKta < toBaseUnits(MIN_BALANCE, ktaDecimals)) {
    console.log(`FAILED: the main trial account holds ${format(startKta, ktaDecimals)} KTA, below ${MIN_BALANCE}; refill ${account.publicKeyString.get()}`);
    process.exit(1);
  }

  step('send 0.01 KTA to the other account and all of it back');
  // The round trip must end where it started, less the KTA network fee on each send.
  const sendValue = toBaseUnits('0.01', ktaDecimals);
  const otherBefore = await otherClient.balance(kta);
  await client.send(other, sendValue, kta);
  const otherAfter = await waitForChange(() => otherClient.balance(kta), otherBefore, 'other account balance');
  if (otherAfter - otherBefore !== sendValue) throw new Error(`other account received ${otherAfter - otherBefore}, expected ${sendValue}`);
  const afterSend = await client.balance(kta);
  const fee = startKta - afterSend - sendValue;   // the network fee the send published
  console.log(`other account received 0.01 KTA; network fee ${fee} base units`);
  if (fee < 0n || fee > toBaseUnits('0.001', ktaDecimals)) throw new Error(`implausible network fee ${fee}`);
  // The other account returns everything it holds (including dust from earlier runs) less its own fee.
  await otherClient.send(account, otherAfter - fee, kta);
  const returned = await waitForChange(() => client.balance(kta), afterSend, 'balance after the send back');
  const otherLeft = await otherClient.balance(kta);
  const expected = startKta + otherBefore - 2n * fee;
  console.log(`KTA ${format(startKta, ktaDecimals)} -> ${format(returned, ktaDecimals)}; other account left with ${otherLeft} base units`);
  if (returned !== expected || otherLeft !== 0n) throw new Error(`round trip ended at ${returned} (other ${otherLeft}), expected ${expected} (other 0): it lost more than the two network fees`);
  const transferCost = startKta - returned;

  step('swap 0.5 KTA to USDC and back');
  const usdc = await tokenFor('$USDC');
  const usdcDecimals = await decimalsOf(usdc);
  const chaining = new AnchorChaining({ client, resolver });
  const gotUsdc = await swap(chaining, kta, usdc, toBaseUnits('0.5', ktaDecimals), ktaDecimals, usdcDecimals);
  // Convert the whole USDC balance back, so USDC a failed earlier run left behind is recovered too.
  const gotKta = await swap(chaining, usdc, kta, await client.balance(usdc), usdcDecimals, ktaDecimals);

  step('cost');
  const endKta = await client.balance(kta);
  const swapCost = returned - endKta;   // network fees plus the provider's spread on both legs
  const cost = startKta - endKta;
  console.log(`KTA ${format(startKta, ktaDecimals)} -> ${format(endKta, ktaDecimals)}: transfers cost ${format(transferCost, ktaDecimals)} (network fees only), swaps cost ${format(swapCost, ktaDecimals)} (fees and spread)`);
  if (cost > toBaseUnits(MAX_LOSS, ktaDecimals)) throw new Error(`the run cost ${format(cost, ktaDecimals)} KTA, more than ${MAX_LOSS}`);
  console.log(`RESULT: On main, sent 0.01 KTA to a second account and got it all back less two network fees (${format(transferCost, ktaDecimals)} KTA), then swapped 0.5 KTA into ${format(gotUsdc, usdcDecimals)} USDC and back into ${format(gotKta, ktaDecimals)} KTA at a cost of ${format(swapCost, ktaDecimals)} KTA. ${explorer}/account/${account.publicKeyString.get()}`);
} finally {
  await client.destroy();
  await otherClient.destroy();
}
