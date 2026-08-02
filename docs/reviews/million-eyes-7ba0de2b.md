# Million Eyes evaluation — Blackmagic `7ba0de2b`

Date: 2026-08-02

Stage: Blackmagic hardening; Million Eyes exploration

## Question

Can Million Eyes facilitate a useful architecture review of Blackmagic, and can
its findings lead to clearer, more coherent code?

The review must supply the findings. Direct source inspection is limited to
high-level context, finding verification, and implementation.

## Runs

Million Eyes extractor/1 accepts `.ts` code but not Blackmagic's `.mjs` code.
The first direct run therefore presented zero code lines:

`<LOCAL_HOME>/repos/million-eyes/artifacts/pi-openai-blackmagic-compact-7ba0de2b-openai-codex-gpt-5.6-luna-v1/report.html`

That run scheduled 12 reviews. It returned one low-severity terminology finding
and 11 needs-context results. It cost USD $0.0053104. The terminology finding
was not used because the run lacked all code and the current contract document.

Two later runs used clean review mirrors. Each `src/NAME.mjs` file was copied
byte-for-byte to `src/NAME.ts`. The frozen `AGENTS.md` records the source commit,
working-tree state, path mapping, and mirror limitation.

The four-lens architecture run is:

`<LOCAL_HOME>/repos/million-eyes/artifacts/pi-openai-blackmagic-compact-7ba0de2b-ts-review-mirror-luna-v1/report.html`

It presented 351 of 352 token-bearing code lines. It returned four findings and
16 needs-context results. It cost USD $0.0242444 and took 31.440 seconds.

The deep-module run used a lens derived from Matt Pocock's
`improve-codebase-architecture` and `codebase-design` skills:

`<LOCAL_HOME>/repos/million-eyes/artifacts/pi-openai-blackmagic-compact-7ba0de2b-deep-module-lens-luna-v1/report.html`

It presented 352 of 353 token-bearing code lines. It returned one finding and
four needs-context results. It cost USD $0.0064468 and took 16.612 seconds.

## Finding assessment

The four-lens run produced two accepted findings.

First, approved hosts and paths did not require HTTPS. Blackmagic now rejects
non-HTTPS endpoints before it sends credentials or conversation history.
Tests cover OpenAI, Azure, and Codex HTTP variants.

Second, the remote request occurred before Blackmagic verified the synthetic
post-compaction continuation. Blackmagic now completes that preflight first.
A lifecycle test proves that preflight failure sends no remote request.

The replay-invalidation finding was rejected as a defect. Pi keeps the original
provider payload when `before_provider_request` returns `undefined`. That
payload contains Pi's readable local summary. A new regression test records
this host invariant.

The broad protocol-dispatch finding was directionally useful but too general.
The later deep-module lens sharpened it into one deepening opportunity: the
controller selected `compactCodex` or `compactResponses`, even though the
adapter module already owned route, authorization, body, parsing, validation,
and retention differences.

Blackmagic now uses one `compactProviderInput` interface at that seam. An
internal capability map selects the matching Responses or Codex adapter and
checks the identity protocol. The controller no longer knows which protocol
adapter to call. The provider loopback tests now cross the same interface as
the controller. A mismatch test proves that no request occurs when an identity
has no matching adapter.

This change improves depth, leverage, and locality. Provider-specific knowledge
stays in the adapter module. The controller keeps the lifecycle and fallback
policy. Two protocol adapters make the seam real rather than hypothetical.

## Million Eyes usage assessment

The CLI's happy path is short: build, smoke-test, extract, then review. Fresh
output paths and clean Git state make the run safe and reproducible. The CLI
summary, NDJSON findings, coverage projection, telemetry, and retained prompts
were sufficient for agent use. The HTML report was not needed for this
assessment.

The main friction is input compatibility. Million Eyes could not directly
review this JavaScript-module repository. The review mirror added manual work
and changed the commit identity, so every accepted finding needed an explicit
mapping back to Blackmagic.

Planning also wastes work. Each module lens ran against five fixed module
scopes, even when four had no selected evidence. The four-lens run spent 13,931
tokens and USD $0.0053522 on 16 empty-evidence reviews. The deep-module run also
scheduled four empty reviews. Million Eyes reports this honestly, but it should
skip those dispatches.

The fixed, one-round evidence model helped and hurt. Reviewers usually returned
needs-context instead of inventing findings. One reviewer still inferred an
incorrect impact because tests and Pi lifecycle documentation were outside its
evidence. The uncertainty and limitation fields made that error easy to reject.

## Conclusion

Million Eyes provided useful review facilitation after adaptation. It found a
real deepening opportunity and two concrete safety or lifecycle improvements.
Its trace data made the findings investigable.

It is not yet a direct or comprehensive Blackmagic review tool. Add `.mjs`
admission, configurable module discovery, test and current-document evidence,
and no-evidence plan pruning before treating it as routine infrastructure.

## Verification

`npm test` passes all 25 tests.

`npm run verify:package` passes.

`npm run pack:check` passes.
