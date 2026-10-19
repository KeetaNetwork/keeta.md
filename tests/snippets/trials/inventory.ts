// networks: test, main
// Trial "inventory": the user asks "what can Keeta do for me on this network?". Lists every provider the
// resolver publishes, by service, and for asset movement the locations each one connects
// (discover-resolve-anchors: inspect lookup results as plain JSON). Read-only on both networks.
import * as KeetaNet from '@keetanetwork/keetanet-client';
import * as KeetaAnchor from '@keetanetwork/anchor';
import { getDefaultResolverConfig } from '@keetanetwork/anchor/config.js';

const network = process.env.KEETA_NETWORK === 'main' ? 'main' : 'test';
if (!process.env.KEETA_SEED) throw new Error('set KEETA_SEED');
const account = KeetaNet.lib.Account.fromSeed(process.env.KEETA_SEED, 0);
const client = KeetaNet.UserClient.fromNetwork(network, account);
const resolver = new KeetaAnchor.lib.Resolver({ ...getDefaultResolverConfig(client), metadataConfig: { signing: { account } } });

// Lookup results mix plain objects with lazy values, so resolve them one by one to inspect as JSON
async function toPlain(v: unknown): Promise<unknown> {
  if (typeof v === 'function') { try { return await toPlain(await v('any')); } catch { return null; } }
  if (Array.isArray(v)) return Promise.all(v.map(toPlain));
  if (v !== null && typeof v === 'object') return Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k, x]) => [k, await toPlain(x)])));
  return v;
}
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const short = (v: unknown) => String(v).replace(/^(keeta_[a-z0-9]{8})[a-z0-9]+$/, '$1…');

try {
  const root = await toPlain((await resolver.getRootMetadata()).services);
  if (!isObject(root)) throw new Error('no services in root metadata');
  const counts: string[] = [];
  for (const [service, providers] of Object.entries(root)) {
    const ids = isObject(providers) ? Object.keys(providers) : [];
    counts.push(`${service}: ${ids.length}`);
    console.log(`\n== ${service} (${ids.length}) ==`);
    for (const id of ids) {
      const meta = (providers as Record<string, unknown>)[id];
      const lines: string[] = [];
      const byRoute = new Map<string, Set<string>>();
      if (service === 'assetMovement' && isObject(meta) && Array.isArray(meta.supportedAssets)) {
        for (const asset of meta.supportedAssets) {
          if (!isObject(asset) || !Array.isArray(asset.paths)) continue;
          for (const path of asset.paths) {
            if (!Array.isArray(path.pair)) continue;
            const [a, b] = path.pair.map((side: unknown) => isObject(side) ? side : {});
            const key = `${a.location ?? '?'} <-> ${b.location ?? '?'}`;
            const assets = byRoute.get(key) ?? new Set<string>();
            assets.add(`${short(a.id)}>${short(b.id)}`);
            byRoute.set(key, assets);
          }
        }
      } else if (service === 'fx' && isObject(meta) && Array.isArray(meta.from)) {
        for (const pair of meta.from) if (isObject(pair)) lines.push(`${[pair.currencyCodes].flat().map(short).join(',')} -> ${[pair.to].flat().map(short).join(',')}`);
      }
      for (const [route, assets] of byRoute) lines.push(`${route} (${assets.size} asset pair(s): ${[...assets].slice(0, 6).join(', ')}${assets.size > 6 ? ', …' : ''})`);
      const unique = [...new Set(lines)];
      console.log(`- ${id}${unique.length ? `: ${unique.length} path(s)` : ''}`);
      for (const line of unique.slice(0, 40)) console.log(`    ${line}`);
      if (unique.length > 40) console.log(`    … and ${unique.length - 40} more`);
    }
  }
  console.log(`RESULT: On ${network} the resolver lists ${counts.join(', ')}.`);
} finally {
  await client.destroy();
}
