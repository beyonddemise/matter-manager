#!/usr/bin/env python3
"""Mutation probe that refuses to report a survivor it cannot justify.

Usage:  python3 scripts/mutation-probe.py <src file> <test path> <mutations.json>
where mutations.json is [[label, findThisText, replaceWithThis], ...].

L3 and its recurrences: a surviving mutant and a mutant that never ran are equally silent,
and the silence reads as thoroughness. Every path that cannot distinguish the two reports
INCONCLUSIVE rather than guessing, because the cost of a wrong guess is asymmetric - a false
"caught" is harmless noise, a false "SURVIVED" sends you off to weaken a test that was fine.
"""
import json
import pathlib
import re
import subprocess
import sys

CAUGHT = 'caught'
SURVIVED = 'SURVIVED'
INCONCLUSIVE = 'INCONCLUSIVE'


def classify(returncode, output):
    """Turn a vitest run into a verdict.

    Pure, so the awkward cases can be tested without running anything. The order matters:
    detected failures win over the exit code, because a non-zero exit is exactly what a
    caught mutation produces.
    """
    failed = re.search(r'Tests\s+(\d+) failed', output)
    if failed:
        return CAUGHT, f'{CAUGHT} — {failed.group(1)} failed'

    passed = re.search(r'Tests\s+.*?(\d+) passed', output)
    if passed and returncode == 0:
        return SURVIVED, f'{SURVIVED} — {passed.group(1)} passed, suite ran clean'
    if passed:
        # Tests passed but the process still failed: an unhandled rejection, a teardown
        # error, a worker crash. The suite's verdict cannot be trusted to mean anything.
        return INCONCLUSIVE, f'{INCONCLUSIVE} — tests passed but vitest exited {returncode}'
    return INCONCLUSIVE, f'{INCONCLUSIVE} — no test counts; the mutant probably did not compile'


def main(argv):
    repo = pathlib.Path(__file__).resolve().parent.parent
    target = repo / argv[1]
    tests = argv[2]

    mutations = json.loads(pathlib.Path(argv[3]).read_text())
    if not isinstance(mutations, list) or not mutations:
        raise SystemExit('mutations.json must be a non-empty list of [label, old, new].')

    original = target.read_text()
    results = []

    for entry in mutations:
        # Types, not just shape. A null replacement crashes inside str.replace and a
        # non-string label crashes while formatting the report - both after some mutations
        # have already run, leaving a half-finished report and a restored file that looks
        # like a completed pass.
        if not (
            isinstance(entry, list)
            and len(entry) == 3
            and all(isinstance(value, str) for value in entry)
        ):
            raise SystemExit(
                f'Each mutation must be [label, old, new], all strings; got {entry!r}.'
            )
        label, old, new = entry

        # An ambiguous pattern is the probe's own version of the bug it hunts: replacing the
        # first of several occurrences mutates a branch the label does not describe, and the
        # verdict then belongs to code nobody was asking about.
        occurrences = original.count(old) if old else 0
        if occurrences != 1:
            results.append((label, f'{INCONCLUSIVE} — pattern occurs {occurrences} times, need exactly 1'))
            continue

        mutated = original.replace(old, new, 1)
        if mutated == original:
            # `assert` would vanish under `python -O`, and the unchanged file would then be
            # tested against itself and reported as a survivor.
            results.append((label, f'{INCONCLUSIVE} — replacement left the file unchanged'))
            continue

        target.write_text(mutated)
        try:
            run = subprocess.run(
                ['npx', 'vitest', 'run', tests],
                cwd=repo, capture_output=True, text=True, timeout=300,
            )
            results.append((label, classify(run.returncode, run.stdout + run.stderr)[1]))
        except subprocess.TimeoutExpired:
            results.append((label, f'{INCONCLUSIVE} — vitest timed out'))
        except OSError as error:
            results.append((label, f'{INCONCLUSIVE} — could not run vitest: {error}'))
        finally:
            target.write_text(original)

    width = max(len(label) for label, _ in results)
    for label, verdict in results:
        print(f'  {label.ljust(width)}  {verdict}')

    unresolved = [label for label, verdict in results if not verdict.startswith(CAUGHT)]
    print()
    print(
        f'{len(results) - len(unresolved)}/{len(results)} caught'
        + (f'; needs attention: {unresolved}' if unresolved else '')
    )
    return 1 if unresolved else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
