// Checks the network facts the skills state as fixed values (keeta/SKILL.md "Networks", the bridge
// tables) against both networks, read-only. A mismatch fails CI, so the tables can't drift silently.
import * as KeetaNet from '@keetanetwork/keetanet-client';
import * as KeetaAnchor from '@keetanetwork/anchor';
import { getDefaultResolverConfig } from '@keetanetwork/anchor/config.js';
import { USDC_TESTNET_ADDRESS, USDC_MAINNET_ADDRESS, getUsdcAddress, KEETA_TESTNET_CAIP2, KEETA_MAINNET_CAIP2 } from '@x402/keeta';

const STATED = {
	test: {
		kta: 'keeta_anyiff4v34alvumupagmdyosydeq24lc4def5mrpmmyhx3j6vj2uucckeqn52',
		usdc: 'keeta_aosjk5tgpgxr3qazd2abxyhj4srqua5c3xgz4lmgxuyrrwzryiqng4vacgwai',
		base: 'chain:evm:84532',
		bridgeProvider: 'evm-anchor'
	},
	main: {
		kta: 'keeta_anqdilpazdekdu4acw65fj7smltcp26wbrildkqtszqvverljpwpezmd44ssg',
		usdc: 'keeta_amnkge74xitii5dsobstldatv3irmyimujfjotftx7plaaaseam4bntb7wnna',
		base: 'chain:evm:8453',
		bridgeProvider: 'keeta',
		kbusd: 'keeta_amg5vtcaylfhat3icwosxnibxf3ndimxnxfu3txbrwhra6ry75muct7d3lxwa'
	}
} as const;

