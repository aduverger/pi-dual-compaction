import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { captureNativeBody, createDualCompactionController, serializationOptions } from "../src/controller.mjs";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { provider: "openai", id: "gpt-5", name: "gpt-5", baseUrl: "https://api.openai.com/v1", api: "openai-responses", input: ["text"], reasoning: true, thinkingLevelMap: { high: "high" }, contextWindow: 128000, maxTokens: 8192, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } };
const auth = { ok: true, apiKey: "synthetic-key", headers: { "x-test": "yes" } };
const tool = { name: "probe", description: "Probe the current branch", parameters: { type: "object", properties: {} } };

function fakePi() {
  const handlers = new Map();
  const renderers = new Map();
  const appended = [];
  let command;
  return {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (_name, value) => { command = value; },
    registerEntryRenderer: (type, renderer) => renderers.set(type, renderer),
    appendEntry: (type, data) => appended.push({ type, data }),
    getActiveTools: () => ["probe"],
    getAllTools: () => [tool],
    handlers,
    renderers,
    appended,
    get command() { return command; },
  };
}

function assistantToolCall() {
  return { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "probe", arguments: {} }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "toolUse", timestamp: 6 };
}

function preparation(firstKeptEntryId) {
  return { firstKeptEntryId, messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 12, fileOps: { read: new Set(), edited: new Set() }, settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } };
}

function portableResult(input, summary = "portable summary") {
  return { summary, firstKeptEntryId: input.firstKeptEntryId, tokensBefore: input.tokensBefore, estimatedTokensAfter: 7, usage, details: { readFiles: ["read.ts"], modifiedFiles: ["edited.ts"] } };
}

async function compactCurrentBranch(entries, contextOverrides = {}, controllerOverrides = {}) {
  const session = SessionManager.inMemory("/tmp");
  let first;
  for (const message of entries) {
    const id = session.appendMessage(message);
    first ??= id;
  }
  const pi = fakePi();
  let request;
  createDualCompactionController(pi, {
    compactImpl: async (input) => portableResult(input),
    configLoader: () => ({ config: { enabled: true, portableSummaryModel: undefined, portableSummaryThinkingLevel: "off" }, warnings: [], source: undefined }),
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ output: [{ type: "compaction", encrypted_content: "opaque" }], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } }) };
    },
    ...controllerOverrides,
  });
  const ctx = {
    model,
    modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => auth },
    sessionManager: session,
    getSystemPrompt: () => "direct system prompt",
    thinkingLevel: "high",
    ...contextOverrides,
  };
  const branchEntries = session.getBranch();
  const result = await pi.handlers.get("session_before_compact")({ preparation: preparation(first), branchEntries, reason: "manual", signal: new AbortController().signal }, ctx);
  return { result, request, pi, ctx, session };
}

test("direct compaction persists a portable summary beside the provider checkpoint", async () => {
  const entries = [
    { role: "user", content: [{ type: "text", text: "ordinary user" }], timestamp: 1 },
    { role: "custom", customType: "handoff", content: "custom handoff", display: false, timestamp: 2 },
    { role: "branchSummary", summary: "branch summary", fromId: "branch", timestamp: 3 },
    { role: "compactionSummary", summary: "old summary", tokensBefore: 10, timestamp: 4 },
    { role: "bashExecution", command: "pwd", output: "/tmp", exitCode: 0, cancelled: false, truncated: false, timestamp: 5 },
    { role: "bashExecution", command: "secret", output: "hidden", exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 5 },
    assistantToolCall(),
    { role: "toolResult", toolCallId: "call-1", toolName: "probe", content: [{ type: "text", text: "tool result" }], isError: false, timestamp: 7 },
  ];
  const { result, request, session } = await compactCurrentBranch(entries);
  assert.equal(result.compaction.details.state, "remote_applied", JSON.stringify(result));
  assert.equal(result.compaction.summary, "portable summary");
  assert.deepEqual(result.compaction.details.readFiles, ["read.ts"]);
  assert.deepEqual(result.compaction.details.modifiedFiles, ["edited.ts"]);
  assert.deepEqual(result.compaction.details.portableSummary, { provider: "openai", model: "gpt-5", thinkingLevel: "off" });
  assert.equal(result.compaction.usage.totalTokens, 6, "portable and remote usage must be combined");
  session.appendCompaction(result.compaction.summary, result.compaction.firstKeptEntryId, result.compaction.tokensBefore, result.compaction.details, true);
  assert.equal(session.getBranch().at(-1).summary, "portable summary");
  const serialized = JSON.stringify(request);
  assert.match(serialized, /direct system prompt/);
  assert.match(serialized, /custom handoff/);
  assert.match(serialized, /branch summary/);
  assert.match(serialized, /old summary/);
  assert.match(serialized, /Ran `pwd`/);
  assert.match(serialized, /tool result/);
  assert.match(serialized, /probe/);
  assert.doesNotMatch(serialized, /hidden/);
});

