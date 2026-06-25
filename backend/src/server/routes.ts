import { Router, type RouteHandler } from "./router.js";
import { jsonResponse, ERRORS, readJsonBody } from "./responses.js";
import { isAuthorized } from "./auth.js";
import { buildEventStreamResponse } from "./sse.js";
import type { Runtime } from "./runtime.js";
import {
  CreateThreadRequest,
  UpdateThreadRequest,
  SetThreadTodosRequest,
  SetThreadGoalRequest,
  ForkThreadRequest,
  ThreadSchema,
} from "../contracts/threads.js";
import { StartTurnRequest, SteerTurnRequest, InterruptTurnRequest, CompactRequest, TurnSchema } from "../contracts/turns.js";
import { z } from "zod";
import {
  NexusConfigSchema,
  redactConfig,
  MASKED_SECRET,
  toRuntimeCapabilitiesConfig,
  defaultEndpointFormat,
  type NexusConfig,
} from "../config/config.js";
import { RuntimeInfoResponse } from "../contracts/runtime-info.js";
import { redactSecrets } from "../config/secret-redaction.js";
import { MemoryCreateRequest, MemoryUpdateRequest } from "../contracts/memory.js";
import { ScheduleCreateRequest, ScheduleUpdateRequest } from "../contracts/schedule.js";
import { AgentCreateRequest, AgentUpdateRequest } from "../contracts/agents.js";
import {
  ConnectorProfileCreateRequest,
  ConnectorProfileUpdateRequest,
  ProjectSpaceCreateRequest,
  ProjectSpaceUpdateRequest,
  ExternalLinkCreateRequest,
  BindProfileRequest,
  ActivityEventCreateRequest,
  ActivityEventUpdateRequest,
  ConnectorVendorSchema,
  BindableVendorSchema,
  EventStatusFilterSchema,
} from "../contracts/connectors.js";
import {
  ImProviderCreateRequest,
  ImProviderUpdateRequest,
  ImChannelCreateRequest,
  ImChannelUpdateRequest,
  ThreadChannelBindRequest,
  RefreshMembersRequest,
  ProviderKindSchema,
  PROVIDER_KIND_SPECS,
} from "../contracts/phone.js";
import { AttachmentUploadRequestSchema } from "../contracts/attachments.js";
import { TranscribeAudioRequest } from "../contracts/audio.js";
import { SpeechToTextError } from "../adapters/model/stt-client.js";
import { ImageGenerationError } from "../adapters/tool/media-gen-tool-provider.js";
import { ApprovalDecisionRequest } from "../contracts/approvals.js";
import { StartReviewRequest, reviewTargetTitle, reviewTargetPrompt } from "../contracts/review.js";
import type { ReviewTarget as CanonicalReviewTarget } from "../contracts/review.js";
import { buildRuntimeCapabilityManifest } from "../contracts/capabilities.js";
import { isReviewWorkspaceNotGitError, resolveReviewTargetPrompt } from "../review/git-review-target.js";
import { toGitReviewTarget } from "../services/review-service.js";
import { makeReviewItem } from "../domain/item.js";
import { finalizeOpenItem } from "../domain/turn.js";
import type { Thread } from "../contracts/threads.js";
import type { TurnStatus } from "../contracts/turns.js";
import type { TurnItem } from "../contracts/items.js";
import type { SessionStore } from "../adapters/store/types.js";
import type { UsageSnapshot } from "../contracts/usage.js";
import {
  UsageValidationError,
  parseDailyUsageQuery,
  parseModelUsageQuery,
  buildThreadUsageResponse,
  buildDailyUsageResponse,
  buildModelUsageResponse,
  reconstructThreadUsageRecords,
  diffUsage,
  hasUsage,
  type PersistedUsageEvent,
  type ReconstructedUsageRecord,
} from "../services/usage-service.js";
import { emptyUsageSnapshot } from "../contracts/usage.js";
import {
  VerifyPlanRequest,
  DraftPlanRequest,
  RefinePlanRequest,
  ReplanRequest,
  BuildPlanRequest,
  WriteWorkspaceFileRequest,
} from "../contracts/plan.js";
import { isGuiPlanRelativePath } from "../shared/gui-plan.js";
import { dirname, resolve, isAbsolute, sep, extname } from "node:path";
import { mkdir, writeFile, rename, readFile } from "node:fs/promises";

// --- /v1/runtime/tools sub-diagnostics (T12.4) ------------------------------
// The original runtime assembled `webProviders`, `mcpSearch`, and per-modality
// `imageGen/speechGen/musicGen/videoGen` diagnostics from the live provider
// builders (runtime-factory.dup2.js toolDiagnostics()). This build folds the
// four media modalities into one `buildMediaToolProvider` and web into one
// `buildWebToolProvider`, so we reconstruct the same diagnostic shapes from the
// resolved capability config instead of discarding them / hardcoding [].

type MediaEndpointLike = { endpoint?: string; apiKey?: string; model?: string } | undefined;
type WebCapabilityLike =
  | {
      enabled?: boolean;
      fetchEnabled?: boolean;
      searchEnabled?: boolean;
      search?: { endpoint?: string; apiKey?: string; provider?: string };
    }
  | undefined;
type McpCapabilityLike = { enabled?: boolean; search?: unknown } | undefined;

/** Per-modality media-gen diagnostic entry, mirroring an `imageGenProviders.diagnostics` item. */
function modalityDiagnostic(
  modality: "image" | "speech" | "music" | "video",
  mediaEnabled: boolean,
  cfg: MediaEndpointLike,
): { id: string; modality: string; available: boolean; reason?: string } {
  const configured = Boolean(cfg?.endpoint && cfg?.apiKey && cfg?.model);
  const available = mediaEnabled && configured;
  const reason = !mediaEnabled
    ? "media generation is disabled by config"
    : !configured
      ? `${modality} generation is not configured; set an endpoint, apiKey, and model`
      : undefined;
  return { id: `media:${modality}`, modality, available, ...(reason ? { reason } : {}) };
}

/** Web tool diagnostics array (one merged provider), mirroring `webProviders.diagnostics`. */
function computeWebProviderDiagnostics(web: WebCapabilityLike): Array<{
  id: string;
  provider: string;
  enabled: boolean;
  fetchAvailable: boolean;
  searchAvailable: boolean;
  reason?: string;
}> {
  const enabled = Boolean(web?.enabled);
  const fetchAvailable = Boolean(enabled && web?.fetchEnabled);
  const searchConfigured = Boolean(web?.search?.endpoint && web?.search?.apiKey);
  const searchAvailable = Boolean(enabled && web?.searchEnabled && searchConfigured);
  const provider = web?.search?.provider ?? "none";
  const reason = !enabled
    ? "web tools are disabled by config"
    : !fetchAvailable && !searchAvailable
      ? "web provider is unavailable"
      : undefined;
  return [{ id: "web", provider, enabled, fetchAvailable, searchAvailable, ...(reason ? { reason } : {}) }];
}

/** MCP search diagnostics, mirroring `mcpProviders.search` (hub index stats + tuning). */
function computeMcpSearchDiagnostics(
  runtime: Runtime,
  mcp: McpCapabilityLike,
): { enabled: boolean; indexedToolCount: number; refreshedAt?: string; tuning: unknown } {
  const hub = runtime.mcpHub;
  return {
    enabled: Boolean(mcp?.enabled),
    indexedToolCount: hub?.indexedToolCount ?? 0,
    ...(hub?.refreshedAt ? { refreshedAt: hub.refreshedAt } : {}),
    tuning: mcp?.search ?? null,
  };
}

