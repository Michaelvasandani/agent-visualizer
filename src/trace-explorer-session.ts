import {
  observeSkillRun,
  type ObserveSkillRunOptions,
  type EvaluationState,
  type ObservationUpdate,
  type SkillRunObservation,
} from "./trace-observation.js";
import {
  projectActivityGraph,
  updateActivityGraphProjection,
  type ActivityGraphProjection,
} from "./activity-graph.js";
import {
  layoutActivityGraph,
  type ActivityGraphLayout,
} from "./activity-graph-layout.js";

export type TraceExplorerPhase =
  | "connecting"
  | "selecting-session"
  | "armed"
  | "observing"
  | "recovering"
  | "evaluating"
  | "completed"
  | "error";

export type TraceExplorerRunStatus =
  | "observing"
  | "evaluating"
  | "completed"
  | "failed"
  | "cancelled";

export function isTraceExplorerPhaseActive(
  phase: TraceExplorerPhase,
): boolean {
  return (
    phase === "observing" ||
    phase === "recovering" ||
    phase === "evaluating"
  );
}

export interface TraceExplorerRunSnapshot {
  readonly id: string;
  readonly sessionId: string;
  readonly status: TraceExplorerRunStatus;
  readonly updates: readonly ObservationUpdate[];
  readonly observation: SkillRunObservation | null;
  readonly activityGraph: ActivityGraphProjection;
  readonly activityLayout: ActivityGraphLayout;
}

export interface TraceExplorerSnapshot {
  readonly revision: number;
  readonly phase: TraceExplorerPhase;
  readonly sessions: readonly string[];
  readonly selectedSessionId: string | null;
  readonly sessionSwitchingLocked: boolean;
  readonly activeRunId: string | null;
  readonly viewedRunId: string | null;
  readonly evaluationState: EvaluationState;
  readonly runs: readonly TraceExplorerRunSnapshot[];
  readonly error: string | null;
}

export type TraceExplorerBrowserAction =
  | { readonly kind: "select-session"; readonly sessionId: string }
  | { readonly kind: "select-run"; readonly runId: string }
  | { readonly kind: "trace-next-run" }
  | { readonly kind: "re-layout" };

export interface TraceExplorerSessionDependencies {
  readonly observeSkillRun: (
    options: ObserveSkillRunOptions,
  ) => Promise<SkillRunObservation>;
}

export interface TraceExplorerSessionManager {
  snapshot(): TraceExplorerSnapshot;
  subscribe(listener: (snapshot: TraceExplorerSnapshot) => void): () => void;
  dispatch(action: TraceExplorerBrowserAction): boolean;
  start(): void;
  close(): Promise<void>;
}

interface MutableRun {
  readonly id: string;
  readonly sessionId: string;
  status: TraceExplorerRunStatus;
  readonly updates: ObservationUpdate[];
  observation: SkillRunObservation | null;
  activityGraph: ActivityGraphProjection;
  activityLayout: ActivityGraphLayout;
}

interface PendingChoice {
  readonly resolve: (sessionId: string) => void;
}

const SWITCH_SESSION = Object.freeze({ kind: "switch-session" });
const CLOSE_MANAGER = Object.freeze({ kind: "close-manager" });

