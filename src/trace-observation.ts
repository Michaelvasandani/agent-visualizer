import { AppServerClient } from "./app-server-client.js";
import {
  evaluateConformance,
  type Finding,
} from "./conformance.js";
import {
  compileObligations,
  type Obligation,
} from "./obligation.js";
import {
  constructSkillContract,
  type RootSkillSelection,
  type SkillAttribution,
  type SkillContract,
} from "./skill-contract.js";
import {
  createNormalizedEvent,
  type JsonObject,
  type NormalizedEvent,
  type TraceEventKind,
} from "./trace-event.js";

export type TerminalOutcome =
  | { readonly kind: "completed" | "cancelled" }
  | { readonly kind: "failed"; readonly error: unknown };

export interface TraceGap {
  readonly afterEventId: string | null;
  readonly historyBoundary:
    | "initial history"
    | "reconnect history"
    | "failed history recovery";
  readonly sources: readonly string[];
  readonly reason: string;
}

export type ObservationLifecycleState =
  | "connecting"
  | "selecting-thread"
  | "observing"
  | "recovering"
  | "evaluating"
  | "completed";

export type EvaluationState =
  | "not-started"
  | "compiling-obligations"
  | "evaluating-findings"
  | "completed"
  | "failed"
  | "skipped";

export type ObservationUpdate =
  | {
      readonly kind: "lifecycle";
      readonly state: ObservationLifecycleState;
      readonly afterEventId?: string | null;
      readonly recoveryComplete?: boolean;
    }
  | { readonly kind: "loaded-threads"; readonly threadIds: readonly string[] }
  | {
      readonly kind: "thread-selected";
      readonly threadId: string;
      readonly automatic: boolean;
    }
  | { readonly kind: "event"; readonly event: NormalizedEvent }
  | { readonly kind: "gap"; readonly gap: TraceGap }
  | { readonly kind: "terminal-outcome"; readonly outcome: TerminalOutcome }
  | {
      readonly kind: "root-skill-candidate";
      readonly rootSkill: RootSkillSelection;
    }
  | {
      readonly kind: "skill-attribution";
      readonly attribution: SkillAttribution;
    }
  | { readonly kind: "skill-contract"; readonly contract: SkillContract }
  | { readonly kind: "obligations"; readonly obligations: readonly Obligation[] }
  | { readonly kind: "findings"; readonly findings: readonly Finding[] }
  | {
      readonly kind: "evaluation-state";
      readonly state: EvaluationState;
      readonly reason?: string;
      readonly error?: unknown;
    };

export interface SkillRunObservation {
  readonly threadId: string;
  readonly cwd: string | null;
  readonly lifecycleState: "completed";
  readonly evaluationState: "completed" | "failed" | "skipped";
  readonly evaluationError: unknown | null;
  readonly events: readonly NormalizedEvent[];
  readonly gaps: readonly TraceGap[];
  readonly terminalOutcome: TerminalOutcome;
  readonly skillAttribution: SkillAttribution;
  readonly skillContract: SkillContract | null;
  readonly obligations: readonly Obligation[];
  readonly findings: readonly Finding[];
}

export interface ObserveSkillRunOptions {
  readonly serverUrl: string;
  readonly selectThread?: (threadIds: readonly string[]) => Promise<string>;
  readonly confirmHistoricalRootSkill?: (
    rootSkill: RootSkillSelection,
  ) => Promise<boolean>;
  readonly onUpdate?: (update: ObservationUpdate) => void;
}

interface LoadedThreadsResponse {
  readonly data: readonly string[];
  readonly nextCursor: string | null;
}

interface ThreadResumeResponse {
  readonly cwd?: string;
  readonly thread: {
    readonly id: string;
    readonly cwd?: string;
    readonly createdAt?: number;
    readonly turns: readonly HistoryTurn[];
  };
}

interface SkillsListResponse {
  readonly data: readonly {
    readonly cwd: string;
    readonly skills: readonly {
      readonly name: string;
      readonly path: string;
      readonly enabled: boolean;
    }[];
  }[];
}

interface HistoryTurn {
  readonly id: string;
  readonly items: readonly JsonObject[];
  readonly itemsView?: "notLoaded" | "summary" | "full";
  readonly status?: string;
  readonly error?: unknown;
  readonly startedAt?: number;
  readonly completedAt?: number;
}

interface TurnWindow {
  readonly startedAt: number | null;
  readonly completedAt: number | null;
}

type LifecycleMethod = "item/started" | "item/completed";

interface IndexedNotification {
  readonly index: number;
  readonly notification: JsonObject;
}

interface ReplayCandidate {
  readonly method: LifecycleMethod;
  readonly payload: JsonObject;
  readonly bufferRank: number | null;
  readonly observationSources: readonly ("history" | "live")[];
}

interface ThreadObservation {
  readonly client: AppServerClient;
  readonly cwd: string | null;
  readonly events: readonly NormalizedEvent[];
  readonly gaps: readonly TraceGap[];
  readonly subscribedThreadIds: readonly string[];
  readonly terminalOutcome: TerminalOutcome;
}

interface RecoveryCheckpoint {
  readonly afterEventId: string | null;
  readonly sourceIds: readonly string[];
}

interface DescendantHistoryReplay {
  readonly completeSourceIds: ReadonlySet<string>;
  readonly subscribedSourceIds: ReadonlySet<string>;
  readonly gaps: readonly DescendantHistoryGap[];
}

interface DescendantHistoryGap {
  readonly sourceId: string;
  readonly reason: string;
}