export function buildRouter(runtime: Runtime): Router {
  const router = new Router();

  const auth =
    (handler: RouteHandler): RouteHandler =>
    (request, ctx) =>
      isAuthorized(request.headers, runtime.runtimeToken, runtime.insecure) ? handler(request, ctx) : ERRORS.unauthorized();

  // --- health + runtime info ------------------------------------------------

  router.add("GET", "/health", () => jsonResponse({ status: "ok", service: "nexus", mode: "serve" }));

  router.add(
    "GET",
    "/v1/runtime/info",
    auth(() => {
      const config = runtime.getConfig();
      // Canonical serving-process identity (host/port/dataDir/startedAt + optional
      // configPath/pid), merged additively when the runtime exposes info().
      const info = runtime.info?.();
      // Default model + its provider's endpoint format (singular `model` /
      // `endpointFormat`), matching the strict RuntimeInfoResponse envelope.
      const defaultModelId = runtime.models.defaultModelId;
      const defaultModelConfig =
        config.models.find((model) => model.id === defaultModelId) ?? config.models[0];
      const providerConfig = defaultModelConfig ? config.providers[defaultModelConfig.provider] : undefined;
      const endpointFormat =
        providerConfig?.endpointFormat ?? (providerConfig ? defaultEndpointFormat(providerConfig.kind) : undefined);
      // The original returns RuntimeInfoResponse.parse(runtime.info()) — a STRICT
      // envelope. We assemble the same singular-field shape and parse it so any
      // stray field is rejected and the response matches the contract exactly.
      return jsonResponse(
        RuntimeInfoResponse.parse({
          ...(info ?? {}),
          model: defaultModelId,
          ...(endpointFormat ? { endpointFormat } : {}),
          approvalPolicy: config.approvalPolicy,
          sandboxMode: config.sandboxMode,
          tokenEconomyMode: Boolean(config.tokenEconomy?.enabled),
          insecure: runtime.insecure,
          // Capability manifest built from the static capabilities config layered
          // with the live runtime signals available from within the routes layer.
          capabilities: buildRuntimeCapabilityManifest(buildCapabilityManifestInput(runtime, config)),
        }),
      );
    }),
  );

  // --- config ---------------------------------------------------------------

  router.add(
    "GET",
    "/v1/config",
    auth(() => jsonResponse(redactConfig(runtime.getConfig()))),
  );

  router.add(
    "PUT",
    "/v1/config",
    auth(async (request) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = NexusConfigSchema.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid config", parsed.error.issues);
      const merged = mergeMaskedSecrets(parsed.data, runtime.getConfig());
      const saved = runtime.updateConfig(merged);
      return jsonResponse(redactConfig(saved));
    }),
  );

  // --- threads --------------------------------------------------------------

  router.add(
    "GET",
    "/v1/threads",
    auth(async (request) => {
      const url = new URL(request.url);
      const parsed = ListThreadsQuery.safeParse(Object.fromEntries(url.searchParams.entries()));
      if (!parsed.success) return ERRORS.validation("invalid list threads query", parsed.error.issues);
      // `include` is a comma-separated opt-in category list; the only category
      // currently understood is `side` (side conversations hidden by default).
      const includeSide = (parsed.data.include ?? "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .includes("side");
      const threads = await runtime.threadService.list({
        ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
        ...(parsed.data.search !== undefined ? { search: parsed.data.search } : {}),
        ...(parsed.data.include_archived !== undefined ? { includeArchived: parsed.data.include_archived } : {}),
        ...(parsed.data.archived_only !== undefined ? { archivedOnly: parsed.data.archived_only } : {}),
        includeSide,
      });
      return jsonResponse({ threads });
    }),
  );

  router.add(
    "POST",
    "/v1/threads",
    auth(async (request) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      // Faithful to the original createThread: validate the raw body (workspace
      // AND model are required) with no route-level defaulting, then pass the
      // parsed data straight to the service.
      const parsed = CreateThreadRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid create thread body", parsed.error.issues);
      const thread = await runtime.threadService.create(parsed.data);
      return jsonResponse(ThreadSchema.parse(thread), 201);
    }),
  );

  router.add(
    "GET",
    "/v1/threads/:id",
    auth(async (_request, ctx) => {
      const thread = await runtime.threadService.get(ctx.params.id);
      if (!thread) return ERRORS.notFound(`thread not found: ${ctx.params.id}`);
      const [latestSeq, rawItems] = await Promise.all([
        runtime.sessionStore.highestSeq(ctx.params.id),
        runtime.sessionStore.loadItems(ctx.params.id),
      ]);
      // Heal session items whose turn already finished but whose item status was
      // left open by a crash, and persist the healed items back to the store so
      // a subsequent read is stable. Faithful to the original GET /v1/threads/:id.
      const sessionItems = await healSessionItemsForFinishedTurns(thread, rawItems, runtime.sessionStore);
      const hydrated = hydrateThreadItemsFromSession(thread, sessionItems);
      return jsonResponse({ ...ThreadSchema.parse(hydrated), latestSeq });
    }),
  );

  router.add(
    "PATCH",
    "/v1/threads/:id",
    auth(async (request, ctx) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = UpdateThreadRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid update thread body", parsed.error.issues);
      try {
        const thread = await runtime.threadService.update(ctx.params.id, parsed.data);
        return jsonResponse(ThreadSchema.parse(thread));
      } catch (error) {
        if (/not found/i.test((error as Error).message)) return ERRORS.notFound((error as Error).message);
        throw error;
      }
    }),
  );

  router.add(
    "DELETE",
    "/v1/threads/:id",
    auth(async (_request, ctx) => {
      const deleted = await runtime.threadService.delete(ctx.params.id);
      if (!deleted) return ERRORS.notFound(`thread not found: ${ctx.params.id}`);
      return jsonResponse({ id: ctx.params.id, deleted: true });
    }),
  );

  router.add(
    "POST",
    "/v1/threads/:id/fork",
    auth(async (request, ctx) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = ForkThreadRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid fork thread body", parsed.error.issues);
      try {
        const thread = await runtime.threadService.fork(ctx.params.id, parsed.data ?? {});
        return jsonResponse(ThreadSchema.parse(thread), 201);
      } catch (error) {
        if (/not found/i.test((error as Error).message)) return ERRORS.notFound((error as Error).message);
        throw error;
      }
    }),
  );

  // --- sessions (resume) ----------------------------------------------------

  router.add(
    "POST",
    "/v1/sessions/:id/resume-thread",
    auth(async (request, ctx) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = ResumeSessionRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid resume session body", parsed.error.issues);
      try {
        const result = await runtime.threadService.resumeSession(ctx.params.id, parsed.data);
        return jsonResponse(
          {
            thread_id: result.thread.id,
            session_id: result.sessionId,
            message_count: result.messageCount,
            summary: result.thread.title,
          },
          201,
        );
      } catch (error) {
        if (/not found/i.test((error as Error).message)) return ERRORS.notFound((error as Error).message);
        throw error;
      }
    }),
  );

  // --- goal -----------------------------------------------------------------

  router.add(
    "GET",
    "/v1/threads/:id/goal",
    auth(async (_request, ctx) => {
      try {
        return jsonResponse({ goal: await runtime.threadService.getGoal(ctx.params.id) });
      } catch (error) {
        if (/not found/i.test((error as Error).message)) return ERRORS.notFound((error as Error).message);
        throw error;
      }
    }),
  );
  router.add(
    "POST",
    "/v1/threads/:id/goal",
    auth(async (request, ctx) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = SetThreadGoalRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid thread goal body", parsed.error.issues);
      try {
        const goal = await runtime.threadService.setGoal(ctx.params.id, parsed.data as never);
        return jsonResponse({ goal });
      } catch (error) {
        if (/no goal exists/i.test((error as Error).message)) return ERRORS.validation((error as Error).message);
        if (/not found/i.test((error as Error).message)) return ERRORS.notFound("thread not found");
        throw error;
      }
    }),
  );
  router.add(
    "DELETE",
    "/v1/threads/:id/goal",
    auth(async (_request, ctx) => {
      try {
        return jsonResponse({ cleared: await runtime.threadService.clearGoal(ctx.params.id) });
      } catch (error) {
        if (/not found/i.test((error as Error).message)) return ERRORS.notFound((error as Error).message);
        throw error;
      }
    }),
  );

  // --- todos ----------------------------------------------------------------

  router.add(
    "GET",
    "/v1/threads/:id/todos",
    auth(async (_request, ctx) => {
      try {
        return jsonResponse({ todos: await runtime.threadService.getTodos(ctx.params.id) });
      } catch (error) {
        if (/not found/i.test((error as Error).message)) return ERRORS.notFound((error as Error).message);
        throw error;
      }
    }),
  );
  router.add(
    "POST",
    "/v1/threads/:id/todos",
    auth(async (request, ctx) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = SetThreadTodosRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid thread todos body", parsed.error.issues);
      try {
        const todos = await runtime.threadService.setTodos(ctx.params.id, parsed.data.todos);
        return jsonResponse({ todos });
      } catch (error) {
        const message = (error as Error).message;
        if (/not found/i.test(message)) return ERRORS.notFound(message);
        // Domain validation failures (bad todo shape, multiple in_progress, …)
        // surface as a 400, faithful to the original setThreadTodos mapping.
        if (/todo|plan|in_progress|content/i.test(message)) return ERRORS.validation(message);
        throw error;
      }
    }),
  );
  router.add(
    "DELETE",
    "/v1/threads/:id/todos",
    auth(async (_request, ctx) => {
      try {
        return jsonResponse({ cleared: await runtime.threadService.clearTodos(ctx.params.id) });
      } catch (error) {
        if (/not found/i.test((error as Error).message)) return ERRORS.notFound((error as Error).message);
        throw error;
      }
    }),
  );

  // --- turns ----------------------------------------------------------------

  router.add(
    "POST",
    "/v1/threads/:id/turns",
    auth(async (request, ctx) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = StartTurnRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid start turn body", parsed.error.issues);
      try {
        const response = await runtime.turnService.startTurn({ threadId: ctx.params.id, request: parsed.data });
        runtime.runTurn(response.threadId, response.turnId);
        return jsonResponse(response, 202);
      } catch (error) {
        if (/not found/i.test((error as Error).message)) return ERRORS.notFound((error as Error).message);
        throw error;
      }
    }),
  );

  router.add(
    "POST",
    "/v1/threads/:id/rewind",
    auth(async (request, ctx) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const value = body.value as { turnId?: unknown; prompt?: unknown };
      if (typeof value.turnId !== "string" || typeof value.prompt !== "string" || !value.prompt.trim()) {
        return ERRORS.validation("rewind requires a string `turnId` and a non-empty `prompt`");
      }
      try {
        const response = await runtime.turnService.rewind({
          threadId: ctx.params.id,
          turnId: value.turnId,
          prompt: value.prompt,
        });
        runtime.runTurn(response.threadId, response.turnId);
        return jsonResponse(response, 202);
      } catch (error) {
        if (/not found/i.test((error as Error).message)) return ERRORS.notFound((error as Error).message);
        throw error;
      }
    }),
  );

  router.add(
    "GET",
    "/v1/threads/:id/turns/:turnId",
    auth(async (_request, ctx) => {
      const turn = await runtime.turnService.getTurn(ctx.params.id, ctx.params.turnId);
      if (!turn) return ERRORS.notFound(`turn not found: ${ctx.params.turnId}`);
      return jsonResponse(TurnSchema.parse(turn));
    }),
  );

  router.add(
    "POST",
    "/v1/threads/:id/turns/:turnId/steer",
    auth(async (request, ctx) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = SteerTurnRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid steer turn body", parsed.error.issues);
      await runtime.turnService.steerTurn({ threadId: ctx.params.id, turnId: ctx.params.turnId, text: parsed.data.text });
      return jsonResponse({ ok: true });
    }),
  );

  router.add(
    "POST",
    "/v1/threads/:id/turns/:turnId/interrupt",
    auth(async (request, ctx) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = InterruptTurnRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid interrupt turn body", parsed.error.issues);
      const result = await runtime.turnService.interruptTurn({ threadId: ctx.params.id, turnId: ctx.params.turnId, discard: parsed.data.discard });
      return jsonResponse({ threadId: ctx.params.id, turnId: ctx.params.turnId, status: result.status });
    }),
  );

  router.add(
    "POST",
    "/v1/threads/:id/compact",
    auth(async (request, ctx) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = CompactRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid compact body", parsed.error.issues);
      try {
        return jsonResponse(await runtime.turnService.compact({ threadId: ctx.params.id, request: parsed.data }));
      } catch (error) {
        if (/not found/i.test((error as Error).message)) return ERRORS.notFound((error as Error).message);
        throw error;
      }
    }),
  );

  // Auto-title: summarize the thread's opening exchange into a concise title.
  // Best-effort + idempotent in the service (only replaces a default title), so
  // a client can safely call this once after the first turn completes.
  router.add(
    "POST",
    "/v1/threads/:id/autotitle",
    auth(async (_request, ctx) => {
      try {
        const thread = await runtime.threadService.autoTitle(ctx.params.id);
        return jsonResponse(ThreadSchema.parse(thread));
      } catch (error) {
        if (/not found/i.test((error as Error).message)) return ERRORS.notFound((error as Error).message);
        throw error;
      }
    }),
  );

  // --- events (SSE) ---------------------------------------------------------

  router.add(
    "GET",
    "/v1/threads/:id/events",
    auth((request, ctx) =>
      buildEventStreamResponse({
        request,
        threadId: ctx.params.id,
        eventBus: runtime.eventBus,
        sessionStore: runtime.sessionStore,
      }),
    ),
  );

  // --- approvals + user input ----------------------------------------------

  router.add(
    "POST",
    "/v1/approvals/:id",
    auth(async (request, ctx) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = ApprovalDecisionRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid approval body", parsed.error.issues);
      const record = runtime.approvalGate.get(ctx.params.id);
      if (!record) return ERRORS.notFound(`approval not found: ${ctx.params.id}`);
      const ok = runtime.approvalGate.decide(ctx.params.id, parsed.data.decision, parsed.data.reason);
      if (!ok) return ERRORS.conflict(`approval already decided: ${ctx.params.id}`);
      const status = parsed.data.decision === "allow" ? "allowed" : "denied";
      await runtime.events.record({
        kind: "approval_resolved",
        threadId: record.threadId,
        turnId: record.turnId,
        // The approval record does not carry an itemId; the original
        // decideApproval always records `itemId: undefined` on the resolved
        // event, so we mirror that exactly.
        itemId: undefined,
        approvalId: ctx.params.id,
        toolName: record.toolName,
        status,
        summary: record.summary,
      });
      return jsonResponse({ approvalId: ctx.params.id, decision: parsed.data.decision, status });
    }),
  );

  const userInputHandler: RouteHandler = async (request, ctx) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const parsed = UserInputResolveRequest.safeParse(body.value);
    if (!parsed.success) return ERRORS.validation("invalid user input body", parsed.error.issues);
    const record = runtime.userInputGate.get(ctx.params.id);
    if (!record) return ERRORS.notFound(`user input not found: ${ctx.params.id}`);
    // Map the request onto the gate's UserInputResolution. The frontend signals
    // cancellation via `status: "cancelled"`; older callers may send
    // `cancelled: true` — honour either. On submit, forward the answers Record
    // and free text straight through to the gate (and downstream tool result).
    const cancelled = parsed.data.cancelled ?? parsed.data.status === "cancelled";
    const resolution = cancelled
      ? { status: "cancelled" as const }
      : {
          status: "submitted" as const,
          answers: parsed.data.answers ?? {},
          ...(parsed.data.text != null ? { text: parsed.data.text } : {}),
        };
    const ok = runtime.userInputGate.resolve(ctx.params.id, resolution);
    if (!ok) return ERRORS.conflict(`user input already resolved: ${ctx.params.id}`);
    // Faithful to the original resolveUserInput: the resolved event carries the
    // pending gate record's itemId and prompt so SSE consumers can correlate the
    // resolution with the request item and show what was asked.
    await runtime.events.record({
      kind: "user_input_resolved",
      threadId: record.threadId,
      turnId: record.turnId,
      itemId: record.itemId,
      inputId: ctx.params.id,
      status: resolution.status,
      prompt: record.prompt,
    });
    return jsonResponse({
      inputId: ctx.params.id,
      status: resolution.status,
      ...(resolution.status === "submitted" ? { answers: parsed.data.answers ?? {} } : {}),
    });
  };
  router.add("POST", "/v1/user-inputs/:id", auth(userInputHandler));
  router.add("POST", "/v1/user-input/:id", auth(userInputHandler));

  // --- usage ----------------------------------------------------------------

  router.add(
    "GET",
    "/v1/usage",
    auth(async (request) => {
      const url = new URL(request.url);
      const query: Record<string, string> = {};
      for (const [key, value] of url.searchParams.entries()) query[key] = value;
      const groupBy = stringParam(query, "group_by") ?? "runtime";
      // group_by=thread/day/model reconstruct per-record usage by diffing the
      // persisted usage events against the live counter remainder; the default
      // (runtime) returns the per-thread breakdown envelope. Faithful to the
      // original /v1/usage route (usageJsonResponse / buildUsageResponse).
      if (groupBy === "thread") {
        return jsonResponse(
          buildThreadUsageResponse(await usageRecords(runtime, { threadId: stringParam(query, "thread_id") })),
        );
      }
      if (groupBy === "day") {
        try {
          return jsonResponse(buildDailyUsageResponse(await usageRecords(runtime), parseDailyUsageQuery(query)));
        } catch (error) {
          if (error instanceof UsageValidationError) return ERRORS.validation(error.message);
          throw error;
        }
      }
      if (groupBy === "model") {
        try {
          return jsonResponse(buildModelUsageResponse(await usageRecords(runtime), parseModelUsageQuery(query)));
        } catch (error) {
          if (error instanceof UsageValidationError) return ERRORS.validation(error.message);
          throw error;
        }
      }
      if (groupBy !== "runtime") {
        return ERRORS.validation(`unsupported usage grouping: ${groupBy}`);
      }
      // runtime grouping: { total, perThread } over every thread.
      const threads = await runtime.threadService.list();
      return jsonResponse({
        total: runtime.usageService.total(),
        perThread: threads.map((thread) => ({
          threadId: thread.id,
          usage: runtime.usageService.forThread(thread.id),
        })),
      });
    }),
  );

  // --- runtime tool diagnostics ---------------------------------------------

  router.add(
    "GET",
    "/v1/runtime/tools",
    auth(async () => {
      // Rich rollup across providers / MCP servers / web providers / skills /
      // attachments / memory, redacted. Faithful to the original
      // runtimeToolDiagnosticsJsonResponse default object shape (the runtime's
      // `toolDiagnostics()` is assembled here from the wired capabilities).
      const providers = runtime.toolHost?.diagnostics() ?? [];
      const mcpServers = (runtime.mcpHub?.servers ?? []).map((server) => ({
        id: server.config.id,
        command: server.config.command,
        trusted: server.trusted,
        connected: server.connected,
        toolCount: server.descriptors.length,
        ...(server.unavailableReason ? { unavailableReason: server.unavailableReason } : {}),
      }));
      const skills = runtime.skillRuntime?.diagnostics() ?? {
        enabled: false,
        roots: [],
        skills: [],
        validationErrors: [],
        lastActivations: [],
      };
      const attachments = runtime.attachmentStore
        ? await runtime.attachmentStore.diagnostics()
        : { enabled: false, rootDir: "", count: 0, totalBytes: 0 };
      const memory = runtime.memoryStore
        ? await runtime.memoryStore.diagnostics()
        : { enabled: false, rootDir: "", activeCount: 0, tombstoneCount: 0, lastInjectedIds: [] };
      // Sub-diagnostics the original surfaced from the live provider builders
      // (web/mcpSearch/imageGen/speechGen/musicGen/videoGen). Reconstructed from
      // the resolved capability config (T12.4) — replacing the discarded inline
      // rollup + hardcoded `webProviders: []`.
      const caps = runtime.getConfig().capabilities;
      const mediaEnabled = Boolean(caps?.media?.enabled);
      const webProviders = computeWebProviderDiagnostics(caps?.web);
      const mcpSearch = computeMcpSearchDiagnostics(runtime, caps?.mcp);
      const imageGen = [modalityDiagnostic("image", mediaEnabled, caps?.media?.image)];
      const speechGen = [modalityDiagnostic("speech", mediaEnabled, caps?.media?.speech)];
      const musicGen = [modalityDiagnostic("music", mediaEnabled, caps?.media?.music)];
      const videoGen = [modalityDiagnostic("video", mediaEnabled, caps?.media?.video)];
      // Deep-redact any secret-looking fields a diagnostic may carry (e.g. an MCP
      // server's configured headers/env), matching the original which wrapped the
      // tool diagnostics in redactSecrets.
      return jsonResponse(
        redactSecrets({
          providers,
          mcpServers,
          mcpSearch,
          webProviders,
          skills,
          attachments,
          memory,
          imageGen,
          speechGen,
          musicGen,
          videoGen,
        }),
      );
    }),
  );

  // --- skills ---------------------------------------------------------------

  router.add(
    "GET",
    "/v1/skills",
    auth(() => {
      // Full skills rollup { enabled, roots, skills, validationErrors } with each
      // skill carrying its complete diagnostic field set. Skills disabled (or
      // runtime absent) => the inert default envelope. Faithful to the original
      // listSkills response shape.
      const diagnostics = runtime.skillRuntime?.diagnostics() ?? {
        enabled: false,
        roots: [],
        skills: [],
        validationErrors: [],
        lastActivations: [],
      };
      return jsonResponse({
        enabled: diagnostics.enabled,
        roots: diagnostics.roots,
        skills: diagnostics.skills,
        validationErrors: diagnostics.validationErrors,
      });
    }),
  );

  // --- memory ---------------------------------------------------------------

  router.add(
    "GET",
    "/v1/memory",
    auth(async (request) => {
      if (!runtime.memoryStore) return ERRORS.unavailable("memory store is unavailable");
      const url = new URL(request.url);
      const workspace = url.searchParams.get("workspace") ?? undefined;
      const includeDeleted = url.searchParams.get("include_deleted") === "true";
      const memories = await runtime.memoryStore.list({
        ...(workspace ? { workspace } : {}),
        includeDeleted,
      });
      return jsonResponse({ memories });
    }),
  );

  router.add(
    "GET",
    "/v1/memory/diagnostics",
    auth(async () => {
      if (!runtime.memoryStore)
        return jsonResponse({ enabled: false, rootDir: "", activeCount: 0, tombstoneCount: 0, lastInjectedIds: [] });
      return jsonResponse(await runtime.memoryStore.diagnostics());
    }),
  );

  router.add(
    "POST",
    "/v1/memory",
    auth(async (request) => {
      if (!runtime.memoryStore) return ERRORS.unavailable("memory store is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = MemoryCreateRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid memory create body", parsed.error.issues);
      return jsonResponse({ memory: await runtime.memoryStore.create(parsed.data) }, 201);
    }),
  );

  router.add(
    "PATCH",
    "/v1/memory/:id",
    auth(async (request, ctx) => {
      if (!runtime.memoryStore) return ERRORS.unavailable("memory store is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = MemoryUpdateRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid memory update body", parsed.error.issues);
      try {
        return jsonResponse({ memory: await runtime.memoryStore.update(ctx.params.id, parsed.data) });
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  router.add(
    "DELETE",
    "/v1/memory/:id",
    auth(async (_request, ctx) => {
      if (!runtime.memoryStore) return ERRORS.unavailable("memory store is unavailable");
      try {
        return jsonResponse({ memory: await runtime.memoryStore.delete(ctx.params.id) });
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  // --- scheduled tasks ------------------------------------------------------

  router.add(
    "GET",
    "/v1/schedule",
    auth(async () => {
      if (!runtime.scheduleService) return jsonResponse({ tasks: [] });
      return jsonResponse({ tasks: await runtime.scheduleService.list() });
    }),
  );

  router.add(
    "POST",
    "/v1/schedule",
    auth(async (request) => {
      if (!runtime.scheduleService) return ERRORS.unavailable("schedule service is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = ScheduleCreateRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid schedule create body", parsed.error.issues);
      return jsonResponse({ task: await runtime.scheduleService.create(parsed.data) }, 201);
    }),
  );

  router.add(
    "PATCH",
    "/v1/schedule/:id",
    auth(async (request, ctx) => {
      if (!runtime.scheduleService) return ERRORS.unavailable("schedule service is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = ScheduleUpdateRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid schedule update body", parsed.error.issues);
      try {
        return jsonResponse({ task: await runtime.scheduleService.update(ctx.params.id, parsed.data) });
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  router.add(
    "DELETE",
    "/v1/schedule/:id",
    auth(async (_request, ctx) => {
      if (!runtime.scheduleService) return ERRORS.unavailable("schedule service is unavailable");
      return jsonResponse(await runtime.scheduleService.delete(ctx.params.id));
    }),
  );

  router.add(
    "POST",
    "/v1/schedule/:id/run",
    auth(async (_request, ctx) => {
      if (!runtime.scheduleService) return ERRORS.unavailable("schedule service is unavailable");
      try {
        return jsonResponse({ task: await runtime.scheduleService.runNow(ctx.params.id) });
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  // --- schedule control-plane (internal; called by the schedule-mcp sidecar) --
  // Bearer-guarded endpoints the `nexus-schedule` MCP sidecar POSTs to. The
  // sidecar maps its snake_case tool args to this camelCase wire shape; these
  // routes are intentionally a separate surface from the GUI `/v1/schedule/*`
  // CRUD, faithful to the original schedule sidecar ↔ backend split.
  router.add(
    "POST",
    "/schedule/internal/list",
    auth(async () => {
      if (!runtime.scheduleService) return jsonResponse({ tasks: [] });
      return jsonResponse({ tasks: await runtime.scheduleService.list() });
    }),
  );

  router.add(
    "POST",
    "/schedule/internal/create",
    auth(async (request) => {
      if (!runtime.scheduleService) return ERRORS.unavailable("schedule service is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const input = (body.value as { input?: unknown })?.input;
      const parsed = ScheduleCreateRequest.safeParse(input);
      if (!parsed.success) return ERRORS.validation("invalid schedule create input", parsed.error.issues);
      return jsonResponse({ task: await runtime.scheduleService.create(parsed.data) });
    }),
  );

  router.add(
    "POST",
    "/schedule/internal/update",
    auth(async (request) => {
      if (!runtime.scheduleService) return ERRORS.unavailable("schedule service is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const value = body.value as { taskId?: unknown; patch?: unknown };
      if (typeof value?.taskId !== "string" || !value.taskId) return ERRORS.validation("taskId is required");
      const parsed = ScheduleUpdateRequest.safeParse(value.patch ?? {});
      if (!parsed.success) return ERRORS.validation("invalid schedule update patch", parsed.error.issues);
      try {
        return jsonResponse({ task: await runtime.scheduleService.update(value.taskId, parsed.data) });
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  router.add(
    "POST",
    "/schedule/internal/delete",
    auth(async (request) => {
      if (!runtime.scheduleService) return ERRORS.unavailable("schedule service is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const taskId = (body.value as { taskId?: unknown })?.taskId;
      if (typeof taskId !== "string" || !taskId) return ERRORS.validation("taskId is required");
      return jsonResponse(await runtime.scheduleService.delete(taskId));
    }),
  );

  // --- attachments ----------------------------------------------------------

  router.add(
    "POST",
    "/v1/attachments",
    auth(async (request) => {
      if (!runtime.attachmentStore) return ERRORS.unavailable("attachment store is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = AttachmentUploadRequestSchema.safeParse(body.value);
      if (!parsed.success) return ERRORS.attachmentValidation("invalid attachment upload body", parsed.error.issues);
      try {
        const attachment = await runtime.attachmentStore.put({
          name: parsed.data.name,
          data: Buffer.from(parsed.data.dataBase64, "base64"),
          ...(parsed.data.mimeType ? { mimeType: parsed.data.mimeType } : {}),
          ...(parsed.data.textFallback ? { textFallback: parsed.data.textFallback } : {}),
          ...(parsed.data.threadId ? { threadId: parsed.data.threadId } : {}),
          ...(parsed.data.workspace ? { workspace: parsed.data.workspace } : {}),
        });
        return jsonResponse({ attachment }, 201);
      } catch (error) {
        return ERRORS.attachmentValidation((error as Error).message);
      }
    }),
  );

  router.add(
    "GET",
    "/v1/attachments/diagnostics",
    auth(async () => {
      if (!runtime.attachmentStore) return jsonResponse({ enabled: false, rootDir: "", count: 0, totalBytes: 0 });
      return jsonResponse(await runtime.attachmentStore.diagnostics());
    }),
  );

  router.add(
    "GET",
    "/v1/attachments/:id",
    auth(async (_request, ctx) => {
      if (!runtime.attachmentStore) return ERRORS.unavailable("attachment store is unavailable");
      const attachment = await runtime.attachmentStore.get(ctx.params.id);
      if (!attachment) return ERRORS.notFound(`attachment not found: ${ctx.params.id}`);
      return jsonResponse({ attachment });
    }),
  );

  router.add(
    "GET",
    "/v1/attachments/:id/content",
    auth(async (request, ctx) => {
      if (!runtime.attachmentStore) return ERRORS.unavailable("attachment store is unavailable");
      const url = new URL(request.url);
      const scope = attachmentScopeFromQuery(url);
      try {
        const content = await runtime.attachmentStore.getContent(ctx.params.id, scope);
        // JSON envelope: metadata (without raw bytes) plus the base64-encoded
        // content under `dataBase64`. Faithful to the original download contract.
        const { data, ...metadata } = content;
        return jsonResponse({ attachment: metadata, dataBase64: data.toString("base64") });
      } catch (error) {
        const message = (error as Error).message;
        return /not authorized/i.test(message) ? ERRORS.forbidden(message) : ERRORS.notFound(message);
      }
    }),
  );

  // --- workspace ------------------------------------------------------------

  router.add(
    "GET",
    "/v1/workspace/status",
    auth(async (request) => {
      const url = new URL(request.url);
      // Accept `?path=` (original contract) or the `?workspace=` alias the UI
      // sends, so the Change Inspector's file list resolves either way.
      const path = url.searchParams.get("path") ?? url.searchParams.get("workspace");
      // Faithful to the original buildWorkspaceStatusResponse: a default stub when
      // no `path` is supplied (no inspector call), otherwise the inspector's
      // canonical status() keyed off `?path=`.
      if (!path) {
        return jsonResponse({
          path: "",
          exists: false,
          isGitRepository: false,
          branch: null,
          headSha: null,
          isDirty: null,
          fileChangeCount: null,
          checkedAt: new Date().toISOString(),
          changedFiles: [],
        });
      }
      if (!runtime.workspaceInspector) return ERRORS.notFound("workspace inspector is not configured");
      return jsonResponse(await runtime.workspaceInspector.status(path));
    }),
  );

  router.add(
    "GET",
    "/v1/workspace/files",
    auth(async (request) => {
      const url = new URL(request.url);
      if (!runtime.workspaceInspector) return jsonResponse({ files: [] });
      const workspace = url.searchParams.get("workspace") ?? url.searchParams.get("path") ?? runtime.defaultWorkspace ?? ".";
      try {
        return jsonResponse({ files: await runtime.workspaceInspector.listFiles(workspace) });
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  router.add(
    "GET",
    "/v1/files/retrieve",
    auth(async (request) => {
      const url = new URL(request.url);
      const file = url.searchParams.get("path") ?? url.searchParams.get("file");
      if (!file) return ERRORS.validation("file retrieve requires `path`");
      if (!runtime.workspaceInspector) return ERRORS.notFound("workspace inspector is not configured");
      const workspace = url.searchParams.get("workspace") ?? runtime.defaultWorkspace ?? ".";
      try {
        return jsonResponse(await runtime.workspaceInspector.retrieve(workspace, file));
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  // --- POST /v1/files/write (path-safe workspace text write) ----------------
  // Companion to GET /v1/files/retrieve: writes a text file INSIDE the resolved
  // workspace root (atomic temp-file + rename). Path-safety mirrors the
  // inspector's `retrieve` containment check (rejects traversal / out-of-tree
  // absolutes) and a text-extension allowlist rejects binary writes. Reserved
  // plan files (.nexus-plan/plan/*.md) are always admitted; other extensions must
  // be in the text allowlist. Plan WRITES from the agent still go through the
  // validated `create_plan` tool — this route is for arbitrary workspace text.
  router.add(
    "POST",
    "/v1/files/write",
    auth(async (request) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = WriteWorkspaceFileRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid file write body", parsed.error.issues);

      const workspace = parsed.data.workspace ?? runtime.defaultWorkspace ?? ".";
      const root = resolve(workspace || ".");
      const abs = isAbsolute(parsed.data.path) ? resolve(parsed.data.path) : resolve(root, parsed.data.path);
      // Containment: must be the root itself or a descendant of it.
      if (abs !== root && !abs.startsWith(root + sep)) {
        return ERRORS.forbidden("file is outside the workspace");
      }
      // Text-only: a reserved plan path is always allowed; otherwise the
      // extension must be in the text allowlist (rejects binary writes).
      const relForCheck = abs.startsWith(root + sep) ? abs.slice(root.length + 1) : abs;
      if (!isGuiPlanRelativePath(relForCheck) && !isAllowedTextExtension(abs)) {
        return ERRORS.forbidden("only text files may be written to the workspace");
      }
      try {
        const byteSize = await writeWorkspaceTextFile(abs, parsed.data.content);
        const rel = abs === root ? "." : abs.startsWith(root + sep) ? abs.slice(root.length + 1) : abs;
        return jsonResponse({ ok: true, path: rel, byteSize });
      } catch (error) {
        return ERRORS.validation((error as Error).message);
      }
    }),
  );

  router.add(
    "GET",
    "/v1/workspace/diff",
    auth(async (request) => {
      const url = new URL(request.url);
      const path = url.searchParams.get("path") ?? url.searchParams.get("workspace");
      const file = url.searchParams.get("file");
      if (!path || !file) return ERRORS.validation("workspace diff requires `path` (or `workspace`) and `file`");
      if (!runtime.workspaceInspector) return ERRORS.notFound("workspace inspector is not configured");
      // Unified per-file diff (staged + unstaged vs HEAD, or untracked vs
      // /dev/null) for the Change Inspector's DiffViewer pane. Never throws.
      return jsonResponse(await runtime.workspaceInspector.diff(path, file));
    }),
  );

  // --- SDD plan (`/v1/plan/*`) ----------------------------------------------
  // POST /v1/plan/verify is a PURE local spec-coverage report (the `iSe` family:
  // parse requirement blocks + plan `(covers: R-N)` steps, roll up coverage,
  // derive statuses, bump in-progress requirements, diff a trace snapshot). No
  // model call. The draft/refine/replan ops are MODEL-BACKED (they build the
  // faithful prompt and call the injected provider-agnostic completion seam);
  // they degrade cleanly to a 503 when no model is configured. build is a pure
  // todo extraction over the plan checklist. The service is absent => 503.

  router.add(
    "POST",
    "/v1/plan/verify",
    auth(async (request) => {
      if (!runtime.planService) return ERRORS.unavailable("plan service is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = VerifyPlanRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid plan verify body", parsed.error.issues);
      return jsonResponse(runtime.planService.verifyPlan(parsed.data));
    }),
  );

  router.add(
    "POST",
    "/v1/plan/build",
    auth(async (request) => {
      if (!runtime.planService) return ERRORS.unavailable("plan service is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = BuildPlanRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid plan build body", parsed.error.issues);
      return jsonResponse(runtime.planService.buildPlan(parsed.data, runtime.nowIso()));
    }),
  );

  router.add(
    "POST",
    "/v1/plan/draft",
    auth(async (request) => {
      if (!runtime.planService) return ERRORS.unavailable("plan service is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = DraftPlanRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid plan draft body", parsed.error.issues);
      if (runtime.models.list().length === 0) return ERRORS.unavailable("no model is configured");
      return jsonResponse(await runtime.planService.draftPlan(parsed.data));
    }),
  );

  router.add(
    "POST",
    "/v1/plan/refine",
    auth(async (request) => {
      if (!runtime.planService) return ERRORS.unavailable("plan service is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = RefinePlanRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid plan refine body", parsed.error.issues);
      if (runtime.models.list().length === 0) return ERRORS.unavailable("no model is configured");
      return jsonResponse(await runtime.planService.refinePlan(parsed.data));
    }),
  );

  router.add(
    "POST",
    "/v1/plan/replan",
    auth(async (request) => {
      if (!runtime.planService) return ERRORS.unavailable("plan service is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = ReplanRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid plan replan body", parsed.error.issues);
      if (runtime.models.list().length === 0) return ERRORS.unavailable("no model is configured");
      return jsonResponse(await runtime.planService.replanPlan(parsed.data));
    }),
  );

  // --- speech-to-text transcription (语音转写, T10.4) -----------------------
  // POST takes base64 audio (no route reads multipart/binary; everything is
  // JSON via readJsonBody) and forwards it to the configured OpenAI-compatible
  // `{endpoint}/v1/audio/transcriptions` endpoint via the injected
  // SpeechToTextService (multipart FormData POST), returning `{ text }`. STT is
  // OFF by default, so the route returns a clean 503 (NOT a crash) when the
  // service is absent / disabled / unconfigured, and a 400 provider_error when
  // the provider rejects the audio.
  router.add(
    "POST",
    "/v1/audio/transcribe",
    auth(async (request) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = TranscribeAudioRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid transcribe body", parsed.error.issues);

      const stt = runtime.getConfig().capabilities?.speechToText;
      if (!runtime.speechToText || !stt?.enabled) {
        return ERRORS.unavailable("speech-to-text is disabled");
      }
      if (!stt.endpoint || !stt.apiKey || !stt.model) {
        return ERRORS.unavailable("speech-to-text provider is not configured");
      }

      try {
        const text = await runtime.speechToText.transcribe({
          audioBase64: parsed.data.audioBase64,
          mimeType: parsed.data.mimeType,
          ...(parsed.data.language ?? stt.language
            ? { language: (parsed.data.language ?? stt.language) as string }
            : {}),
        });
        return jsonResponse({ text });
      } catch (error) {
        // A provider/transport failure (SpeechToTextError carries the HTTP
        // status + body) or any other error surfaces as a clean 400 — never a
        // 500. The `instanceof` keeps the import load-bearing and documents that
        // this is the expected provider-error path.
        const message =
          error instanceof SpeechToTextError ? error.message : (error as Error).message;
        return ERRORS.validation(message);
      }
    }),
  );

  // --- agents (智能体目录) ---------------------------------------------------

  router.add(
    "GET",
    "/v1/agents",
    auth(async () => {
      if (!runtime.agentDirectory) return jsonResponse({ agents: [] });
      return jsonResponse({ agents: await runtime.agentDirectory.list() });
    }),
  );

  router.add(
    "POST",
    "/v1/agents",
    auth(async (request) => {
      if (!runtime.agentDirectory) return ERRORS.unavailable("agent directory is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = AgentCreateRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid agent create body", parsed.error.issues);
      return jsonResponse({ agent: await runtime.agentDirectory.create(parsed.data) }, 201);
    }),
  );

  router.add(
    "PATCH",
    "/v1/agents/:id",
    auth(async (request, ctx) => {
      if (!runtime.agentDirectory) return ERRORS.unavailable("agent directory is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = AgentUpdateRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid agent update body", parsed.error.issues);
      try {
        return jsonResponse({ agent: await runtime.agentDirectory.update(ctx.params.id, parsed.data) });
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  router.add(
    "DELETE",
    "/v1/agents/:id",
    auth(async (_request, ctx) => {
      if (!runtime.agentDirectory) return ERRORS.unavailable("agent directory is unavailable");
      try {
        return jsonResponse({ agent: await runtime.agentDirectory.delete(ctx.params.id) });
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  // --- connectors (连接中心 / ConnectorHub) ----------------------------------
  // Credential profiles, project spaces, external resource links, and an
  // activity stream over the file-backed connector store. The store owns the
  // secret-masking / merge-mask discipline (raw secrets never reach the GUI; a
  // `********` echo on update preserves the stored value), per-vendor default
  // promotion, cascade deletes, and the LIGHTWEIGHT health check ("检测") that
  // validates required fields + URL well-formedness only (real connectivity is
  // delegated to the corresponding MCP — no faked network probe). Same
  // registration idiom + error handling as the /v1/agents
  // routes: the service is absent => 503; a domain "not found" => 404; a
  // vendor-mismatch on bind/default => 400.

  // profiles --------------------------------------------------------------
  router.add(
    "GET",
    "/v1/connectors/profiles",
    auth(async (request) => {
      if (!runtime.connectorService) return ERRORS.unavailable("connector hub is unavailable");
      const url = new URL(request.url);
      const vendorRaw = url.searchParams.get("vendor");
      let vendor: ReturnType<typeof ConnectorVendorSchema.parse> | undefined;
      if (vendorRaw) {
        const parsed = ConnectorVendorSchema.safeParse(vendorRaw);
        if (!parsed.success) return ERRORS.validation(`unknown connector vendor: ${vendorRaw}`);
        vendor = parsed.data;
      }
      return jsonResponse({ profiles: await runtime.connectorService.listProfiles(vendor) });
    }),
  );

  router.add(
    "POST",
    "/v1/connectors/profiles",
    auth(async (request) => {
      if (!runtime.connectorService) return ERRORS.unavailable("connector hub is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = ConnectorProfileCreateRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid connector profile create body", parsed.error.issues);
      return jsonResponse({ profile: await runtime.connectorService.createProfile(parsed.data) }, 201);
    }),
  );

  router.add(
    "PATCH",
    "/v1/connectors/profiles/:id",
    auth(async (request, ctx) => {
      if (!runtime.connectorService) return ERRORS.unavailable("connector hub is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = ConnectorProfileUpdateRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid connector profile update body", parsed.error.issues);
      try {
        return jsonResponse({ profile: await runtime.connectorService.updateProfile(ctx.params.id, parsed.data) });
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  router.add(
    "DELETE",
    "/v1/connectors/profiles/:id",
    auth(async (_request, ctx) => {
      if (!runtime.connectorService) return ERRORS.unavailable("connector hub is unavailable");
      try {
        return jsonResponse({ profile: await runtime.connectorService.deleteProfile(ctx.params.id) });
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  router.add(
    "POST",
    "/v1/connectors/profiles/:id/default",
    auth(async (_request, ctx) => {
      if (!runtime.connectorService) return ERRORS.unavailable("connector hub is unavailable");
      // Promote a profile to its vendor's default. The vendor is resolved from
      // the stored profile, so a vendor-mismatch is impossible here; an unknown
      // id maps to a 404.
      const profile = await runtime.connectorService.getProfile(ctx.params.id);
      if (!profile) return ERRORS.notFound(`profile not found: ${ctx.params.id}`);
      try {
        return jsonResponse({ profile: await runtime.connectorService.setDefaultProfile(profile.vendor, ctx.params.id) });
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  router.add(
    "POST",
    "/v1/connectors/profiles/:id/check",
    auth(async (_request, ctx) => {
      if (!runtime.connectorService) return ERRORS.unavailable("connector hub is unavailable");
      // LIGHTWEIGHT health check ("检测") only: required-fields-present + URL
      // well-formed, run on the stored (unmasked) credentials. A clean structured
      // `{ ok, missingFields, message }` — never a faked network probe.
      try {
        return jsonResponse(await runtime.connectorService.checkProfile(ctx.params.id));
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  // spaces ----------------------------------------------------------------
  router.add(
    "GET",
    "/v1/connectors/spaces",
    auth(async () => {
      if (!runtime.connectorService) return ERRORS.unavailable("connector hub is unavailable");
      return jsonResponse({ spaces: await runtime.connectorService.listSpaces() });
    }),
  );

  router.add(
    "POST",
    "/v1/connectors/spaces",
    auth(async (request) => {
      if (!runtime.connectorService) return ERRORS.unavailable("connector hub is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = ProjectSpaceCreateRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid connector space create body", parsed.error.issues);
      return jsonResponse({ space: await runtime.connectorService.createSpace(parsed.data) }, 201);
    }),
  );

  router.add(
    "PATCH",
    "/v1/connectors/spaces/:id",
    auth(async (request, ctx) => {
      if (!runtime.connectorService) return ERRORS.unavailable("connector hub is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = ProjectSpaceUpdateRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid connector space update body", parsed.error.issues);
      try {
        return jsonResponse({ space: await runtime.connectorService.updateSpace(ctx.params.id, parsed.data) });
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  router.add(
    "DELETE",
    "/v1/connectors/spaces/:id",
    auth(async (_request, ctx) => {
      if (!runtime.connectorService) return ERRORS.unavailable("connector hub is unavailable");
      try {
        return jsonResponse({ space: await runtime.connectorService.deleteSpace(ctx.params.id) });
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  router.add(
    "POST",
    "/v1/connectors/spaces/:id/bind",
    auth(async (request, ctx) => {
      if (!runtime.connectorService) return ERRORS.unavailable("connector hub is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      // Bind one bindable vendor to a profile. `{ vendor, profileId }`; `vendor`
      // must be a bindable vendor (gitlab/k8s/nacos).
      const value = body.value as { vendor?: unknown };
      const vendorParsed = BindableVendorSchema.safeParse(value?.vendor);
      if (!vendorParsed.success) return ERRORS.validation("bind requires a bindable `vendor` (gitlab/k8s/nacos)");
      const parsed = BindProfileRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid connector bind body", parsed.error.issues);
      try {
        return jsonResponse({
          space: await runtime.connectorService.bindProfile(ctx.params.id, vendorParsed.data, parsed.data.profileId),
        });
      } catch (error) {
        const message = (error as Error).message;
        // A vendor-mismatch ("is not a <vendor> profile") is a 400; an unknown
        // space/profile is a 404.
        if (/is not a .* profile/i.test(message)) return ERRORS.validation(message);
        return ERRORS.notFound(message);
      }
    }),
  );

  router.add(
    "DELETE",
    "/v1/connectors/spaces/:id/bindings/:vendor",
    auth(async (_request, ctx) => {
      if (!runtime.connectorService) return ERRORS.unavailable("connector hub is unavailable");
      const vendorParsed = BindableVendorSchema.safeParse(ctx.params.vendor);
      if (!vendorParsed.success) return ERRORS.validation(`unknown bindable vendor: ${ctx.params.vendor}`);
      try {
        return jsonResponse({ space: await runtime.connectorService.unbindProfile(ctx.params.id, vendorParsed.data) });
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  // links -----------------------------------------------------------------
  router.add(
    "GET",
    "/v1/connectors/links",
    auth(async (request) => {
      if (!runtime.connectorService) return ERRORS.unavailable("connector hub is unavailable");
      const url = new URL(request.url);
      const spaceId = url.searchParams.get("spaceId") ?? url.searchParams.get("space_id") ?? undefined;
      return jsonResponse({ links: await runtime.connectorService.listLinks(spaceId) });
    }),
  );

  router.add(
    "POST",
    "/v1/connectors/links",
    auth(async (request) => {
      if (!runtime.connectorService) return ERRORS.unavailable("connector hub is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = ExternalLinkCreateRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid connector link create body", parsed.error.issues);
      try {
        return jsonResponse({ link: await runtime.connectorService.createLink(parsed.data) }, 201);
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  router.add(
    "DELETE",
    "/v1/connectors/links/:id",
    auth(async (_request, ctx) => {
      if (!runtime.connectorService) return ERRORS.unavailable("connector hub is unavailable");
      try {
        return jsonResponse({ link: await runtime.connectorService.deleteLink(ctx.params.id) });
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  // events ----------------------------------------------------------------
  router.add(
    "GET",
    "/v1/connectors/events",
    auth(async (request) => {
      if (!runtime.connectorService) return ERRORS.unavailable("connector hub is unavailable");
      const url = new URL(request.url);
      const spaceId = url.searchParams.get("spaceId") ?? url.searchParams.get("space_id") ?? undefined;
      const statusRaw = url.searchParams.get("status");
      let status: ReturnType<typeof EventStatusFilterSchema.parse> | undefined;
      if (statusRaw) {
        const parsed = EventStatusFilterSchema.safeParse(statusRaw);
        if (!parsed.success) return ERRORS.validation(`unknown event status filter: ${statusRaw}`);
        status = parsed.data;
      }
      return jsonResponse({
        events: await runtime.connectorService.listEvents({
          ...(spaceId ? { spaceId } : {}),
          ...(status ? { status } : {}),
        }),
      });
    }),
  );

  router.add(
    "POST",
    "/v1/connectors/events",
    auth(async (request) => {
      if (!runtime.connectorService) return ERRORS.unavailable("connector hub is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = ActivityEventCreateRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid connector event create body", parsed.error.issues);
      return jsonResponse({ event: await runtime.connectorService.createEvent(parsed.data) }, 201);
    }),
  );

  router.add(
    "PATCH",
    "/v1/connectors/events/:id/status",
    auth(async (request, ctx) => {
      if (!runtime.connectorService) return ERRORS.unavailable("connector hub is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = ActivityEventUpdateRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid connector event status body", parsed.error.issues);
      try {
        return jsonResponse({ event: await runtime.connectorService.setEventStatus(ctx.params.id, parsed.data.status) });
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  // --- connect phone (连接手机) IM relay -------------------------------------
  //
  // De-branded port of the original native IM relay. A pluggable IM-provider
  // interface (Feishu is the one reference impl driving `feishu-bridge.mjs`) +
  // a file-backed provider/channel/binding store + a 127.0.0.1-only inbound
  // webhook + the inbound→thread-turn / reply→IM mirror — all behind
  // `runtime.phoneService`. Provider credential secrets are masked on read and
  // merge-masked on write by the store, so a re-PUT of a `********` secret never
  // clobbers the stored value. Every route does real work via the service; the
  // inbound webhook itself is a separate loopback server owned by the service
  // (these management routes stay under the normal bearer `auth`).

  // catalog + relay status ------------------------------------------------
  router.add(
    "GET",
    "/v1/phone/providers/catalog",
    auth(() => {
      // Static per-kind capability/field descriptors for the (future) UI.
      // `supportsQrInstall` is the honest stub flag (always false): the QR
      // device-code login is platform-coupled and is NOT faked here.
      if (!runtime.phoneService) return ERRORS.unavailable("connect phone relay is unavailable");
      return jsonResponse({
        kinds: ProviderKindSchema.options,
        specs: Object.values(PROVIDER_KIND_SPECS),
      });
    }),
  );

  router.add(
    "GET",
    "/v1/phone/status",
    auth(() => {
      if (!runtime.phoneService) return ERRORS.unavailable("connect phone relay is unavailable");
      return jsonResponse(runtime.phoneService.status());
    }),
  );

  router.add(
    "GET",
    "/v1/phone/webhook-status",
    auth(() => {
      // The loopback inbound-webhook bind address (host/port), or null if the
      // relay has not started its webhook yet. The webhook is bound to
      // 127.0.0.1 only and is the inbound surface for `custom` providers.
      if (!runtime.phoneService) return ERRORS.unavailable("connect phone relay is unavailable");
      return jsonResponse({ webhook: runtime.phoneService.webhookInfo() });
    }),
  );

  router.add(
    "POST",
    "/v1/phone/background-mode",
    auth(async (request) => {
      // Toggle background automation at runtime: ON connects every enabled
      // provider transport + arms the reconnect tick; OFF tears them down but
      // keeps the loopback webhook live so management routes still work.
      if (!runtime.phoneService) return ERRORS.unavailable("connect phone relay is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = z.object({ enabled: z.boolean() }).safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid background-mode body", parsed.error.issues);
      await runtime.phoneService.setBackgroundMode(parsed.data.enabled);
      return jsonResponse(runtime.phoneService.status());
    }),
  );

  // providers -------------------------------------------------------------
  router.add(
    "GET",
    "/v1/phone/providers",
    auth(async (request) => {
      if (!runtime.phoneService) return ERRORS.unavailable("connect phone relay is unavailable");
      const url = new URL(request.url);
      const kindRaw = url.searchParams.get("kind");
      let kind: ReturnType<typeof ProviderKindSchema.parse> | undefined;
      if (kindRaw) {
        const parsed = ProviderKindSchema.safeParse(kindRaw);
        if (!parsed.success) return ERRORS.validation(`unknown provider kind: ${kindRaw}`);
        kind = parsed.data;
      }
      return jsonResponse({ providers: await runtime.phoneService.listProviders(kind) });
    }),
  );

  router.add(
    "GET",
    "/v1/phone/providers/:id",
    auth(async (_request, ctx) => {
      if (!runtime.phoneService) return ERRORS.unavailable("connect phone relay is unavailable");
      const provider = await runtime.phoneService.getProvider(ctx.params.id);
      if (!provider) return ERRORS.notFound(`provider not found: ${ctx.params.id}`);
      return jsonResponse({ provider });
    }),
  );

  router.add(
    "POST",
    "/v1/phone/providers",
    auth(async (request) => {
      if (!runtime.phoneService) return ERRORS.unavailable("connect phone relay is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = ImProviderCreateRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid provider create body", parsed.error.issues);
      return jsonResponse({ provider: await runtime.phoneService.createProvider(parsed.data) }, 201);
    }),
  );

  router.add(
    "PATCH",
    "/v1/phone/providers/:id",
    auth(async (request, ctx) => {
      // Merge-masks echoed secrets in the store, then reconciles the live
      // transport (connect on enable, disconnect on disable, restart on a
      // credential change while enabled).
      if (!runtime.phoneService) return ERRORS.unavailable("connect phone relay is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = ImProviderUpdateRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid provider update body", parsed.error.issues);
      try {
        return jsonResponse({ provider: await runtime.phoneService.updateProvider(ctx.params.id, parsed.data) });
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  router.add(
    "DELETE",
    "/v1/phone/providers/:id",
    auth(async (_request, ctx) => {
      if (!runtime.phoneService) return ERRORS.unavailable("connect phone relay is unavailable");
      try {
        return jsonResponse({ provider: await runtime.phoneService.deleteProvider(ctx.params.id) });
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  router.add(
    "POST",
    "/v1/phone/providers/:id/test",
    auth(async (_request, ctx) => {
      // LIGHTWEIGHT connection test ("检测"): required-fields-present for the
      // kind, run on the stored (unmasked) credentials. Live connectivity is the
      // provider's `status` (reported by the bridge `ready`), never a faked probe.
      if (!runtime.phoneService) return ERRORS.unavailable("connect phone relay is unavailable");
      try {
        return jsonResponse(await runtime.phoneService.testProvider(ctx.params.id));
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  router.add(
    "POST",
    "/v1/phone/providers/:id/connect",
    auth(async (_request, ctx) => {
      // Enable + connect the provider's transport (spawn the Feishu bridge /
      // register the loopback webhook). Idempotent; reflects the new status.
      if (!runtime.phoneService) return ERRORS.unavailable("connect phone relay is unavailable");
      try {
        const provider = await runtime.phoneService.updateProvider(ctx.params.id, { enabled: true });
        return jsonResponse({ provider });
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  router.add(
    "POST",
    "/v1/phone/providers/:id/disconnect",
    auth(async (_request, ctx) => {
      // Disable + tear down the provider's transport (kill the bridge child).
      if (!runtime.phoneService) return ERRORS.unavailable("connect phone relay is unavailable");
      try {
        const provider = await runtime.phoneService.updateProvider(ctx.params.id, { enabled: false });
        return jsonResponse({ provider });
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  // channels --------------------------------------------------------------
  router.add(
    "GET",
    "/v1/phone/channels",
    auth(async (request) => {
      if (!runtime.phoneService) return ERRORS.unavailable("connect phone relay is unavailable");
      const url = new URL(request.url);
      const providerId = url.searchParams.get("providerId") ?? undefined;
      return jsonResponse({ channels: await runtime.phoneService.listChannels(providerId) });
    }),
  );

  router.add(
    "GET",
    "/v1/phone/channels/:id",
    auth(async (_request, ctx) => {
      if (!runtime.phoneService) return ERRORS.unavailable("connect phone relay is unavailable");
      const channel = await runtime.phoneService.getChannel(ctx.params.id);
      if (!channel) return ERRORS.notFound(`channel not found: ${ctx.params.id}`);
      return jsonResponse({ channel });
    }),
  );

  router.add(
    "POST",
    "/v1/phone/channels",
    auth(async (request) => {
      if (!runtime.phoneService) return ERRORS.unavailable("connect phone relay is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = ImChannelCreateRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid channel create body", parsed.error.issues);
      try {
        return jsonResponse({ channel: await runtime.phoneService.createChannel(parsed.data) }, 201);
      } catch (error) {
        const message = (error as Error).message;
        if (/already exists/i.test(message)) return ERRORS.conflict(message);
        if (/not found/i.test(message)) return ERRORS.notFound(message);
        throw error;
      }
    }),
  );

  router.add(
    "PATCH",
    "/v1/phone/channels/:id",
    auth(async (request, ctx) => {
      if (!runtime.phoneService) return ERRORS.unavailable("connect phone relay is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = ImChannelUpdateRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid channel update body", parsed.error.issues);
      try {
        return jsonResponse({ channel: await runtime.phoneService.updateChannel(ctx.params.id, parsed.data) });
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  router.add(
    "DELETE",
    "/v1/phone/channels/:id",
    auth(async (_request, ctx) => {
      if (!runtime.phoneService) return ERRORS.unavailable("connect phone relay is unavailable");
      try {
        return jsonResponse({ channel: await runtime.phoneService.deleteChannel(ctx.params.id) });
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  // members (@-mention roster, T2.8) --------------------------------------
  router.add(
    "GET",
    "/v1/phone/channels/:id/members",
    auth(async (_request, ctx) => {
      // The cached @-mention roster for a channel (the composer's mention source).
      if (!runtime.phoneService) return ERRORS.unavailable("connect phone relay is unavailable");
      return jsonResponse({ members: await runtime.phoneService.listMembers(ctx.params.id) });
    }),
  );

  router.add(
    "POST",
    "/v1/phone/channels/:id/members/refresh",
    auth(async (request, ctx) => {
      // Re-fetch a channel's roster from its provider (Feishu bridge
      // `list_chat_members`) and persist it. Requires a live transport; a clear
      // error keeps this from being a dead endpoint.
      if (!runtime.phoneService) return ERRORS.unavailable("connect phone relay is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = RefreshMembersRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid members refresh body", parsed.error.issues);
      try {
        const members = await runtime.phoneService.refreshMembers(ctx.params.id, parsed.data.pageSize);
        return jsonResponse({ members });
      } catch (error) {
        const message = (error as Error).message;
        if (/not found/i.test(message)) return ERRORS.notFound(message);
        // Transport down / member lookup unsupported → 503 (not a 500).
        return ERRORS.unavailable(message);
      }
    }),
  );

  // bindings --------------------------------------------------------------
  router.add(
    "GET",
    "/v1/phone/bindings",
    auth(async (request) => {
      if (!runtime.phoneService) return ERRORS.unavailable("connect phone relay is unavailable");
      const url = new URL(request.url);
      const channelId = url.searchParams.get("channelId") ?? undefined;
      const threadId = url.searchParams.get("threadId") ?? undefined;
      const filter = { ...(channelId ? { channelId } : {}), ...(threadId ? { threadId } : {}) };
      return jsonResponse({ bindings: await runtime.phoneService.listBindings(filter) });
    }),
  );

  router.add(
    "PUT",
    "/v1/phone/bindings",
    auth(async (request) => {
      // Upsert a thread↔channel binding (idempotent on channelId, the native
      // `setNexusChatThreadBinding`). `mirrorInbound`/`mirrorOutbound` toggle the
      // inbound→turn and reply→IM halves of the mirror.
      if (!runtime.phoneService) return ERRORS.unavailable("connect phone relay is unavailable");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = ThreadChannelBindRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid binding body", parsed.error.issues);
      try {
        return jsonResponse({ binding: await runtime.phoneService.upsertBinding(parsed.data) }, 201);
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  router.add(
    "DELETE",
    "/v1/phone/bindings/:channelId",
    auth(async (_request, ctx) => {
      // Unbind a channel (the native unbind, originally a `threadId=""` PUT).
      if (!runtime.phoneService) return ERRORS.unavailable("connect phone relay is unavailable");
      try {
        return jsonResponse({ binding: await runtime.phoneService.deleteBinding(ctx.params.channelId) });
      } catch (error) {
        return ERRORS.notFound((error as Error).message);
      }
    }),
  );

  // --- review ---------------------------------------------------------------

  router.add(
    "POST",
    "/v1/threads/:id/review",
    auth(async (request, ctx) => {
      const reviewService = runtime.reviewService;
      if (!reviewService) return ERRORS.unavailable("review is not available");
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = StartReviewRequest.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid review body", parsed.error.issues);
      const target = parsed.data.target as CanonicalReviewTarget;
      const title = reviewTargetTitle(target);
      try {
        const thread = await runtime.threadService.get(ctx.params.id);
        if (!thread) return ERRORS.notFound(`thread not found: ${ctx.params.id}`);
        // Resolve the diff up front so a non-git workspace (or a bad target)
        // surfaces synchronously as a 4xx rather than failing a started turn.
        await resolveReviewTargetPrompt({ workspace: thread.workspace, target: toGitReviewTarget(target) });
        // Spawn a streaming agent turn: start the turn, attach a `running`
        // review item, then drive the review in the background.
        const started = await runtime.turnService.startTurn({
          threadId: ctx.params.id,
          request: {
            prompt: reviewTargetPrompt(target),
            displayText: title,
            ...(parsed.data.model ? { model: parsed.data.model } : {}),
            mode: "agent",
          } as never,
        });
        const reviewItemId = `item_${started.turnId}_review`;
        await runtime.turnService.applyItem(
          ctx.params.id,
          makeReviewItem({
            id: reviewItemId,
            threadId: ctx.params.id,
            turnId: started.turnId,
            createdAt: runtime.nowIso(),
            target,
            title,
            status: "running",
          }),
        );
        // Background: run the one-shot review pass and finalize the turn. Errors
        // are captured onto the review item / turn by runReviewTurn itself.
        void reviewService
          .runReviewTurn({
            turns: runtime.turnService,
            threadStore: runtime.threadService,
            threadId: ctx.params.id,
            turnId: started.turnId,
            reviewItemId,
            target: toGitReviewTarget(target),
            ...(parsed.data.model ? { model: parsed.data.model } : {}),
          })
          .catch(() => {
            /* runReviewTurn already records failures onto the turn */
          });
        return jsonResponse({ ...started, reviewItemId }, 202);
      } catch (error) {
        if (isReviewWorkspaceNotGitError(error)) {
          return ERRORS.workspaceNotGit((error as Error).message, { workspace: (error as { workspace?: string }).workspace });
        }
        if (error instanceof Error && /not found/i.test(error.message)) return ERRORS.notFound(error.message);
        throw error;
      }
    }),
  );

  // --- debug: llm rounds ----------------------------------------------------

  router.add(
    "GET",
    "/v1/debug/llm-rounds",
    auth(() => {
      // Unconditional newest-first snapshot of the debug ring buffer (empty when
      // no recorder is wired); no 404, no filtering. Faithful to the original
      // llmDebugRoundsResponse.
      return jsonResponse({ rounds: runtime.llmDebug?.list() ?? [] });
    }),
  );

  // --- feishu observe (pluggable transport) ---------------------------------

  router.add(
    "POST",
    "/v1/feishu/observe",
    auth(async (request) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = FeishuObserveRequestSchema.safeParse(body.value);
      if (!parsed.success) return ERRORS.validation("invalid observe body", parsed.error.issues);
      // Forward the observed batch to the group watcher when one is wired; the
      // watcher buffers + debounces it and may emit a suggestion. With no watcher
      // the endpoint is inert. Faithful to the original handleFeishuObserve.
      const watcher = runtime.groupWatcher;
      if (!watcher) {
        return jsonResponse({ accepted: false, reason: "observation_disabled" });
      }
      watcher.observe({
        threadId: parsed.data.threadId,
        chatId: parsed.data.chatId,
        messages: parsed.data.messages,
      });
      return jsonResponse({ accepted: true });
    }),
  );

  // --- delegation diagnostics -----------------------------------------------

  router.add(
    "GET",
    "/v1/delegation/diagnostics",
    auth(async (request) => {
      const url = new URL(request.url);
      const threadId = url.searchParams.get("threadId") ?? undefined;
      const diagnostics = await runtime.delegation?.diagnostics(threadId);
      return jsonResponse(diagnostics ?? { enabled: false, active: 0, childRuns: [], aggregates: [] });
    }),
  );

  // --- mcp diagnostics ------------------------------------------------------

  router.add(
    "GET",
    "/v1/mcp",
    auth(() => {
      const servers = (runtime.mcpHub?.servers ?? []).map((server) => ({
        id: server.config.id,
        command: server.config.command,
        trusted: server.trusted,
        connected: server.connected,
        toolCount: server.descriptors.length,
        ...(server.unavailableReason ? { unavailableReason: server.unavailableReason } : {}),
      }));
      return jsonResponse({
        enabled: Boolean(runtime.mcpHub),
        refreshedAt: runtime.mcpHub?.refreshedAt,
        indexedToolCount: runtime.mcpHub?.indexedToolCount ?? 0,
        servers,
      });
    }),
  );

  return router;
}

/** Resolve an attachment authorization scope from `?thread_id=&workspace=`. */
function attachmentScopeFromQuery(url: URL): { threadId?: string; workspace?: string } {
  // The download authorization scope reads the snake_case `thread_id` (matching
  // the original getAttachmentContent), with `workspace` unchanged.
  const threadId = url.searchParams.get("thread_id") ?? undefined;
  const workspace = url.searchParams.get("workspace") ?? undefined;
  return { ...(threadId ? { threadId } : {}), ...(workspace ? { workspace } : {}) };
}

/** Coerce common truthy/falsy query strings (1/true/yes/on, 0/false/no/off) to boolean. */
const BooleanQuery = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return value;
}, z.boolean());

/** Query schema for GET /v1/threads: positive int limit capped at 500 + boolean coercion. */
const ListThreadsQuery = z.object({
  limit: z.preprocess((value) => {
    if (typeof value !== "string" || value.trim() === "") return undefined;
    return Number(value);
  }, z.number().int().positive().max(500).optional()),
  search: z.string().optional(),
  include_archived: BooleanQuery.optional(),
  archived_only: BooleanQuery.optional(),
  /** Comma-separated opt-in categories; `side` un-hides side conversations. */
  include: z.string().optional(),
});

/** Request body for POST /v1/sessions/:id/resume-thread. */
const ResumeSessionRequest = z.object({
  workspace: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  mode: z.enum(["agent", "plan"]).optional(),
});

/**
 * Text-file extension allowlist for POST /v1/files/write — rejects binary
 * writes (images, archives, executables, …). A reserved plan path is admitted
 * regardless (see the route), but everything else must match one of these.
 */
const WRITABLE_TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdx",
  ".txt",
  ".text",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".env",
  ".csv",
  ".tsv",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".less",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".sh",
  ".bash",
  ".zsh",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".sql",
  ".graphql",
  ".gql",
  ".svg",
  ".vue",
  ".svelte",
]);

/** True when `absolutePath`'s extension is in the writable text allowlist. */
function isAllowedTextExtension(absolutePath: string): boolean {
  return WRITABLE_TEXT_EXTENSIONS.has(extname(absolutePath).toLowerCase());
}

/**
 * Atomically write text to `absolutePath` (mkdir -p the dirname, write a unique
 * temp sibling, then rename). Returns the UTF-8 byte size. Mirrors the
 * create_plan tool's atomic temp+rename so a partial write is never observable.
 */
async function writeWorkspaceTextFile(absolutePath: string, content: string): Promise<number> {
  await mkdir(dirname(absolutePath), { recursive: true });
  const dot = absolutePath.lastIndexOf(".");
  const stem = dot > 0 ? absolutePath.slice(0, dot) : absolutePath;
  const ext = dot > 0 ? absolutePath.slice(dot) : "";
  const tempPath = `${stem}.tmp-${process.pid}-${Date.now()}${ext}`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, absolutePath);
  return Buffer.byteLength(content, "utf8");
}

/** Request body for POST /v1/user-input(s)/:id: structured answers or a cancel.
 *  Canonical shape shared by the frontend client, the gate's UserInputResolution,
 *  and the tool output: answers keyed by question id, plus optional free text. */
const UserInputResolveRequest = z.object({
  status: z.enum(["submitted", "cancelled"]).optional(),
  answers: z.record(z.string()).optional(),
  text: z.string().optional(),
  cancelled: z.boolean().optional(),
});

/** Read a trimmed non-empty string query param from a flattened query record. */
function stringParam(input: Record<string, string>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Reconstruct per-record usage for the requested threads. When the session store
 * exposes the SQLite usage index (`loadUsageRecords`), records are served from the
 * index and only the live in-memory remainder (current counter minus the latest
 * indexed snapshot) is appended. Otherwise this falls back to diffing the ordered
 * persisted `usage` events from each thread's events.jsonl. Faithful to the
 * original /v1/usage route.
 */
async function usageRecords(
  runtime: Runtime,
  options: { threadId?: string } = {},
): Promise<ReconstructedUsageRecord[]> {
  if (typeof runtime.sessionStore.loadUsageRecords === "function") {
    try {
      const indexed = await usageRecordsFromIndex(runtime, options);
      if (indexed) return indexed;
    } catch {
      /* fall through to the JSONL replay path */
    }
  }
  const records: ReconstructedUsageRecord[] = [];
  const explicitThread = options.threadId ? await runtime.threadService.get(options.threadId) : null;
  if (options.threadId && !explicitThread) return records;
  const sources = explicitThread
    ? [{ id: explicitThread.id }]
    : (await runtime.threadService.list()).map((thread) => ({ id: thread.id }));
  for (const source of sources) {
    const thread = explicitThread?.id === source.id ? explicitThread : await runtime.threadService.get(source.id);
    if (!thread) continue;
    const events = await runtime.sessionStore.loadEventsSince(thread.id, 0);
    const usageEvents: PersistedUsageEvent[] = events
      .filter((event) => event.kind === "usage")
      .map((event) => {
        const usageEvent = event as Extract<typeof event, { kind: "usage" }>;
        const usage: UsageSnapshot = usageEvent.usage;
        return {
          seq: usageEvent.seq,
          timestamp: usageEvent.timestamp,
          ...(usageEvent.turnId ? { turnId: usageEvent.turnId } : {}),
          ...(usageEvent.model ? { model: usageEvent.model } : {}),
          usage,
        };
      });
    for (const record of reconstructThreadUsageRecords({
      thread: { id: thread.id, model: thread.model, updatedAt: thread.updatedAt, turns: thread.turns },
      usageEvents,
      liveRemainder: runtime.usageService.forThread(thread.id),
      nowIso: runtime.nowIso(),
    })) {
      records.push(record);
    }
  }
  return records;
}

/**
 * SQLite usage-index fast path: load already-diffed per-record usage straight
 * from the index, then append the live in-memory remainder (current counter
 * minus the latest indexed cumulative snapshot) per thread. Returns null when the
 * requested thread does not exist so the caller can short-circuit to []. Faithful
 * to the original /v1/usage `usageRecords` SQLite branch.
 */
async function usageRecordsFromIndex(
  runtime: Runtime,
  options: { threadId?: string },
): Promise<ReconstructedUsageRecord[] | null> {
  const loadUsageRecords = runtime.sessionStore.loadUsageRecords;
  if (typeof loadUsageRecords !== "function") return null;
  const explicitThread = options.threadId ? await runtime.threadService.get(options.threadId) : null;
  if (options.threadId && !explicitThread) return [];
  const threadSummaries = options.threadId ? [] : await runtime.threadService.list();
  const allowedThreadIds = new Set(options.threadId ? [options.threadId] : threadSummaries.map((thread) => thread.id));

  const indexedRaw = await loadUsageRecords.call(runtime.sessionStore, { threadId: options.threadId });
  const records: ReconstructedUsageRecord[] = indexedRaw
    .filter((record) => allowedThreadIds.has(record.threadId))
    .map((record) => ({
      threadId: record.threadId,
      ...(record.model ? { model: record.model } : {}),
      completedAt: record.completedAt,
      usage: record.usage,
    }));

  const loadLatest = runtime.sessionStore.loadLatestUsageSnapshots;
  const latest =
    typeof loadLatest === "function" && allowedThreadIds.size > 0
      ? await loadLatest.call(runtime.sessionStore, { threadIds: [...allowedThreadIds] })
      : [];
  const latestByThread = new Map(latest.map((record) => [record.threadId, record.usage]));
  const summariesById = new Map(threadSummaries.map((thread) => [thread.id, thread]));
  const liveThreadIds = options.threadId ? [options.threadId] : threadSummaries.map((thread) => thread.id);

  for (const threadId of liveThreadIds) {
    const liveRemainder = diffUsage(
      runtime.usageService.forThread(threadId),
      latestByThread.get(threadId) ?? emptyUsageSnapshot(),
    );
    if (!hasUsage(liveRemainder)) continue;
    const summary = summariesById.get(threadId);
    const thread =
      explicitThread?.id === threadId ? explicitThread : await runtime.threadService.get(threadId);
    if (!thread) continue;
    records.push({
      threadId,
      model: usageRecordModelFromThread(thread, { turnId: thread.turns?.at(-1)?.id }),
      completedAt: thread.updatedAt || summary?.updatedAt || runtime.nowIso(),
      usage: liveRemainder,
    });
  }
  return records;
}

/** Attribute a usage record to a model, preferring the event/turn over the thread default. */
function usageRecordModelFromThread(
  thread: { model?: string; turns?: Array<{ id: string; model?: string }> },
  event: { model?: string; turnId?: string },
): string {
  const eventModel = event.model?.trim();
  if (eventModel) return eventModel;
  const trimmedTurnId = event.turnId?.trim() ?? "";
  if (trimmedTurnId) {
    const turnModel = thread.turns?.find((turn) => turn.id === trimmedTurnId)?.model?.trim();
    if (turnModel) return turnModel;
  }
  const latestTurnModel = [...(thread.turns ?? [])].reverse().find((turn) => turn.model?.trim())?.model?.trim();
  return latestTurnModel || thread.model?.trim() || "unknown";
}

/**
 * Heal session items whose turn already finished (completed/failed/aborted) but
 * whose item status was left pending/running by a crash, persisting the healed
 * items back to the store. Faithful to the original GET /v1/threads/:id healing.
 */
async function healSessionItemsForFinishedTurns(
  thread: Thread,
  items: TurnItem[],
  sessionStore: SessionStore,
): Promise<TurnItem[]> {
  if (items.length === 0 || thread.turns.length === 0) return items;
  const finishedByTurnId = new Map<string, { status: TurnStatus; finishedAt?: string }>();
  for (const turn of thread.turns) {
    if (turn.status === "completed" || turn.status === "failed" || turn.status === "aborted") {
      finishedByTurnId.set(turn.id, { status: turn.status, finishedAt: turn.finishedAt });
    }
  }
  if (finishedByTurnId.size === 0) return items;
  const healedAt = new Date().toISOString();
  const healed: TurnItem[] = [];
  const next = items.map((item) => {
    const finished = finishedByTurnId.get(item.turnId);
    if (!finished) return item;
    const updated = finalizeOpenItem(item, finished.status, finished.finishedAt ?? healedAt);
    if (updated !== item) healed.push(updated);
    return updated;
  });
  if (healed.length === 0) return items;
  for (const item of healed) {
    try {
      await sessionStore.updateItem(thread.id, item.id, item);
    } catch {
      /* best-effort heal; the in-memory hydrated copy is still returned */
    }
  }
  return next;
}

/** Overlay session items onto their turns (the session log is authoritative for items). */
function hydrateThreadItemsFromSession(thread: Thread, items: TurnItem[]): Thread {
  if (items.length === 0 || thread.turns.length === 0) return thread;
  const itemsByTurn = new Map<string, TurnItem[]>();
  for (const item of items) {
    const turnItems = itemsByTurn.get(item.turnId) ?? [];
    turnItems.push(item);
    itemsByTurn.set(item.turnId, turnItems);
  }
  let changed = false;
  const turns = thread.turns.map((turn) => {
    const turnItems = itemsByTurn.get(turn.id);
    if (!turnItems) return turn;
    changed = true;
    return { ...turn, items: turnItems };
  });
  return changed ? { ...thread, turns } : thread;
}

/**
 * Assemble the runtime-observed inputs for {@link buildRuntimeCapabilityManifest}
 * from what the routes layer can see (config + MCP hub + skills runtime). The
 * model metadata is derived from the default model's config entry.
 */
function buildCapabilityManifestInput(
  runtime: Runtime,
  config: NexusConfig,
): Parameters<typeof buildRuntimeCapabilityManifest>[0] {
  const defaultModelId = runtime.models.defaultModelId;
  const modelConfig = config.models.find((model) => model.id === defaultModelId) ?? config.models[0];
  const inputModalities: Array<"text" | "image"> = modelConfig?.supportsImages ? ["text", "image"] : ["text"];
  const messageParts: Array<"text" | "image_url" | "input_image"> = modelConfig?.supportsImages
    ? ["text", "image_url"]
    : ["text"];
  const mcpServers = runtime.mcpHub?.servers ?? [];
  const skills = runtime.skillRuntime?.diagnostics()?.skills ?? [];
  return {
    config: toRuntimeCapabilitiesConfig(config.capabilities),
    model: {
      id: modelConfig?.id ?? defaultModelId,
      inputModalities,
      outputModalities: ["text"],
      supportsToolCalling: modelConfig?.supportsToolCalling ?? true,
      ...(modelConfig?.contextWindowTokens ? { contextWindowTokens: modelConfig.contextWindowTokens } : {}),
      messageParts,
    },
    mcp: {
      configuredServers: mcpServers.length,
      connectedServers: mcpServers.filter((server) => server.connected).length,
      toolCount: runtime.mcpHub?.indexedToolCount ?? 0,
    },
    skills: {
      configuredRoots: config.capabilities?.skills?.roots?.length ?? 0,
      discoveredSkills: skills.length,
    },
    attachments: { available: Boolean(runtime.attachmentStore) },
    memory: { available: Boolean(runtime.memoryStore) },
    delegation: { available: Boolean(runtime.delegation) },
  };
}

/** Request body for POST /v1/feishu/observe: a batch of group messages. */
const FeishuObserveRequestSchema = z.object({
  threadId: z.string().min(1),
  chatId: z.string().min(1),
  messages: z
    .array(
      z.object({
        sender: z.string().default(""),
        text: z.string(),
      }),
    )
    .min(1),
});

/**
 * Restore stored secrets wherever the UI echoed back the masked ("********")
 * sentinel, by walking `incoming` and `current` in parallel. Covers every
 * secret `redactConfig` masks — provider `apiKey`, runtime token, capability
 * `apiKey`s, header/env secrets — not just the provider key. A masked value
 * with no stored counterpart (a new/renamed entry) falls back to empty so the
 * sentinel is never persisted as a real secret (which would be sent as
 * `Bearer ********` and 401); a genuinely empty value stays empty so a secret
 * can be intentionally cleared.
 */
function restoreMaskedSecrets(incoming: unknown, current: unknown): unknown {
  if (incoming === MASKED_SECRET) return typeof current === "string" ? current : "";
  if (Array.isArray(incoming)) {
    const cur = Array.isArray(current) ? current : [];
    return incoming.map((item, i) => restoreMaskedSecrets(item, cur[i]));
  }
  if (incoming && typeof incoming === "object") {
    const cur = (current && typeof current === "object" ? current : {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(incoming)) out[key] = restoreMaskedSecrets(value, cur[key]);
    return out;
  }
  return incoming;
}

/** Preserve stored secrets when the UI submits a masked ("********") value. */
function mergeMaskedSecrets(incoming: NexusConfig, current: NexusConfig): NexusConfig {
  return restoreMaskedSecrets(incoming, current) as NexusConfig;
}
