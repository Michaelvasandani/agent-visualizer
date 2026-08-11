import { AppServerClient } from "./app-server-client.js";
import {
  evaluateConformance,
  renderFindings,
  type Finding,
} from "./conformance.js";
import {
  compileObligations,
  renderObligations,
  type Obligation,
} from "./obligation.js";
import {
  exportSavedTrace,
  SAVED_TRACE_SENSITIVE_DATA_WARNING,
} from "./saved-trace.js";
import {
  constructSkillContract,
  renderSkillContract,
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
import type { TerminalOutcome, TraceGap } from "./trace-observation.js";
import {
  projectTraceEvents,
  renderSkillAttribution,
  renderTerminalOutcome,
  renderTraceIntegrity,
} from "./trace-projection.js";

interface LoadedThreadsResponse {
  readonly data: readonly string[];
  readonly nextCursor: string | null;
}

interface ThreadResumeResponse {
  readonly cwd?: string;
  readonly thread: {
    readonly id: string;
    readonly cwd?: string;
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

const SENSITIVE_DATA_WARNING =
  "WARNING: THIS LIVE TRACE CONTAINS UNREDACTED SENSITIVE INFORMATION. " +
  "Prompts, credentials, paths, proprietary content, and personal data may be " +
  "exposed in terminal output; Skill Contracts and Traces are sent unredacted " +
  "to OpenAI by Evaluation Runs.";

export async function traceLoadedThread(
  serverUrl: string,
  writeLine: (line: string) => void,
  selectThread: (threadIds: readonly string[]) => Promise<string> =
    rejectMultipleThreads,
  confirmHistoricalRootSkill: (
    rootSkill: RootSkillSelection,
  ) => Promise<boolean> = rejectHistoricalRootSkill,
  exportPath?: string,
): Promise<void> {
  writeLine(SENSITIVE_DATA_WARNING);
  let client = await AppServerClient.connect(serverUrl);

  try {
    const threadIds = await listAllLoadedThreads(client);
    const threadId = await chooseLoadedThread(threadIds, writeLine, selectThread);
    writeLine(
      "Live Trace note: per-source sequence and causal links are authoritative; append-only line position is not a total order across concurrent sources.",
    );

    const observation = await observeResumedThread(
      serverUrl,
      client,
      threadId,
      writeLine,
    );
    client = observation.client;
    renderTerminalOutcome(observation.terminalOutcome, writeLine);
    renderTraceIntegrity(observation.gaps, writeLine);
    const skillAttribution = await resolveRootSkillAttribution(
      client,
      observation,
      writeLine,
      confirmHistoricalRootSkill,
    );
    renderSkillAttribution(skillAttribution, writeLine);
    let skillContract: SkillContract | null = null;
    let obligations: readonly Obligation[] = Object.freeze([]);
    let findings: readonly Finding[] = Object.freeze([]);
    if (skillAttribution.kind !== "unresolved") {
      const { rootSkill } = skillAttribution;
      skillContract = await constructSkillContract(
        rootSkill,
        observation.cwd ?? undefined,
      );
      for (const line of renderSkillContract(skillContract)) writeLine(line);
      obligations = await compileObligations(client, skillContract);
      for (const line of renderObligations(obligations)) writeLine(line);
      findings = await evaluateConformance(client, {
        rootSkillPath: rootSkill.path,
        obligations,
        events: observation.events,
        gaps: observation.gaps,
        terminalOutcome: observation.terminalOutcome,
      });
      for (const line of renderFindings(findings)) writeLine(line);
    }
    if (exportPath !== undefined) {
      writeLine(SAVED_TRACE_SENSITIVE_DATA_WARNING);
      await exportSavedTrace(exportPath, {
        run: { threadId, cwd: observation.cwd },
        terminalOutcome: observation.terminalOutcome,
        traceIntegrity: {
          complete: observation.gaps.length === 0,
          gaps: observation.gaps,
        },
        skillAttribution,
        skillContract,
        obligations,
        events: observation.events,
        findings,
      });
      writeLine(`Saved Trace exported to ${exportPath}`);
    }
    for (const subscribedThreadId of observation.subscribedThreadIds) {
      await client.request("thread/unsubscribe", {
        threadId: subscribedThreadId,
      });
    }
  } finally {
    client.close();
  }
}

async function rejectHistoricalRootSkill(): Promise<false> {
  return false;
}

async function chooseLoadedThread(
  threadIds: readonly string[],
  writeLine: (line: string) => void,
  selectThread: (threadIds: readonly string[]) => Promise<string>,
): Promise<string> {
  const onlyThreadId = threadIds[0];
  if (threadIds.length === 1 && onlyThreadId !== undefined) {
    writeLine(`Automatically selected the only loaded thread: ${onlyThreadId}`);
    return onlyThreadId;
  }
  if (threadIds.length === 0) {
    throw new Error("No loaded threads are available to trace.");
  }

  writeLine("Multiple loaded threads are available:");
  threadIds.forEach((threadId, index) => {
    writeLine(`${index + 1}. ${threadId}`);
  });
  const selectedThreadId = await selectThread(threadIds);
  if (!threadIds.includes(selectedThreadId)) {
    throw new Error("The selected thread is not loaded.");
  }
  writeLine(`Selected loaded thread: ${selectedThreadId}`);
  return selectedThreadId;
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
  writeLine: (line: string) => void,
): Promise<ThreadObservation> {
  const pipeline = new EventPipeline(threadId, writeLine);
  const gaps: TraceGap[] = [];
  let client = initialClient;
  let cwd: string | null = null;
  let recoveryCheckpoint: RecoveryCheckpoint | null = null;

  while (true) {
    let result: Awaited<ReturnType<typeof observeConnection>>;
    try {
      result = await observeConnection(client, threadId, pipeline);
    } catch (error) {
      if (recoveryCheckpoint === null) throw error;
      const failureGap = recoveryFailureGap(recoveryCheckpoint, error);
      renderTraceIntegrity([...gaps, failureGap], writeLine);
      client.close();
      throw error;
    }
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
    );
    gaps.push(...historyGaps);
    if (
      isRecovery &&
      selectedThreadItemHistoryIsFull(result.response.thread.turns)
    ) {
      writeLine(
        "Available item history recovery complete; resumed live observation without duplicate Events.",
      );
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
    writeLine(
      `Connection interruption detected after ${recoveryCheckpoint.afterEventId ?? "observation start"}.`,
    );
    writeLine("Attempting history recovery before continuing live observation.");
    try {
      client = await AppServerClient.connect(serverUrl);
    } catch (error) {
      const failureGap = recoveryFailureGap(recoveryCheckpoint, error);
      renderTraceIntegrity([...gaps, failureGap], writeLine);
      throw error;
    }
  }
}

async function observeConnection(
  client: AppServerClient,
  threadId: string,
  pipeline: EventPipeline,
): Promise<{
  readonly response: ThreadResumeResponse;
  readonly completeSourceIds: ReadonlySet<string>;
  readonly subscribedThreadIds: ReadonlySet<string>;
  readonly descendantHistoryGaps: readonly DescendantHistoryGap[];
  readonly terminalOutcome: TerminalOutcome | null;
}> {
  const bufferedNotifications: JsonObject[] = [];
  let replayingHistory = true;
  let liveTerminalOutcome: TerminalOutcome | null = null;
  let resolveCompletion: (outcome: TerminalOutcome) => void = () => undefined;
  const completion = new Promise<TerminalOutcome>((resolve) => {
    resolveCompletion = resolve;
  });

  const processNotification = (notification: JsonObject): void => {
    const params = asObject(notification.params);
    if (params === null) return;
    const method = notification.method;
    if (typeof method !== "string") return;
    pipeline.append(method, params, ["live"]);
    if (method === "turn/completed" && params.threadId === threadId) {
      liveTerminalOutcome = terminalOutcomeFromTurn(asObject(params.turn));
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
    const selectedTurns = selectedSkillRunHistory(response.thread.turns);
    const selectedResponse: ThreadResumeResponse = {
      ...response,
      thread: { ...response.thread, turns: selectedTurns },
    };
    pipeline.replay(threadId, selectedTurns, bufferedNotifications);
    replayingHistory = false;
    for (const notification of bufferedNotifications) {
      processNotification(notification);
    }
    const historicalOutcome = terminalOutcomeFromHistory(selectedTurns);
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
      );
    }
    return {
      response: selectedResponse,
      completeSourceIds: descendantReplay.completeSourceIds,
      subscribedThreadIds: descendantReplay.subscribedSourceIds,
      descendantHistoryGaps: descendantReplay.gaps,
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
      classifyLiveDescendantCoverage(
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
      let historyIsFull = true;
      for (const turn of response.thread.turns) {
        if (turn.itemsView !== undefined && turn.itemsView !== "full") {
          historyIsFull = false;
          gaps.push({
            sourceId,
            reason: `turn ${turn.id} itemsView=${turn.itemsView}`,
          });
        }
      }
      if (
        classifyLiveDescendantCoverage(
          sourceId,
          pipeline,
          completeSourceIds,
          gaps,
          "live activity arrived before descendant history replay completed",
        )
      ) {
        continue;
      }
      pipeline.replay(sourceId, response.thread.turns, []);
      if (historyIsFull) completeSourceIds.add(sourceId);
    } catch {
      // The root trace remains usable; gap reporting identifies this source.
    }
  }
}

function classifyLiveDescendantCoverage(
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
): readonly TraceGap[] {
  const incompleteViews = turns.flatMap((turn) =>
    turn.itemsView !== undefined && turn.itemsView !== "full"
      ? [`turn ${turn.id} itemsView=${turn.itemsView}`]
      : [],
  );
  const rootReasons = [...incompleteViews];
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
): readonly HistoryTurn[] {
  const selectedTurn = turns.at(-1);
  return selectedTurn === undefined ? [] : [selectedTurn];
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
  writeLine: (line: string) => void,
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

  writeLine(
    `Root Skill candidate inferred from replayed prompt text: name=${JSON.stringify(candidate.name)} path=${candidate.path}. Developer confirmation is required.`,
  );
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
  readonly #writeLine: (line: string) => void;
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

  constructor(threadId: string, writeLine: (line: string) => void) {
    this.#writeLine = writeLine;
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
    projectTraceEvents([event], this.#writeLine);
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
