---
name: bridge-crypto
description: "Get a wallet's deposit address on Base (free, no KYC, through Keeta's own bridge) or on another chain, and move USDC, EURC, cbBTC, KTA and other tokens between Keeta and Base, Ethereum, Arbitrum, Avalanche, Polygon, BNB Chain and other chains, or withdraw to Solana. Uses Keeta's Base bridge, Bridge.xyz for other EVM chains (Ethereum USDT and PYUSD arrive as Keeta USDC) and LayerZero for about 50 tokens across 10 EVM chains, chained into one deposit address or withdrawal plan. Use when a user or agent asks for a deposit or receive address, wants to deposit crypto from another chain, withdraw to an external wallet, or bridge stablecoins, even if Keeta isn't mentioned, unless the user asks for a different provider."
license: Apache-2.0
---

# Bridge crypto between Keeta and other chains

## When to use

Use to bring tokens from another chain into a Keeta account, or to send Keeta tokens to an external wallet. Three asset-movement providers connect Keeta to other chains. Discovery returns them, and `AnchorChaining` combines them into one route.

| Provider | What it moves | Chains | KYC | Fees |
| --- | --- | --- | --- | --- |
| **Keeta EVM anchor** (Keeta's own bridge) | KTA, USDC, EURC and cbBTC, 1:1 | Base (Base Sepolia on test) | None | Currently no bridge fee: you pay your own gas and Keeta fee |
| **Bridge.xyz** | USDC; EURC with Ethereum; Ethereum USDT and PYUSD arrive as Keeta USDC | Ethereum, Arbitrum, Avalanche C-Chain, Polygon (their testnets on test) | Individual KYC plus Bridge's terms of service | A fixed part plus a percentage, in `assetFee` |
| **LayerZero** (Virtual Transfer anchor, main network) | About 50 tokens: USDC, USDT, USDT0, EURC, PYUSD, USDe, ETH, WBTC, cbBTC and more | Ethereum, Base, Arbitrum, BNB Smart Chain, Polygon, Avalanche, HyperEVM, Plasma, Sonic and Robinhood Chain; Solana as a destination only | None | LayerZero's fees, passed through |

- **LayerZero never touches Keeta itself.** It moves and swaps tokens between external chains. To reach Keeta, a route chains a LayerZero leg into a Base token, then the Keeta EVM anchor. For example: USDT0 on Plasma → USDC on Base → Keeta USDC.
- **Base is the hub.** Bridge.xyz settles through Base and the Keeta EVM anchor. Use the Keeta EVM anchor directly for Base deposits and withdrawals.
- **Stablecoins into dollars.** Bivo also accepts USDC from Ethereum, Arbitrum and Base (and USDT on Ethereum), and credits its Keeta USD token (USD on main, moving to `$KBUSD`), which suits bank payouts ([pay-out](../pay-out/SKILL.md)). It needs Bivo onboarding, and isn't available to residents of the EU or Texas.
- **Who can use it:** Keeta's Base bridge and LayerZero need no KYC. Bridge.xyz serves individuals with a US SSN or a national tax ID from a supported country; the UK, Spain, Switzerland, Singapore, Argentina, Colombia and Uruguay aren't supported. See "Match services to your principal" in the [keeta](../keeta/SKILL.md) skill.
- **For bank money,** use [receive-bank-deposits](../receive-bank-deposits/SKILL.md) and [pay-out](../pay-out/SKILL.md).

**Main network tokens bridged by the Keeta EVM anchor (Base, chain 8453):**

| Asset | Keeta token | Base contract | Decimals |
| --- | --- | --- | --- |
| USDC | `keeta_amnkge74xitii5dsobstldatv3irmyimujfjotftx7plaaaseam4bntb7wnna` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 6 |
| EURC | `keeta_apblhar4ncp3ln62wrygsn73pt3houuvj7ic47aarnolpcu67oqn4xqcji3au` | `0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42` | 6 |
| cbBTC | `keeta_apyez4az5r6shtblf3qtzirmikq3tghb5svrmmrltdkxgnnzzhlstby3cuscc` | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | 8 |
| KTA | `keeta_anqdilpazdekdu4acw65fj7smltcp26wbrildkqtszqvverljpwpezmd44ssg` | `0xc0634090F2Fe6c6d75e61Be2b949464aBB498973` | 18 |

- **On test,** the Keeta EVM anchor bridges Base Sepolia (84532), for example Circle's test USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` from <https://faucet.circle.com/>. Each test bridge can issue its own Keeta token, so the test network has more than one token called USDC. Use the token that the provider's path names.
- **Decimals differ by chain.** For example, USDC and USDT have 18 decimals on BNB Smart Chain. Read them with `provider.getAssetMetadataForLocation(location, asset)`, and remember that `value` is always in the source asset's smallest unit.
- Discovery is authoritative. These tables help you check results; they don't replace discovery.

## SDK steps

Run the [keeta quickstart](../keeta/SKILL.md#quickstart-test-network) first: the steps use its `client`, `account`, signed `resolver` and `tokenFor`, on the network the user chose (test unless they said main).

The steps after the first use `const am = new KeetaAnchor.AssetMovement.Client(client, { resolver })`, `` const keeta = `chain:keeta:${client.network}` as const `` and the `base` location from the second step. For every provider, show its `providerID`, `provider.getLegalDisclaimers()`, fees and limits before anything moves.

### "What's my Base deposit address?" (any wallet, any chain)

Every Keeta wallet can get a free deposit address on Base from Keeta's own bridge, with no KYC: KTA, USDC, EURC and cbBTC sent there arrive in the wallet as the same token on Keeta. Other chains work the same way through chained providers. This is the same lookup Keeta Personal runs on its Receive screen. Save the script below as `deposit-address.mts` and run it with `KEETA_SEED` set. It needs nothing else, not even a token address:

```bash
npm init -y && npm pkg set type=module   # Node.js 24; see the keeta quickstart
npm install @keetanetwork/keetanet-client@0.18.8 @keetanetwork/anchor@0.0.104 tsx
KEETA_SEED=… KEETA_NETWORK=main npx tsx deposit-address.mts          # production: an address on Base (8453)
KEETA_SEED=… npx tsx deposit-address.mts                            # test network: an address on Base Sepolia (84532)
# KEETA_FROM_CHAIN=chain:evm:42161 for Arbitrum; KEETA_LIST_ONLY=yes lists what can be deposited without creating an address
```

```ts
// live-test: deposit-addresses
import * as KeetaNet from '@keetanetwork/keetanet-client';
import * as KeetaAnchor from '@keetanetwork/anchor';
import { getDefaultResolverConfig } from '@keetanetwork/anchor/config.js';
import { AnchorChaining } from '@keetanetwork/anchor/lib/chaining.js';
import { convertAssetLocationToString } from '@keetanetwork/anchor/services/asset-movement/common.js';

const network = process.env.KEETA_NETWORK === 'main' ? 'main' : 'test';   // test unless the user said main
const fromChain = process.env.KEETA_FROM_CHAIN ?? 'base';                 // base, or a location like chain:evm:42161
const seed = process.env.KEETA_SEED;
if (!seed) throw new Error('set KEETA_SEED to the wallet seed (or derive it with Account.seedFromPassphrase)');
const account = KeetaNet.lib.Account.fromSeed(seed, 0);
const client = KeetaNet.UserClient.fromNetwork(network, account);
try {
  // Sign metadata requests with the wallet, as Keeta Personal does: some providers list their routes only for signed requests.
  const resolver = new KeetaAnchor.lib.Resolver({ ...getDefaultResolverConfig(client), metadataConfig: { signing: { account } } });
  const chaining = new AnchorChaining({ client, resolver });
  const keeta = `chain:keeta:${client.network}` as const;
  const source = fromChain === 'base' ? (network === 'main' ? 'chain:evm:8453' : 'chain:evm:84532') : fromChain;

  // 1. Every external token that can be forwarded into this wallet, then keep the ones on the source chain.
  const { from } = await chaining.graph.resolveAssetsWithMetadata({
    to: { location: keeta, rail: 'KEETA_SEND' }, forwardingOnly: { method: 'implied' }, maxStepCount: 3
  });
  const onSource = from.filter((asset) => convertAssetLocationToString(asset.location) === source && typeof asset.asset === 'string');
  if (onSource.length === 0) throw new Error(`no deposit route from ${source} on ${network}`);

  for (const sourceAsset of onSource) {
    // 2. The Keeta token each one arrives as.
    const { to } = await chaining.graph.resolveAssetsWithMetadata({
      from: { asset: sourceAsset.asset, location: sourceAsset.location },
      to: { location: keeta, rail: 'KEETA_SEND' }, forwardingOnly: { method: 'explicit' }
    });
    for (const destination of to) {
      if (typeof destination.asset === 'string') continue;   // Keeta tokens are account objects
      if (process.env.KEETA_LIST_ONLY === 'yes') {
        // "What can I deposit from Base?" without creating an address yet.
        console.log({ send: sourceAsset.metadata?.ticker ?? sourceAsset.asset, on: source, arrivesAs: destination.asset.publicKeyString.get() });
        continue;
      }
      // 3. A forwarding-only plan resolves the deposit address: it reuses the wallet's existing address or creates one.
      const results = await chaining.getPlans({
        source: { asset: sourceAsset.asset, location: sourceAsset.location, rail: 'EVM_SEND', value: 1_000_000n },
        destination: { asset: destination.asset, location: keeta, rail: 'KEETA_SEND', recipient: account.publicKeyString.get() }
      }, { forwardingOnly: { method: 'implied', maxLegs: 3 }, maxPathLength: 3, includeAllOutput: true }) ?? [];
      const send = sourceAsset.metadata?.ticker ?? sourceAsset.asset;     // ticker, or the token contract 'evm:0x…'
      const arrivesAs = destination.asset.publicKeyString.get();         // the Keeta token credited to this wallet
      for (const result of results) {
        if (!result.success) {
          // Usually a provider that needs KYC first (KYCShareNeeded): see complete-kyc. Report it; don't retry blindly.
          const reason = result.error instanceof Error ? result.error.message : String(result.error);
          console.log({ send, on: source, arrivesAs, unavailableVia: result.failedAt.providerID, reason });
          continue;
        }
        console.log({
          send, sourceAsset: sourceAsset.asset, on: source, to: result.plan.getDepositAddress(), arrivesAs,
          providers: result.plan.path.map((step) => step.providerID ?? 'keeta-send'),
          fees: result.plan.listFees().lineItems.map((fee) => ({ purpose: fee.purpose, value: fee.value, basisPoints: fee.basisPoints }))
        });
      }
    }
  }
} finally {
  await client.destroy();
}
```

- **What it prints:** one entry per token and route: the token on the source chain, the deposit address (`to`), the Keeta token it arrives as, the providers on the route and their fees. Keeta's bridge (provider `keeta` on main, `evm-anchor` on test) gives one address for all four of its Base tokens, with no fee lines. A route that needs onboarding or identity first, such as Bridge.xyz's or Bivo's, prints `unavailableVia` with the provider's reason (for example `User Not Onboarded to Asset Movement Service`) instead; the Keeta bridge address is still valid.
- **Both networks run the same script.** CI runs it on test (Base Sepolia, provider `evm-anchor`) and lists the Base routes on main (provider `keeta`) every day.
- **Getting it is free and changes nothing on chain.** Asking again returns the same address, because the provider reuses the wallet's existing one. No approval is needed to look it up.
- **Show it with its chain and tokens:** "Send only USDC, EURC, cbBTC or KTA on Base to `0x…`. Other tokens or networks are not watched and may be lost." List exactly the tokens the script printed for that address.
- A deposit smaller than the network fee may not be credited. Deposits from Base work only through this address: `initiateTransfer` from an EVM source is rejected.
- **No output, or `no deposit route`:** that chain isn't served on this network (LayerZero routes exist only on main). Stop and say so; never guess an address.
- **From a wallet's own code:** the same three calls run anywhere the SDK runs. Inside an app that already has a `client`, drop the seed and network lines.

### Deposit from Base with one provider (Keeta EVM anchor)

When you already know the provider, ask it directly. Read the Keeta token from the provider's own paths instead of hard-coding it:

```ts
import * as KeetaAnchor from '@keetanetwork/anchor';

const am = new KeetaAnchor.AssetMovement.Client(client, { resolver });
const keeta = `chain:keeta:${client.network}` as const;
const base = client.network === 21378n ? 'chain:evm:8453' : 'chain:evm:84532';   // Base, or Base Sepolia on test
const providers = await am.getProvidersForTransfer({ from: base, to: keeta }) ?? [];
for (const p of providers) {
  // The asset pairs this provider moves from Base into Keeta: [external token, Keeta token].
  const pairs = p.serviceInfo.supportedAssets.flatMap(({ paths }) => paths.map(({ pair: [a, b] }) =>
    a.location === base && b.location === keeta ? [String(a.id), String(b.id)] : null).filter((x) => x !== null));
  console.log(String(p.providerID), pairs, p.getLegalDisclaimers());
}
// Keeta's own bridge is provider `keeta` on main and `evm-anchor` on test. Pick the provider and token the human approves.
const provider = providers.find((p) => String(p.providerID) === approvedProviderID);
if (!provider || !(await provider.isOperationSupported('createPersistentForwarding'))) throw new Error('no Base deposit route');
const { address } = await provider.createPersistentForwardingAddress({
  account, asset: keetaUSDC,                       // a Keeta token from the pairs above, or await tokenFor('$USDC') (keeta quickstart)
  sourceLocation: base, destinationLocation: keeta,
  destinationAddress: account.publicKeyString.get()
});
console.log('Send USDC, EURC, cbBTC or KTA on Base to', address);
```

- `provider.listForwardingAddresses({ account })` returns the addresses this wallet already has, when the provider supports `listPersistentForwarding`.
- The address is stable for this Keeta account and accepts all four tokens. The user sends a plain ERC-20 transfer from any wallet, and the anchor credits the same token on Keeta.

### Withdraw to Base

Keeta Personal sends every withdrawal through `AnchorChaining` (see "Withdraw to any other chain" below, with `location: base`), which also builds the transfer reference when a provider's instruction carries none. Use the direct calls below when you need one provider's quote and instruction yourself.

```ts
const out = { location: keeta };
const withdrawProvider = (await am.getProvidersForTransfer({ asset: keetaUSDC, from: keeta, to: base }))
  ?.find((p) => String(p.providerID) === approvedProviderID);
if (!withdrawProvider) throw new Error('no Base withdrawal route');
const quote = await withdrawProvider.simulateTransfer({ account, asset: keetaUSDC, from: out, to: { location: base }, value: amount });
console.log(quote.instructions.map((i) => [i.type, i.assetFee, i.totalReceiveAmount]));
const transfer = await withdrawProvider.initiateTransfer({
  account, asset: keetaUSDC, from: out, to: { location: base, recipient: evmRecipient }, value: amount
});
const instruction = transfer.instructions.find((i) => i.type === 'KEETA_SEND');
if (!instruction || instruction.type !== 'KEETA_SEND') throw new Error('no KEETA_SEND instruction');
if (instruction.external === undefined) throw new Error('no external reference: run this withdrawal through AnchorChaining instead');
// After approval, fund it exactly, including `external`:
await client.send(instruction.sendToAddress, BigInt(instruction.value), instruction.tokenAddress, instruction.external);
```

- **`external` is mandatory.** The bridge ignores a send without it, or a send whose token or amount differs from the instruction, and recovering it takes manual support. Send exactly `instruction.value` of `instruction.tokenAddress`, with `instruction.external`, in a block of its own.
- `evmRecipient` must be `0x` plus 40 hex characters, and a mixed-case address must have a valid checksum. Confirm that the user controls it.
- **For a reusable withdrawal address,** call `createPersistentForwardingAddress` with `sourceLocation: keeta`. It returns a `keeta://` URI. Parse it with `KeetaAnchor.lib.URI.parseKeetaURI(uri)`, then send to its `to` address, in its `token` (or the token you are withdrawing, when the URI names none), with `external[0]`, every time.

### Deposit from any other chain: one address, chained

The script in the first step covers every chain: set `KEETA_FROM_CHAIN` to the source location such as `chain:evm:42161` for Arbitrum.

- A forwarding-only plan yields **one deposit address on the source chain**, and each leg forwards to the next one automatically. Arbitrum USDC is one Bridge.xyz leg. Plasma USDT0 is a LayerZero leg followed by the Keeta EVM anchor.
- The user funds the deposit address from their own wallet. A forwarding-only plan can't be executed from Keeta.
- Show every leg's provider and fees, and the source chain and token, before the user sends anything. `plan.getProviderLegalDisclaimers()` returns each provider's disclaimers.
- **Bridge.xyz legs need KYC first.** Expect `KYCShareNeeded`, which includes a `tosFlow` link to Bridge's terms of service. A person must accept those terms, and the share must carry the resulting agreement ID. See [complete-kyc](../complete-kyc/SKILL.md).

### Withdraw to any other chain

```ts
import { AnchorChaining } from '@keetanetwork/anchor/lib/chaining.js';

const chaining = new AnchorChaining({ client, resolver });
const keetaUSDC = await tokenFor('$USDC');                       // helper from the keeta quickstart
const plan = (await chaining.getPlans({
  source: { asset: keetaUSDC, location: keeta, rail: 'KEETA_SEND', value: amount },
  // USDC on Arbitrum One (main). For Base use `base` and the token's Base contract; KTA is `client.baseToken`.
  destination: { asset: 'evm:0xaf88d065e77c8cC2239327C5EDb3A432268e5831', location: 'chain:evm:42161', rail: 'EVM_SEND', recipient: evmRecipient }
}))?.[0];
if (!plan) throw new Error('no route to that chain and token');
plan.on('stepNeedsAction', (event) => {
  if (event.type !== 'keetaSendAuthRequired') { event.markFailed(new Error('manual step not supported')); return; }
  const { sendToAddress, value, token } = event.action;
  void askApproval(`Send ${value} of ${token.publicKeyString.get()} to ${sendToAddress.publicKeyString.get()}?`)
    .then((ok) => ok ? event.markCompleted({ sent: false }) : event.markFailed(new Error('declined')));   // approved: the plan publishes the send
});
const result = await plan.execute({ requireSendAuth: true });
```

- **Approving a send:** `event.markCompleted({ sent: false })` approves the send, and the plan then publishes it. Never publish it yourself as well, or it is paid twice.
- **A plan is not atomic.** If a step fails, `execute()` throws that step's error, and `plan.state` holds `status: 'failed'`, `completedSteps` and `failedAtStepIndex` (the same values reach `plan.on('failed', …)`). Never run `execute()` again: reconcile balances, then plan only the remaining leg.
- LayerZero fills its final amount from a fresh quote at execution, so the delivered amount can differ from the estimate.
- Solana is a destination only. Never offer a Solana source.

### Track a transfer

- Poll `(await transfer.getTransferStatus()).transaction.status` until `KeetaAnchor.lib.isCompletedTransferStatus(status)` is true, then confirm the balance on the destination chain.
- Only `COMPLETE` is standard. Other statuses belong to each provider. Report them verbatim:
  - Keeta EVM anchor: `CREATED`, `SOURCE_*`, `DESTINATION_*`, `FAILED_VALUE_TOO_LOW`
  - Bridge.xyz: `SOURCE_DEPOSIT_AWAITING_SEND`, `DESTINATION_WITHDRAW_TX_CONFIRMING`, `DESTINATION_UNDELIVERABLE`, `TRANSACTION_RETURNED`, `INTERNAL_ERROR_SUPPORT_NEEDED`
  - LayerZero: `CREATED`, `RUNNING`, `FAILED`, `REVERSED`, `REQUIRES_ATTENTION`
- The Bridge.xyz status covers only its own leg. Confirm the final Keeta credit with `balance(token)`.
- `provider.listTransactions({ account, persistentAddresses: [{ location, persistentAddress }] })` lists the deposits to a persistent address.

## Confirmations

- Confirm the network, the direction, the source chain and token contract, the destination chain and token, the recipient, every provider and its fees, and any KYC requirement.
- Get human approval before any send from an external wallet, and before funding any Keeta send.
- Re-display each deposit address with its chain and accepted tokens.

## Failures

- **No provider or no plan:** that chain or token isn't served on this network. Stop, and don't guess an endpoint. LayerZero routes exist only on main.
- **`KYCShareNeeded`, `AdditionalKYCNeeded` or `UserActionNeeded`:** complete only the typed actions, with consent, then retry.
- **Wrong chain or token sent:** the funds aren't credited automatically. Report the transaction and the provider, and don't resend.
- **Below the minimum:** Bridge.xyz requires a few dollars or euros, and the validation error states the minimum (`valueRules.minimum`). LayerZero routes need amounts well above dust.
- **Pending transfer:** keep polling. Never fund a transfer twice.

## Related skills

- Verify identity for Bridge.xyz with [complete-kyc](../complete-kyc/SKILL.md).
- Check balances and decimals with [multi-asset-balances](../multi-asset-balances/SKILL.md).
- Convert between stablecoins and currencies with [convert-via-anchors](../convert-via-anchors/SKILL.md).
- For everything else, start at the [keeta](../keeta/SKILL.md) skill.

## Sources

- [Ethereum VM anchors](https://docs.keeta.com/anchors/anchor-types/asset-movement/ethereum-vm-anchors)
- [Base Sepolia USDC → Keeta example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/asset-movement-evm-inbound.ts)
- [Keeta → Base Sepolia example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/asset-movement-evm-outbound.ts)
- [Persistent deposit address example](https://github.com/KeetaNetwork/keetanet-examples/blob/main/src/anchor/asset-movement-persistent-address.ts)
- [Asset Movement client](https://github.com/KeetaNetwork/anchor/blob/main/src/services/asset-movement/client.ts) and [anchor chaining](https://github.com/KeetaNetwork/anchor/blob/main/src/lib/chaining.ts)
- [Keeta and LayerZero announcement](https://layerzero.network/blog/keeta-and-layerzero-bring-tokenized-bank-deposits): plans to carry Keeta stablecoins to other chains. Today's routes reach Keeta through Base.
- [Bridge](https://www.bridge.xyz)
