// networks: test, main
// Trial "swap": the user says "Swap 1 KTA to USDC for me."
// Built only from the Keeta skills: keeta/SKILL.md (quickstart, rules), convert-via-anchors/SKILL.md
// ("Swap 1 KTA for USDC" script), create-fund-wallet/SKILL.md (faucet, balance polling) and
// multi-asset-balances/SKILL.md (allBalances reconciliation).
//
// main  (KEETA_READ_ONLY=yes): quote every route KTA -> USDC through anchor chaining and report what the
//        user would send, receive and pay. Nothing is executed.
// test  (KEETA_CONFIRMED=yes): fund the wallet from the faucet, quote KTA -> USDC; the skills say test has
//        no USDC route and KTA converts only into demo tokens, so when that is the case pick one from the
//        "can convert into" list, re-plan a small conversion and execute it behind the confirmation gate,
//        then show which balances changed.
import * as KeetaNet from '@keetanetwork/keetanet-client';
import * as KeetaAnchor from '@keetanetwork/anchor';
import { getDefaultResolverConfig } from '@keetanetwork/anchor/config.js';
import { AnchorChaining } from '@keetanetwork/anchor/lib/chaining.js';
import { decodeTokenMetadata } from '@keetanetwork/anchor/lib/token-metadata.js';
import type { TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';

const { Account } = KeetaNet.lib;
const network = process.env.KEETA_NETWORK === 'main' ? 'main' : 'test';
const explorer = network === 'main' ? 'https://explorer.keeta.com' : 'https://explorer.test.keeta.com';
const readOnly = process.env.KEETA_READ_ONLY === 'yes' || network === 'main';
const confirmed = process.env.KEETA_CONFIRMED === 'yes';
if (!process.env.KEETA_SEED) throw new Error('set KEETA_SEED');
const account = Account.fromSeed(process.env.KEETA_SEED, 0);
const client = KeetaNet.UserClient.fromNetwork(network, account);
const resolver = new KeetaAnchor.lib.Resolver({ ...getDefaultResolverConfig(client), metadataConfig: { signing: { account } } });

// Watchdog: the runner allows 8 minutes; fail loudly before it kills us.
const watchdog = setTimeout(() => { console.log('FAILED: trial exceeded 7.5 minutes'); process.exit(3); }, 7.5 * 60_000);
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

// Faucet (create-fund-wallet step 3 and 4). Request once, poll the balance, never loop on the faucet.
async function fundFromFaucet(address: string): Promise<bigint> {
  const before = await client.balance(client.baseToken);
  console.log('KTA balance before faucet (base units):', before);
  const reply = await fetch('https://faucet.test.keeta.com/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `address=${address}&amount=10`
  });
  console.log('faucet HTTP status:', reply.status, '(the body is an HTML page; sends go out in batches)');
  let balance = before;
  for (let attempt = 0; attempt < 16; attempt++) {           // up to 4 minutes
    balance = await client.balance(client.baseToken);
    if (balance > before) break;
    await KeetaNet.lib.Utils.Helper.asleep(15_000);
  }
  console.log('KTA balance after faucet (base units):', balance);
  return balance;
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

// What `from` converts into on this network (the skill's "can convert into" line), as token addresses.
async function reachableFrom(chaining: AnchorChaining, from: TokenAddress): Promise<TokenAddress[]> {
  const keeta = `chain:keeta:${client.network}` as const;
  const { to: reachable } = await chaining.graph.resolveAssetsWithMetadata({ from: { asset: from, location: keeta }, to: { location: keeta } });
  const out: TokenAddress[] = [];
  const names: string[] = [];
  for (const { asset } of reachable) {
    if (typeof asset === 'string' || asset.comparePublicKey(from)) continue;
    const token = Account.fromPublicKeyString(asset.publicKeyString.get()).assertKeyType(Account.AccountKeyAlgorithm.TOKEN);
    out.push(token);
    names.push(`${await nameOf(token)} ${token.publicKeyString.get()}`);
  }
  console.log('can convert into:', names.join(', ') || 'nothing');
  return out;
}

try {
  const address = account.publicKeyString.get();
  step('wallet');
  console.log('Network:', network, readOnly ? '(read-only: nothing will be executed)' : '(test value may move with KEETA_CONFIRMED=yes)');
  console.log('Address:', address, `${explorer}/account/${address}`);

  const kta = client.baseToken;
  const ktaDecimals = await decimalsOf(kta);
  console.log('KTA:', kta.publicKeyString.get(), 'decimals', ktaDecimals);
  const usdc = await tokenFor('$USDC');
  const usdcDecimals = await decimalsOf(usdc);
  console.log('USDC:', usdc.publicKeyString.get(), 'decimals', usdcDecimals);

  const oneKta = toBaseUnits('1', ktaDecimals);
  const chaining = new AnchorChaining({ client, resolver });

  step('quote 1 KTA -> USDC (moves nothing)');
  const { plans, summaries } = await quote(chaining, kta, usdc, oneKta, ktaDecimals, usdcDecimals);
  const reachable = await reachableFrom(chaining, kta);

  if (readOnly) {
    if (plans.length === 0) {
      console.log(`RESULT: On ${network}, no provider currently serves KTA -> USDC for this account, so I cannot swap 1 KTA to USDC right now; KTA can convert into ${reachable.length} other token(s) listed above. Pick one of those or try again later.`);
      process.exit(0);
    }
    const lines = summaries.map((s) => `plan ${s.plan}: send ${s.send} KTA, receive about ${s.receive} USDC via ${s.steps.join(' > ')}, fees ${JSON.stringify(s.fees, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`);
    console.log(`RESULT: On ${network}, swapping 1 KTA to USDC has ${plans.length} route(s): ${lines.join('; ')}. Plus the KTA network fee on the send. This is a quote only; nothing was executed because this run is read-only (and this wallet holds no KTA). Tell me which plan to execute and I will re-quote and run it after your confirmation.`);
    process.exit(0);
  }

  // ---- test network: fund, then convert ----
  step('fund from the test faucet');
  const funded = await fundFromFaucet(address);
  if (funded === 0n) {
    console.log(`RESULT: The test faucet did not deliver any KTA to ${address} within 4 minutes, so no swap could be made; fund the address and run again.`);
    process.exit(2);
  }

  let from = kta;
  let fromDecimals = ktaDecimals;
  let to = usdc;
  let toDecimals = usdcDecimals;
  let value = oneKta;
  let candidates: Awaited<ReturnType<typeof quote>>['plans'] = plans;
  let candidateSummaries = summaries;

  if (plans.length === 0) {
    step('no KTA -> USDC route on test: convert into a demo token instead');
    // The skill: "On test, KTA has no USDC route; it converts only into demo tokens, which the `can convert
    // into` line lists, so test a swap with one of those." Pick the first one that quotes. The user (via
    // KEETA_CONFIRMED) stands in for the choice here; a real agent would show the list and ask.
    if (reachable.length === 0) {
      console.log('RESULT: On test, KTA converts into nothing right now (no FX or conversion provider found), so no swap was possible.');
      process.exit(0);
    }
    // A small conversion: 0.1 KTA, well under the faucet grant, leaving KTA for fees.
    value = toBaseUnits('0.1', ktaDecimals);
    for (const candidate of reachable) {
      const decimals = await decimalsOf(candidate);   // 0 (base units) for a demo token without metadata
      const q = await quote(chaining, kta, candidate, value, ktaDecimals, decimals);
      if (q.plans.length > 0) { to = candidate; toDecimals = decimals; candidates = q.plans; candidateSummaries = q.summaries; break; }
    }
    if (candidates.length === 0) {
      console.log('RESULT: On test, KTA -> USDC has no route and none of the tokens KTA can convert into returned a plan, so no swap was possible.');
      process.exit(0);
    }
  }

  // Pick the plan that returns the most. Shown to the user before anything moves.
  let pick = 0;
  for (const [n, s] of candidateSummaries.entries()) if (candidates[n].plan.totalValueOut > candidates[pick].plan.totalValueOut) pick = n;
  const chosen = candidates[pick];
  const chosenSummary = candidateSummaries[pick];

  step('confirmation');
  const before = await balances();
  console.log({
    network,
    from: `${format(value, fromDecimals)} ${await nameOf(from)} (${value} base units) ${from.publicKeyString.get()}`,
    to: `about ${chosenSummary.receive} ${await nameOf(to)} (${chosen.plan.totalValueOut} base units, an estimate unless a signed FX quote) ${to.publicKeyString.get()}`,
    recipient: address,
    providers: chosenSummary.steps,
    fees: chosenSummary.fees,
    plus: 'the KTA network fee on the send, paid by this account',
    ktaBalance: `${format(before.get(kta.publicKeyString.get())!.balance, ktaDecimals)} KTA`
  });
  if (!confirmed) {
    console.log('RESULT: Awaiting your confirmation of the plan above before anything moves (set KEETA_CONFIRMED=yes).');
    process.exit(0);
  }
  console.log('Confirmed (KEETA_CONFIRMED=yes). Executing plan', pick, 'once.');

  step('execute');
  chosen.on('stepNeedsAction', (event) => {
    if (event.type !== 'keetaSendAuthRequired') { event.markFailed(new Error(`manual step ${event.type} not supported`)); return; }
    const { sendToAddress, value: sendValue, token } = event.action;
    console.log(`step asks to send ${sendValue} base units of ${token.publicKeyString.get()} to ${sendToAddress.publicKeyString.get()}`);
    if (!confirmed || !token.comparePublicKey(from) || sendValue > value) {
      event.markFailed(new Error('send differs from the confirmed plan; declined'));
      return;
    }
    event.markCompleted({ sent: false });   // the plan publishes the send; never publish it ourselves too
  });
  try {
    await chosen.execute({ requireSendAuth: true });
    console.log('plan state:', chosen.state.status);
  } catch (error) {
    console.log('plan failed:', error instanceof Error ? error.message : String(error), { state: chosen.state });
    console.log('Not re-executing (plans are not atomic). Reconcile balances below.');
    const after = await balances();
    for (const [addr, { balance }] of after) {
      const prev = before.get(addr)?.balance ?? 0n;
      if (prev !== balance) console.log('changed:', addr, prev, '->', balance);
    }
    console.log('RESULT: The conversion failed mid-plan; see the plan state and balance changes above before retrying.');
    process.exit(1);
  }

  step('balances that changed');
  // Give the receive a moment to land, then compare fresh reads.
  await KeetaNet.lib.Utils.Helper.asleep(3000);
  const after = await balances();
  const changes: string[] = [];
  for (const [addr, { token, balance }] of after) {
    const prev = before.get(addr)?.balance ?? 0n;
    if (prev === balance) continue;
    let decimals: number | null = null;
    try { decimals = await decimalsOf(token); } catch { /* unknown decimals */ }
    const show = (v: bigint) => decimals === null ? `${v} base units` : `${format(v, decimals)}`;
    const line = `${await nameOf(token)}: ${show(prev)} -> ${show(balance)} (${balance - prev > 0n ? '+' : ''}${balance - prev} base units) ${explorer}/token/${addr}`;
    console.log(line);
    changes.push(line);
  }
  const received = (after.get(to.publicKeyString.get())?.balance ?? 0n) - (before.get(to.publicKeyString.get())?.balance ?? 0n);
  const toName = await nameOf(to);
  const note = to.comparePublicKey(usdc) ? '' : ` (KTA -> USDC has no route on ${network}; I converted into ${toName} instead, one of the tokens KTA can convert into here)`;
  console.log(`RESULT: Converted ${format(value, fromDecimals)} KTA into ${format(received, toDecimals)} ${toName} on ${network}${note}; balances changed: ${changes.join(' | ')}; ${explorer}/account/${address}`);
} finally {
  await client.destroy();
}
