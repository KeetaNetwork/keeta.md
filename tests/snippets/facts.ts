// Checks the network facts the skills state as fixed values (keeta/SKILL.md "Networks", the bridge
// tables) against both networks, read-only. A mismatch fails CI, so the tables can't drift silently.
import * as KeetaNet from '@keetanetwork/keetanet-client';
import * as KeetaAnchor from '@keetanetwork/anchor';
import { getDefaultResolverConfig } from '@keetanetwork/anchor/config.js';
import { USDC_TESTNET_ADDRESS, USDC_MAINNET_ADDRESS } from '@x402/keeta';

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
		bridgeProvider: 'keeta'
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

		if (kta !== stated.kta) problems.push(`${network}: KTA is ${kta}, skills say ${stated.kta}`);
		if (usdc !== stated.usdc) problems.push(`${network}: resolver $USDC is ${usdc}, skills say ${stated.usdc}`);
		// x402-payments says @x402/keeta's test USDC doesn't exist and its main USDC matches the resolver.
		if (network === 'test' && x402UsdcExists) problems.push('test: @x402/keeta USDC now exists; update the x402-payments warning');
		if (network === 'main' && x402Usdc !== usdc) problems.push(`main: @x402/keeta USDC ${x402Usdc} differs from the resolver's ${usdc}`);
		// send-receive-tokens says neither network lists a username provider yet.
		if (usernameProviders !== 0) problems.push(`${network}: ${usernameProviders} username provider(s) now listed; update send-receive-tokens`);
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
