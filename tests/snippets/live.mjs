// Runs every `// live-test:` block from the skills on the test network and on main, each run with a
// brand-new wallet, and checks what it prints. Nothing here moves value: a new wallet has no funds,
// and on main the deposit-address script only lists routes (KEETA_LIST_ONLY) so CI creates no
// production addresses. `npm run live` extracts the blocks first.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import * as KeetaNet from '@keetanetwork/keetanet-client';

// What each live test must print on each network. A test missing here fails, so a new one gets a check.
const EXPECT = {
	// The quickstart reads the new wallet's address and KTA decimals, and finds USDC through the resolver.
	quickstart: {
		test: [/Address: keeta_a\w+ on test/, /KTA balance \(base units\): 0n decimals: 18/, /USDC token: keeta_a\w+ decimals: \d+/],
		main: [/Address: keeta_a\w+ on main/, /KTA balance \(base units\): 0n decimals: 18/, /USDC token: keeta_a\w+ decimals: \d+/]
	},
	// A new wallet holds nothing, but the balances script still describes KTA from its metadata.
	balances: {
		test: [/0 token\(s\) held on test by keeta_a/, /official: '\$KTA'/, /decimals: 18/],
		main: [/0 token\(s\) held on main by keeta_a/, /decimals: 18/]
	},
	history: {
		test: [/0 transaction\(s\) for keeta_a/],
		main: [/0 transaction\(s\) for keeta_a/]
	},
	// Quoting needs no balance. The plan count is checked loosely; the log shows which providers answered.
	'swap-quote': {
		test: [/\d+ plan\(s\) for 1 keeta_a\w+ -> keeta_a\w+ on test/, /can convert into: /],
		main: [/[1-9]\d* plan\(s\) for 1 keeta_a\w+ -> keeta_a\w+ on main/, /route: 'fx:/, /can convert into: .*USDC keeta_a/]
	},
	// Test: Keeta's own Base bridge gives this wallet a Base Sepolia address. Main: Base routes are listed.
	'deposit-addresses': {
		test: [/on: 'chain:evm:84532',\s+to: '0x[0-9a-fA-F]{40}',[^}]*providers: \[ 'evm-anchor' \]/],
		main: [/on: 'chain:evm:8453'/]
	},
	// Keeta USDC to USDC on Arbitrum. Test: LayerZero runs on main only, so there is no route and the script says so.
	// Main: the routes are listed from metadata alone (KEETA_LIST_ONLY), so CI quotes nothing and creates no
	// forwarding address at LayerZero; quoting and execution need a confirmed rerun.
	'pay-on-other-chains': {
		test: [/no route from keeta_a\w+ to chain:evm:42161 on test/],
		main: [/can reach on chain:evm:42161: /, /route: assetMovement:\S+ > assetMovement:\S+/]
	},
	// facts.ts is not a skill block: it checks the fixed values the skills state, on both networks itself.
	facts: { test: [/network facts match the skills/] }
};
const NETWORK_ENV = { main: { 'deposit-addresses': { KEETA_LIST_ONLY: 'yes' }, 'pay-on-other-chains': { KEETA_LIST_ONLY: 'yes' } } };

const tests = [...readdirSync(new URL('./live/', import.meta.url)).filter((name) => name.endsWith('.ts')).sort().map((name) => `live/${name}`), 'facts.ts'];
let failed = 0;
let runs = 0;
for (const file of tests) {
	const name = file.replace(/^live\//, '').replace(/\.ts$/, '');
	const networks = EXPECT[name] ? Object.keys(EXPECT[name]) : ['test'];
	for (const network of networks) {
		runs++;
		const seed = KeetaNet.lib.Account.generateRandomSeed({ asString: true });
		const started = Date.now();
		const run = spawnSync('npx', ['tsx', file], {
			cwd: new URL('.', import.meta.url),
			env: { ...process.env, KEETA_NETWORK: network, KEETA_SEED: seed, ...NETWORK_ENV[network]?.[name] },
			encoding: 'utf-8',
			timeout: 5 * 60_000
		});
		const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
		const expected = EXPECT[name]?.[network];
		const problems = [];
		if (run.status !== 0) problems.push(`exited with ${run.status ?? run.signal}`);
		if (!expected) problems.push('no expectation in live.mjs');
		for (const pattern of expected ?? []) {
			if (!pattern.test(run.stdout ?? '')) problems.push(`output does not match ${pattern}`);
		}
		const label = `${name} on ${network}`;
		console.log(`::group::${label} (${Math.round((Date.now() - started) / 1000)} s)`);
		console.log(output);
		console.log('::endgroup::');
		if (problems.length) {
			failed++;
			console.log(`FAIL ${label}: ${problems.join('; ')}`);
		} else {
			console.log(`ok   ${label}`);
		}
	}
}
console.log(`${runs - failed} of ${runs} live runs passed.`);
process.exit(failed ? 1 : 0);