test("one authorization snapshot serves both current-model compaction paths", async () => {
  let lookups = 0;
  const { result } = await compactCurrentBranch(
    [{ role: "user", content: [{ type: "text", text: "ordinary user" }], timestamp: 1 }],
    { modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => { lookups += 1; return auth; } } },
  );
  assert.equal(result.compaction.details.state, "remote_applied");
  assert.equal(lookups, 1);
});

test("repeated compaction applies the latest provider checkpoint", async () => {
  const first = await compactCurrentBranch([{ role: "user", content: [{ type: "text", text: "old branch" }], timestamp: 1 }]);
  first.session.appendCompaction(first.result.compaction.summary, first.result.compaction.firstKeptEntryId, first.result.compaction.tokensBefore, first.result.compaction.details, true);
  first.session.appendMessage({ role: "user", content: [{ type: "text", text: "later branch" }], timestamp: 2 });
  const pi = fakePi();
  let request;
  createDualCompactionController(pi, {
    compactImpl: async (input) => portableResult(input, "updated portable summary"),
    configLoader: () => ({ config: { enabled: true, portableSummaryModel: undefined, portableSummaryThinkingLevel: "off" }, warnings: [] }),
    fetchImpl: async (_url, options) => { request = JSON.parse(options.body); return { ok: true, status: 200, json: async () => ({ output: [{ type: "compaction", encrypted_content: "opaque-2" }] }) }; },
  });
  const branchEntries = first.session.getBranch();
  const result = await pi.handlers.get("session_before_compact")({ preparation: preparation(branchEntries[0].id), branchEntries, signal: new AbortController().signal }, first.ctx);
  assert.equal(result.compaction.summary, "updated portable summary");
  assert.match(JSON.stringify(request), /opaque/);
  assert.doesNotMatch(JSON.stringify(request), /old branch/);
});

test("failed continuation serialization keeps the already-generated portable compaction", async () => {
  let serializationCount = 0;
  const { result, request } = await compactCurrentBranch(
    [{ role: "user", content: [{ type: "text", text: "ordinary user" }], timestamp: 1 }],
    { getSystemPrompt: () => { serializationCount += 1; if (serializationCount === 2) throw new Error("synthetic post-compaction serialization failed"); return "direct system prompt"; } },
  );
  assert.equal(result.compaction.summary, "portable summary");
  assert.equal(result.compaction.details.state, undefined);
  assert.equal(request, undefined, "remote compaction must not run without a validated replay segment");
});

test("remote failure keeps the portable native result", async () => {
  const { result } = await compactCurrentBranch(
    [{ role: "user", content: [{ type: "text", text: "ordinary user" }], timestamp: 1 }],
    {},
    { fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) },
  );
  assert.equal(result.compaction.summary, "portable summary");
  assert.equal(result.compaction.details.state, undefined);
});

test("portable summary failure defers to Pi without sending a remote request", async () => {
  let fetchCalls = 0;
  const { result } = await compactCurrentBranch(
    [{ role: "user", content: [{ type: "text", text: "ordinary user" }], timestamp: 1 }],
    {},
    { compactImpl: async () => { throw new Error("summary unavailable"); }, fetchImpl: async () => { fetchCalls += 1; } },
  );
  assert.equal(result, undefined);
  assert.equal(fetchCalls, 0);
});

test("a configured portable model resolves its own authorization", async () => {
  const smallModel = { ...model, provider: "openai", id: "gpt-5-mini" };
  const lookups = [];
  let compactModel;
  const { result } = await compactCurrentBranch(
    [{ role: "user", content: [{ type: "text", text: "ordinary user" }], timestamp: 1 }],
    { modelRegistry: { find: (provider, id) => provider === "openai" && id === "gpt-5-mini" ? smallModel : undefined, getApiKeyAndHeaders: async (selected) => { lookups.push(selected.id); return auth; } } },
    {
      configLoader: () => ({ config: { enabled: true, portableSummaryModel: "openai/gpt-5-mini", portableSummaryThinkingLevel: "off" }, warnings: [] }),
      compactImpl: async (input, selected) => { compactModel = selected; return portableResult(input); },
    },
  );
  assert.equal(compactModel.id, "gpt-5-mini");
  assert.deepEqual(lookups, ["gpt-5", "gpt-5-mini"]);
  assert.equal(result.compaction.details.portableSummary.model, "gpt-5-mini");
});

