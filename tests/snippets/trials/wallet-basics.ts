// networks: test
// Trial "wallet-basics": set up a Keeta test wallet, fund it from the faucet, report the balance,
// send 1 KTA to a friend's (brand-new) wallet, then show both balances and the transaction history.
// Written from the skills alone: keeta (quickstart), create-fund-wallet, multi-asset-balances, send-receive-tokens.
import * as KeetaNet from '@keetanetwork/keetanet-client';
import * as KeetaAnchor from '@keetanetwork/anchor';
import { getDefaultResolverConfig } from '@keetanetwork/anchor/config.js';
import { decodeTokenMetadata } from '@keetanetwork/anchor/lib/token-metadata.js';
import type { HistorySource } from '@keetanetwork/anchor/lib/history.js';
import type { TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';

const { Account } = KeetaNet.lib;
type KeyPairAccount = ReturnType<typeof Account.fromSeed>;

// Rule 1: pick the network explicitly. This trial runs on test only (free faucet KTA).
const network = process.env.KEETA_NETWORK === 'main' ? 'main' : 'test';
const explorer = network === 'main' ? 'https://explorer.keeta.com' : 'https://explorer.test.keeta.com';
const confirmed = process.env.KEETA_CONFIRMED === 'yes';
const readOnly = process.env.KEETA_READ_ONLY === 'yes' || network === 'main';

// Rule 2: the seed comes from the environment (the runner's secret store); it is never printed.
if (!process.env.KEETA_SEED) throw new Error('KEETA_SEED is not set: load the wallet seed from your secret store');
const account = Account.fromSeed(process.env.KEETA_SEED, 0);
const address = account.publicKeyString.get();

// The friend's wallet: a second brand-new wallet from a fresh random seed. Only its public address is ever shown.
const friendSeed = Account.generateRandomSeed({ asString: true });
const friend = Account.fromSeed(friendSeed, 0);
const friendAddress = friend.publicKeyString.get();

const client = KeetaNet.UserClient.fromNetwork(network, account);
const resolver = new KeetaAnchor.lib.Resolver({ ...getDefaultResolverConfig(client), metadataConfig: { signing: { account } } });

function format(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const fraction = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${amount / base}.${fraction}` : `${amount / base}`;
}

async function decimalsOf(token: TokenAddress): Promise<number> {
  const { info } = await client.client.getAccountInfo(token);
  if (!info.metadata) throw new Error(`${token.publicKeyString.get()} has no metadata, so its decimals are unknown`);
  return decodeTokenMetadata(info.metadata).decimalPlaces;
}

// Every balance an account holds, with ticker, name, official status and formatted amount (multi-asset-balances).
async function printBalances(label: string, owner: KeyPairAccount, official: Map<string, string>): Promise<Map<string, bigint>> {
  const held = await client.allBalances({ account: owner });
  const rows: { token: TokenAddress; balance: bigint }[] = held.map(({ token, balance }) => ({ token, balance }));
  if (!rows.some(({ token }) => token.comparePublicKey(client.baseToken))) rows.unshift({ token: client.baseToken, balance: 0n });
  const byToken = new Map<string, bigint>();
  console.log(`${label}: ${held.length} token(s) held on ${network} by ${owner.publicKeyString.get()}`);
  for (const { token, balance } of rows) {
    const tokenAddress = token.publicKeyString.get();
    byToken.set(tokenAddress, balance);
    const { info } = await client.client.getAccountInfo(token);
    let decimals: number | null = null;
    try { decimals = info.metadata ? decodeTokenMetadata(info.metadata).decimalPlaces : null; } catch { /* unreadable metadata */ }
    console.log('  ', {
      ticker: info.name,
      name: info.description,
      official: official.get(tokenAddress) ?? 'NOT IN THE NETWORK TOKEN LIST',
      amount: decimals === null ? 'unknown decimals' : format(balance, decimals),
      baseUnits: balance,
      decimals,
      token: `${explorer}/token/${tokenAddress}`
    });
  }
  return byToken;
}

// Wallet-style history rows, newest first (multi-asset-balances, "What did I do recently?").
async function printHistory(label: string, who: string): Promise<number> {
  const history = new KeetaAnchor.lib.UserHistory({ history: client.client as unknown as HistorySource });
  const rows = await history.list(who, { limit: 20 });
  console.log(`${label}: ${rows.length} transaction(s) for ${who}`);
  for (const row of rows) {
    console.log('  ', row.timestamp, row.type, row.direction, row.status, {
      sent: row.send, received: row.receive, fee: row.fee, counterparty: row.counterparty?.id, blocks: row.refs.blockHashes
    });
  }
  return rows.length;
}

async function requestFaucet(to: string, amountKta: number): Promise<void> {
  // create-fund-wallet step 3: POST address=…&amount=… with exactly this Content-Type (no charset suffix).
  const response = await fetch('https://faucet.test.keeta.com/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `address=${encodeURIComponent(to)}&amount=${amountKta}`
  });
  // The reply is an HTML page and sends go out in batches: don't parse it, just note the status and poll the balance.
  console.log(`Faucet replied HTTP ${response.status}; polling the balance instead of parsing the page`);
  await response.text();
}

async function waitForBalanceAbove(owner: KeyPairAccount, token: TokenAddress, before: bigint, attempts: number): Promise<bigint> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const now = (await client.allBalances({ account: owner })).find((row) => row.token.comparePublicKey(token))?.balance ?? 0n;
    if (now > before) return now;
    console.log(`  waiting for funds (attempt ${attempt + 1}/${attempts}), balance still ${now}`);
    await KeetaNet.lib.Utils.Helper.asleep(15_000);
  }
  return (await client.allBalances({ account: owner })).find((row) => row.token.comparePublicKey(token))?.balance ?? 0n;
}

try {
  // Step 1: the wallet. Share only the public address.
  console.log(`Step 1: wallet set up on ${network}`);
  console.log(`  Your address:     ${address}  ${explorer}/account/${address}`);
  console.log(`  Friend's address: ${friendAddress}  ${explorer}/account/${friendAddress}  (new wallet from a fresh random seed; seed not shown)`);

  const kta = client.baseToken;
  const ktaAddress = kta.publicKeyString.get();
  const decimals = await decimalsOf(kta);
  const oneKta = 10n ** BigInt(decimals);
  console.log(`  KTA token: ${ktaAddress}, decimals (from on-chain metadata): ${decimals}, so 1 KTA = ${oneKta} base units`);

  const official = new Map((await resolver.listTokens()).map(({ token, currency }) => [token, currency]));

  // Step 2: fund from the test faucet. Funding moves test value to this wallet, so it is gated on confirmation.
  console.log('Step 2: fund the wallet from the test faucet');
  const before = await client.balance(kta);
  console.log(`  KTA balance before funding: ${before} base units (${format(before, decimals)} KTA)`);
  if (network !== 'test') {
    console.log('  There is no faucet on main; funds arrive by a transfer, bank deposit, card top-up or bridge.');
    console.log(`RESULT: Your wallet ${address} is set up on ${network} with ${format(before, decimals)} KTA; there is no faucet on main, so fund it by transfer or deposit before sending.`);
    process.exit(0);
  }
  if (readOnly || !confirmed) {
    console.log('  About to ask the faucet for 10 test KTA, but no confirmation (KEETA_CONFIRMED=yes) was given; stopping here.');
    console.log(`RESULT: Your wallet ${address} is set up on ${network} with ${format(before, decimals)} KTA; confirm and I will request faucet funds and send 1 KTA to ${friendAddress}.`);
    process.exit(0);
  }
  console.log(`  About to request 10 test KTA (token ${ktaAddress}) from https://faucet.test.keeta.com/ for ${address}. KEETA_CONFIRMED=yes, proceeding.`);
  await requestFaucet(address, 10);
  const funded = await waitForBalanceAbove(account, kta, before, 20);
  if (funded <= before) {
    console.log(`  The balance has not changed after about five minutes (still ${funded} base units). The faucet may be rate limited or empty.`);
    console.log(`RESULT: Your wallet ${address} is set up on ${network} but the faucet did not deliver KTA within five minutes; its balance is ${format(funded, decimals)} KTA, so the send to ${friendAddress} was not attempted.`);
    process.exit(0);
  }
  console.log(`  Funds arrived: ${funded} base units (${format(funded, decimals)} KTA)`);

  // Step 3: the balance, every token with names and amounts.
  console.log('Step 3: your balance');
  await printBalances('  Your wallet', account, official);

  // Step 4: send 1 KTA to the friend. Validate, check funds, confirm, send, verify.
  console.log('Step 4: send 1 KTA to the friend');
  const recipient = Account.fromPublicKeyString(friendAddress);
  if (recipient.isToken()) throw new Error('recipient is a token address, not an account');
  const token = Account.fromPublicKeyString(ktaAddress).assertKeyType(Account.AccountKeyAlgorithm.TOKEN);
  const amount = oneKta;
  const ktaBalance = await client.balance(token);
  if (ktaBalance <= amount) throw new Error(`KTA balance ${ktaBalance} cannot cover ${amount} base units plus fees`);
  const external = 'wallet-basics-trial';
  console.log('  Confirmation needed before value moves:');
  console.log(`    network:        ${network}`);
  console.log(`    recipient:      ${friendAddress}`);
  console.log(`    token:          ${ktaAddress} (KTA, the base token)`);
  console.log(`    amount:         ${amount} base units = ${format(amount, decimals)} KTA (decimals ${decimals} verified from metadata)`);
  console.log(`    fees:           paid in KTA by your account, added at publish time`);
  console.log(`    reference:      ${external} (public)`);
  if (!confirmed || readOnly) {
    console.log('  Not confirmed; stopping before the send.');
    console.log(`RESULT: Your wallet ${address} holds ${format(ktaBalance, decimals)} KTA; confirm and I will send 1 KTA to ${friendAddress}.`);
    process.exit(0);
  }
  console.log('  KEETA_CONFIRMED=yes: sending now.');
  const result = await client.send(recipient, amount, token, external);
  const hashes = result.from === 'direct'
    ? result.voteStaple.blocks.map((block) => block.hash.toString())
    : result.blocks.map((block) => block.hash.toString());
  for (const hash of hashes) console.log(`  Published block ${hash}  ${explorer}/block/${hash}`);

  // Step 5: verify with fresh balance reads on both wallets.
  console.log('Step 5: balances after the send');
  const mine = await printBalances('  Your wallet', account, official);
  const theirs = await waitForBalanceAbove(friend, kta, 0n, 4);
  const friendRows = await printBalances("  Friend's wallet", friend, official);
  const myKta = mine.get(ktaAddress) ?? 0n;
  const friendKta = friendRows.get(ktaAddress) ?? theirs;
  if (friendKta < amount) throw new Error(`friend's KTA balance is ${friendKta}, expected at least ${amount}`);

  // Step 6: transaction history, newest first, for both wallets.
  console.log('Step 6: transaction history');
  const count = await printHistory('  Your wallet', address);
  await printHistory("  Friend's wallet", friendAddress);
  if (count === 0) throw new Error('history is empty after a funded wallet sent 1 KTA');

  console.log(`RESULT: Your test wallet ${address} was funded from the faucet and sent 1 KTA to ${friendAddress} (block ${hashes[0]}); you now hold ${format(myKta, decimals)} KTA and your friend holds ${format(friendKta, decimals)} KTA, and your history shows ${count} transaction(s).`);
} finally {
  await client.destroy();
}
