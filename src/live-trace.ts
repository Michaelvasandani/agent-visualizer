import { AppServerClient } from "./app-server-client.js";
import { compileObligations, renderObligations } from "./obligation.js";
import {
  constructSkillContract,
  renderSkillContract,
  type RootSkillSelection,
} from "./skill-contract.js";
import {
  createNormalizedEvent,
  renderTraceEvent,
  type JsonObject,
  type NormalizedEvent,
  type TraceEventKind,
} from "./trace-event.js";

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
  readonly terminalOutcome: TerminalOutcome;
}

type TerminalOutcome =
  | { readonly kind: "completed" | "cancelled" }
  | { readonly kind: "failed"; readonly error: unknown };

interface TraceGap {
  readonly afterEventId: string | null;
  readonly historyBoundary:
    | "initial history"
    | "reconnect history"
    | "failed history recovery";
  readonly sources: readonly string[];
  readonly reason: string;
}

interface RecoveryCheckpoint {
  readonly afterEventId: string | null;
  readonly sourceIds: readonly string[];
}

interface ResolvedAttribution {
  readonly kind: "exact" | "confirmed";
  readonly rootSkill: RootSkillSelection;
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
    const attribution = await resolveRootSkillAttribution(
      client,
      observation,
      writeLine,
      confirmHistoricalRootSkill,
    );
    if (attribution !== null) {
      const { rootSkill } = attribution;
      writeLine(
        `Root Skill Attribution: ${attribution.kind} name=${JSON.stringify(rootSkill.name)} path=${rootSkill.path}`,
      );
      const contract = await constructSkillContract(rootSkill);
      for (const line of renderSkillContract(contract)) writeLine(line);
      const obligations = await compileObligations(client, contract);
      for (const line of renderObligations(obligations)) writeLine(line);
    }
    await client.request("thread/unsubscribe", { threadId });
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

  try {
    const response = await client.request<ThreadResumeResponse>(
      "thread/resume",
      { threadId },
    );
    pipeline.replay(response.thread.turns, bufferedNotifications);
    replayingHistory = false;
    for (const notification of bufferedNotifications) {
      processNotification(notification);
    }
    const historicalOutcome = terminalOutcomeFromHistory(response.thread.turns);
    const terminalOutcome = historicalOutcome ?? liveTerminalOutcome;
    if (terminalOutcome !== null) return { response, terminalOutcome };

    return {
      response,
      terminalOutcome: await Promise.race([
        completion,
        client.whenClosed().then(() => null),
      ]),
    };
  } finally {
    removeHandler();
  }
}

function findHistoryGaps(
  threadId: string,
  turns: readonly HistoryTurn[],
  checkpoint: RecoveryCheckpoint,
  historyBoundary: TraceGap["historyBoundary"],
): readonly TraceGap[] {
  const incompleteViews = turns.flatMap((turn) =>
    turn.itemsView !== undefined && turn.itemsView !== "full"
      ? [`turn ${turn.id} itemsView=${turn.itemsView}`]
      : [],
  );
  const unavailableDescendants = checkpoint.sourceIds.filter(
    (sourceId) => sourceId !== threadId,
  );
  if (
    historyBoundary === "initial history" &&
    turns.length === 0 &&
    incompleteViews.length === 0 &&
    unavailableDescendants.length === 0
  ) {
    return [];
  }

  const reasons = [...incompleteViews];
  if (historyBoundary === "reconnect history") {
    reasons.push(
      "notification-only activity is unavailable from resumed history",
    );
  } else if (turns.length > 0) {
    reasons.push(
      "notification-only activity before attachment is unavailable from resumed history",
    );
  }
  if (unavailableDescendants.length > 0) {
    reasons.push("selected-thread history does not reconstruct descendant sources");
  }
  return [
    Object.freeze({
      afterEventId: checkpoint.afterEventId,
      historyBoundary,
      sources: Object.freeze([...checkpoint.sourceIds]),
      reason: reasons.join("; "),
    }),
  ];
}

