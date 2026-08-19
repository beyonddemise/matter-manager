# Pull request

## What and why

<!-- What changed, and what problem it solves. Link the issue. -->

Closes #

## How it was tested

<!--
Name the tests, not the activity. "Added 14 table-driven cases covering every invalid
Base38 character class" tells a reviewer something; "added tests" does not.
-->

## Test-first confirmation

- [ ] The test was written first and **observed failing** before the implementation existed
- [ ] The failure message described the missing behaviour, not a typo or import error

## Checklist

- [ ] `npm run verify` is clean (Biome, typecheck, tests)
- [ ] Coverage gates met (`core` 90%, others 70%)
- [ ] Every acceptance criterion in the issue is demonstrably met
- [ ] User-visible strings wrapped in `msg()` from `@lit/localize`
- [ ] No Matter payload or setup passcode is logged, or included in this PR's description
- [ ] An ADR was added or updated if this changes an architectural decision

## Offline behaviour

<!-- Delete if not applicable. If this touches data or sync, answer both: -->

- What happens when this runs with no connectivity?
- What happens when two clients do this concurrently and then sync?
