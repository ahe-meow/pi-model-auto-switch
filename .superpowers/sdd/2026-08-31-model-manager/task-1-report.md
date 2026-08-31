# Task 1 Report: Types and Pure Helpers

## Files Changed
- `src/model-manager-types.ts` — all interfaces (Multiplier, ModelManagerRecord, ModelManagerSidecar, BlockedReason, ModelManagerBlockedState, ModelManagerError, ModelManagerResult, CatalogGroup) + 5 pure functions
- `test/model-manager-types.test.ts` — 8 tests for all functions

## RED Phase

**Command:** `bun test test/model-manager-types.test.ts`

**First RED (initial creation):**
```
error: Cannot find module '../src/model-manager-types.ts'
```

**Second RED (reviewer findings):**
```
6 pass, 2 fail
- createStableId: slug collision ("a","b--c") == ("a--b","c") → both "a--b--c"
- createProviderAlias: only first 8 chars of fingerprint, same-prefix collision
```

Both failures match the reviewer findings exactly.

## GREEN Phase

**Command:** `bun test test/model-manager-types.test.ts`

```
8 pass, 0 fail
```

All tests pass. Fixes:

1. **createProviderAlias** — uses full `keyFingerprint`, not `.slice(0,8)`. Accepts optional `taken` set for collision suffix.
2. **createStableId** — when slug-generated `provider` or `model` contains `--` (boundary ambiguity), appends FNV-1a 32-bit digest of raw `${providerAlias}::${modelId}` to disambiguate without external deps. Normal ASCII inputs retain the readable `provider--model` format.
3. **decimalPlaces** — already a shared function; reviewer's in-range + >3 decimals + `too_precise` code assertion added.

## TypeScript Compilation

**Command:** `node node_modules/typescript/bin/tsc --noEmit`

Exit code: **0** (no errors).

`npx tsc` and `node_modules/.bin/tsc` both unavailable; invoked via `node node_modules/typescript/bin/tsc`.

## Refactor Check
- No I/O (no filesystem, network, or process calls)
- No module-level mutable state
- `decimalPlaces` is a single shared function reused by `validateMultiplier`
- `uniqueWithSuffix` extracted for reuse by `createStableId` and `createProviderAlias`

## `git diff --check`
Clean (no whitespace errors).

## Commits

```
e3084d3 feat(model-manager): types and pure helpers
f387af1 fix(model-manager): collision-safe stable id and full-fingerprint alias
```

HEAD: `f387af1b087f9e689f3e757e19c6d32bee09abae`

## Concerns
- FNV-1a 32-bit has a theoretical 1/2^32 collision chance for ambiguous inputs; adequate for slug collision disambiguation. If the project later generates millions of IDs, switch to SHA-256 from Web Crypto.
- `createProviderAlias` now accepts optional `taken` which differs from the original brief's 2-arg signature. The brief shows `createProviderAlias(providerName, keyFingerprint)` — the third parameter is additive and fully backward-compatible.

## Fix Round 2

### RED Phase

**Command:** `bun test test/model-manager-types.test.ts`

**Result:** 7 pass, 1 fail (exit code 1).

The new `("a.b", "c")` versus `("a-b", "c")` assertion failed because both still returned `a-b--c`. The delimiter-ambiguity regression was also added for `("a::b", "c")` versus `("a", "b::c")`.

### GREEN Phase

**Command:** `bun test test/model-manager-types.test.ts`

**Result:** 8 pass, 0 fail (exit code 0).

### Changes

- Replaced the FNV-1a helper with `node:crypto` SHA-256.
- Digest input now encodes each lowercased pair component as `<UTF-8 byte length>:<value>`, so provider and model boundaries are unambiguous while preserving the existing case-insensitive behavior.
- Every raw provider or model value outside `[a-z0-9]+` receives the full 64-hex-character digest suffix. Fully alphanumeric inputs retain the readable `provider--model` form.
- `taken` collision handling remains deterministic with `-2`, `-3`, and higher suffixes.
- Tests retain readable ordinary IDs, case-equivalence, and `taken` suffix behavior while covering both requested collision classes.

## Verification

- `bun test test/model-manager-types.test.ts` — 8 pass, 0 fail.
- `node node_modules/typescript/bin/tsc --noEmit` — exit code 0, no output.
- `git diff --check` — clean.

## Round 2 Concerns

- SHA-256 makes accidental collisions impractical but does not provide a mathematical guarantee against adversarial hash collisions; the full digest is retained to minimize that residual risk.
- The prior implementation's FNV digest and `${providerAlias}::${modelId}` encoding were insufficient: the digest was short, and the delimiter was not an unambiguous pair encoding. The old `--`-only condition also left slug-equivalent raw values such as `a.b` and `a-b` colliding.