export async function observeSkillRun(
  options: ObserveSkillRunOptions,
): Promise<SkillRunObservation> {
  const emit = options.onUpdate ?? (() => undefined);
  emitUpdate(emit, { kind: "lifecycle", state: "connecting" });
  let client = await AppServerClient.connect(options.serverUrl);

  try {
    emitUpdate(emit, { kind: "lifecycle", state: "selecting-thread" });
    const threadIds = await listAllLoadedThreads(client);
    emitUpdate(emit, {
      kind: "loaded-threads",
      threadIds: Object.freeze([...threadIds]),
    });
    const selection = await chooseLoadedThread(
      threadIds,
      options.selectThread ?? rejectMultipleThreads,
    );
    const threadId = selection.threadId;
    emitUpdate(emit, { kind: "thread-selected", ...selection });
    emitUpdate(emit, { kind: "evaluation-state", state: "not-started" });
    emitUpdate(emit, { kind: "lifecycle", state: "observing" });

    const observation = await observeResumedThread(
      options.serverUrl,
      client,
      threadId,
      emit,
    );
    client = observation.client;
    emitUpdate(emit, {
      kind: "terminal-outcome",
      outcome: observation.terminalOutcome,
    });
    const skillAttribution = await resolveRootSkillAttribution(
      client,
      observation,
      emit,
      options.confirmHistoricalRootSkill ?? rejectHistoricalRootSkill,
    );
    emitUpdate(emit, { kind: "skill-attribution", attribution: skillAttribution });
    let skillContract: SkillContract | null = null;
    let obligations: readonly Obligation[] = Object.freeze([]);
    let findings: readonly Finding[] = Object.freeze([]);
    let evaluationState: "completed" | "failed" | "skipped";
    let evaluationError: unknown | null = null;
    if (skillAttribution.kind !== "unresolved") {
      emitUpdate(emit, { kind: "lifecycle", state: "evaluating" });
      const { rootSkill } = skillAttribution;
      try {
        skillContract = await constructSkillContract(
          rootSkill,
          observation.cwd ?? undefined,
        );
        emitUpdate(emit, { kind: "skill-contract", contract: skillContract });
        emitUpdate(emit, {
          kind: "evaluation-state",
          state: "compiling-obligations",
        });
        obligations = await compileObligations(client, skillContract);
        emitUpdate(emit, { kind: "obligations", obligations });
        emitUpdate(emit, {
          kind: "evaluation-state",
          state: "evaluating-findings",
        });
        findings = await evaluateConformance(client, {
          rootSkillPath: rootSkill.path,
          obligations,
          events: observation.events,
          gaps: observation.gaps,
          terminalOutcome: observation.terminalOutcome,
        });
        emitUpdate(emit, { kind: "findings", findings });
        evaluationState = "completed";
        emitUpdate(emit, { kind: "evaluation-state", state: evaluationState });
      } catch (error) {
        evaluationState = "failed";
        evaluationError = error;
        emitUpdate(emit, {
          kind: "evaluation-state",
          state: evaluationState,
          error,
        });
      }
    } else {
      evaluationState = "skipped";
      emitUpdate(emit, {
        kind: "evaluation-state",
        state: evaluationState,
        reason: skillAttribution.reason,
      });
    }
    for (const subscribedThreadId of observation.subscribedThreadIds) {
      await client.request("thread/unsubscribe", {
        threadId: subscribedThreadId,
      });
    }
    emitUpdate(emit, { kind: "lifecycle", state: "completed" });
    return Object.freeze({
      threadId,
      cwd: observation.cwd,
      lifecycleState: "completed",
      evaluationState,
      evaluationError,
      events: observation.events,
      gaps: observation.gaps,
      terminalOutcome: observation.terminalOutcome,
      skillAttribution,
      skillContract,
      obligations,
      findings,
    });
  } finally {
    client.close();
  }
}

function emitUpdate(
  emit: (update: ObservationUpdate) => void,
  update: ObservationUpdate,
): void {
  try {
    emit(Object.freeze(update));
  } catch {
    // Observation is process-owned; a failed projection must not stop it.
  }
}

async function rejectHistoricalRootSkill(): Promise<false> {
  return false;
}

async function chooseLoadedThread(
  threadIds: readonly string[],
  selectThread: (threadIds: readonly string[]) => Promise<string>,
): Promise<{
  readonly threadId: string;
  readonly automatic: boolean;
}> {
  const onlyThreadId = threadIds[0];
  if (threadIds.length === 1 && onlyThreadId !== undefined) {
    return Object.freeze({ threadId: onlyThreadId, automatic: true });
  }
  if (threadIds.length === 0) {
    throw new Error("No loaded threads are available to trace.");
  }

  const selectedThreadId = await selectThread(threadIds);
  if (!threadIds.includes(selectedThreadId)) {
    throw new Error("The selected thread is not loaded.");
  }
  return Object.freeze({ threadId: selectedThreadId, automatic: false });
}

async function rejectMultipleThreads(): Promise<never> {
  throw new Error("Multiple loaded threads require an explicit selection.");
}

async function listAllLoadedThreads(
  client: AppServerClient,
): Promise<readonly string[]> {
  const threadIds: string[] = [];
  let cursor: string | null = null;
  do {
    const response: LoadedThreadsResponse =
      await client.request<LoadedThreadsResponse>(
        "thread/loaded/list",
        cursor === null ? {} : { cursor },
      );
    threadIds.push(...response.data);
    cursor = response.nextCursor;
  } while (cursor !== null);
  return threadIds;
}