export function createTraceExplorerSessionManager(options: {
  readonly serverUrl: string;
  readonly dependencies?: TraceExplorerSessionDependencies;
  readonly shouldStartConformance?: () => boolean;
}): TraceExplorerSessionManager {
  const dependencies = options.dependencies ?? { observeSkillRun };
  const listeners = new Set<(snapshot: TraceExplorerSnapshot) => void>();
  const runs: MutableRun[] = [];
  const pendingRunUpdates: ObservationUpdate[] = [];
  let revision = 0;
  let phase: TraceExplorerPhase = "connecting";
  let sessions: readonly string[] = Object.freeze([]);
  let selectedSessionId: string | null = null;
  let activeRunId: string | null = null;
  let viewedRunId: string | null = null;
  let evaluationState: EvaluationState = "not-started";
  let error: string | null = null;
  let pendingChoice: PendingChoice | null = null;
  let resolveNextRun: (() => void) | null = null;
  let cycleAbortController: AbortController | null = null;
  let started = false;
  let closed = false;
  let loop: Promise<void> = Promise.resolve();

  const snapshot = (): TraceExplorerSnapshot => freezeSnapshot({
    revision,
    phase,
    sessions,
    selectedSessionId,
    activeRunId,
    viewedRunId,
    evaluationState,
    runs,
    error,
  });

  const publish = (): void => {
    revision += 1;
    const next = snapshot();
    for (const listener of listeners) listener(next);
  };

  const setPhase = (nextPhase: TraceExplorerPhase): void => {
    phase = nextPhase;
    error = null;
  };

  const currentRun = (): MutableRun | undefined =>
    runs.find((run) => run.id === activeRunId);

  const setEvaluating = (): void => {
    setPhase("evaluating");
    const run = currentRun();
    if (run !== undefined) run.status = "evaluating";
  };

  const resetCycle = (clearActiveRun: boolean): void => {
    if (clearActiveRun) activeRunId = null;
    viewedRunId = null;
    evaluationState = "not-started";
    pendingRunUpdates.length = 0;
    setPhase("connecting");
    publish();
  };

  const startRun = (): MutableRun => {
    const sessionId = selectedSessionId;
    if (sessionId === null) {
      throw new Error("Cannot create a Skill Run without a selected session.");
    }
    let activityGraph = projectActivityGraph({
      rootSourceId: sessionId,
      events: [],
      gaps: [],
      terminalOutcome: null,
    });
    let activityLayout = layoutActivityGraph(activityGraph);
    const run: MutableRun = {
      id: `run-${runs.length + 1}`,
      sessionId,
      status: "observing",
      updates: [],
      observation: null,
      activityGraph,
      activityLayout,
    };
    runs.push(run);
    for (const update of pendingRunUpdates) {
      run.updates.push(update);
      ({ activityGraph, activityLayout } = applyGraphUpdate(
        activityGraph,
        activityLayout,
        update,
      ));
    }
    run.activityGraph = activityGraph;
    run.activityLayout = activityLayout;
    pendingRunUpdates.length = 0;
    activeRunId = run.id;
    viewedRunId = run.id;
    return run;
  };

  const processObservationUpdate = (update: ObservationUpdate): void => {
    switch (update.kind) {
      case "loaded-threads":
        sessions = Object.freeze([...update.threadIds]);
        break;
      case "thread-selected":
        selectedSessionId = update.threadId;
        break;
      case "lifecycle":
        if (update.state === "connecting") setPhase("connecting");
        if (update.state === "selecting-thread") setPhase("selecting-session");
        if (update.state === "armed") setPhase("armed");
        if (update.state === "observing") {
          setPhase("observing");
          currentRun() ?? startRun();
        }
        if (update.state === "recovering") setPhase("recovering");
        if (update.state === "evaluating") setEvaluating();
        break;
      case "evaluation-state":
        evaluationState = update.state;
        if (
          update.state === "compiling-obligations" ||
          update.state === "evaluating-findings"
        ) {
          setEvaluating();
        }
        break;
      default:
        break;
    }
    const run = currentRun();
    if (run !== undefined) {
      run.updates.push(update);
      const graphState = applyGraphUpdate(
        run.activityGraph,
        run.activityLayout,
        update,
      );
      run.activityGraph = graphState.activityGraph;
      run.activityLayout = graphState.activityLayout;
    } else if (isRunUpdate(update)) {
      pendingRunUpdates.push(update);
    }
    publish();
  };

  const chooseSession = async (
    availableSessions: readonly string[],
    signal: AbortSignal,
  ): Promise<string> => {
    signal.throwIfAborted();
    if (
      selectedSessionId !== null &&
      availableSessions.includes(selectedSessionId)
    ) {
      return selectedSessionId;
    }
    return await new Promise<string>((resolve, reject) => {
      const onAbort = (): void => {
        pendingChoice = null;
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      pendingChoice = {
        resolve: (sessionId) => {
          signal.removeEventListener("abort", onAbort);
          pendingChoice = null;
          resolve(sessionId);
        },
      };
    });
  };

  const waitForNextRun = async (signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        resolveNextRun = null;
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      resolveNextRun = () => {
        signal.removeEventListener("abort", onAbort);
        resolveNextRun = null;
        resolve();
      };
    });
  };

  const observeNextRun = async (signal: AbortSignal): Promise<void> => {
    const observation = await dependencies.observeSkillRun({
      serverUrl: options.serverUrl,
      signal,
      turnSelection: "active-or-next",
      ...(options.shouldStartConformance === undefined
        ? {}
        : { shouldStartConformance: options.shouldStartConformance }),
      selectThread: async (availableSessions) =>
        await chooseSession(availableSessions, signal),
      onUpdate: processObservationUpdate,
    });
    const run = currentRun();
    if (run === undefined) {
      throw new Error("A completed observation did not create a Skill Run.");
    }
    run.status = observation.terminalOutcome.kind;
    run.observation = observation;
    run.activityGraph = updateActivityGraphProjection(run.activityGraph, {
      kind: "terminal-outcome",
      outcome: observation.terminalOutcome,
    });
    run.activityLayout = layoutActivityGraph(run.activityGraph, run.activityLayout);
    evaluationState = observation.evaluationState;
    activeRunId = null;
    viewedRunId = run.id;
    setPhase("completed");
    publish();
  };

  const runLoop = async (): Promise<void> => {
    while (!closed) {
      const controller = new AbortController();
      cycleAbortController = controller;
      try {
        await observeNextRun(controller.signal);
        await waitForNextRun(controller.signal);
        resetCycle(false);
      } catch (caught) {
        if (closed || caught === CLOSE_MANAGER) return;
        if (caught === SWITCH_SESSION) {
          resetCycle(true);
          continue;
        }
        error = caught instanceof Error ? caught.message : String(caught);
        phase = "error";
        publish();
        return;
      } finally {
        if (cycleAbortController === controller) cycleAbortController = null;
      }
    }
  };

  return Object.freeze({
    snapshot,
    subscribe(listener: (snapshot: TraceExplorerSnapshot) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch(action: TraceExplorerBrowserAction): boolean {
      if (closed) return false;
      if (action.kind === "select-run") {
        if (!runs.some((run) => run.id === action.runId)) return false;
        viewedRunId = action.runId;
        publish();
        return true;
      }
      if (action.kind === "trace-next-run") {
        if (phase !== "completed" || resolveNextRun === null) return false;
        resolveNextRun();
        return true;
      }
      if (action.kind === "re-layout") {
        const run = runs.find(({ id }) => id === viewedRunId);
        if (run === undefined) return false;
        run.activityLayout = layoutActivityGraph(run.activityGraph);
        publish();
        return true;
      }
      if (
        isTraceExplorerPhaseActive(phase) ||
        !sessions.includes(action.sessionId)
      ) {
        return false;
      }
      selectedSessionId = action.sessionId;
      if (pendingChoice !== null) {
        pendingChoice.resolve(action.sessionId);
      } else if (phase === "armed") {
        cycleAbortController?.abort(SWITCH_SESSION);
      }
      publish();
      return true;
    },
    start(): void {
      if (started || closed) return;
      started = true;
      loop = runLoop();
    },
    async close(): Promise<void> {
      if (closed) return await loop;
      closed = true;
      cycleAbortController?.abort(CLOSE_MANAGER);
      await loop;
    },
  });
}

