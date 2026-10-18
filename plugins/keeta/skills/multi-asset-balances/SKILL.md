---
name: multi-asset-balances
description: Read and reconcile every balance on a Keeta account (dollars, euros, stablecoins, KTA or any token), or a storage account it controls, with exact token identities, on-chain decimals and base units, and flag look-alike tokens. Use for portfolio views, for checking funds before a payment, conversion or payout, and for confirming that a deposit or transfer settled.
license: Apache-2.0
---

# Read multi-asset balances

## When to use

Use when an agent must list an account's assets, check one token before a transfer, or compare balances before and after an anchor flow. A Keeta account holds many native tokens at once. Never collapse them into a single "USD balance" or "wallet balance", and never identify a token by its ticker alone.

## SDK steps

### "What's in my wallet?" (every balance, with names and amounts)

This script lists every token the account holds, plus KTA for fees, with the ticker, name, decimals, the formatted amount and whether the token is in the network's official list. Set it up like the [keeta quickstart](../keeta/SKILL.md#quickstart-test-network) (Node 24, `type: module`, pinned SDKs), save it as `balances.mts`, and run `KEETA_SEED=… npx tsx balances.mts`. To read any other address without its seed, set `KEETA_ADDRESS` instead.

```ts
// live-test: balances
import * as KeetaNet from '@keetanetwork/keetanet-client';
import * as KeetaAnchor from '@keetanetwork/anchor';
import { getDefaultResolverConfig } from '@keetanetwork/anchor/config.js';
import { decodeTokenMetadata } from '@keetanetwork/anchor/lib/token-metadata.js';
import type { TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';

const { Account } = KeetaNet.lib;
const network = process.env.KEETA_NETWORK === 'main' ? 'main' : 'test';
const explorer = network === 'main' ? 'https://explorer.keeta.com' : 'https://explorer.test.keeta.com';
const signer = process.env.KEETA_SEED ? Account.fromSeed(process.env.KEETA_SEED, 0) : null;
const address = process.env.KEETA_ADDRESS ?? signer?.publicKeyString.get();
if (!address) throw new Error('set KEETA_SEED (your wallet) or KEETA_ADDRESS (any wallet, read-only)');
const owner = Account.fromPublicKeyString(address);

// A client without a signer reads any account. The resolver signs only when there is a signer.
const client = KeetaNet.UserClient.fromNetwork(network, signer);
const resolver = new KeetaAnchor.lib.Resolver({
  ...getDefaultResolverConfig(client),
  ...(signer ? { metadataConfig: { signing: { account: signer } } } : {})
});

function format(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const fraction = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${amount / base}.${fraction}` : `${amount / base}`;
}

try {
  const official = new Map((await resolver.listTokens()).map(({ token, currency }) => [token, currency]));
  const held = await client.allBalances({ account: owner });
  const rows: { token: TokenAddress; balance: bigint }[] = held.map(({ token, balance }) => ({ token, balance }));
  if (!rows.some(({ token }) => token.comparePublicKey(client.baseToken))) rows.unshift({ token: client.baseToken, balance: 0n });

  console.log(`${held.length} token(s) held on ${network} by ${address}`);
  for (const { token, balance } of rows) {
    const tokenAddress = token.publicKeyString.get();
    const { info } = await client.client.getAccountInfo(token);
    let decimals: number | null = null;
    try { decimals = info.metadata ? decodeTokenMetadata(info.metadata).decimalPlaces : null; } catch { /* unreadable metadata */ }
    console.log({
      ticker: info.name,                                       // the token's name is its ticker
      name: info.description,
      official: official.get(tokenAddress) ?? 'NOT IN THE NETWORK TOKEN LIST',
      amount: decimals === null ? 'unknown decimals' : format(balance, decimals),
      baseUnits: balance,
      decimals,
      token: `${explorer}/token/${tokenAddress}`
    });
  }
} finally {
  await client.destroy();
}
```

- Report each row as the formatted amount and ticker, for example "12.5 USDC", and keep the token link. Never add different tokens into one total, and never convert `bigint` to `number` for arithmetic on money.
- A row whose `official` value is `NOT IN THE NETWORK TOKEN LIST` but whose ticker looks like a known asset (`USDC`, `USD`, `KTA`) may be a spoof. Label it unverified.
- To check one token before a payment, read `await client.balance(token)` and the KTA balance for fees (`client.balance(client.baseToken)`). Storage accounts you can read work the same way: `client.allBalances({ account: vault })`.

### "What did I do recently?" (wallet history)

`UserHistory` folds raw blocks into wallet-style rows (send, receive, swap, deposit, withdraw, bridge), the way Keeta Personal shows them. It reads the chain only, so it works with the same client:

```ts
// live-test: history
import * as KeetaNet from '@keetanetwork/keetanet-client';
import * as KeetaAnchor from '@keetanetwork/anchor';
import type { HistorySource } from '@keetanetwork/anchor/lib/history.js';

