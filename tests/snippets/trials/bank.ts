// networks: test, main
/*
 * Trial "bank": the user wants to (a) send 50 USD to their mother's bank account in Mexico and
 * (b) get an account number so an employer can pay salary into Keeta.
 *
 * Read-only on both networks: discover the providers and corridors, read the token each provider
 * pays from or credits (from its paths), check the account's readiness with each provider, quote
 * the payout where the provider allows it without KYC, and work out the user's next step.
 * Nothing is funded, created, started or published.
 */
import * as KeetaNet from '@keetanetwork/keetanet-client';
import * as KeetaAnchor from '@keetanetwork/anchor';
import { getDefaultResolverConfig } from '@keetanetwork/anchor/config.js';
import { decodeTokenMetadata } from '@keetanetwork/anchor/lib/token-metadata.js';
import { Errors } from '@keetanetwork/anchor/services/asset-movement/common.js';
import { KeetaAnchorUserValidationError } from '@keetanetwork/anchor/lib/error.js';
import type { TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';

const { Account } = KeetaNet.lib;

// ---- quickstart (keeta/SKILL.md) ---------------------------------------------------------------
const seed = process.env.KEETA_SEED;
if (!seed) throw new Error('KEETA_SEED is not set');
const account = Account.fromSeed(seed, 0);
const network = process.env.KEETA_NETWORK === 'main' ? 'main' : 'test';
const readOnly = network === 'main' || process.env.KEETA_READ_ONLY === 'yes';
const explorer = network === 'main' ? 'https://explorer.keeta.com' : 'https://explorer.test.keeta.com';
const client = KeetaNet.UserClient.fromNetwork(network, account);
const resolver = new KeetaAnchor.lib.Resolver({ ...getDefaultResolverConfig(client), metadataConfig: { signing: { account } } });

const am = new KeetaAnchor.AssetMovement.Client(client, { resolver });
const keeta = `chain:keeta:${client.network}` as const;
const toMexico = 'bank-account:clabe' as const;
const fromUS = 'bank-account:us' as const;
type Provider = NonNullable<Awaited<ReturnType<typeof am.getProvidersForTransfer>>>[number];

const sendUSD = 50n;   // the user's request, in whole dollars; base units follow the token's decimals

function asToken(id: string): TokenAddress {
  return Account.fromPublicKeyString(id).assertKeyType(Account.AccountKeyAlgorithm.TOKEN);
}

async function decimalsOf(token: TokenAddress): Promise<number | undefined> {
  try {
    const { info } = await client.client.getAccountInfo(token);
    if (!info.metadata) return undefined;
    return decodeTokenMetadata(info.metadata).decimalPlaces;
  } catch (error) {
    console.log(`  (could not read metadata of ${token.publicKeyString.get()}: ${String(error)})`);
    return undefined;
  }
}

// Tokens on the Keeta side of a provider's paths between `keeta` and `other` (either direction).
function keetaTokensFor(provider: Provider, other: string, direction: 'from-keeta' | 'to-keeta'): string[] {
  const tokens = new Set<string>();
  for (const { paths } of provider.serviceInfo.supportedAssets) {
    for (const { pair: [a, b] } of paths) {
      if (direction === 'from-keeta' && a.location === keeta && b.location === other) tokens.add(String(a.id));
      if (direction === 'to-keeta' && a.location === other && b.location === keeta) tokens.add(String(b.id));
    }
  }
  return [...tokens];
}

// Every (location, rail) pair a provider lists between Keeta and bank accounts, for the reviewer.
function corridorsOf(provider: Provider): string[] {
  const out = new Set<string>();
  for (const { paths } of provider.serviceInfo.supportedAssets) {
    for (const path of paths) {
      const [a, b] = path.pair;
      const rails = 'rails' in path && Array.isArray((path as { rails?: unknown }).rails) ? ((path as { rails: unknown[] }).rails).map(String).join('|') : '?';
      out.add(`${a.location} -> ${b.location} [${rails}]`);
    }
  }
  return [...out];
}

type Readiness = { ready: boolean; summary: string[] };

// What a typed anchor error asks the user to do. Nothing here is acted on; it is only reported.
function describeAnchorError(e: unknown): string {
  if (Errors.KYCShareNeeded.isInstance(e)) {
    const attrs = JSON.stringify(e.neededAttributes);
    const principals = (e.shareWithPrincipals ?? []).map((p) => String(p.publicKeyString?.get?.() ?? p)).join(', ');
    const tos = e.tosFlow ? ` and accept terms of service at ${e.tosFlow.url}` : '';
    return `KYCShareNeeded: share KYC attributes ${attrs} with ${principals || 'the provider'}${tos} (needs a Keeta KYC certificate first: complete-kyc)`;
  }
  if (Errors.AdditionalKYCNeeded.isInstance(e)) {
    return e.toCompleteFlow ? `AdditionalKYCNeeded: the person must finish ${e.toCompleteFlow.url}` : 'AdditionalKYCNeeded: review pending, wait and retry';
  }
  if (Errors.UserActionNeeded.isInstance(e)) {
    return `UserActionNeeded: on-chain setup (${e.actionsNeeded.length} action(s): add the provider certificate / grant SEND_ON_BEHALF), with approval`;
  }
  if (e instanceof KeetaAnchorUserValidationError) {
    return `validation error: ${e.fields.map((f) => `${f.path}: ${f.message}`).join('; ')}`;
  }
  return `${e instanceof Error ? e.constructor.name + ': ' + e.message : String(e)}`;
}

async function readiness(provider: Provider): Promise<Readiness> {
  const supported = await provider.isOperationSupported('getAccountStatus');
  if (!supported) return { ready: false, summary: ['provider has no getAccountStatus: readiness is only reported by initiateTransfer / createPersistentForwardingAddress'] };
  try {
    const status = await provider.getAccountStatus({ account });
    if (!status.actionRequired) return { ready: true, summary: ['no action required'] };
    return { ready: false, summary: status.errors.map(describeAnchorError) };
  } catch (error) {
    return { ready: false, summary: [`getAccountStatus failed: ${describeAnchorError(error)}`] };
  }
}

async function describeProvider(provider: Provider): Promise<void> {
  console.log(`  provider ${String(provider.providerID)}`);
  console.log(`    disclaimers: ${JSON.stringify(provider.getLegalDisclaimers())}`);
  for (const op of ['initiateTransfer', 'createPersistentForwarding', 'getAccountStatus'] as const) {
    console.log(`    supports ${op}: ${await provider.isOperationSupported(op)}`);
  }
  for (const c of corridorsOf(provider)) console.log(`    path: ${c}`);
}

const next: string[] = [];   // what the user must do, in order

try {
  const address = account.publicKeyString.get();
  console.log(`== Network: ${network} (read-only: ${readOnly}) ==`);
  console.log(`Account: ${address}  ${explorer}/account/${address}`);
  console.log(`KTA balance (base units): ${await client.balance(client.baseToken)}`);

  // ---- 1. identity: does this account carry a KYC certificate? ----------------------------
  console.log('\n== Step 1: identity on this account ==');
  const certRecords = await client.client.getAllCertificates(account);
  console.log(`certificates on account: ${certRecords.length}`);
  const hasKYC = certRecords.length > 0;
  if (!hasKYC) console.log('No KYC certificate: Bivo and Bridge.xyz serve verified individuals, so KYC comes first (complete-kyc).');

  const kyc = new KeetaAnchor.KYC.Client(client, { resolver });
  const countries = await kyc.getSupportedCountries('individual');
  console.log(`KYC providers cover ${countries.length} countries for individuals${countries.length ? ` (incl. US: ${countries.map(String).includes('US')}, MX: ${countries.map(String).includes('MX')})` : ''}`);
  const kycProviders = await resolver.lookup('kyc', { countryCodes: ['US'], entityType: 'individual' });   // the user's country is unknown; US stands in for the lookup
  const kycPlain = kycProviders ? await KeetaAnchor.lib.Resolver.Metadata.fullyResolveValuizable(kycProviders) : null;
  const kycNames = Array.isArray(kycPlain) ? kycPlain.map((p: unknown) => (p && typeof p === 'object' && 'id' in p ? String((p as { id: unknown }).id) : '?')) : [];
  console.log(`KYC providers listed: ${kycNames.length ? kycNames.join(', ') : '(none)'}`);
  if (!hasKYC) {
    next.push(countries.length
      ? `verify your identity once with the KYC provider on ${network} (${kycNames.join(', ') || 'OneFootprint'}): the agent opens a hosted page, you complete it, and the certificate is attached to your account with your consent`
      : `no KYC provider is listed on ${network}, so identity verification is not possible here`);
  }

  // ---- 2. payout corridor: Keeta -> Mexican CLABE by SPEI ---------------------------------
  console.log('\n== Step 2: payout providers, Keeta -> bank-account:clabe (SPEI_PUSH) ==');
  const payoutProviders = (await am.getProvidersForTransfer({ from: keeta, to: toMexico, rail: 'SPEI_PUSH' })) ?? [];
  const anyRailProviders = payoutProviders.length ? [] : ((await am.getProvidersForTransfer({ from: keeta, to: toMexico })) ?? []);
  const payoutCandidates = payoutProviders.length ? payoutProviders : anyRailProviders;
  console.log(`providers: ${payoutCandidates.length}${payoutProviders.length ? '' : ' (none advertise SPEI_PUSH; listing any rail to clabe)'}`);

  let payoutRoute: { provider: Provider; token: TokenAddress; decimals: number | undefined; ready: Readiness } | undefined;
  for (const provider of payoutCandidates) {
    await describeProvider(provider);
    const tokens = keetaTokensFor(provider, toMexico, 'from-keeta');
    console.log(`    pays out from Keeta token(s): ${tokens.join(', ') || '(none in paths)'}`);
    const canInitiate = await provider.isOperationSupported('initiateTransfer');
    const ready = await readiness(provider);
    console.log(`    readiness for this account: ${ready.ready ? 'ready' : 'action required'}`);
    for (const line of ready.summary) console.log(`      - ${line}`);
    if (!canInitiate || tokens.length === 0) continue;
    const token = asToken(tokens[0]);
    const decimals = await decimalsOf(token);
    const balance = await client.balance(token);
    console.log(`    token ${token.publicKeyString.get()} decimals=${decimals ?? 'unknown'} balance(base units)=${balance}`);
    if (!payoutRoute) payoutRoute = { provider, token, decimals, ready };
  }

  if (!payoutRoute) {
    console.log('No provider pays out to a Mexican CLABE for this account on this network.');
    next.push(`there is no SPEI payout provider for this account on ${network}, so the transfer to Mexico cannot be made here`);
  } else {
    const { provider, token, decimals, ready } = payoutRoute;
    const id = String(provider.providerID);
    if (decimals === undefined) {
      console.log('Cannot quote: the payout token has no readable decimals.');
    } else {
      const value = sendUSD * 10n ** BigInt(decimals);
      console.log(`\nQuote (moves nothing): ${sendUSD} USD = ${value} base units of ${token.publicKeyString.get()} -> MXN via ${id}`);
      try {
        const quote = await provider.simulateTransfer({
          account, asset: { from: token, to: 'MXN' as const }, from: { location: keeta }, to: { location: toMexico }, value, allowedRails: ['SPEI_PUSH']
        });
        for (const i of quote.instructions) console.log(`  instruction ${i.type}: fee=${String(i.assetFee)} totalReceiveAmount=${String(i.totalReceiveAmount)} (MXN smallest unit)`);
      } catch (error) {
        console.log(`  simulateTransfer did not return a quote: ${describeAnchorError(error)}`);
      }
    }
    const balance = await client.balance(token);
    if (!ready.ready) next.push(`then satisfy ${id}'s requirements for payouts: ${ready.summary.join('; ')}`);
    if (balance === 0n) next.push(`fund your Keeta account with ${sendUSD} USD plus fees in ${id}'s USD token (${token.publicKeyString.get()}) — for example by depositing to the named US account below, or converting what you hold (convert-via-anchors) — and keep a little KTA for network fees`);
    next.push(`then the agent quotes the SPEI payout (fees and estimated MXN), you confirm your mother's legal name and 18-digit CLABE, and the agent initiates it and funds the KEETA_SEND instruction after your final approval`);
  }

  // ---- 3. deposit corridor: US bank account (ACH) -> Keeta ---------------------------------
  console.log('\n== Step 3: deposit providers, bank-account:us -> Keeta ==');
  const depositProviders = (await am.getProvidersForTransfer({ from: fromUS, to: keeta })) ?? [];
  console.log(`providers: ${depositProviders.length}`);
  let namedAccount: { provider: Provider; token: TokenAddress; ready: Readiness } | undefined;
  for (const provider of depositProviders) {
    await describeProvider(provider);
    const tokens = keetaTokensFor(provider, fromUS, 'to-keeta');
    console.log(`    credits Keeta token(s): ${tokens.join(', ') || '(none in paths)'}`);
    const persistent = await provider.isOperationSupported('createPersistentForwarding');
    const ready = await readiness(provider);
    console.log(`    readiness for this account: ${ready.ready ? 'ready' : 'action required'}`);
    for (const line of ready.summary) console.log(`      - ${line}`);
    console.log(`    named account (standing address): ${persistent ? 'offered' : 'not offered (one-time deposit instructions only)'}`);
    if (persistent && tokens.length && !namedAccount) {
      const token = asToken(tokens[0]);
      console.log(`    token ${token.publicKeyString.get()} decimals=${(await decimalsOf(token)) ?? 'unknown'}`);
      namedAccount = { provider, token, ready };
    }
  }

  if (!namedAccount) {
    console.log('No provider issues a standing US account for this account on this network.');
    next.push(`no provider issues a named US account for this account on ${network}, so salary cannot be received by ACH here${depositProviders.length ? ' (only one-time deposit instructions are offered)' : ''}`);
  } else {
    const id = String(namedAccount.provider.providerID);
    if (!namedAccount.ready.ready) next.push(`then satisfy ${id}'s requirements for a named account: ${namedAccount.ready.summary.join('; ')}`);
    next.push(`then the agent requests your named US checking account (routing and account number in your legal name) from ${id}, which your employer pays by ACH; deposits land as ${id}'s Keeta USD token ${namedAccount.token.publicKeyString.get()} and can fund the Mexico payout`);
  }

  // ---- 4. the answer -------------------------------------------------------------------
  console.log('\n== Next steps for the user ==');
  next.forEach((step, n) => console.log(`${n + 1}. ${step}`));
  const first = next[0] ?? 'nothing further is needed';
  console.log(`\nRESULT: On ${network}, nothing was moved or created; your first step is to ${first}${next.length > 1 ? `, after which: ${next.slice(1).join('; ')}` : ''}.`);
} finally {
  await client.destroy();
}