function isRunUpdate(update: ObservationUpdate): boolean {
  return (
    update.kind === "event" ||
    update.kind === "gap" ||
    update.kind === "terminal-outcome" ||
    update.kind === "root-skill-candidate" ||
    update.kind === "skill-attribution" ||
    update.kind === "skill-contract" ||
    update.kind === "obligations" ||
    update.kind === "findings"
  );
}

function freezeSnapshot(state: {
  readonly revision: number;
  readonly phase: TraceExplorerPhase;
  readonly sessions: readonly string[];
  readonly selectedSessionId: string | null;
  readonly activeRunId: string | null;
  readonly viewedRunId: string | null;
  readonly evaluationState: EvaluationState;
  readonly runs: readonly MutableRun[];
  readonly error: string | null;
}): TraceExplorerSnapshot {
  const runSnapshots = state.runs.map((run) => Object.freeze({
    id: run.id,
    sessionId: run.sessionId,
    status: run.status,
    updates: Object.freeze([...run.updates]),
    observation: run.observation,
    activityGraph: run.activityGraph,
    activityLayout: run.activityLayout,
  }));
  return Object.freeze({
    revision: state.revision,
    phase: state.phase,
    sessions: Object.freeze([...state.sessions]),
    selectedSessionId: state.selectedSessionId,
    sessionSwitchingLocked: isTraceExplorerPhaseActive(state.phase),
    activeRunId: state.activeRunId,
    viewedRunId: state.viewedRunId,
    evaluationState: state.evaluationState,
    runs: Object.freeze(runSnapshots),
    error: state.error,
  });
}

function applyGraphUpdate(
  activityGraph: ActivityGraphProjection,
  activityLayout: ActivityGraphLayout,
  update: ObservationUpdate,
): {
  readonly activityGraph: ActivityGraphProjection;
  readonly activityLayout: ActivityGraphLayout;
} {
  if (
    update.kind !== "event" &&
    update.kind !== "gap" &&
    update.kind !== "terminal-outcome"
  ) {
    return { activityGraph, activityLayout };
  }
  const nextGraph = updateActivityGraphProjection(activityGraph, update);
  return {
    activityGraph: nextGraph,
    activityLayout: layoutActivityGraph(nextGraph, activityLayout),
  };
}