const { Account } = KeetaNet.lib;
const network = process.env.KEETA_NETWORK === 'main' ? 'main' : 'test';
const signer = process.env.KEETA_SEED ? Account.fromSeed(process.env.KEETA_SEED, 0) : null;
const address = process.env.KEETA_ADDRESS ?? signer?.publicKeyString.get();
if (!address) throw new Error('set KEETA_SEED (your wallet) or KEETA_ADDRESS (any wallet, read-only)');

const client = KeetaNet.UserClient.fromNetwork(network, signer);
try {
  // The anchor package ships its own copy of the client (same version), so TypeScript sees two Block classes.
  const history = new KeetaAnchor.lib.UserHistory({ history: client.client as unknown as HistorySource });
  const rows = await history.list(address, { limit: 20 });   // newest first
  console.log(`${rows.length} transaction(s) for ${address}`);
  for (const row of rows) {
    console.log(row.timestamp, row.type, row.direction, row.status, {
      sent: row.send, received: row.receive, fee: row.fee, counterparty: row.counterparty?.id, blocks: row.refs.blockHashes
    });
  }
} finally {
  await client.destroy();
}
```

- Amounts are base units of `send.token` or `receive.token`. Format them with that token's decimals, as in the balances script.
- `provisional: true` marks a deposit or withdrawal inferred from the anchor reference on the block; check the anchor's transfer status before calling it final.
- Page with `history.iterate(account, { limit })`, or pass the `cursor` option. For raw blocks, see the `keeta` skill's [transactions reference](../keeta/references/transactions.md).

### Prove a transfer settled

Take a fresh balance read after the expected transfer, compare it with the read from before, and find the matching row in the history (same token, amount and counterparty). For an anchor flow, also check the anchor's transfer status.

## Confirmations

- Confirm the network and the account address before you read anything.
- For a single-token check, confirm the full token address, not just the ticker.
- Before using a balance as proof of settlement, take a fresh read after the expected transfer.

## Failures

- **Empty balance list:** it may be an unfunded account, the wrong network, or a node that can't be reached. Work out which before you act.
- **Missing or unparseable decimals:** show raw base units only, and don't convert.
- **Look-alike tokens:** a token that is not in the official list (`officialCurrency === null`) but whose ticker looks like a currency or a well-known asset (`USD`, `USDC`, `EUR`, `KTA`) may be a spoof. Label it unverified, and never treat it as that asset.
- **Floating point:** never convert `bigint` to `number` for arithmetic on money.
- **Cached state:** don't claim settlement from a cached UI value. Refresh from the client, and for anchor flows also check the anchor's transfer status.

## Related skills

- Set up the account with [create-fund-wallet](../create-fund-wallet/SKILL.md).
- Exchange assets with [convert-via-anchors](../convert-via-anchors/SKILL.md).
- Pay out externally with [pay-out](../pay-out/SKILL.md).
- For the full map of what Keeta can do, start at the [keeta](../keeta/SKILL.md) skill.

## Sources

- [UserClient reference](https://static.test.keeta.com/docs/classes/KeetaNetSDK.UserClient.html)
- [Anchor Resolver](https://docs.keeta.com/anchors/overview/anchor-resolver)
- [Overview: main vs test networks](https://docs.keeta.com/guides/overview-main-vs-test-networks)
- [KeetaNet client package](https://www.npmjs.com/package/@keetanetwork/keetanet-client)
