import { buildSessionContext, compact, convertToLlm } from "@earendil-works/pi-coding-agent";
import { calculateCost } from "@earendil-works/pi-ai";
import { azureOpenAIResponsesApi, openAICodexResponsesApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { Box, Text } from "@earendil-works/pi-tui";
import { compactProviderInput } from "./adapters.mjs";
import { loadConfig, parseModelSpec } from "./config.mjs";
import {
  COMPACTION_TIMELINE_ENTRY_TYPE,
  compactionTimelineData,
  compactionTimelineLabel,
  describeRemoteRoute,
  identifySurface,
  identityMatches,
  latestActiveCompaction,
  projectCompactionMethod,
  replaceOneHashSegment,
  safeTelemetry,
  sha256,
} from "./contract.mjs";

const DELEGATES = Object.freeze({
  "openai-responses": openAIResponsesApi().streamSimple,
  "openai-codex-responses": openAICodexResponsesApi().streamSimple,
  "azure-openai-responses": azureOpenAIResponsesApi().streamSimple,
});
const REPLAY_NAMESPACE = "pi-dual-compaction/1";
class SerializationProbeComplete extends Error {}

function extractPrepared(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.input)) return undefined;
  return { payload, instructions: payload.instructions, tools: payload.tools, input: payload.input, model: payload.model };
}

function azureDeployment(model, auth) {
  const mapping = auth?.env?.AZURE_OPENAI_DEPLOYMENT_NAME_MAP ?? process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
  for (const entry of String(mapping ?? "").split(",")) {
    const [id, deployment] = entry.split("=", 2).map((value) => value?.trim());
    if (id === model?.id && deployment) return deployment;
  }
  return model?.id;
}

function modelIdentity(ctx, auth) {
  const model = ctx?.model;
  const env = auth?.env ?? {};
  const baseUrl = model?.api === "azure-openai-responses"
    ? (env.AZURE_OPENAI_BASE_URL ?? (env.AZURE_OPENAI_RESOURCE_NAME
      ? `https://${env.AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com/openai/v1`
      : model?.baseUrl))
    : (env.OPENAI_BASE_URL ?? model?.baseUrl);
  return identifySurface({
    provider: model?.provider,
    baseUrl,
    api: model?.api,
    model: model?.id,
    deployment: model?.api === "azure-openai-responses" ? azureDeployment(model, auth) : undefined,
  });
}

function activeCheckpoint(branch) {
  const entry = latestActiveCompaction(branch);
  const details = entry?.details;
  const replay = details?.replay;
  const checkpoint = details?.checkpoint;
  if (
    details?.schemaVersion !== 1
    || details.state !== "remote_applied"
    || replay?.namespace !== REPLAY_NAMESPACE
    || !Array.isArray(replay.replacedItemHashes)
    || !replay.replacedItemHashes.length
    || replay.replacedItemHashes.some((hash) => !/^[0-9a-f]{64}$/.test(hash))
    || !Array.isArray(checkpoint?.artifact)
    || !checkpoint.artifact.length
  ) return undefined;
  const serialized = JSON.stringify(checkpoint.artifact);
  if (checkpoint.hash !== sha256(serialized) || checkpoint.length !== serialized.length) return undefined;
  return { entry, details };
}

function rewriteReplay(payload, checkpoint, identity) {
  const replay = checkpoint?.details?.replay;
  if (!payload || !identityMatches(checkpoint.details, identity) || replay?.namespace !== REPLAY_NAMESPACE) return undefined;
  const next = replaceOneHashSegment(payload.input, replay.replacedItemHashes, checkpoint.details.checkpoint?.artifact);
  return next ? { ...payload, input: next } : undefined;
}

