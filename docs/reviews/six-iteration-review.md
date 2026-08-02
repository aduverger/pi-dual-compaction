# Six-iteration Million Eyes review

Started: 2026-08-02

Stage: alpha. Preserve current behavior. Backward compatibility is not required.
Accept findings only when they improve robustness, elegance, coherence, or
maintainability without adding net complexity.

Each iteration records its exact lens in `docs/reviews/lenses/`. Million Eyes
reviews a clean mirror that copies `.mjs` source byte-for-byte to `.ts` paths.
The mirror exists because extractor/1 does not admit JavaScript modules.

## Iteration 1 — public interface deletion test

Blackmagic commit reviewed: `16f21335`

Scope: `src/index.ts`, `src/extension.ts`, and `src/controller.ts`.

Report artifact:
`<LOCAL_HOME>/repos/million-eyes/artifacts/pi-openai-blackmagic-compact-16f21335-iter01-public-interface-luna-v1/`

Finding: the public `readableSummary` interface always threw and directed callers
to the lifecycle handler.

Assessment: accepted. It was an unusable public concept. Alpha compatibility
permits deletion, and the extension lifecycle remains the only summary route.

Change: deleted `readableSummary` and its root export.

## Iteration 2 — state ontology minimization

Blackmagic commit reviewed: `4ab19f64`

Scope: `src/contract.ts` and `src/controller.ts`.

Report artifact:
`<LOCAL_HOME>/repos/million-eyes/artifacts/pi-openai-blackmagic-compact-4ab19f64-iter02-state-ontology-luna-v1/`

Finding: persisted state projection accepted `remote_replayed`,
`remote_invalidated`, and `unsupported_surface`, although the controller emits
those as transient telemetry and persists only applied or fallback outcomes.

Assessment: accepted. The overlap made impossible durable transitions appear
valid and forced parallel state vocabularies to stay aligned.

Change: removed event-only states and labels from durable method projection.
Unknown extension state still projects as unsupported. A test records that a
telemetry-only outcome is not a durable state.

## Iteration 3 — lifecycle authority

Blackmagic commit reviewed: `e22ad26b`

Scope: `src/controller.ts` and `src/contract.ts`.

Report artifact:
`<LOCAL_HOME>/repos/million-eyes/artifacts/pi-openai-blackmagic-compact-e22ad26b-iter03-lifecycle-authority-luna-v1/`

Finding: native summary generation resolved authorization once, then the
handler discarded it and resolved authorization again for identity and remote
work.

Assessment: accepted in part. Returning `undefined` still lets Pi run its
default compaction, so the report overstated fallback loss. The duplicate
lookup was real and could make one attempt use two authorization or environment
snapshots.

Change: resolve authorization once and pass it through native summary,
identity, serialization, and remote submission. A lifecycle test proves one
lookup serves a successful attempt.

## Iteration 4 — adapter interface depth

Blackmagic commit reviewed: `cfdbdc53`

Scope: `src/adapters.ts`, `src/controller.ts`, and `src/index.ts`.

Report artifact:
`<LOCAL_HOME>/repos/million-eyes/artifacts/pi-openai-blackmagic-compact-cfdbdc53-iter04-adapter-interface-luna-v1/`

Finding: the root interface exposed protocol-specific compaction functions and
the Codex retention helper beside `compactProviderInput`. Those alternate routes
could bypass centralized identity and protocol matching.

Assessment: accepted. No compatibility requirement justifies exposing
implementation choices. The controller and tests already use the deeper
capability interface.

Change: made protocol adapters and retention logic module-private. The root now
exposes only `compactProviderInput` for provider compaction. A public-interface
test prevents the bypass exports from returning.

## Iteration 5 — persistence minimality

Blackmagic commit reviewed: `479551a9`

Scope: `src/controller.ts` and `src/contract.ts`.

Report artifact:
`<LOCAL_HOME>/repos/million-eyes/artifacts/pi-openai-blackmagic-compact-479551a9-iter05-persistence-minimality-luna-v1/`

Finding: current writes use one replay namespace, but validation and rewriting
also accepted an obsolete legacy namespace.

Assessment: accepted. Alpha has no compatibility requirement. The extra branch
did not support current output and expanded the persisted schema and test
surface.

Change: removed the legacy namespace and both compatibility checks. Current
namespace, identity, digest, active-branch, and exact-segment validation remain.

## Iteration 6 — interface and test surface

Blackmagic commit reviewed: `f4b0ce30`

Scope: `src/extension.ts`, `src/index.ts`, `src/controller.ts`, and review-mirror
copies of the adversarial, controller lifecycle, and RPC load tests.

Report artifact:
`<LOCAL_HOME>/repos/million-eyes/artifacts/pi-openai-blackmagic-compact-f4b0ce30-iter06-test-surface-luna-v1/`

Finding: the package exposed the controller and its collaborator-injection
options as public interfaces, although Pi users enter through the extension and
tests use those options only as an internal seam.

Assessment: accepted. The README promises no extension configuration. Keeping
test injection internal preserves test leverage without making it part of the
external interface.

Change: the package now exports only the default Pi extension. The extension
accepts only Pi's interface. Controller options remain available only to direct
internal tests. Deleted the pass-through root index module and blocked internal
contract, controller, and adapter imports through package exports. Package
verification enforces this single external route.

## Final result

The six runs scheduled 30 reviewers. Six evidence-bearing reviewers returned
one finding each. The 24 fixed empty scopes returned needs-context. Total use
was 118,761 tokens, USD $0.0321752, and 99.070 seconds of summed wall time.
Empty scopes used 22,245 tokens and USD $0.0080830.

The findings were not accepted blindly. Iteration 3 overstated fallback loss,
so only its verified duplicate-authorization problem was accepted. Each other
finding passed a deletion, current-behavior, and net-complexity check.

Relative to the reviewed baseline, production source is 12 lines smaller. The
package now has one external export instead of four. It has one current replay
namespace, two durable extension states, one authorization snapshot per
compaction attempt, and no throwing or protocol-specific public helpers.

Final verification has 26 passing tests. Package verification and dry-run
packing pass.

Iteration commits:

1. `4ab19f6` — remove unusable summary interface
2. `e22ad26` — separate durable and transient states
3. `cfdbdc5` — reuse compaction authorization snapshot
4. `479551a` — hide protocol adapter internals
5. `f4b0ce3` — remove legacy replay namespace
6. final iteration commit — expose only the Pi extension entry