test("portable summary remains in Pi context when switching providers", async () => {
  const compacted = await compactCurrentBranch([{ role: "user", content: [{ type: "text", text: "old provider context" }], timestamp: 1 }]);
  compacted.session.appendCompaction(compacted.result.compaction.summary, compacted.result.compaction.firstKeptEntryId, compacted.result.compaction.tokensBefore, compacted.result.compaction.details, true);
  const context = compacted.session.buildSessionContext().messages;
  assert.match(JSON.stringify(context), /portable summary/);
  const anthropicPayload = { model: "claude", messages: [{ role: "user", content: "portable summary" }] };
  const rewritten = await compacted.pi.handlers.get("before_provider_request")(
    { payload: anthropicPayload },
    { ...compacted.ctx, model: { provider: "anthropic", id: "claude", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" } },
  );
  assert.equal(rewritten, undefined);
  assert.match(JSON.stringify(anthropicPayload), /portable summary/);
});

test("native serialization probe carries reasoning and session identity without network", async () => {
  let networkCalled = false;
  const options = serializationOptions({ thinkingLevel: "high", sessionManager: { getSessionId: () => "session-1" } }, auth, new AbortController().signal);
  const body = await captureNativeBody(model, { systemPrompt: "probe system", messages: [], tools: [tool] }, { ...options, fetch() { networkCalled = true; throw new Error("network must not run"); } });
  assert.equal(options.reasoning, "high");
  assert.equal(options.sessionId, "session-1");
  assert.equal(body.reasoning?.effort, "high");
  assert.match(JSON.stringify(body), /probe system/);
  assert.match(JSON.stringify(body.tools), /probe/);
  assert.equal(networkCalled, false);
  assert.equal(serializationOptions({ thinkingLevel: "off", sessionManager: { getSessionId: () => "session-1" } }, auth).reasoning, undefined);
});

test("timeline entries append once after recognized dual compaction only", async () => {
  const { pi } = await compactCurrentBranch([]);
  const compactHandler = pi.handlers.get("session_compact");
  const entry = { id: "compact-1", type: "compaction", details: { schemaVersion: 1, state: "remote_applied", identity: { surface: "openai_api", protocol: "responses_compact_v1", endpoint: "https://secret.example/v1", model: "secret-model" }, checkpoint: { artifact: ["secret"], hash: "secret", length: 6 } } };
  compactHandler({ compactionEntry: entry, fromExtension: true });
  compactHandler({ compactionEntry: entry, fromExtension: true });
  compactHandler({ compactionEntry: { ...entry, id: "compact-2" }, fromExtension: false });
  assert.deepEqual(pi.appended, [{ type: "pi-dual-compaction/compaction-timeline/1", data: { method: "remote_responses_v1" } }]);
  const renderer = pi.renderers.get("pi-dual-compaction/compaction-timeline/1");
  assert.ok(renderer({ data: pi.appended[0].data }, {}, { bg: (_key, text) => text, fg: (_key, text) => text }));
  assert.equal(renderer({ data: { method: "secret-model" } }, {}, { bg: (_key, text) => text, fg: (_key, text) => text }), undefined);
});

test("an already-aborted compaction cancels before doing work", async () => {
  const pi = fakePi();
  let compactCalls = 0;
  createDualCompactionController(pi, {
    compactImpl: async () => { compactCalls += 1; },
    configLoader: () => ({ config: { enabled: true, portableSummaryModel: undefined, portableSummaryThinkingLevel: "off" }, warnings: [] }),
  });
  const controller = new AbortController();
  controller.abort();
  const result = await pi.handlers.get("session_before_compact")(
    { preparation: preparation("x"), branchEntries: [], signal: controller.signal },
    { model, modelRegistry: { getApiKeyAndHeaders: async () => auth } },
  );
  assert.deepEqual(result, { cancel: true });
  assert.equal(compactCalls, 0);
});

test("disabled configuration leaves compaction and replay untouched", async () => {
  const pi = fakePi();
  createDualCompactionController(pi, {
    configLoader: () => ({ config: { enabled: false, portableSummaryModel: undefined, portableSummaryThinkingLevel: "off" }, warnings: [] }),
  });
  const ctx = { model, modelRegistry: { getApiKeyAndHeaders: async () => auth }, sessionManager: { getBranch: () => [] } };
  assert.equal(await pi.handlers.get("session_before_compact")({ preparation: preparation("x"), branchEntries: [], signal: new AbortController().signal }, ctx), undefined);
  assert.equal(await pi.handlers.get("before_provider_request")({ payload: { input: [] } }, ctx), undefined);
});

test("unsupported models defer entirely to Pi", async () => {
  const entry = { role: "user", content: [{ type: "text", text: "one" }], timestamp: 1 };
  const { result, pi, ctx } = await compactCurrentBranch([entry]);
  assert.equal(result.compaction.details.state, "remote_applied");
  assert.equal(pi.handlers.has("message_end"), false);
  const unsupported = await pi.handlers.get("session_before_compact")(
    { preparation: preparation("x"), branchEntries: [], signal: new AbortController().signal },
    { ...ctx, model: { ...model, baseUrl: "https://proxy.invalid/v1" } },
  );
  assert.equal(unsupported, undefined);
});