async function observeResumedThread(
  serverUrl: string,
  initialClient: AppServerClient,
  threadId: string,
  emit: (update: ObservationUpdate) => void,
): Promise<ThreadObservation> {
  const pipeline = new EventPipeline(threadId, (event) =>
    emitUpdate(emit, { kind: "event", event }),
  );
  const gaps: TraceGap[] = [];
  let client = initialClient;
  let cwd: string | null = null;
  let recoveryCheckpoint: RecoveryCheckpoint | null = null;
  let selectedTurnId: string | null = null;

  while (true) {
    let result: Awaited<ReturnType<typeof observeConnection>>;
    try {
      result = await observeConnection(
        client,
        threadId,
        pipeline,
        selectedTurnId,
      );
    } catch (error) {
      if (recoveryCheckpoint === null) throw error;
      const failureGap = recoveryFailureGap(recoveryCheckpoint, error);
      emitUpdate(emit, { kind: "gap", gap: failureGap });
      client.close();
      throw error;
    }
    selectedTurnId = result.selectedTurnId;
    cwd = result.response.cwd ?? result.response.thread.cwd ?? cwd;
    const isRecovery = recoveryCheckpoint !== null;
    const historyCheckpoint = recoveryCheckpoint ?? {
      afterEventId: null,
      sourceIds: pipeline.sourceIds(),
    };
    const historyGaps = findHistoryGaps(
      threadId,
      result.response.thread.turns,
      historyCheckpoint,
      isRecovery ? "reconnect history" : "initial history",
      result.completeSourceIds,
      result.descendantHistoryGaps,
      result.rootNotificationGapReasons,
    );
    gaps.push(...historyGaps);
    for (const gap of historyGaps) {
      emitUpdate(emit, { kind: "gap", gap });
    }
    if (
      isRecovery &&
      selectedThreadItemHistoryIsFull(result.response.thread.turns)
    ) {
      emitUpdate(emit, {
        kind: "lifecycle",
        state: "observing",
        recoveryComplete: true,
      });
    }
    recoveryCheckpoint = null;

    if (result.terminalOutcome !== null) {
      return Object.freeze({
        client,
        cwd,
        events: pipeline.events(),
        gaps: Object.freeze([...gaps]),
        subscribedThreadIds: Object.freeze([...result.subscribedThreadIds]),
        terminalOutcome: result.terminalOutcome,
      });
    }

    recoveryCheckpoint = pipeline.recoveryCheckpoint();
    emitUpdate(emit, {
      kind: "lifecycle",
      state: "recovering",
      afterEventId: recoveryCheckpoint.afterEventId,
    });
    try {
      client = await AppServerClient.connect(serverUrl);
    } catch (error) {
      const failureGap = recoveryFailureGap(recoveryCheckpoint, error);
      emitUpdate(emit, { kind: "gap", gap: failureGap });
      throw error;
    }
  }
}

async function observeConnection(
  client: AppServerClient,
  threadId: string,
  pipeline: EventPipeline,
  selectedTurnId: string | null,
): Promise<{
  readonly response: ThreadResumeResponse;
  readonly selectedTurnId: string | null;
  readonly completeSourceIds: ReadonlySet<string>;
  readonly subscribedThreadIds: ReadonlySet<string>;
  readonly descendantHistoryGaps: readonly DescendantHistoryGap[];
  readonly rootNotificationGapReasons: readonly string[];
  readonly terminalOutcome: TerminalOutcome | null;
}> {
  const bufferedNotifications: JsonObject[] = [];
  let replayingHistory = true;
  let liveTerminalOutcome: TerminalOutcome | null = null;
  let rootTurnWindow: TurnWindow = { startedAt: null, completedAt: null };
  const turnlessRootNotificationMethods = new Set<string>();
  let resolveCompletion: (outcome: TerminalOutcome) => void = () => undefined;
  const completion = new Promise<TerminalOutcome>((resolve) => {
    resolveCompletion = resolve;
  });

  let observedTurnId = selectedTurnId;
  const processNotification = (notification: JsonObject): void => {
    const params = asObject(notification.params);
    if (params === null) return;
    const method = notification.method;
    if (typeof method !== "string") return;
    if (
      params.threadId === threadId &&
      notificationTurnId(params) === null
    ) {
      turnlessRootNotificationMethods.add(method);
    }
    const scoped = scopeRootNotification(params, threadId, observedTurnId);
    observedTurnId = scoped.selectedTurnId;
    if (!scoped.include) return;
    pipeline.append(method, params, ["live"]);
    if (method === "turn/completed" && params.threadId === threadId) {
      const turn = asObject(params.turn);
      rootTurnWindow = mergeTurnWindows(rootTurnWindow, turnWindow(turn));
      liveTerminalOutcome = terminalOutcomeFromTurn(turn);
      if (liveTerminalOutcome !== null) resolveCompletion(liveTerminalOutcome);
    }
  };

  const removeHandler = client.onNotification((notification) => {
    if (replayingHistory) {
      bufferedNotifications.push(notification);
      return;
    }
    processNotification(notification);
  });
  let handlerIsActive = true;
  const stopProcessingNotifications = (): void => {
    if (!handlerIsActive) return;
    handlerIsActive = false;
    removeHandler();
  };

  try {
    const response = await client.request<ThreadResumeResponse>(
      "thread/resume",
      { threadId },
    );
    const selectedHistory = selectedSkillRunHistory(
      response.thread.turns,
      observedTurnId,
    );
    observedTurnId = selectedHistory.turnId;
    const selectedTurns = selectedHistory.turns;
    rootTurnWindow = mergeTurnWindows(
      rootTurnWindow,
      turnWindow(selectedTurns.at(0) ?? null),
    );
    const historicalOutcome = terminalOutcomeFromHistory(selectedTurns);
    const selectedResponse: ThreadResumeResponse = {
      ...response,
      thread: { ...response.thread, turns: selectedTurns },
    };
    const selectedBufferedNotifications = bufferedNotifications.filter(
      (notification) => {
        const params = asObject(notification.params);
        if (params === null) return true;
        if (
          typeof notification.method === "string" &&
          params.threadId === threadId &&
          notificationTurnId(params) === null
        ) {
          turnlessRootNotificationMethods.add(notification.method);
        }
        if (
          historicalOutcome !== null &&
          params.threadId !== threadId
        ) {
          return false;
        }
        const scoped = scopeRootNotification(
          params,
          threadId,
          observedTurnId,
        );
        observedTurnId = scoped.selectedTurnId;
        return scoped.include;
      },
    );
    pipeline.replay(threadId, selectedTurns, selectedBufferedNotifications);
    replayingHistory = false;
    for (const notification of selectedBufferedNotifications) {
      processNotification(notification);
    }
    const terminalOutcome =
      historicalOutcome ??
      liveTerminalOutcome ??
      (await Promise.race([
        completion,
        client.whenClosed().then(() => null),
      ]));
    let descendantReplay: DescendantHistoryReplay;
    if (terminalOutcome === null) {
      descendantReplay = {
        completeSourceIds: new Set([threadId]),
        subscribedSourceIds: new Set([threadId]),
        gaps: [],
      };
    } else {
      stopProcessingNotifications();
      descendantReplay = await replayDescendantHistories(
        client,
        threadId,
        pipeline,
        rootTurnWindow,
      );
    }
    return {
      response: selectedResponse,
      selectedTurnId: observedTurnId,
      completeSourceIds: descendantReplay.completeSourceIds,
      subscribedThreadIds: descendantReplay.subscribedSourceIds,
      descendantHistoryGaps: descendantReplay.gaps,
      rootNotificationGapReasons: Object.freeze(
        [...turnlessRootNotificationMethods].map(
          (method) =>
            `turn-less root notification ${method} could not be attributed to the selected Skill Run`,
        ),
      ),
      terminalOutcome,
    };
  } finally {
    stopProcessingNotifications();
  }
}

