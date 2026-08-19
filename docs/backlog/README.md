# Backlog

Reviewable source for the GitHub issues. **Nothing is created in GitHub until this has been
reviewed** — editing a markdown file is far faster than editing forty issues, and a bad
decomposition is expensive to undo once it is a board.

| Milestone | File | Issues | Status |
|---|---|---|---|
| M0 Foundations | [milestone-0.md](milestone-0.md) | 8 | mostly done in the setup session |
| M1 Domain core | [milestone-1.md](milestone-1.md) | 7 | ready |
| M2 Local catalogue | [milestone-2.md](milestone-2.md) | 12 | ready |
| M3 PDF export | [milestone-3.md](milestone-3.md) | 6 | ready |
| M4 Auth + backend | [milestone-4.md](milestone-4.md) | 8 | ready |
| M5 Projects + sync | [milestone-5.md](milestone-5.md) | 10 | ready |

M6–M9 are named in the [design document](../superpowers/specs/2026-08-19-matter-manager-design.md)
and get their own files when M0–M5 is close to done. Writing them now would mean writing
acceptance criteria for a product we have not used yet.

## Issue shape

Every issue carries a user story, Given/When/Then acceptance criteria, an explicit
out-of-scope list, and a test plan.

The acceptance criteria are not decoration — **they become the tests verbatim**. Write them
precisely enough that someone else could turn them into assertions without asking a
question.

The out-of-scope list is what stops scope creep. An issue without one grows.

## A story is a slice, not a layer

"Add a device and see it in the list" is a story: someone wants it, and you can demonstrate
it. "Create the device repository" is not — no user is behind it, and it cannot be shown
working.

Layers still get built, of course. They get built *because* a slice needs them, which keeps
them the size the slice actually requires rather than the size someone imagined up front.

## Applying this to GitHub

Once reviewed:

```bash
# Labels
gh label create "type:story" --color 0E8A16 --description "A vertical slice of user-visible value"
# ... see .github/labels.yml

# Milestones
gh api repos/:owner/:repo/milestones -f title="M0 Foundations" -f description="..."

# Issues
gh issue create --title "..." --body-file ... --label "type:story,area:core,size:M" --milestone "M1 Domain core"
```

A script that reads these files is worth writing once the content is settled — not before,
or it gets rewritten alongside every edit.