function activeTools(pi) {
  if (typeof pi?.getActiveTools !== "function" || typeof pi?.getAllTools !== "function") {
    throw new Error("Pi tool access is unavailable");
  }
  const names = new Set(pi.getActiveTools());
  return pi.getAllTools()
    .filter((tool) => names.has(tool.name))
    .map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export async function captureNativeBody(model, context, options) {
  const delegate = DELEGATES[model?.api];
  if (!delegate) throw new Error("unsupported Responses serializer API");
  let settled = false;
  let resolveCapture;
  let rejectCapture;
  const capture = new Promise((resolve, reject) => {
    resolveCapture = resolve;
    rejectCapture = reject;
  });
  let stream;
  try {
    stream = delegate(model, context, {
      ...options,
      onPayload(payload) {
        if (!Array.isArray(payload?.input)) throw new Error("native Responses serializer produced no input array");
        settled = true;
        resolveCapture(structuredClone(payload));
        throw new SerializationProbeComplete("serialization probe complete");
      },
    });
  } catch (error) {
    rejectCapture(error);
    return capture;
  }
  void stream.result().then(
    (message) => { if (!settled) rejectCapture(new Error(message?.errorMessage ?? "native Responses serializer failed")); },
    rejectCapture,
  );
  return capture;
}

export function serializationOptions(ctx, auth, signal) {
  return {
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
    cacheRetention: "none",
    transport: "sse",
    reasoning: ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel,
    sessionId: ctx.sessionManager?.getSessionId?.(),
    signal,
  };
}

async function serializeBranch(pi, event, ctx, auth) {
  if (typeof ctx?.getSystemPrompt !== "function") throw new Error("Pi system prompt access is unavailable");
  const messages = convertToLlm(buildSessionContext(event.branchEntries ?? ctx.sessionManager?.getBranch?.() ?? []).messages);
  return captureNativeBody(
    ctx.model,
    { systemPrompt: ctx.getSystemPrompt(), messages, tools: activeTools(pi) },
    serializationOptions(ctx, auth, event.signal),
  );
}

async function serializePostCompaction(pi, event, ctx, auth, summary) {
  if (typeof ctx?.getSystemPrompt !== "function") throw new Error("Pi system prompt access is unavailable");
  const branch = event.branchEntries ?? ctx.sessionManager?.getBranch?.() ?? [];
  const syntheticCompaction = {
    type: "compaction",
    id: "pi-dual-compaction-pending",
    parentId: ctx.sessionManager?.getLeafId?.() ?? "",
    timestamp: Date.now(),
    summary,
    firstKeptEntryId: event.preparation.firstKeptEntryId,
    tokensBefore: event.preparation.tokensBefore,
  };
  const messages = convertToLlm(buildSessionContext([...branch, syntheticCompaction]).messages);
  return (await captureNativeBody(
    ctx.model,
    { systemPrompt: ctx.getSystemPrompt(), messages, tools: activeTools(pi) },
    serializationOptions(ctx, auth, event.signal),
  )).input;
}

function sameModel(left, right) {
  return left?.provider === right?.provider && left?.id === right?.id;
}

async function generatePortableSummary(event, ctx, currentAuth, config, compactImpl) {
  let summaryModel = ctx.model;
  const configured = parseModelSpec(config.portableSummaryModel);
  if (configured) {
    summaryModel = ctx.modelRegistry.find(configured.provider, configured.modelId);
    if (!summaryModel) throw new Error(`portable summary model not found: ${config.portableSummaryModel}`);
  }
  if (!summaryModel) throw new Error("current model is unavailable for portable summary generation");

  const auth = sameModel(summaryModel, ctx.model)
    ? currentAuth
    : await ctx.modelRegistry.getApiKeyAndHeaders(summaryModel);
  if (!auth?.ok) throw new Error(auth?.error ?? `authorization unavailable for ${summaryModel.provider}/${summaryModel.id}`);

  const result = await compactImpl(
    event.preparation,
    summaryModel,
    auth.apiKey,
    auth.headers,
    event.customInstructions,
    event.signal,
    config.portableSummaryThinkingLevel,
    undefined,
    auth.env,
  );
  if (!result?.summary?.trim()) throw new Error("portable summary model returned an empty summary");
  return { result, model: summaryModel };
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function remoteUsage(details, model) {
  const source = details?.usage;
  if (!source) return undefined;
  const usage = emptyUsage();
  usage.cacheRead = source.cached_tokens ?? 0;
  usage.cacheWrite = source.cache_write_tokens ?? 0;
  usage.input = Math.max(0, (source.input_tokens ?? 0) - usage.cacheRead - usage.cacheWrite);
  usage.output = source.output_tokens ?? 0;
  usage.reasoning = source.reasoning_tokens ?? 0;
  usage.totalTokens = source.total_tokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  calculateCost(model, usage);
  return usage;
}

function addUsage(left, right) {
  if (!left) return right;
  if (!right) return left;
  const result = emptyUsage();
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "cacheWrite1h", "totalTokens"]) {
    const value = (left[field] ?? 0) + (right[field] ?? 0);
    if (value || field in result) result[field] = value;
  }
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
    result.cost[field] = (left.cost?.[field] ?? 0) + (right.cost?.[field] ?? 0);
  }
  return result;
}

