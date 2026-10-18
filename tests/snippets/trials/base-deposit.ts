// networks: test, main
// Trial: "What's my Base deposit address? I want to move KTA and USDC from Base into my Keeta wallet."
// Written from the skills only: keeta/SKILL.md (quickstart, "Common wallet requests") and
// bridge-crypto/SKILL.md ("What's my Base deposit address?" and "Deposit from Base with one provider").
//
// test: resolves the wallet's actual deposit address on Base Sepolia through a forwarding-only plan.
// main (KEETA_READ_ONLY=yes): lists the providers and assets that would serve the deposit without
// creating an address (the skill's KEETA_LIST_ONLY mode), and says what the user does to get it.
import * as KeetaNet from '@keetanetwork/keetanet-client';
import * as KeetaAnchor from '@keetanetwork/anchor';
import { getDefaultResolverConfig } from '@keetanetwork/anchor/config.js';
import { AnchorChaining } from '@keetanetwork/anchor/lib/chaining.js';
import { convertAssetLocationToString } from '@keetanetwork/anchor/services/asset-movement/common.js';
import { decodeTokenMetadata } from '@keetanetwork/anchor/lib/token-metadata.js';

const { Account } = KeetaNet.lib;

const network = process.env.KEETA_NETWORK === 'main' ? 'main' : 'test';
const readOnly = process.env.KEETA_READ_ONLY === 'yes';
const seed = process.env.KEETA_SEED;
if (!seed) throw new Error('set KEETA_SEED to the wallet seed');
const account = Account.fromSeed(seed, 0);
const address = account.publicKeyString.get();
const explorer = network === 'main' ? 'https://explorer.keeta.com' : 'https://explorer.test.keeta.com';
const walletApp = network === 'main' ? 'https://wallet.keeta.com' : 'https://wallet.test.keeta.com';
const base = network === 'main' ? 'chain:evm:8453' : 'chain:evm:84532';   // Base, or Base Sepolia on test
const baseName = network === 'main' ? 'Base (chain 8453)' : 'Base Sepolia (chain 84532)';
const wanted = ['KTA', 'USDC'];                                            // what the user said they will send

// Hard stop well inside the runner's 8 minutes, so a hung representative or anchor fails loudly.
setTimeout(() => { console.error('FAIL: timed out after 7 minutes'); process.exit(1); }, 7 * 60_000).unref();

function normalizeTicker(ticker: string | undefined): string | undefined {
  return ticker?.replace(/^\$/, '').toUpperCase();
}

console.log(`Step 0: wallet ${address} on ${network} (${explorer}/account/${address}); read-only: ${readOnly}`);