function selectedThreadItemHistoryIsFull(
  turns: readonly HistoryTurn[],
): boolean {
  return turns.every(
    (turn) => turn.itemsView === undefined || turn.itemsView === "full",
  );
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

function renderTerminalOutcome(
  outcome: TerminalOutcome,
  writeLine: (line: string) => void,
): void {
  const failure = outcome.kind === "failed" ? ` error=${JSON.stringify(outcome.error)}` : "";
  writeLine(`Skill Run terminal outcome: ${outcome.kind}${failure}`);
}

function renderTraceIntegrity(
  gaps: readonly TraceGap[],
  writeLine: (line: string) => void,
): void {
  if (gaps.length === 0) {
    writeLine("Trace integrity: complete.");
    return;
  }
  for (const gap of gaps) {
    const intervalStart =
      gap.afterEventId === null
        ? "observation start"
        : `after ${gap.afterEventId}`;
    writeLine(
      `Incomplete Trace: interval=${intervalStart} through ${gap.historyBoundary}; ` +
        `sources=${gap.sources.join(",")}; reason=${gap.reason}.`,
    );
  }
}

async function resolveRootSkillAttribution(
  client: AppServerClient,
  observation: ThreadObservation,
  writeLine: (line: string) => void,
  confirmHistoricalRootSkill: (
    rootSkill: RootSkillSelection,
  ) => Promise<boolean>,
): Promise<ResolvedAttribution | null> {
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
      writeLine,
      "structured live metadata identified multiple Root Skills",
    );
  }

  const mentionedNames = historicalSkillMentions(observation.events);
  if (mentionedNames.length === 0) {
    return unresolvedAttribution(
      writeLine,
      "replayed prompt text did not identify a Root Skill candidate",
    );
  }
  if (mentionedNames.length > 1 || observation.cwd === null) {
    return unresolvedAttribution(
      writeLine,
      mentionedNames.length > 1
        ? `replayed prompt text mentioned multiple skills: ${mentionedNames.join(", ")}`
        : "the historical thread working directory is unavailable",
    );
  }

  const mentionedName = mentionedNames[0];
  if (mentionedName === undefined) {
    return unresolvedAttribution(writeLine, "no Root Skill candidate was found");
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
      writeLine,
      `historical mention ${JSON.stringify(`$${mentionedName}`)} did not resolve to exactly one enabled skill`,
    );
  }

  writeLine(
    `Root Skill candidate inferred from replayed prompt text: name=${JSON.stringify(candidate.name)} path=${candidate.path}. Developer confirmation is required.`,
  );
  if (!(await confirmHistoricalRootSkill(candidate))) {
    return unresolvedAttribution(
      writeLine,
      `developer rejected historical candidate ${JSON.stringify(candidate.name)}`,
    );
  }
  return { kind: "confirmed", rootSkill: candidate };
}

function unresolvedAttribution(
  writeLine: (line: string) => void,
  reason: string,
): null {
  writeLine(`Root Skill Attribution unresolved: ${reason}.`);
  writeLine(
    "Conformance evaluation is unavailable because Root Skill Attribution is unresolved; Trace collection was not affected.",
  );
  return null;
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
  readonly #threadId: string;
  readonly #writeLine: (line: string) => void;
  readonly #seenEventIds = new Set<string>();
  readonly #events: NormalizedEvent[] = [];
  readonly #knownSourceIds: Set<string>;
  readonly #sourceParents = new Map<string, string>();
  readonly #sourceDepths = new Map<string, number>();
  readonly #sourceSequences = new Map<string, number>();
  readonly #pendingBySource = new Map<
    string,
    Array<{
      readonly method: string;
      readonly params: JsonObject;
      readonly observationSources: readonly ("history" | "live")[];
    }>
  >();

  constructor(threadId: string, writeLine: (line: string) => void) {
    this.#threadId = threadId;
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

  replay(
    turns: readonly HistoryTurn[],
    bufferedNotifications: JsonObject[],
  ): void {
    const candidates: ReplayCandidate[] = [];
    const consumedNotificationIndexes = new Set<number>();
    for (const turn of turns) {
      for (const item of turn.items) {
        const historyParams = {
          threadId: this.#threadId,
          turnId: turn.id,
          item,
        };
        const method = historyMethod(item);
        const overlapping = findItemNotifications(
          bufferedNotifications,
          this.#threadId,
          turn.id,
          item.id,
          method,
        );
        const predecessors =
          method === "item/completed"
            ? findItemNotifications(
                bufferedNotifications,
                this.#threadId,
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
    this.#writeLine(renderTraceEvent(event));
    this.#registerDescendantSource(event);
  }

  #registerDescendantSource(event: NormalizedEvent): void {
    const item = asObject(event.payload.item);
    if (
      item === null ||
      (item.type !== "collabToolCall" && item.type !== "collabAgentToolCall")
    ) {
      return;
    }
    if (item.tool !== "spawnAgent" && item.tool !== "spawn_agent") return;
    const reportedReceiverIds = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds
      : [];
    for (const candidate of [
      ...reportedReceiverIds,
      item.newThreadId,
      item.receiverThreadId,
    ]) {
      if (
        typeof candidate !== "string" ||
        candidate === event.sourceId ||
        this.#knownSourceIds.has(candidate)
      ) {
        continue;
      }
      this.#knownSourceIds.add(candidate);
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
