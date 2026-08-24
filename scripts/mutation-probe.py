#!/usr/bin/env python3
"""Mutation probe that refuses to report a survivor it cannot justify.

Usage:  python3 scripts/mutation-probe.py <src file> <test path> <mutations.json>
where mutations.json is [[label, findThisText, replaceWithThis], ...].


L3 and its recurrences: a surviving mutant and a mutant that never ran are equally
silent. This applies the mutation in-process (no shell quoting), asserts the text
actually changed, and requires evidence that the suite ran before calling anything a
survivor.
"""
import json
import pathlib
import re
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
TARGET = REPO / sys.argv[1]
TESTS = sys.argv[2]
MUTATIONS = json.loads(pathlib.Path(sys.argv[3]).read_text())

original = TARGET.read_text()
results = []

for label, old, new in MUTATIONS:
    if old not in original:
        results.append((label, 'PATTERN NOT FOUND — probe is broken'))
        continue
    mutated = original.replace(old, new, 1)
    assert mutated != original, label
    TARGET.write_text(mutated)
    try:
        run = subprocess.run(
            ['npx', 'vitest', 'run', TESTS],
            cwd=REPO, capture_output=True, text=True, timeout=300,
        )
        out = run.stdout + run.stderr
        failed = re.search(r'Tests\s+(\d+) failed', out)
        passed = re.search(r'Tests\s+.*?(\d+) passed', out)
        if failed:
            results.append((label, f'caught — {failed.group(1)} failed'))
        elif passed:
            results.append((label, f'SURVIVED — {passed.group(1)} passed, suite ran'))
        else:
            # No test counts at all: the mutant did not compile, or the run died.
            results.append((label, 'INCONCLUSIVE — suite produced no test counts'))
    finally:
        TARGET.write_text(original)

width = max(len(label) for label, _ in results)
for label, verdict in results:
    print(f'  {label.ljust(width)}  {verdict}')

bad = [l for l, v in results if not v.startswith('caught')]
print()
print(f'{len(results) - len(bad)}/{len(results)} caught' + (f'; needs attention: {bad}' if bad else ''))