async function replayDescendantHistories(
  client: AppServerClient,
  rootThreadId: string,
  pipeline: EventPipeline,
  rootTurnWindow: TurnWindow,
): Promise<DescendantHistoryReplay> {
  const completeSourceIds = new Set([rootThreadId]);
  const subscribedSourceIds = new Set([rootThreadId]);
  const gaps: DescendantHistoryGap[] = [];
  const attemptedSourceIds = new Set([rootThreadId]);
  while (true) {
    const sourceId = pipeline
      .sourceIds()
      .find((candidate) => !attemptedSourceIds.has(candidate));
    if (sourceId === undefined) {
      return Object.freeze({
        completeSourceIds,
        subscribedSourceIds,
        gaps: Object.freeze(gaps),
      });
    }
    attemptedSourceIds.add(sourceId);
    if (
      recordLiveDescendantCoverage(
        sourceId,
        pipeline,
        completeSourceIds,
        gaps,
        "live activity began before descendant history could be reconstructed",
      )
    ) {
      continue;
    }
    try {
      const response = await client.request<ThreadResumeResponse>(
        "thread/resume",
        { threadId: sourceId },
      );
      subscribedSourceIds.add(sourceId);
      const scopedHistory = causallyScopedDescendantHistory(
        response.thread,
        rootTurnWindow,
      );
      const selectedTurns = scopedHistory.turns;
      let historyIsFull = true;
      if (scopedHistory.gapReason !== null) {
        historyIsFull = false;
        gaps.push({ sourceId, reason: scopedHistory.gapReason });
      }
      for (const turn of selectedTurns) {
        if (turn.itemsView !== undefined && turn.itemsView !== "full") {
          historyIsFull = false;
          gaps.push({
            sourceId,
            reason: `turn ${turn.id} itemsView=${turn.itemsView}`,
          });
        }
      }
      if (
        recordLiveDescendantCoverage(
          sourceId,
          pipeline,
          completeSourceIds,
          gaps,
          "live activity arrived before descendant history replay completed",
        )
      ) {
        continue;
      }
      pipeline.replay(sourceId, selectedTurns, []);
      if (historyIsFull) completeSourceIds.add(sourceId);
    } catch {
      // The root trace remains usable; gap reporting identifies this source.
    }
  }
}

function recordLiveDescendantCoverage(
  sourceId: string,
  pipeline: EventPipeline,
  completeSourceIds: Set<string>,
  gaps: DescendantHistoryGap[],
  incompleteReason: string,
): boolean {
  if (!pipeline.hasEvents(sourceId)) return false;
  if (pipeline.hasCompleteLiveCoverage(sourceId)) {
    completeSourceIds.add(sourceId);
  } else {
    gaps.push({ sourceId, reason: incompleteReason });
  }
  return true;
}

function findHistoryGaps(
  threadId: string,
  turns: readonly HistoryTurn[],
  checkpoint: RecoveryCheckpoint,
  historyBoundary: TraceGap["historyBoundary"],
  completeSourceIds: ReadonlySet<string>,
  descendantHistoryGaps: readonly DescendantHistoryGap[],
  rootNotificationGapReasons: readonly string[],
): readonly TraceGap[] {
  const incompleteViews = turns.flatMap((turn) =>
    turn.itemsView !== undefined && turn.itemsView !== "full"
      ? [`turn ${turn.id} itemsView=${turn.itemsView}`]
      : [],
  );
  const rootReasons = [...incompleteViews, ...rootNotificationGapReasons];
  if (historyBoundary === "reconnect history") {
    rootReasons.push(
      "notification-only activity is unavailable from resumed history",
    );
  } else if (turns.length > 0) {
    rootReasons.push(
      "notification-only activity before attachment is unavailable from resumed history",
    );
  }

  const descendantReasons = new Map<string, string[]>();
  for (const gap of descendantHistoryGaps) {
    const reasons = descendantReasons.get(gap.sourceId) ?? [];
    reasons.push(gap.reason);
    descendantReasons.set(gap.sourceId, reasons);
  }
  for (const sourceId of checkpoint.sourceIds) {
    if (sourceId === threadId || completeSourceIds.has(sourceId)) continue;
    const reasons = descendantReasons.get(sourceId) ?? [];
    reasons.push("selected-thread history does not reconstruct this descendant source");
    descendantReasons.set(sourceId, reasons);
  }

  const gaps: TraceGap[] = [];
  if (rootReasons.length > 0) {
    gaps.push(Object.freeze({
      afterEventId: checkpoint.afterEventId,
      historyBoundary,
      sources: Object.freeze([threadId]),
      reason: rootReasons.join("; "),
    }));
  }
  for (const [sourceId, reasons] of descendantReasons) {
    gaps.push(Object.freeze({
      afterEventId: checkpoint.afterEventId,
      historyBoundary,
      sources: Object.freeze([sourceId]),
      reason: reasons.join("; "),
    }));
  }
  return gaps;
}

function selectedThreadItemHistoryIsFull(
  turns: readonly HistoryTurn[],
): boolean {
  return turns.every(
    (turn) => turn.itemsView === undefined || turn.itemsView === "full",
  );
}

