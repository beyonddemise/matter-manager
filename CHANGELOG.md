# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Monorepo scaffolding: npm workspaces, TypeScript project references, Biome, Vitest,
  Playwright
- Devcontainer with a CouchDB 3.x service matching the production image
- CI workflow enforcing lint, typecheck, tests and coverage gates
- Architecture documentation, data model, security model and thirteen ADRs recording the
  decisions behind them
- Reviewable backlog for milestones M0–M5
- `packages/core`: Base38 decoder for Matter onboarding payloads, developed test-first
  against Matter Core Specification vectors

[Unreleased]: https://github.com/beyonddemise/matter-manager/commits/main
