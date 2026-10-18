// Runs every `// live-test:` block from the skills against the Keeta test network, each with a
// brand-new wallet, and checks what it prints. `npm run live` extracts the blocks first.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import * as KeetaNet from '@keetanetwork/keetanet-client';

// What each live test must print to pass. A test missing here fails, so a new one gets a check.
const EXPECT = {
	facts: [/network facts match the skills/],
	// The quickstart reads the new wallet's address and KTA decimals, and finds test USDC through the resolver.
	quickstart: [/Address: keeta_a/, /KTA balance \(base units\): 0n decimals: \d+/, /USDC token: keeta_a\w+ decimals: \d+/],
	// A new wallet holds nothing, but the balances script still describes KTA from its metadata.
	balances: [/0 token\(s\) held on test by keeta_a/, /official: '\$KTA'/, /decimals: 18/],
	history: [/0 transaction\(s\) for keeta_a/],
	// Quoting needs no balance. The count is checked loosely; the log shows which providers answered.
	'swap-quote': [/\d+ plan\(s\) for 1 keeta_a\w+ -> keeta_a\w+ on test/],
	// Keeta's own Base bridge must give this wallet a Base Sepolia address for test USDC.
	'deposit-addresses': [/on: 'chain:evm:84532',\s+to: '0x[0-9a-fA-F]{40}',[^}]*providers: \[ 'evm-anchor' \]/]
};

// facts.ts is not a skill block: it checks the fixed values the skills state, on both networks.
const tests = [...readdirSync(new URL('./live/', import.meta.url)).filter((name) => name.endsWith('.ts')).sort().map((name) => `live/${name}`), 'facts.ts'];
let failed = 0;
for (const file of tests) {
	const name = file.replace(/^live\//, '').replace(/\.ts$/, '');
	const seed = KeetaNet.lib.Account.generateRandomSeed({ asString: true });
	const started = Date.now();
	const run = spawnSync('npx', ['tsx', file], {
		cwd: new URL('.', import.meta.url),
		env: { ...process.env, KEETA_NETWORK: 'test', KEETA_SEED: seed },
		encoding: 'utf-8',
		timeout: 5 * 60_000
	});
	const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
	const expected = EXPECT[name];
	const problems = [];
	if (run.status !== 0) problems.push(`exited with ${run.status ?? run.signal}`);
	if (!expected) problems.push('no expectation in live.mjs');
	for (const pattern of expected ?? []) {
		if (!pattern.test(run.stdout ?? '')) problems.push(`output does not match ${pattern}`);
	}
	console.log(`::group::${name} (${Math.round((Date.now() - started) / 1000)} s)`);
	console.log(output);
	console.log('::endgroup::');
	if (problems.length) {
		failed++;
		console.log(`FAIL ${name}: ${problems.join('; ')}`);
	} else {
		console.log(`ok   ${name}`);
	}
}
console.log(`${tests.length - failed} of ${tests.length} live tests passed on the test network.`);
process.exit(failed ? 1 : 0);
