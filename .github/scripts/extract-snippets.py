#!/usr/bin/env python3
"""Write every ```ts block in the skills to tests/snippets/generated/ so tsc can check it.

Each block becomes its own module. Free names that blocks share (client, account, amount…)
are declared once in tests/snippets/globals.d.ts; a block that declares one itself shadows it.
Names that only one page shares between its blocks, or that mean something different on that
page, are declared in tests/snippets/context/<page>.d.ts (one `declare …` per line, page path
with `/` replaced by `__`). Those lines are copied into each block of the page that does not
declare the name itself.

A block whose first line is `// live-test: <name>` is self-contained and runs for real: it is
also written to tests/snippets/live/<name>.ts, which CI runs against the test network.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKILLS_ROOT = ROOT / "plugins" / "keeta" / "skills"
OUT = ROOT / "tests" / "snippets" / "generated"
CONTEXT = ROOT / "tests" / "snippets" / "context"
DECLARED_NAME = re.compile(r"^declare\s+(?:const|let|function|class|type)\s+([A-Za-z_$][\w$]*)")
FENCE = re.compile(r"^(?P<indent>[ \t]*)```(?P<lang>[A-Za-z0-9_-]*)[ \t]*$")
TS_LANGS = {"ts", "typescript"}
LIVE = ROOT / "tests" / "snippets" / "live"
SKIP_MARKER = "// snippet: no-typecheck"
LIVE_MARKER = re.compile(r"^// live-test: ([a-z0-9-]+)\s*$")


def blocks(path: Path):
    lines = path.read_text(encoding="utf-8").splitlines()
    i = 0
    while i < len(lines):
        match = FENCE.match(lines[i])
        if not match or match["lang"] not in TS_LANGS:
            i += 1
            continue
        indent = match["indent"]
        start = i + 1
        body: list[str] = []
        i += 1
        while i < len(lines) and lines[i].strip() != "```":
            line = lines[i]
            body.append(line[len(indent):] if line.startswith(indent) else line.lstrip())
            i += 1
        yield start, "\n".join(body)
        i += 1


def declares(code: str, name: str) -> bool:
    """Whether a block binds `name` itself, so the page context must not redeclare it."""
    n = re.escape(name)
    patterns = [
        rf"\b(?:const|let|var|function|class|type|interface)\s+{n}\b",
        rf"\b(?:const|let|var)\s*[{{\[][^=;]*\b{n}\b[^=;]*[}}\]]\s*=",
        rf"\bimport\s+(?:type\s+)?{n}\b",
        rf"\bimport\b[^;]*\{{[^}}]*\b{n}\b[^}}]*\}}",
        rf"\bimport\s+\*\s+as\s+{n}\b",
    ]
    return any(re.search(pattern, code) for pattern in patterns)


def page_context(stem: str) -> list[tuple[str, str]]:
    path = CONTEXT / f"{stem}.d.ts"
    if not path.exists():
        return []
    entries = []
    for line in path.read_text(encoding="utf-8").splitlines():
        match = DECLARED_NAME.match(line.strip())
        if match:
            entries.append((match[1], line.strip()))
    return entries


def main() -> int:
    for folder in (OUT, LIVE):
        if folder.exists():
            shutil.rmtree(folder)
        folder.mkdir(parents=True)
    count = 0
    live: dict[str, str] = {}
    for path in sorted(SKILLS_ROOT.rglob("*.md")):
        rel = path.relative_to(SKILLS_ROOT)
        stem = "__".join(rel.with_suffix("").parts)
        context = page_context(stem)
        for line, code in blocks(path):
            if SKIP_MARKER in code:
                continue
            needed = [text for name, text in context if not declares(code, name)]
            header = f"// {rel}:{line}\n" + "".join(f"{text}\n" for text in needed)
            (OUT / f"{stem}__L{line}.ts").write_text(header + code + "\n\nexport {};\n", encoding="utf-8")
            count += 1
            marker = LIVE_MARKER.match(code.splitlines()[0]) if code else None
            if marker:
                name = marker[1]
                if name in live:
                    raise SystemExit(f"{rel}:{line}: live test {name!r} is already defined in {live[name]}")
                live[name] = f"{rel}:{line}"
                (LIVE / f"{name}.ts").write_text(f"// {rel}:{line}\n" + code + "\n", encoding="utf-8")
    print(f"wrote {count} TypeScript snippets to {OUT.relative_to(ROOT)} and {len(live)} live tests to {LIVE.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