function mergeDetails(remoteDetails, portable, config) {
  const nativeDetails = portable.result.details;
  return {
    ...remoteDetails,
    readFiles: Array.isArray(nativeDetails?.readFiles) ? nativeDetails.readFiles : [],
    modifiedFiles: Array.isArray(nativeDetails?.modifiedFiles) ? nativeDetails.modifiedFiles : [],
    portableSummary: {
      provider: portable.model.provider,
      model: portable.model.id,
      thinkingLevel: config.portableSummaryThinkingLevel,
    },
  };
}

function isAborted(event, error) {
  return event.signal?.aborted || error?.name === "AbortError" || error?.name === "ABORT_ERR";
}

function linkedAbortController(parentSignal) {
  const controller = new AbortController();
  if (parentSignal?.aborted) controller.abort(parentSignal.reason);
  else parentSignal?.addEventListener("abort", () => controller.abort(parentSignal.reason), { once: true });
  return controller;
}

async function abortAndSettle(controller, promise) {
  controller.abort();
  try { await promise; } catch {}
}

export function createDualCompactionController(pi, options = {}) {
  if (!pi?.on || !pi?.registerCommand || !pi?.registerEntryRenderer || !pi?.appendEntry) {
    throw new TypeError("A complete Pi ExtensionAPI is required");
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const compactImpl = options.compactImpl ?? compact;
  const configLoader = options.configLoader ?? loadConfig;
  const telemetry = typeof options.telemetry === "function" ? options.telemetry : () => {};
  const emit = (type, data = {}) => {
    try { telemetry(safeTelemetry(type, data)); } catch {}
  };
  const methodFor = (ctx) => projectCompactionMethod(ctx?.sessionManager?.getBranch?.());
  const routeFor = (ctx) => describeRemoteRoute(modelIdentity(ctx));
  const appendedCompactions = new Set();

  pi.registerEntryRenderer(COMPACTION_TIMELINE_ENTRY_TYPE, (entry, _options, theme) => {
    const label = compactionTimelineLabel(entry.data);
    if (!label) return undefined;
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("accent", label), 0, 0));
    return box;
  });

  pi.on("session_start", (_event, ctx) => {
    const { warnings } = configLoader();
    if (warnings.length && ctx?.hasUI) ctx.ui.notify(`pi-dual-compaction: ${warnings[0]}`, "warning");
  });

  pi.on("session_compact", (event) => {
    const data = event?.fromExtension && compactionTimelineData(event.compactionEntry);
    const id = event?.compactionEntry?.id;
    if (!data || !id || appendedCompactions.has(id)) return;
    appendedCompactions.add(id);
    pi.appendEntry(COMPACTION_TIMELINE_ENTRY_TYPE, data);
  });

  pi.on("before_provider_request", async (event, ctx) => {
    const { config } = configLoader();
    if (!config.enabled) return undefined;
    const auth = ctx?.model && typeof ctx?.modelRegistry?.getApiKeyAndHeaders === "function"
      ? await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)
      : undefined;
    const identity = modelIdentity(ctx, auth);
    if (identity.kind !== "supported") {
      emit("unsupported_surface", { identity });
      return undefined;
    }
    const checkpoint = activeCheckpoint(ctx?.sessionManager?.getBranch?.());
    const replayed = checkpoint && rewriteReplay(event.payload, checkpoint, identity);
    if (replayed) emit("remote_replayed", { identity, checkpoint: checkpoint.details.checkpoint });
    else if (checkpoint?.details?.schemaVersion === 1) {
      emit("remote_invalidated", {
        identity,
        failureClass: identityMatches(checkpoint.details, identity) ? "replay_segment_mismatch" : "identity_mismatch",
      });
    }
    return replayed;
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const { config } = configLoader();
    if (!config.enabled) return undefined;
    if (event.signal?.aborted) return { cancel: true };
    const canResolveAuth = ctx?.model && typeof ctx?.modelRegistry?.getApiKeyAndHeaders === "function";
    if (!canResolveAuth) return undefined;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    const identity = modelIdentity(ctx, auth);
    if (!auth?.ok || !auth.apiKey || identity.kind !== "supported") return undefined;

    let compactBody;
    try {
      compactBody = extractPrepared(await serializeBranch(pi, event, ctx, auth));
    } catch {
      return undefined;
    }
    if (!compactBody) return undefined;

    const checkpoint = activeCheckpoint(event.branchEntries ?? ctx.sessionManager?.getBranch?.());
    if (checkpoint) {
      const replayed = rewriteReplay(compactBody.payload, checkpoint, identity);
      if (!replayed) return undefined;
      compactBody = extractPrepared(replayed);
    }

    const remoteController = linkedAbortController(event.signal);
    const portablePromise = generatePortableSummary(event, ctx, auth, config, compactImpl);
    const remotePromise = compactProviderInput({
      identity,
      prepared: compactBody,
      auth,
      fetchImpl,
      signal: remoteController.signal,
    });

    let portable;
    try {
      portable = await portablePromise;
    } catch (error) {
      await abortAndSettle(remoteController, remotePromise);
      if (isAborted(event, error)) return { cancel: true };
      if (ctx?.hasUI) ctx.ui.notify(`pi-dual-compaction: ${error.message}; using Pi default compaction`, "warning");
      return undefined;
    }

    let postSegment;
    try {
      postSegment = await serializePostCompaction(pi, event, ctx, auth, portable.result.summary);
    } catch (error) {
      await abortAndSettle(remoteController, remotePromise);
      if (isAborted(event, error)) return { cancel: true };
      return { compaction: portable.result };
    }

    const remote = await remotePromise;
    if (!remote.details) {
      if (event.signal?.aborted) return { cancel: true };
      emit("local_fallback", { identity, failureClass: remote.failureClass });
      return { compaction: portable.result };
    }

    const details = mergeDetails(remote.details, portable, config);
    details.lineage = {
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      leafId: ctx.sessionManager?.getLeafId?.(),
    };
    details.replay = {
      namespace: REPLAY_NAMESPACE,
      replacedItemHashes: postSegment.map((item) => sha256(item)),
    };
    emit("remote_applied", { identity, ...details, checkpoint: details.checkpoint });
    return {
      compaction: {
        ...portable.result,
        summary: portable.result.summary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        usage: addUsage(portable.result.usage, remoteUsage(remote.details, ctx.model)),
        details,
      },
    };
  });

  pi.registerCommand("dual-compact", {
    description: "Show dual-compaction status or help; it never changes Pi thresholds.",
    getArgumentCompletions(prefix) {
      const items = ["status", "help"]
        .filter((value) => value.startsWith(prefix.trim()))
        .map((value) => ({ value, label: value, description: value === "status" ? "Current dual-compaction status" : "Command usage" }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      const { config, source, warnings } = configLoader();
      const method = methodFor(ctx);
      const route = routeFor(ctx);
      const portableModel = config.portableSummaryModel ?? "current model";
      const text = action === "help"
        ? "Usage: /dual-compact [status|help]. It does not change Pi compaction thresholds."
        : action === "status"
          ? [
            `Enabled: ${config.enabled ? "yes" : "no"}`,
            `Active branch: ${method}`,
            `Next /compact: ${route && config.enabled ? "provider checkpoint + portable Pi summary" : "Pi native compaction"}`,
            ...(route && config.enabled ? [`Route/protocol: ${route}`] : []),
            `Portable summary model: ${portableModel} (${config.portableSummaryThinkingLevel})`,
            `Config: ${source ?? "defaults"}`,
            ...(warnings.length ? [`Warning: ${warnings[0]}`] : []),
          ].join("\n")
          : "Usage: /dual-compact [status|help]";
      if (ctx?.hasUI && typeof ctx.ui?.notify === "function") {
        ctx.ui.notify(text, action === "status" || action === "help" ? "info" : "warning");
      }
    },
  });
}
