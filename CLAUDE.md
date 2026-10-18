# keeta.md

This repository is the Keeta agent skills, served at https://keeta-md.pages.dev as plain files for agents (see README.md, "What keeta.md serves"). Its job is to keep every skill accurate and to add skills as Keeta ships features.

## Layout

- `plugins/keeta/skills/<name>/SKILL.md`: one folder per skill, plus optional `references/*.md`. This is the only place a `SKILL.md` may live; one anywhere else hides the pack from `npx skills add KeetaNetwork/keeta.md`.
- `plugins/keeta/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`: the Claude Code plugin and marketplace.
- `.github/scripts/validate-skills.py`: the checks CI runs. `.github/scripts/build-site.py`: builds `_site/` (llms.txt, llms-full.txt, /SKILL.md, /skills/, discovery indexes). Generated files are never committed.
- `site/`: Cloudflare Pages `_headers`, `_redirects` (`/` serves `llms.txt`) and `404.html`. No HTML pages beyond that: keeta.md is not a website.

## Rules for every skill

- Follow the Agent Skills specification (https://agentskills.io/specification). Frontmatter: `name` (equal to the folder, lowercase-hyphenated, at most 64 characters) and `description` (1 to 1024 characters, saying what it does and when to use it); optional `license`, `compatibility`, `metadata`, `allowed-tools`. Quote a value that contains `: ` or ` #`.
- Task skills need the sections `## When to use`, `## SDK steps`, `## Confirmations`, `## Failures` and `## Related skills`. The main `keeta` skill keeps its own sections (what you can do, rules, quickstart, task map, networks, reference files).
- Keep each `SKILL.md` under 500 lines; move detail to `references/`, and link every reference file from its `SKILL.md`. Relative links must resolve inside the skills tree.
- Code blocks: every ```ts block is typechecked in CI (`tests/snippets/`). A block may use the shared names declared in `tests/snippets/globals.d.ts` (`client`, `account`, `amount`…) without defining them; names one page shares between its blocks go in `tests/snippets/context/<page>.d.ts`. Start a self-contained block with `// live-test: <name>` and add its expected output per network to `tests/snippets/live.mjs` to run it on test and main. Live blocks read `KEETA_NETWORK` and must not move value or create anything on main. When you bump an SDK version, change `tests/snippets/package.json` and the versions in README.md together.
- Accuracy policy (README.md): code typechecks against the published `@keetanetwork/*` and `@x402/*` versions named there; providers, corridors and token addresses are discovered at run time, never hard-coded as available; amounts are integer base units with decimals read from token metadata; partner endpoints are never guessed; every value-moving workflow asks for confirmation first.
- Never publish fee schedules, internal hostnames, credentials, account allowlists, or a real seed or private key. Examples use the test network unless the text is explicitly about the main network.

## Adding a skill

1. Create `plugins/keeta/skills/<name>/SKILL.md` following the rules above.
2. Add `<name>` to `EXPECTED_SKILLS` in `.github/scripts/validate-skills.py`.
3. Add a row to the Skills table in README.md linking `plugins/keeta/skills/<name>/SKILL.md` (the validator checks for it), and link the new skill from the `keeta` skill's task map and from related skills where it fits.
4. Bump `version` in `plugins/keeta/.claude-plugin/plugin.json` and the matching entry in `.claude-plugin/marketplace.json` (they must be equal). Bump the minor version for a new skill, the patch version for fixes.

`llms.txt`, `llms-full.txt` and the discovery indexes are generated from the skill folders, so a new skill appears in them without further edits.

## Checking a change

```bash
python3 .github/scripts/validate-skills.py
(cd tests/snippets && npm ci && npm run typecheck)   # every ```ts block, against the pinned SDKs
(cd tests/snippets && npm run live)                  # `// live-test:` blocks on test and main
python3 .github/scripts/build-site.py
npx wrangler@4.151.0 pages dev _site          # http://localhost:8788 serves _site/ the way Pages does
npx skills add http://localhost:8788 --list    # every skill must be listed
```

CI runs the same checks on every pull request.

## Shipping

Work on a branch and open a pull request. Cloudflare Pages builds every push: pull requests get a preview URL, and merging to `main` deploys https://keeta-md.pages.dev. Never deploy by hand, and never change the Pages project, DNS or repository settings.
