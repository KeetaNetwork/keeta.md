// Runs the agent trials: programs that an agent wrote using only the skills, for requests a real user
// makes ("what's my Base deposit address", "send 1 KTA"). Each trial declares the networks it runs on
// in a `// networks: test, main` header. On test it gets a new wallet and KEETA_CONFIRMED=yes, so it
// may fund itself from the faucet and move test value; on main it gets KEETA_READ_ONLY=yes and must not
// move value or create anything. A trial passes when it exits 0 and prints a line starting `RESULT:`.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import * as KeetaNet from '@keetanetwork/keetanet-client';

const only = process.argv[2];
const dir = new URL('./trials/', import.meta.url);
const trials = readdirSync(dir).filter((name) => name.endsWith('.ts') && (!only || name.startsWith(only))).sort();
let failed = 0;
let runs = 0;
for (const file of trials) {
	const header = readFileSync(new URL(file, dir), 'utf-8').match(/^\/\/ networks:\s*(.+)$/m);
	const networks = header ? header[1].split(',').map((n) => n.trim()).filter((n) => n === 'test' || n === 'main') : ['test'];
	for (const network of networks) {
		runs++;
		const started = Date.now();
		const run = spawnSync('npx', ['tsx', `trials/${file}`], {
			cwd: new URL('.', import.meta.url),
			env: {
				...process.env,
				KEETA_NETWORK: network,
				KEETA_SEED: KeetaNet.lib.Account.generateRandomSeed({ asString: true }),
				...(network === 'main' ? { KEETA_READ_ONLY: 'yes' } : { KEETA_CONFIRMED: 'yes' })
			},
			encoding: 'utf-8',
			timeout: 10 * 60_000
		});
		const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
		const problems = [];
		if (run.status !== 0) problems.push(`exited with ${run.status ?? run.signal}`);
		if (!/^RESULT:/m.test(run.stdout ?? '')) problems.push('printed no RESULT: line');
		console.log(`::group::${file} on ${network} (${Math.round((Date.now() - started) / 1000)} s)`);
		console.log(output.trim());
		console.log('::endgroup::');
		if (problems.length) {
			failed++;
			console.log(`FAIL ${file} on ${network}: ${problems.join('; ')}`);
		} else {
			console.log(`ok   ${file} on ${network}`);
		}
	}
}
console.log(`${runs - failed} of ${runs} trial runs passed.`);
process.exit(failed ? 1 : 0);
