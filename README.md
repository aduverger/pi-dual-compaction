# @aduverger/pi-dual-compaction

Provider-native OpenAI compaction without sacrificing portable Pi context.

The extension stores two representations at every supported OpenAI compaction boundary:

1. an opaque provider checkpoint for efficient continuation with the same OpenAI model; and
2. a normal Pi textual summary that remains usable after switching to Anthropic, Gemini, another OpenAI model, or another provider.

Unsupported models always use Pi's built-in compaction behavior.

## Why

OpenAI's native compaction artifacts are opaque and provider-specific. They are useful when continuing with the same model, but another provider cannot consume them. Storing only the opaque artifact can therefore discard useful context when a session changes providers.

This extension first generates Pi's normal portable summary, then obtains the provider checkpoint. OpenAI replay replaces the textual-summary segment with the matching opaque checkpoint. Other providers receive the textual summary unchanged.

## Requirements

- Pi `0.83.0`
- Node.js 20 or newer
- One of these official Pi model surfaces for dual compaction:
  - OpenAI Responses
  - Azure OpenAI Responses
  - ChatGPT Codex Responses

OpenAI-compatible proxies and other API families intentionally fall back to Pi's built-in compaction.

## Install

From a checkout:

```sh
git clone https://github.com/aduverger/pi-dual-compaction.git
pi install ./pi-dual-compaction
```

Once published to npm:

```sh
pi install npm:@aduverger/pi-dual-compaction@0.1.0
```

For a one-off test:

```sh
pi -e /absolute/path/to/pi-dual-compaction/src/extension.mjs
```

Use `/compact` normally. The extension does not replace Pi's thresholds or auto-compaction settings.

Check the active behavior with:

```text
/dual-compact status
```

## Behavior

```text
session_before_compact
│
├─ disabled or unsupported model
│  └─ return control to Pi's built-in compaction
│
└─ supported official OpenAI surface
   ├─ serialize the current branch with Pi's canonical serializer
   ├─ generate a portable summary with Pi's exported compact()
   ├─ verify the post-compaction replay segment
   ├─ request the provider-native checkpoint
   │  ├─ success: persist portable summary + opaque checkpoint
   │  └─ failure: persist the already-generated portable Pi result
   └─ portable-summary failure: return control to Pi's built-in compaction
```

On later requests:

| Active model | Context representation |
|---|---|
| Same supported OpenAI model and endpoint | Opaque provider checkpoint + live tail |
| Different model, endpoint, or provider | Portable Pi summary + live tail |
| Switch back before another compaction | Matching OpenAI checkpoint + cross-provider live tail |
| A later non-native compaction occurred | Latest portable Pi summary; older checkpoint is not replayed |

Checkpoint replay requires an exact model, endpoint, API, branch, and serialized-segment match. If validation fails, the extension leaves Pi's textual-summary payload untouched.

## Configuration

Configuration is optional. Defaults are safe for provider switching:

```text
~/.pi/agent/extensions/pi-dual-compaction/config.json
```

```json
{
  "enabled": true,
  "portableSummaryModel": null,
  "portableSummaryThinkingLevel": "off"
}
```

| Setting | Default | Description |
|---|---|---|
| `enabled` | `true` | Disable to restore unmodified Pi behavior, including replay. |
| `portableSummaryModel` | `null` | Optional `provider/model-id`. `null` uses the active model. Model IDs may contain `/`. |
| `portableSummaryThinkingLevel` | `"off"` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |

A smaller dedicated model can reduce the extra latency and cost:

```json
{
  "portableSummaryModel": "openai/gpt-5-mini",
  "portableSummaryThinkingLevel": "off"
}
```

The configured model must be available in Pi and have valid authentication.

## Cost and usage

Dual compaction performs two model operations on supported OpenAI surfaces:

1. Pi textual summarization; and
2. OpenAI provider compaction.

The saved compaction usage combines both operations when the provider reports usage. Provider checkpoint metadata also retains the provider's redacted usage counters. Costs are estimated from Pi's current model pricing.

Unsupported providers perform only Pi's normal compaction call.

## Failure and cancellation semantics

- If portable summary generation fails before provider compaction, the hook returns no result and Pi runs its default compaction.
- If provider compaction fails after a portable summary was generated, that portable result is saved instead of paying for the same summary twice.
- User cancellation cancels the compaction.
- Invalid or mismatched checkpoints are never guessed or replayed.
- Disabling the extension stops both new dual compactions and replay of existing checkpoints; the stored textual summary remains usable.

## Persistence and security

The opaque provider artifact is stored in `CompactionEntry.details`. Session files should therefore be treated as sensitive conversation history. Timeline cards contain only an allowlisted method label and never enter LLM context.

The extension preserves Pi's cumulative `readFiles` and `modifiedFiles` metadata from the portable compaction result.

## Development

```sh
make check
npm run pack:check
```

The test suite covers OpenAI, Azure, and Codex request contracts; dual persistence; cross-provider context; repeated compaction; replay invalidation; cancellation/failure boundaries; dedicated summary models; session reopen/fork behavior; redaction; packaging; and Pi RPC loading.

## Lineage

The provider checkpoint adapters, strict surface allowlisting, canonical Pi serialization probe, and replay validation were derived from [`deephbz/pi-openai-blackmagic-compact`](https://github.com/deephbz/pi-openai-blackmagic-compact), used under the MIT License. See [NOTICE.md](NOTICE.md).