const problems: string[] = [];
// A hung provider fails its own check with a name instead of stalling the whole run.
function within<T>(seconds: number, what: string, work: Promise<T>): Promise<T> {
	return Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} took over ${seconds} s`)), seconds * 1000).unref())]);
}
for (const network of ['test', 'main'] as const) {
	const stated = STATED[network];
	const account = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed({ asString: true }), 0);
	const client = KeetaNet.UserClient.fromNetwork(network, account);
	try {
		const resolver = new KeetaAnchor.lib.Resolver({ ...getDefaultResolverConfig(client), metadataConfig: { signing: { account } } });
		const kta = client.baseToken.publicKeyString.get();
		const usdc = (await resolver.lookupToken('$USDC'))?.token ?? null;
		const x402Usdc = network === 'test' ? USDC_TESTNET_ADDRESS : USDC_MAINNET_ADDRESS;
		let x402UsdcExists = false;
		try {
			const { info } = await client.client.getAccountInfo(x402Usdc);
			x402UsdcExists = info.name !== '' || info.metadata !== '';
		} catch {
			x402UsdcExists = false;
		}
		const am = new KeetaAnchor.AssetMovement.Client(client, { resolver });
		const keeta = `chain:keeta:${client.network}` as const;
		const baseProviders = ((await am.getProvidersForTransfer({ from: stated.base, to: keeta })) ?? []).map((p) => String(p.providerID));
		// send-receive-tokens resolves usernames across providers; an unknown name must give null, not throw.
		const usernameProviders = (await within(60, 'username provider lookup', resolver.lookup('username', {})))?.length ?? 0;
		const unknownName = await within(60, 'username lookup', new KeetaAnchor.Username.Client(client, { resolver }).resolveMulti(`no-such-user-${Date.now()}`));
		const tokens = (await resolver.listTokens()).map((t) => `${t.currency}=${t.token}`);
		console.log(JSON.stringify({ network, kta, usdc, x402Usdc, x402UsdcExists, baseProviders, usernameProviders, tokens }, null, 2));
		// Bivo's Keeta tokens, read from its own paths (pay-out, receive-bank-deposits, card-payments, bridge-crypto).
		const tickers = new Map<string, string>((await resolver.listTokens()).map((t) => [String(t.token), t.currency]));
		const nameOf = (id: string): string => `${tickers.get(id) ?? '(unlisted)'}=${id}`;
		const bivo: { [route: string]: { [provider: string]: string[] } } = {};
		const routes = [[keeta, 'bank-account:us'], ['bank-account:us', keeta], [keeta, 'bank-account:iban-swift'], [stated.base, keeta]] as const;
		for (const [from, to] of routes) {
			const found = (await within(60, `providers ${from} -> ${to}`, am.getProvidersForTransfer({ from, to }).catch(() => null))) ?? [];
			for (const p of found) {
				const ids = new Set<string>();
				for (const { paths } of p.serviceInfo.supportedAssets) {
					for (const { pair: [a, b] } of paths) {
						if (a.location === from && b.location === to) ids.add(String(from === keeta ? a.id : b.id));
					}
				}
				(bivo[`${from} -> ${to}`] ??= {})[String(p.providerID)] = [...ids].map(nameOf);
			}
		}
		// The stablecoin FX anchor converts each issuer's stablecoin 1:1 with the abstract currency token ($KBUSD <-> $KUSD).
		const fx = new KeetaAnchor.FX.Client(client, { resolver });
		const stable: { [pair: string]: string[] } = {};
		for (const [fromTicker, toTicker] of [['$KBUSD', '$KUSD'], ['$KUSD', '$KBUSD']] as const) {
			const fromHit = await resolver.lookupToken(fromTicker), toHit = await resolver.lookupToken(toTicker);
			if (!fromHit || !toHit) continue;
			const [fromToken, toToken] = [fromHit.token, toHit.token].map((t) => KeetaNet.lib.Account.fromPublicKeyString(t).assertKeyType(KeetaNet.lib.Account.AccountKeyAlgorithm.TOKEN));
			if (!fromToken || !toToken) continue;
			const estimates = (await within(60, `${fromTicker} -> ${toTicker} estimates`, fx.getEstimates({ from: fromToken, to: toToken, amount: 1_000_000n, affinity: 'from' }).catch(() => null))) ?? [];
			stable[`${fromTicker} -> ${toTicker}`] = estimates.map((e) => `${String(e.provider.providerID)}: ${String(e.estimate.convertedAmount)}`);
		}
		console.log(JSON.stringify({ network, bivo, stable }, null, 2));
		if (network === 'main') {
			// pay-out and receive-bank-deposits say main Bivo pays from USD and is moving to $KBUSD.
			const kbusd = (await resolver.lookupToken('$KBUSD'))?.token ?? null;
			if (kbusd !== STATED.main.kbusd) problems.push(`main: $KBUSD is ${kbusd}, skills expect ${STATED.main.kbusd}`);
			const bivoUS = Object.entries(bivo[`${keeta} -> bank-account:us`] ?? {}).filter(([id]) => id.includes('bivo')).flatMap(([, ids]) => ids);
			if (!bivoUS.length || !bivoUS.every((t) => t.startsWith('USD=') || t.startsWith('$KBUSD='))) problems.push(`main: Bivo's US payout tokens are ${bivoUS.join(', ') || 'none'}, skills say USD or $KBUSD`);
			// convert-via-anchors says the stablecoin FX anchor converts $KBUSD <-> $KUSD on main.
			for (const pair of ['$KBUSD -> $KUSD', '$KUSD -> $KBUSD']) {
				if (!(stable[pair] ?? []).some((e) => e.includes('stablecoin'))) problems.push(`main: no stablecoin FX estimate for ${pair} (${(stable[pair] ?? []).join(', ') || 'none'})`);
			}
		}

		if (kta !== stated.kta) problems.push(`${network}: KTA is ${kta}, skills say ${stated.kta}`);
		if (usdc !== stated.usdc) problems.push(`${network}: resolver $USDC is ${usdc}, skills say ${stated.usdc}`);
		// x402-payments says @x402/keeta's test USDC doesn't exist and its main USDC matches the resolver.
		if (network === 'test' && x402UsdcExists) problems.push('test: @x402/keeta USDC now exists; update the x402-payments warning');
		// x402-payments prices and caps in getUsdcAddress(), which must be the resolver's $USDC on both networks.
		const x402Resolved = await within(60, 'getUsdcAddress', getUsdcAddress(network === 'test' ? KEETA_TESTNET_CAIP2 : KEETA_MAINNET_CAIP2));
		if (x402Resolved !== usdc) problems.push(`${network}: getUsdcAddress is ${x402Resolved}, resolver $USDC is ${usdc}`);
		if (network === 'main' && x402Usdc !== usdc) problems.push(`main: @x402/keeta USDC ${x402Usdc} differs from the resolver's ${usdc}`);
		// send-receive-tokens resolves usernames through a provider discovered at run time, so each network must list one.
		if (usernameProviders === 0) problems.push(`${network}: no username provider listed; update send-receive-tokens`);
		if (unknownName !== null) problems.push(`${network}: an unknown username resolved to ${JSON.stringify(unknownName)}`);
		if (!baseProviders.includes(stated.bridgeProvider)) problems.push(`${network}: Base providers are ${baseProviders.join(', ')}, skills name ${stated.bridgeProvider}`);
	} finally {
		await client.destroy();
	}
}

if (problems.length) {
	console.log(problems.map((problem) => `MISMATCH ${problem}`).join('\n'));
	process.exit(1);
}
console.log('network facts match the skills');
