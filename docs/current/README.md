# Pi OpenAI Blackmagic Compact — current state

As of: 2026-08-02

Candidate: 0.1.0-rc.5

Stage: alpha hardening of the narrow direct-compaction contract.

Compatibility: no backward-compatibility guarantee applies before the first stable release.

## Purpose and boundary

This hook-only package compacts the authoritative current Pi branch on official OpenAI Responses, official Azure OpenAI Responses, and ChatGPT Codex Responses. It preserves Pi's readable local summary and adds an opaque provider checkpoint only after the provider accepts compaction.

The package has no extension configuration. It does not register or wrap providers, observe normal provider requests, own thresholds, or create handoffs. Payload-only request rewrites are outside the compaction source because they are not persisted Pi Session history.

## Contract

At `session_before_compact`, Pi first creates its normal readable summary. The package derives AgentMessages from `buildSessionContext(event.branchEntries)`, converts them through Pi `convertToLlm()`, filters the current Pi tool definitions by active tool names, and uses the unmodified Pi-AI Responses `streamSimple` delegate with a deliberately terminated `onPayload` probe. This captures one native semantic request body without a network request.

The probe receives the current system prompt, thinking level, session ID, authorization, and stable serializer options. The package identifies the exact approved surface, applies a matching active checkpoint replay to the derived body when present, and calls the matching compact protocol. Failure to serialize, authenticate, match replay, compact, or serialize the post-compaction segment returns Pi's readable local fallback.

Normal `before_provider_request` only replays an active persisted checkpoint or records its invalidation. It does not affect compaction readiness. `/server-compact status` sends a transient notice from the active branch and current model route. It does not set persistent footer state.

## Persistence and replay

Replay requires an active-branch checkpoint, exact provider identity, a supported namespace, and exactly one matching contiguous hashed provider-input segment. The opaque provider artifact stays in typed `CompactionEntry.details`; the readable summary stays in Pi's normal compaction record. After a recognized extension compaction, one namespaced custom timeline entry stores only an allowlisted method label. Pi custom entries do not enter LLM context. Forks before a checkpoint cannot replay it.

## Public source lineage

rc.5 uses a sanitized current source lineage. Product behavior derives from reviewed cutoff `9b77aca` and its tree `382232f`; the public root differs only by public-neutral substitutions in two non-runtime review documents. The deterministic transform and its minimal source-lineage receipt are recorded in [release/privacy-lineage.v1.json](../../release/privacy-lineage.v1.json).

Old tag graphs remain public and are not privacy-clean. Old releases remain immutable. `v0.1.0-rc.4` was an unpublished failed attempt.

## Evidence

- All 26 rc.5 tests pass.
- Unit and lifecycle tests cover all three protocol adapters and direct current-branch serialization.
- The serialization corpus includes custom messages, branch and compaction summaries, included and excluded bash messages, assistant tool calls, and tool results.
- Tests cover checkpoint replay, restart and fork boundaries, redacted telemetry, package contents, and RPC loading from another directory.
- Official OpenAI and Azure authenticated canaries remain live-unverified. Pi native compaction remains the safe readable fallback.