function selectedSkillRunHistory(
  turns: readonly HistoryTurn[],
  selectedTurnId: string | null,
): {
  readonly turnId: string | null;
  readonly turns: readonly HistoryTurn[];
} {
  const selectedTurn =
    selectedTurnId === null
      ? turns.at(-1)
      : turns.find((turn) => turn.id === selectedTurnId);
  if (
    selectedTurnId !== null &&
    selectedTurn === undefined &&
    turns.length > 0
  ) {
    throw new Error(
      `selected Skill Run turn ${selectedTurnId} is unavailable from resumed history`,
    );
  }
  return selectedTurn === undefined
    ? { turnId: selectedTurnId, turns: [] }
    : { turnId: selectedTurn.id, turns: [selectedTurn] };
}

function notificationTurnId(params: JsonObject): string | null {
  if (typeof params.turnId === "string") return params.turnId;
  const turn = asObject(params.turn);
  return typeof turn?.id === "string" ? turn.id : null;
}

function scopeRootNotification(
  params: JsonObject,
  rootThreadId: string,
  selectedTurnId: string | null,
): { readonly selectedTurnId: string | null; readonly include: boolean } {
  if (params.threadId !== rootThreadId) {
    return { selectedTurnId, include: true };
  }
  const turnId = notificationTurnId(params);
  if (turnId === null) return { selectedTurnId, include: false };
  if (selectedTurnId === null) {
    return { selectedTurnId: turnId, include: true };
  }
  return { selectedTurnId, include: turnId === selectedTurnId };
}

function turnWindow(turn: JsonObject | HistoryTurn | null): TurnWindow {
  return {
    startedAt:
      typeof turn?.startedAt === "number" ? turn.startedAt : null,
    completedAt:
      typeof turn?.completedAt === "number" ? turn.completedAt : null,
  };
}

function mergeTurnWindows(left: TurnWindow, right: TurnWindow): TurnWindow {
  return {
    startedAt: left.startedAt ?? right.startedAt,
    completedAt: left.completedAt ?? right.completedAt,
  };
}

function causallyScopedDescendantHistory(
  thread: ThreadResumeResponse["thread"],
  rootTurnWindow: TurnWindow,
): {
  readonly turns: readonly HistoryTurn[];
  readonly gapReason: string | null;
} {
  const lowerBounds = [rootTurnWindow.startedAt, thread.createdAt].filter(
    (value): value is number => value !== null && value !== undefined,
  );
  const lowerBound =
    lowerBounds.length === 0 ? null : Math.max(...lowerBounds);
  const upperBound = rootTurnWindow.completedAt;
  if (lowerBound === null || upperBound === null) {
    return {
      turns: [],
      gapReason:
        "causal child-turn boundary is unavailable; descendant history was not guessed",
    };
  }
  if (
    thread.turns.some(
      (turn) =>
        typeof turn.startedAt !== "number" ||
        typeof turn.completedAt !== "number",
    )
  ) {
    return {
      turns: [],
      gapReason:
        "child-turn timestamps are unavailable; descendant history was not guessed",
    };
  }

  const turns = thread.turns.filter(
    (turn) =>
      (turn.startedAt ?? Number.NEGATIVE_INFINITY) >= lowerBound &&
      (turn.completedAt ?? Number.POSITIVE_INFINITY) <= upperBound,
  );
  return turns.length === 0
    ? {
        turns,
        gapReason:
          "no descendant turn falls within the selected Root Skill turn",
      }
    : { turns, gapReason: null };
}

function recoveryFailureGap(
  checkpoint: RecoveryCheckpoint,
  error: unknown,
): TraceGap {
  const reason = error instanceof Error ? error.message : String(error);
  return Object.freeze({
    afterEventId: checkpoint.afterEventId,
    historyBoundary: "failed history recovery",
    sources: Object.freeze([...checkpoint.sourceIds]),
    reason,
  });
}

function terminalOutcomeFromHistory(
  turns: readonly HistoryTurn[],
): TerminalOutcome | null {
  const latestTurn = turns.at(-1);
  return latestTurn === undefined
    ? null
    : terminalOutcome(latestTurn.status, latestTurn.error);
}

function terminalOutcomeFromTurn(turn: JsonObject | null): TerminalOutcome | null {
  return terminalOutcome(
    typeof turn?.status === "string" ? turn.status : "completed",
    turn?.error,
  );
}

function terminalOutcome(status: string | undefined, error: unknown): TerminalOutcome | null {
  if (status === "completed") return { kind: "completed" };
  if (status === "interrupted") return { kind: "cancelled" };
  if (status === "failed") return { kind: "failed", error };
  return null;
}

async function resolveRootSkillAttribution(
  client: AppServerClient,
  observation: ThreadObservation,
  emit: (update: ObservationUpdate) => void,
  confirmHistoricalRootSkill: (
    rootSkill: RootSkillSelection,
  ) => Promise<boolean>,
): Promise<SkillAttribution> {
  const exactSelections = uniqueRootSkills(
    observation.events.flatMap((event) =>
      event.observationSources.includes("live")
        ? structuredSkillSelections(event)
        : [],
    ),
  );
  const exactRootSkill = exactSelections[0];
  if (exactSelections.length === 1 && exactRootSkill !== undefined) {
    return { kind: "exact", rootSkill: exactRootSkill };
  }
  if (exactSelections.length > 1) {
    return unresolvedAttribution(
      "structured live metadata identified multiple Root Skills",
    );
  }

  const mentionedNames = historicalSkillMentions(observation.events);
  if (mentionedNames.length === 0) {
    return unresolvedAttribution(
      "replayed prompt text did not identify a Root Skill candidate",
    );
  }
  if (mentionedNames.length > 1 || observation.cwd === null) {
    return unresolvedAttribution(
      mentionedNames.length > 1
        ? `replayed prompt text mentioned multiple skills: ${mentionedNames.join(", ")}`
        : "the historical thread working directory is unavailable",
    );
  }

  const mentionedName = mentionedNames[0];
  if (mentionedName === undefined) {
    return unresolvedAttribution("no Root Skill candidate was found");
  }
  const response = await client.request<SkillsListResponse>("skills/list", {
    cwds: [observation.cwd],
  });
  const matchingSkills = uniqueRootSkills(
    response.data.flatMap((entry) =>
      entry.skills
        .filter((skill) => skill.enabled && skill.name === mentionedName)
        .map(({ name, path: skillPath }) => ({ name, path: skillPath })),
    ),
  );
  const candidate = matchingSkills[0];
  if (matchingSkills.length !== 1 || candidate === undefined) {
    return unresolvedAttribution(
      `historical mention ${JSON.stringify(`$${mentionedName}`)} did not resolve to exactly one enabled skill`,
    );
  }

  emitUpdate(emit, { kind: "root-skill-candidate", rootSkill: candidate });
  if (!(await confirmHistoricalRootSkill(candidate))) {
    return unresolvedAttribution(
      `developer rejected historical candidate ${JSON.stringify(candidate.name)}`,
    );
  }
  return { kind: "confirmed", rootSkill: candidate };
}

