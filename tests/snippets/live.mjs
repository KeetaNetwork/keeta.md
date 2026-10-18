// Runs every `// live-test:` block from the skills against the Keeta test network, each with a
// brand-new wallet, and checks what it prints. `npm run live` extracts the blocks first.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import * as KeetaNet from '@keetanetwork/keetanet-client';

// What each live test must print to pass. A test missing here fails, so a new one gets a check.
const EXPECT = {
	// Keeta's own Base bridge must give this wallet a Base Sepolia address for test USDC.
	'deposit-addresses': [/on: 'chain:evm:84532',\s+to: '0x[0-9a-fA-F]{40}',[^}]*providers: \[ 'evm-anchor' \]/]
};

const tests = readdirSync(new URL('./live/', import.meta.url)).filter((name) => name.endsWith('.ts')).sort();
let failed = 0;
for (const file of tests) {
	const name = file.replace(/\.ts$/, '');
	const seed = KeetaNet.lib.Account.generateRandomSeed({ asString: true });
	const started = Date.now();
	const run = spawnSync('npx', ['tsx', `live/${file}`], {
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