const client = KeetaNet.UserClient.fromNetwork(network, account);
try {
  // Sign metadata requests with the wallet, as Keeta Personal does, so providers that only list routes for signed requests are seen.
  const resolver = new KeetaAnchor.lib.Resolver({ ...getDefaultResolverConfig(client), metadataConfig: { signing: { account } } });
  const chaining = new AnchorChaining({ client, resolver });
  const am = new KeetaAnchor.AssetMovement.Client(client, { resolver });
  const keeta = `chain:keeta:${client.network}` as const;

  // Name and decimals of the Keeta token a deposit arrives as, read from the chain (never hard-coded).
  async function describeKeetaToken(publicKey: string): Promise<string> {
    try {
      const token = Account.fromPublicKeyString(publicKey);
      const { info } = await client.client.getAccountInfo(token);
      const decimals = info.metadata ? decodeTokenMetadata(info.metadata).decimalPlaces : undefined;
      return `${info.name || '(unnamed)'}${decimals === undefined ? '' : `, ${decimals} decimals`}`;
    } catch (error) {
      return `(metadata unavailable: ${error instanceof Error ? error.message : String(error)})`;
    }
  }

  // Step 1: which providers move assets from Base into Keeta, and which asset pairs each one bridges.
  console.log(`Step 1: providers that move assets from ${baseName} into Keeta`);
  const providers = (await am.getProvidersForTransfer({ from: base, to: keeta })) ?? [];
  if (providers.length === 0) {
    console.log(`No asset-movement provider serves ${base} -> ${keeta} on ${network}.`);
  }
  for (const p of providers) {
    const pairs = p.serviceInfo.supportedAssets.flatMap(({ paths }) => paths.map(({ pair: [a, b] }) =>
      a.location === base && b.location === keeta ? [String(a.id), String(b.id)] : null).filter((x) => x !== null));
    let persistent: boolean | string;
    try { persistent = await p.isOperationSupported('createPersistentForwarding'); } catch (error) { persistent = `unknown (${error instanceof Error ? error.message : String(error)})`; }
    console.log(`  provider ${String(p.providerID)}: deposit address supported: ${persistent}`);
    for (const [external, internal] of pairs) console.log(`    ${external} on ${base} -> ${internal} (${await describeKeetaToken(internal)})`);
    const disclaimers = p.getLegalDisclaimers();
    if (disclaimers && (Array.isArray(disclaimers) ? disclaimers.length : true)) console.log(`    disclaimers: ${JSON.stringify(disclaimers)}`);
  }

  // Step 2: every external token that can be forwarded into this wallet, kept to the ones on Base.
  console.log(`Step 2: tokens on ${baseName} that can be forwarded into this wallet (chained routes, up to 3 legs)`);
  const { from } = await chaining.graph.resolveAssetsWithMetadata({
    to: { location: keeta, rail: 'KEETA_SEND' }, forwardingOnly: { method: 'implied' }, maxStepCount: 3
  });
  const onBase = from.filter((asset) => convertAssetLocationToString(asset.location) === base && typeof asset.asset === 'string');
  if (onBase.length === 0) {
    console.log(`RESULT: No deposit route from ${baseName} into Keeta exists on ${network}, so there is no Base deposit address to give; nothing was created.`);
    process.exitCode = 1;
  } else {
    for (const a of onBase) console.log(`  ${a.metadata?.ticker ?? '(no ticker)'}: ${String(a.asset)}`);

    type Route = { send: string; sourceAsset: string; arrivesAs: string; arrivesDescription: string; providers: string[]; fees: unknown[]; to?: string; unavailableVia?: string; reason?: string };
    const routes: Route[] = [];

    for (const sourceAsset of onBase) {
      if (typeof sourceAsset.asset !== 'string') continue;
      const send = sourceAsset.metadata?.ticker ?? sourceAsset.asset;
      // Step 3: the Keeta token each Base token arrives as.
      const { to } = await chaining.graph.resolveAssetsWithMetadata({
        from: { asset: sourceAsset.asset, location: sourceAsset.location },
        to: { location: keeta, rail: 'KEETA_SEND' }, forwardingOnly: { method: 'explicit' }
      });
      for (const destination of to) {
        if (typeof destination.asset === 'string') continue;   // Keeta tokens are account objects
        const arrivesAs = destination.asset.publicKeyString.get();
        const arrivesDescription = await describeKeetaToken(arrivesAs);
        if (readOnly) {
          // main: list only. Resolving a forwarding plan would create a persistent forwarding address at the provider.
          console.log(`  [list only] send ${send} (${sourceAsset.asset}) on ${base} -> arrives as ${arrivesAs} (${arrivesDescription})`);
          routes.push({ send, sourceAsset: sourceAsset.asset, arrivesAs, arrivesDescription, providers: [], fees: [] });
          continue;
        }
        // Step 4 (test): a forwarding-only plan resolves the deposit address; the provider reuses an existing one or creates it.
        // The skill says this is a free lookup that changes nothing on chain and needs no approval.
        console.log(`Step 4: resolving the deposit address for ${send} on ${baseName} -> ${arrivesAs}`);
        const results = await chaining.getPlans({
          source: { asset: sourceAsset.asset, location: sourceAsset.location, rail: 'EVM_SEND', value: 1_000_000n },
          destination: { asset: destination.asset, location: keeta, rail: 'KEETA_SEND', recipient: address }
        }, { forwardingOnly: { method: 'implied', maxLegs: 3 }, maxPathLength: 3, includeAllOutput: true }) ?? [];
        if (results.length === 0) console.log(`  no plan for ${send} -> ${arrivesAs}`);
        for (const result of results) {
          if (!result.success) {
            const reason = result.error instanceof Error ? result.error.message : String(result.error);
            const unavailableVia = String(result.failedAt.providerID);
            console.log(`  unavailable via ${unavailableVia}: ${reason}`);
            routes.push({ send, sourceAsset: sourceAsset.asset, arrivesAs, arrivesDescription, providers: [unavailableVia], fees: [], unavailableVia, reason });
            continue;
          }
          const depositAddress = result.plan.getDepositAddress();
          const route: Route = {
            send, sourceAsset: sourceAsset.asset, arrivesAs, arrivesDescription,
            to: depositAddress === undefined || depositAddress === null ? undefined : String(depositAddress),
            providers: result.plan.path.map((step) => String(step.providerID ?? 'keeta-send')),
            fees: result.plan.listFees().lineItems.map((fee) => ({ purpose: fee.purpose, value: String(fee.value), basisPoints: fee.basisPoints }))
          };
          console.log(`  ${JSON.stringify(route)}`);
          routes.push(route);
        }
      }
    }

    // Summary for the user: the tokens they named first, then everything else that address accepts.
    const matches = (r: Route, t: string) => normalizeTicker(r.send) === t;
    if (readOnly) {
      const servedTickers = [...new Set(routes.map((r) => normalizeTicker(r.send) ?? r.send))];
      const missing = wanted.filter((t) => !routes.some((r) => matches(r, t)));
      const providerNames = providers.map((p) => String(p.providerID));
      console.log('Summary (main, read-only):');
      console.log(`  providers from ${baseName} into Keeta: ${providerNames.join(', ') || 'none'}`);
      console.log(`  Base tokens that can be deposited: ${servedTickers.join(', ')}`);
      for (const t of wanted) for (const r of routes.filter((x) => matches(x, t))) console.log(`  ${t}: send ${r.sourceAsset} on Base, arrives as ${r.arrivesAs} (${r.arrivesDescription})`);
      console.log(`  To get the address, approve creating it: rerun this with the wallet seed and without KEETA_READ_ONLY (the skill's deposit-address script), or open Keeta Personal (${walletApp}) > Receive, which runs the same lookup. The address is reused every time afterwards.`);
      if (missing.length) console.log(`  Not served from Base on main: ${missing.join(', ')}`);
      console.log(`RESULT: On main this wallet (${address}) has no Base deposit address yet and none was created (read-only); ${providerNames.join(', ') || 'no provider'} would issue one free of KYC for ${servedTickers.join(', ')} on Base${missing.length ? ` (but not ${missing.join(', ')})` : ''}, and to get it the user runs the deposit-address script with their seed or opens Receive in Keeta Personal at ${walletApp}.`);
    } else {
      const available = routes.filter((r) => r.to !== undefined);
      const addresses = [...new Set(available.map((r) => r.to))];
      const wantedRoutes = wanted.map((t) => ({ ticker: t, routes: available.filter((r) => matches(r, t)) }));
      console.log('Summary (test):');
      for (const { ticker, routes: rs } of wantedRoutes) {
        if (rs.length === 0) console.log(`  ${ticker}: no deposit address available from ${baseName}`);
        for (const r of rs) console.log(`  ${ticker}: send ${r.sourceAsset} on ${baseName} to ${r.to}; arrives as ${r.arrivesAs} (${r.arrivesDescription}) via ${r.providers.join(' -> ')}; fees: ${JSON.stringify(r.fees)}`);
      }
      const others = available.filter((r) => !wanted.some((t) => matches(r, t)));
      for (const r of others) console.log(`  also accepted: ${r.send} (${r.sourceAsset}) to ${r.to} via ${r.providers.join(' -> ')}`);
      for (const r of routes.filter((x) => x.unavailableVia)) console.log(`  unavailable: ${r.send} via ${r.unavailableVia}: ${r.reason}`);
      const missing = wantedRoutes.filter((w) => w.routes.length === 0).map((w) => w.ticker);
      if (addresses.length === 0) {
        console.log(`RESULT: No provider gave this wallet a deposit address on ${baseName}; nothing was created and the user should not send anything to Base yet.`);
        process.exitCode = 1;
      } else {
        const describe = (t: string) => wantedRoutes.find((w) => w.ticker === t)!.routes.map((r) => `${r.sourceAsset} -> ${r.arrivesAs} via ${r.providers.join('->')}`).join('; ');
        const covered = wanted.filter((t) => !missing.includes(t));
        console.log(`RESULT: Your Base deposit address on ${baseName} (test network) is ${addresses.join(' / ')}: send only ${[...new Set(available.map((r) => r.send))].join(', ')} there from Base${covered.length ? ` (${covered.map((t) => `${t}: ${describe(t)}`).join('; ')})` : ''}${missing.length ? `; ${missing.join(' and ')} cannot be deposited from Base on this network` : ''}; other tokens or chains are not watched and may be lost.`);
      }
    }
  }
} finally {
  await client.destroy();
}