function unresolvedAttribution(
  reason: string,
): SkillAttribution {
  return { kind: "unresolved", reason };
}

function historicalSkillMentions(
  events: readonly NormalizedEvent[],
): readonly string[] {
  const historicalUserEvents = events.filter(
    (event) =>
      event.kind === "user" && event.observationSources.includes("history"),
  );
  const latestTurnId = historicalUserEvents.at(-1)?.causalParentId;
  if (latestTurnId === undefined) return [];
  const names = new Set<string>();
  for (const event of historicalUserEvents) {
    if (event.causalParentId !== latestTurnId) continue;
    const item = asObject(event.payload.item);
    if (item === null) continue;
    if (item.type !== "userMessage" || !Array.isArray(item.content)) continue;
    for (const contentItem of item.content) {
      const content = asObject(contentItem);
      if (content?.type !== "text" || typeof content.text !== "string") {
        continue;
      }
      const placeholders = Array.isArray(content.text_elements)
        ? content.text_elements
        : Array.isArray(content.textElements)
          ? content.textElements
          : [];
      for (const element of placeholders) {
        const placeholder = asObject(element)?.placeholder;
        if (typeof placeholder === "string") addSkillMention(names, placeholder);
      }
      for (const match of content.text.matchAll(/(?:^|[^\w])\$([a-z\d][\w:-]*)/gi)) {
        const name = match[1];
        if (name !== undefined) names.add(name);
      }
    }
  }
  return [...names];
}

function addSkillMention(names: Set<string>, placeholder: string): void {
  const match = /^\$([a-z\d][\w:-]*)$/i.exec(placeholder.trim());
  if (match?.[1] !== undefined) names.add(match[1]);
}

function structuredSkillSelections(
  event: NormalizedEvent,
): readonly RootSkillSelection[] {
  if (event.method !== "item/started" && event.method !== "item/completed") {
    return [];
  }
  const item = asObject(event.payload.item);
  if (item?.type !== "userMessage" || !Array.isArray(item.content)) return [];

  const selections: RootSkillSelection[] = [];
  for (const contentItem of item.content) {
    const content = asObject(contentItem);
    if (
      content?.type === "skill" &&
      typeof content.name === "string" &&
      typeof content.path === "string"
    ) {
      selections.push({ name: content.name, path: content.path });
    }
  }
  return selections;
}

function uniqueRootSkills(
  selections: readonly RootSkillSelection[],
): readonly RootSkillSelection[] {
  const unique = new Map(
    selections.map((selection) => [
      `${selection.name}\0${selection.path}`,
      selection,
    ]),
  );
  return [...unique.values()];
}

class EventPipeline {
  readonly #emitEvent: (event: NormalizedEvent) => void;
  readonly #seenEventIds = new Set<string>();
  readonly #events: NormalizedEvent[] = [];
  readonly #knownSourceIds: Set<string>;
  readonly #sourceParents = new Map<string, string>();
  readonly #sourceDepths = new Map<string, number>();
  readonly #sourceSequences = new Map<string, number>();
  readonly #completeLiveCoverageSourceIds = new Set<string>();
  readonly #pendingBySource = new Map<
    string,
    Array<{
      readonly method: string;
      readonly params: JsonObject;
      readonly observationSources: readonly ("history" | "live")[];
    }>
  >();

  constructor(threadId: string, emitEvent: (event: NormalizedEvent) => void) {
    this.#emitEvent = emitEvent;
    this.#knownSourceIds = new Set([threadId]);
    this.#sourceDepths.set(threadId, 0);
  }

  events(): readonly NormalizedEvent[] {
    return Object.freeze([...this.#events]);
  }

  recoveryCheckpoint(): RecoveryCheckpoint {
    return Object.freeze({
      afterEventId: this.#events.at(-1)?.id ?? null,
      sourceIds: Object.freeze([...this.#knownSourceIds]),
    });
  }

  sourceIds(): readonly string[] {
    return Object.freeze([...this.#knownSourceIds]);
  }

  hasEvents(sourceId: string): boolean {
    return this.#events.some((event) => event.sourceId === sourceId);
  }

  hasCompleteLiveCoverage(sourceId: string): boolean {
    return this.#completeLiveCoverageSourceIds.has(sourceId);
  }

  replay(
    sourceId: string,
    turns: readonly HistoryTurn[],
    bufferedNotifications: JsonObject[],
  ): void {
    const candidates: ReplayCandidate[] = [];
    const consumedNotificationIndexes = new Set<number>();
    for (const turn of turns) {
      for (const item of turn.items) {
        const historyParams = {
          threadId: sourceId,
          turnId: turn.id,
          item,
        };
        const method = historyMethod(item);
        const overlapping = findItemNotifications(
          bufferedNotifications,
          sourceId,
          turn.id,
          item.id,
          method,
        );
        const predecessors =
          method === "item/completed"
            ? findItemNotifications(
                bufferedNotifications,
                sourceId,
                turn.id,
                item.id,
                "item/started",
              )
            : [];
        const predecessorPayload = mergeNotificationPayloads(
          predecessors.map(({ notification }) => notification),
        );
        if (predecessorPayload !== null) {
          candidates.push({
            method: "item/started",
            payload: predecessorPayload,
            bufferRank: minimumIndex(predecessors),
            observationSources: ["live"],
          });
        }
        const payload = overlapping.reduce<JsonObject>(
          (combined, { notification }) => {
            const params = asObject(notification.params);
            return params === null
              ? combined
              : mergeEventPayload(combined, params);
          },
          historyParams,
        );
        candidates.push({
          method,
          payload,
          bufferRank: minimumIndex(overlapping),
          observationSources:
            overlapping.length === 0 ? ["history"] : ["history", "live"],
        });
        for (const { index } of overlapping.concat(predecessors)) {
          consumedNotificationIndexes.add(index);
        }
      }
    }

    const anchoredCandidates = candidates
      .filter((candidate) => candidate.bufferRank !== null)
      .sort(
        (left, right) =>
          (left.bufferRank ?? Number.MAX_SAFE_INTEGER) -
          (right.bufferRank ?? Number.MAX_SAFE_INTEGER),
      );
    let anchoredIndex = 0;
    const orderedCandidates = candidates.map((candidate) =>
      candidate.bufferRank === null
        ? candidate
        : (anchoredCandidates[anchoredIndex++] ?? candidate),
    );
    for (const candidate of orderedCandidates) {
      this.append(
        candidate.method,
        candidate.payload,
        candidate.observationSources,
      );
    }

    const remainingNotifications = bufferedNotifications.filter(
      (_notification, index) => !consumedNotificationIndexes.has(index),
    );
    bufferedNotifications.splice(
      0,
      bufferedNotifications.length,
      ...remainingNotifications,
    );
  }

  append(
    method: string,
    params: JsonObject,
    observationSources: readonly ("history" | "live")[],
  ): void {
    const sourceId = notificationSourceId(params);
    if (sourceId === null) return;
    if (!this.#knownSourceIds.has(sourceId)) {
      const pending = this.#pendingBySource.get(sourceId) ?? [];
      pending.push({ method, params, observationSources });
      this.#pendingBySource.set(sourceId, pending);
      return;
    }
    this.#appendKnown(method, params, observationSources, sourceId);
  }

  #appendKnown(
    method: string,
    params: JsonObject,
    observationSources: readonly ("history" | "live")[],
    sourceId: string,
  ): void {
    const kind = traceKind(method, params);
    const item = asObject(params.item);
    const itemId =
      typeof item?.id === "string"
        ? item.id
        : typeof params.itemId === "string"
          ? params.itemId
          : null;
    const turn = asObject(params.turn);
    const turnId =
      typeof params.turnId === "string"
        ? params.turnId
        : typeof turn?.id === "string"
          ? turn.id
          : null;
    const sourceSequence = (this.#sourceSequences.get(sourceId) ?? 0) + 1;
    const eventId = eventIdentity(
      sourceId,
      sourceSequence,
      method,
      turnId,
      itemId,
    );
    if (this.#seenEventIds.has(eventId)) return;
    this.#seenEventIds.add(eventId);
    this.#sourceSequences.set(sourceId, sourceSequence);

    const sourceParentId = this.#sourceParents.get(sourceId) ?? null;
    const event = createNormalizedEvent({
      id: eventId,
      sourceId,
      sourceSequence,
      causalParentId: causalParentId(sourceId, turnId, itemId, method, sourceParentId),
      sourceParentId,
      sourceDepth: this.#sourceDepths.get(sourceId) ?? 0,
      method,
      kind,
      timing: eventTiming(params, item),
      observationSources,
      payload: params,
    });
    this.#events.push(event);
    this.#emitEvent(event);
    this.#registerDescendantSource(event);
  }

  #registerDescendantSource(event: NormalizedEvent): void {
    const item = asObject(event.payload.item);
    if (item === null) return;
    const isSpawnCall =
      (item.type === "collabToolCall" || item.type === "collabAgentToolCall") &&
      (item.tool === "spawnAgent" || item.tool === "spawn_agent");
    const isSubagentActivity = item.type === "subAgentActivity";
    if (!isSpawnCall && !isSubagentActivity) return;
    const reportedReceiverIds =
      isSpawnCall && Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds
        : [];
    for (const candidate of [
      ...reportedReceiverIds,
      ...(isSpawnCall ? [item.newThreadId, item.receiverThreadId] : []),
      ...(isSubagentActivity ? [item.agentThreadId] : []),
    ]) {
      if (
        typeof candidate !== "string" ||
        candidate === event.sourceId ||
        this.#knownSourceIds.has(candidate)
      ) {
        continue;
      }
      this.#knownSourceIds.add(candidate);
      const observedLiveStart =
        event.observationSources.length === 1 &&
        event.observationSources[0] === "live" &&
        ((isSpawnCall &&
          (event.method === "item/started" || item.status === "inProgress")) ||
          (isSubagentActivity && item.kind === "started"));
      if (observedLiveStart) {
        this.#completeLiveCoverageSourceIds.add(candidate);
      }
      this.#sourceParents.set(candidate, event.id);
      this.#sourceDepths.set(candidate, event.sourceDepth + 1);
      const pending = this.#pendingBySource.get(candidate) ?? [];
      this.#pendingBySource.delete(candidate);
      for (const queued of pending) {
        this.#appendKnown(
          queued.method,
          queued.params,
          queued.observationSources,
          candidate,
        );
      }
    }
  }
}

function notificationSourceId(params: JsonObject): string | null {
  if (typeof params.threadId === "string") return params.threadId;
  const thread = asObject(params.thread);
  return typeof thread?.id === "string" ? thread.id : null;
}

function eventIdentity(
  sourceId: string,
  sourceSequence: number,
  method: string,
  turnId: string | null,
  itemId: unknown,
): string {
  if (
    (method === "item/started" || method === "item/completed") &&
    turnId !== null &&
    typeof itemId === "string"
  ) {
    const lifecycle = method === "item/started" ? "started" : "completed";
    return `${sourceId}/${turnId}/${itemId}/${lifecycle}`;
  }
  if (
    (method === "turn/started" || method === "turn/completed") &&
    turnId !== null
  ) {
    const lifecycle = method === "turn/started" ? "started" : "completed";
    return `${sourceId}/${turnId}/turn/${lifecycle}`;
  }
  return `${sourceId}/event/${sourceSequence}`;
}

function causalParentId(
  sourceId: string,
  turnId: string | null,
  itemId: unknown,
  method: string,
  sourceParentId: string | null,
): string | null {
  if (turnId === null) return sourceParentId;
  if (
    method !== "item/started" &&
    method !== "item/completed" &&
    typeof itemId === "string"
  ) {
    return `${sourceId}/${turnId}/${itemId}`;
  }
  return `${sourceId}/${turnId}`;
}

function eventTiming(
  params: JsonObject,
  item: JsonObject | null,
): {
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly startedAtMs?: number;
  readonly completedAtMs?: number;
  readonly durationMs?: number;
} | null {
  const timing: {
    startedAt?: number;
    completedAt?: number;
    startedAtMs?: number;
    completedAtMs?: number;
    durationMs?: number;
  } = {};
  const turn = asObject(params.turn);
  if (typeof turn?.startedAt === "number") timing.startedAt = turn.startedAt;
  if (typeof turn?.completedAt === "number") timing.completedAt = turn.completedAt;
  if (typeof params.startedAtMs === "number") timing.startedAtMs = params.startedAtMs;
  if (typeof params.completedAtMs === "number") {
    timing.completedAtMs = params.completedAtMs;
  }
  const durationMs =
    typeof params.durationMs === "number"
      ? params.durationMs
      : typeof item?.durationMs === "number"
        ? item.durationMs
        : turn?.durationMs;
  if (typeof durationMs === "number") timing.durationMs = durationMs;
  return Object.keys(timing).length === 0 ? null : timing;
}

function historyMethod(item: JsonObject): LifecycleMethod {
  return item.status === "inProgress" || item.type === "userMessage"
    ? "item/started"
    : "item/completed";
}

function findItemNotifications(
  notifications: readonly JsonObject[],
  threadId: string,
  turnId: string,
  itemId: unknown,
  method: LifecycleMethod,
): IndexedNotification[] {
  if (typeof itemId !== "string") return [];
  const matches: IndexedNotification[] = [];
  for (let index = 0; index < notifications.length; index += 1) {
    const notification = notifications[index];
    const params = asObject(notification?.params);
    const item = asObject(params?.item);
    if (
      notification?.method === method &&
      params?.threadId === threadId &&
      params.turnId === turnId &&
      item?.id === itemId
    ) {
      if (notification !== undefined) matches.push({ index, notification });
    }
  }
  return matches;
}

function minimumIndex(
  notifications: readonly IndexedNotification[],
): number | null {
  if (notifications.length === 0) return null;
  return Math.min(...notifications.map(({ index }) => index));
}

function mergeNotificationPayloads(
  notifications: readonly JsonObject[],
): JsonObject | null {
  let combined: JsonObject | null = null;
  for (const notification of notifications) {
    const params = asObject(notification.params);
    if (params === null) continue;
    combined = combined === null ? params : mergeEventPayload(combined, params);
  }
  return combined;
}

function mergeEventPayload(
  earlierPayload: JsonObject,
  laterPayload: JsonObject,
): JsonObject {
  const earlierItem = asObject(earlierPayload.item) ?? {};
  const laterItem = asObject(laterPayload.item) ?? {};
  return {
    ...earlierPayload,
    ...laterPayload,
    item: { ...earlierItem, ...laterItem },
  };
}

function traceKind(method: string, params: JsonObject): TraceEventKind {
  if (method === "error") return "error";
  if (method === "thread/tokenUsage/updated") return "resource";
  if (
    method === "thread/started" ||
    method === "thread/closed" ||
    method === "thread/status/changed"
  ) {
    return "thread";
  }
  if (method === "turn/started" || method === "turn/completed") return "turn";
  if (
    method === "item/commandExecution/outputDelta" ||
    method === "item/commandExecution/terminalInteraction"
  ) {
    return "command";
  }
  if (
    method === "item/fileChange/patchUpdated" ||
    method === "item/fileChange/outputDelta" ||
    method === "turn/diff/updated"
  ) {
    return "file-change";
  }
  if (method === "item/agentMessage/delta") return "agent";
  if (method === "item/plan/delta" || method === "turn/plan/updated") {
    return "plan";
  }
  if (
    method === "item/reasoning/summaryTextDelta" ||
    method === "item/reasoning/summaryPartAdded" ||
    method === "item/reasoning/textDelta"
  ) {
    return "reasoning";
  }
  if (method === "item/mcpToolCall/progress") return "tool";
  if (method !== "item/started" && method !== "item/completed") {
    return "unknown";
  }
  const item = asObject(params.item);
  const itemType = item?.type;
  if (itemType === "userMessage") return "user";
  if (itemType === "agentMessage") return "agent";
  if (itemType === "reasoning") return "reasoning";
  if (itemType === "plan") return "plan";
  if (itemType === "commandExecution") return "command";
  if (itemType === "fileChange") return "file-change";
  if (itemType === "collabToolCall" || itemType === "collabAgentToolCall") {
    return "collaboration";
  }
  if (itemType === "subAgentActivity") return "collaboration";
  if (itemType === "sleep") return "duration";
  if (
    itemType === "mcpToolCall" ||
    itemType === "dynamicToolCall" ||
    itemType === "webSearch" ||
    itemType === "imageView" ||
    itemType === "imageGeneration"
  ) {
    return "tool";
  }
  return "unknown";
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null
    ? (value as JsonObject)
    : null;
}
