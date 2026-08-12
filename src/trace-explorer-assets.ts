export const TRACE_EXPLORER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Trace Explorer</title>
    <link rel="stylesheet" href="/assets/app.css">
  </head>
  <body>
    <header class="top-bar">
      <div>
        <h1>Trace Explorer</h1>
        <p id="connection" role="status">Connecting to the local Tracer…</p>
      </div>
      <label>Observable Session <select id="sessions"></select></label>
      <dl class="run-state">
        <div><dt>State</dt><dd id="phase">Connecting</dd></div>
        <div><dt>Conformance:</dt><dd id="evaluation">not-started</dd></div>
      </dl>
      <button id="trace-next" type="button" hidden>Trace Next Run</button>
    </header>
    <main class="workspace">
      <aside class="run-list" aria-labelledby="runs-heading">
        <h2 id="runs-heading">Run List</h2>
        <ol id="runs"></ol>
      </aside>
      <section class="graph-panel" aria-labelledby="graph-heading">
        <div class="graph-heading">
          <div>
            <h2 id="graph-heading">Activity Graph</h2>
            <output id="selected-activity" aria-live="polite">No activity selected</output>
          </div>
          <div class="graph-toolbar" role="toolbar" aria-label="Activity Graph navigation">
            <label class="search-field"><span>Search</span><input id="activity-search" type="search" aria-label="Search activity" placeholder="Summary, type, or source"></label>
            <label>Show <select id="activity-filter">
              <option value="all">All activity</option>
              <option value="agent">Agents</option>
              <option value="turn">Turns</option>
              <option value="tool">Tools</option>
              <option value="command">Commands</option>
              <option value="file-change">File changes</option>
              <option value="unknown">Unknown Events</option>
            </select></label>
            <button id="zoom-out" type="button" aria-label="Zoom out">−</button>
            <button id="zoom-in" type="button" aria-label="Zoom in">+</button>
            <button id="reset-view" type="button">Reset view</button>
            <button id="re-layout" type="button">Re-layout</button>
            <button id="camera-follow" type="button" aria-pressed="false">Pause follow</button>
            <button id="collapse-branch" type="button" disabled>Collapse selected branch</button>
          </div>
        </div>
        <div class="graph-canvas">
          <svg id="activity-graph" role="application" tabindex="0" aria-label="Activity Graph. Use arrow keys to pan, plus and minus to zoom, and Tab to reach activities.">
            <defs>
              <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z"></path></marker>
              <pattern id="gap-pattern" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M-1,1 L1,-1 M0,6 L6,0 M5,7 L7,5"></path></pattern>
            </defs>
            <g id="activity-viewport"></g>
          </svg>
          <p id="graph-empty">Activity will appear here when a Skill Run begins.</p>
        </div>
      </section>
    </main>
    <script type="module" src="/assets/app.js"></script>
  </body>
</html>`;

export const TRACE_EXPLORER_SCRIPT = `const SVG_NS = "http://www.w3.org/2000/svg";
const status = document.querySelector("#connection");
const sessionSelect = document.querySelector("#sessions");
const phase = document.querySelector("#phase");
const evaluation = document.querySelector("#evaluation");
const traceNext = document.querySelector("#trace-next");
const runList = document.querySelector("#runs");
const search = document.querySelector("#activity-search");
const filter = document.querySelector("#activity-filter");
const graphSvg = document.querySelector("#activity-graph");
const viewport = document.querySelector("#activity-viewport");
const empty = document.querySelector("#graph-empty");
const selectedActivity = document.querySelector("#selected-activity");
const followButton = document.querySelector("#camera-follow");
const collapseButton = document.querySelector("#collapse-branch");
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const icons = { agent: "◉", turn: "↪", tool: "◇", command: ">_", "file-change": "±", unknown: "?" };
const stateCues = { running: "◌", completed: "✓", failed: "!", cancelled: "×", unknown: "?" };
let socket;
let latestSnapshot;
let selectedNodeId = null;
let cameraFollowPaused = false;
let camera = { x: 36, y: 36, scale: 1 };
let pointerStart = null;
const collapsedBranchNodeIds = new Set();

function send(action) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(action));
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function textElement(value, attributes = {}) {
  const element = svgElement("text", attributes);
  element.textContent = value;
  return element;
}

function viewedRun(snapshot) {
  return snapshot.runs.find((run) => run.id === snapshot.viewedRunId) ?? null;
}

function render(snapshot) {
  latestSnapshot = snapshot;
  phase.textContent = snapshot.phase;
  evaluation.textContent = snapshot.evaluationState;
  sessionSelect.replaceChildren();
  if (snapshot.sessions.length !== 1 && snapshot.selectedSessionId === null) {
    const prompt = document.createElement("option");
    prompt.textContent = "Choose a session…";
    prompt.value = "";
    sessionSelect.append(prompt);
  }
  for (const sessionId of snapshot.sessions) {
    const option = document.createElement("option");
    option.value = sessionId;
    option.textContent = sessionId;
    option.selected = sessionId === snapshot.selectedSessionId;
    sessionSelect.append(option);
  }
  sessionSelect.disabled = snapshot.sessionSwitchingLocked;
  traceNext.hidden = snapshot.phase !== "completed";
  runList.replaceChildren();
  for (const run of snapshot.runs) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = run.id + " · " + run.sessionId + " · " + run.status;
    button.ariaPressed = String(run.id === snapshot.viewedRunId);
    button.addEventListener("click", () => send({ kind: "select-run", runId: run.id }));
    item.append(button);
    runList.append(item);
  }
  renderActivityGraph(viewedRun(snapshot));
}

function hiddenSources(graph) {
  const hidden = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const lane of Object.values(graph.lanesBySource)) {
      if (hidden.has(lane.sourceId)) continue;
      if (collapsedBranchNodeIds.has(lane.sourceParentActivityNodeId) ||
          Object.values(graph.lanesBySource).some((parent) =>
            hidden.has(parent.sourceId) && lane.sourceParentActivityNodeId !== null &&
            parent.nodeIds.includes(lane.sourceParentActivityNodeId))) {
        hidden.add(lane.sourceId);
        changed = true;
      }
    }
  }
  return hidden;
}

function renderActivityGraph(run) {
  viewport.replaceChildren();
  if (run === null || Object.keys(run.activityGraph.nodesById).length === 0 && run.activityGraph.gaps.length === 0) {
    empty.hidden = false;
    selectedNodeId = null;
    updateSelectionControls(run);
    return;
  }
  empty.hidden = true;
  const graph = run.activityGraph;
  const layout = run.activityLayout;
  const hiddenLaneIds = hiddenSources(graph);
  const filterValue = filter.value;
  const query = search.value.trim().toLocaleLowerCase();
  const visibleNodeIds = new Set();
  for (const lane of Object.values(graph.lanesBySource)) {
    if (hiddenLaneIds.has(lane.sourceId)) continue;
    const y = layout.laneYBySource[lane.sourceId];
    if (y === undefined) continue;
    const laneGroup = svgElement("g", { class: "source-lane", "data-source-id": lane.sourceId });
    laneGroup.append(
      svgElement("line", { x1: 18, y1: y, x2: layout.width - 36, y2: y }),
      textElement((lane.sourceDepth > 0 ? "↳ " : "") + lane.sourceId, { x: 18, y: y - 57 }),
    );
    viewport.append(laneGroup);
    for (const nodeId of lane.nodeIds) {
      const node = graph.nodesById[nodeId];
      const haystack = (node.summary + " " + node.type + " " + node.sourceId).toLocaleLowerCase();
      if (filterValue !== "all" && node.type !== filterValue) continue;
      if (query !== "" && !haystack.includes(query)) continue;
      visibleNodeIds.add(nodeId);
    }
  }
  for (const edge of Object.values(graph.causalEdgesById)) {
    if (!visibleNodeIds.has(edge.fromActivityNodeId) || !visibleNodeIds.has(edge.toActivityNodeId)) continue;
    const from = layout.positionsByNodeId[edge.fromActivityNodeId];
    const to = layout.positionsByNodeId[edge.toActivityNodeId];
    if (from === undefined || to === undefined) continue;
    const bend = Math.max(from.x + 52, (from.x + to.x) / 2);
    const path = svgElement("path", {
      class: "causal-edge " + edge.relationship,
      d: "M " + (from.x + 92) + " " + from.y + " C " + bend + " " + from.y + ", " + bend + " " + to.y + ", " + (to.x - 96) + " " + to.y,
      "marker-end": "url(#arrow)",
    });
    viewport.append(path);
  }
  for (const nodeId of visibleNodeIds) renderNode(graph, layout, nodeId);
  renderGaps(graph, layout, hiddenLaneIds);
  graphSvg.setAttribute("viewBox", "0 0 " + layout.width + " " + layout.height);
  updateSelectionControls(run);
  if (!cameraFollowPaused) followLatestActivity(run);
  applyCamera();
}

function renderNode(graph, layout, nodeId) {
  const node = graph.nodesById[nodeId];
  const position = layout.positionsByNodeId[nodeId];
  if (node === undefined || position === undefined) return;
  const group = svgElement("g", {
    class: "activity-node type-" + node.type + " state-" + node.state + (nodeId === selectedNodeId ? " selected" : ""),
    transform: "translate(" + position.x + " " + position.y + ")",
    tabindex: "0",
    role: "button",
    "aria-label": node.type + ", " + node.state + ", " + node.summary,
    "aria-pressed": String(nodeId === selectedNodeId),
    "data-node-id": nodeId,
  });
  const title = svgElement("title");
  title.textContent = node.summary + " — " + node.state;
  const card = svgElement("rect", { x: -90, y: -42, width: 180, height: 84, rx: node.type === "unknown" ? 2 : 12 });
  const type = textElement((icons[node.type] ?? "•") + " " + node.type, { class: "node-type", x: -72, y: -16 });
  const summary = textElement(node.summary, { class: "node-summary", x: -72, y: 8 });
  const duration = node.durationMs === null ? "" : " · " + node.durationMs + " ms";
  const state = textElement((stateCues[node.state] ?? "?") + " " + node.state + duration, { class: "node-state", x: -72, y: 29 });
  group.append(title, card, type, summary, state);
  if (node.coverageWarning !== null) group.append(textElement("coverage warning", { class: "coverage-warning", x: 72, y: -27, "text-anchor": "end" }));
  const select = () => {
    selectedNodeId = nodeId;
    renderActivityGraph(viewedRun(latestSnapshot));
  };
  group.addEventListener("click", select);
  group.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select();
    }
  });
  viewport.append(group);
}

function renderGaps(graph, layout, hiddenLaneIds) {
  graph.gaps.forEach((gap, gapIndex) => {
    for (const [sourceIndex, sourceId] of gap.sources.entries()) {
      if (hiddenLaneIds.has(sourceId)) continue;
      const y = layout.laneYBySource[sourceId];
      if (y === undefined) continue;
      const afterNode = Object.values(graph.nodesById).find((node) => gap.afterEventId !== null && node.eventIds.includes(gap.afterEventId));
      const afterPosition = afterNode === undefined ? undefined : layout.positionsByNodeId[afterNode.id];
      const x = (afterPosition?.x ?? 80) + 116 + gapIndex * 28 + sourceIndex * 18;
      const marker = svgElement("g", {
        class: "integrity-gap",
        role: "img",
        "aria-label": "Integrity gap for " + sourceId + ": " + gap.reason,
        transform: "translate(" + x + " " + y + ")",
      });
      const title = svgElement("title");
      title.textContent = gap.reason;
      marker.append(title, svgElement("path", { d: "M 0 -22 L 22 0 L 0 22 L -22 0 Z" }), textElement("!", { x: 0, y: 6, "text-anchor": "middle" }), textElement("Gap", { x: 0, y: 40, "text-anchor": "middle" }));
      viewport.append(marker);
    }
  });
}

function updateSelectionControls(run) {
  const node = run?.activityGraph.nodesById[selectedNodeId];
  selectedActivity.textContent = node === undefined ? "No activity selected" : node.type + " · " + node.state + " · " + node.summary;
  const hasChildren = node !== undefined && Object.values(run.activityGraph.lanesBySource).some((lane) => lane.sourceParentActivityNodeId === node.id);
  collapseButton.disabled = !hasChildren;
  collapseButton.textContent = collapsedBranchNodeIds.has(selectedNodeId) ? "Expand selected branch" : "Collapse selected branch";
}

function latestNode(run) {
  for (let index = run.updates.length - 1; index >= 0; index -= 1) {
    const update = run.updates[index];
    if (update.kind !== "event") continue;
    const found = Object.values(run.activityGraph.nodesById).find((node) => node.eventIds.includes(update.event.id));
    if (found !== undefined) return found;
  }
  return null;
}

function followLatestActivity(run) {
  const node = latestNode(run);
  const position = node === null ? undefined : run.activityLayout.positionsByNodeId[node.id];
  if (position === undefined) return;
  const bounds = graphSvg.getBoundingClientRect();
  camera.x = bounds.width / 2 - position.x * camera.scale;
  camera.y = bounds.height / 2 - position.y * camera.scale;
}

function applyCamera() {
  viewport.setAttribute("transform", "translate(" + camera.x + " " + camera.y + ") scale(" + camera.scale + ")");
}

function zoomBy(factor) {
  camera.scale = Math.min(2.5, Math.max(0.35, camera.scale * factor));
  applyCamera();
}

sessionSelect.addEventListener("change", () => {
  if (sessionSelect.value !== "") send({ kind: "select-session", sessionId: sessionSelect.value });
});
traceNext.addEventListener("click", () => send({ kind: "trace-next-run" }));
search.addEventListener("input", () => renderActivityGraph(viewedRun(latestSnapshot)));
filter.addEventListener("change", () => renderActivityGraph(viewedRun(latestSnapshot)));
document.querySelector("#zoom-out").addEventListener("click", () => zoomBy(0.8));
document.querySelector("#zoom-in").addEventListener("click", () => zoomBy(1.25));
document.querySelector("#reset-view").addEventListener("click", () => { camera = { x: 36, y: 36, scale: 1 }; applyCamera(); });
document.querySelector("#re-layout").addEventListener("click", () => send({ kind: "re-layout" }));
followButton.addEventListener("click", () => {
  cameraFollowPaused = !cameraFollowPaused;
  followButton.ariaPressed = String(cameraFollowPaused);
  followButton.textContent = cameraFollowPaused ? "Resume follow" : "Pause follow";
  if (!cameraFollowPaused) renderActivityGraph(viewedRun(latestSnapshot));
});
collapseButton.addEventListener("click", () => {
  if (selectedNodeId === null) return;
  if (collapsedBranchNodeIds.has(selectedNodeId)) collapsedBranchNodeIds.delete(selectedNodeId);
  else collapsedBranchNodeIds.add(selectedNodeId);
  renderActivityGraph(viewedRun(latestSnapshot));
});
graphSvg.addEventListener("wheel", (event) => { event.preventDefault(); zoomBy(event.deltaY < 0 ? 1.1 : 0.9); }, { passive: false });
graphSvg.addEventListener("pointerdown", (event) => {
  if (event.target.closest?.(".activity-node")) return;
  pointerStart = { pointerX: event.clientX, pointerY: event.clientY, cameraX: camera.x, cameraY: camera.y };
  graphSvg.setPointerCapture(event.pointerId);
});
graphSvg.addEventListener("pointermove", (event) => {
  if (pointerStart === null) return;
  camera.x = pointerStart.cameraX + event.clientX - pointerStart.pointerX;
  camera.y = pointerStart.cameraY + event.clientY - pointerStart.pointerY;
  applyCamera();
});
graphSvg.addEventListener("pointerup", () => { pointerStart = null; });
graphSvg.addEventListener("keydown", (event) => {
  const moves = { ArrowLeft: [32, 0], ArrowRight: [-32, 0], ArrowUp: [0, 32], ArrowDown: [0, -32] };
  if (moves[event.key] !== undefined) {
    event.preventDefault(); camera.x += moves[event.key][0]; camera.y += moves[event.key][1]; applyCamera();
  } else if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomBy(1.2); }
  else if (event.key === "-") { event.preventDefault(); zoomBy(0.8); }
  else if (event.key === "0") { event.preventDefault(); camera = { x: 36, y: 36, scale: 1 }; applyCamera(); }
});

function connect() {
  socket = new WebSocket(protocol + "//" + location.host + "/live");
  socket.addEventListener("open", () => { status.textContent = "Connected to the local Tracer."; });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.kind === "snapshot" || message.kind === "update") render(message.snapshot);
  });
  socket.addEventListener("close", () => {
    status.textContent = "Disconnected from the local Tracer; reconnecting…";
    setTimeout(connect, 500);
  });
}
connect();`;

export const TRACE_EXPLORER_STYLE = `:root {
  color-scheme: light dark;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --page: #f5f6f8; --panel: #ffffff; --ink: #1c2028; --muted: #626b7a;
  --line: #cbd1da; --accent: #325ec9; --node: #f8fafc; --running: #356fd1;
  --completed: #257a55; --failed: #bb3b3b; --cancelled: #7a647d; --warning: #9b5c00;
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: var(--page); color: var(--ink); }
button, input, select { font: inherit; color: inherit; }
button, select, input { border: 1px solid var(--line); border-radius: 6px; background: var(--panel); padding: 0.42rem 0.58rem; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: 0.48; }
button:focus-visible, input:focus-visible, select:focus-visible, svg:focus-visible, .activity-node:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.top-bar { min-height: 72px; display: flex; align-items: center; gap: 1.25rem; padding: 0.75rem 1rem; background: var(--panel); border-bottom: 1px solid var(--line); }
h1, h2, p { margin: 0; }
h1 { font-size: 1.08rem; }
h2 { font-size: 0.95rem; }
#connection { color: var(--muted); font-size: 0.72rem; margin-top: 0.2rem; }
.top-bar > label { margin-left: auto; font-size: 0.72rem; color: var(--muted); }
.top-bar select { margin-left: 0.35rem; }
.run-state { display: flex; gap: 1rem; margin: 0; }
.run-state div { display: grid; gap: 0.15rem; }
.run-state dt { color: var(--muted); font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.08em; }
.run-state dd { margin: 0; font-size: 0.8rem; }
.workspace { height: calc(100vh - 72px); display: grid; grid-template-columns: 230px minmax(0, 1fr); }
.run-list { padding: 1rem; border-right: 1px solid var(--line); background: var(--panel); overflow: auto; }
#runs { padding: 0; list-style: none; }
#runs button { width: 100%; margin-top: 0.55rem; text-align: left; font-size: 0.72rem; }
#runs button[aria-pressed="true"] { border-color: var(--accent); box-shadow: inset 3px 0 var(--accent); }
.graph-panel { min-width: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); }
.graph-heading { min-height: 92px; display: flex; align-items: flex-start; gap: 1rem; padding: 0.75rem 1rem; background: var(--panel); border-bottom: 1px solid var(--line); }
#selected-activity { display: block; max-width: 28rem; margin-top: 0.35rem; color: var(--muted); font-size: 0.7rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.graph-toolbar { margin-left: auto; display: flex; flex-wrap: wrap; align-items: end; justify-content: flex-end; gap: 0.4rem; }
.graph-toolbar label { display: grid; gap: 0.2rem; color: var(--muted); font-size: 0.65rem; }
.graph-toolbar button, .graph-toolbar input, .graph-toolbar select { font-size: 0.72rem; }
.search-field input { width: 13rem; }
.graph-canvas { position: relative; min-height: 0; overflow: hidden; background-color: var(--page); background-image: radial-gradient(var(--line) 0.7px, transparent 0.7px); background-size: 18px 18px; }
#activity-graph { display: block; width: 100%; height: 100%; min-height: 420px; touch-action: none; cursor: grab; }
#activity-graph:active { cursor: grabbing; }
#graph-empty { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; color: var(--muted); }
.source-lane line { stroke: var(--line); stroke-width: 1; stroke-dasharray: 3 8; }
.source-lane text { fill: var(--muted); font-size: 11px; }
.causal-edge { fill: none; stroke: var(--muted); stroke-width: 1.5; opacity: 0.7; }
.causal-edge.spawn { stroke-dasharray: 5 4; }
#arrow path { fill: var(--muted); }
.activity-node { cursor: pointer; }
.activity-node rect { fill: var(--node); stroke: var(--completed); stroke-width: 2; }
.activity-node text { pointer-events: none; fill: var(--ink); }
.activity-node .node-type { font-size: 11px; font-weight: 700; text-transform: uppercase; }
.activity-node .node-summary { font-size: 12px; }
.activity-node .node-state { fill: var(--muted); font-size: 10px; }
.activity-node .coverage-warning { fill: var(--warning); font-size: 8px; text-transform: uppercase; }
.activity-node.state-running rect { stroke: var(--running); stroke-width: 4; stroke-dasharray: 2 3; }
.activity-node.state-failed rect { stroke: var(--failed); stroke-width: 5; }
.activity-node.state-cancelled rect { stroke: var(--cancelled); stroke-width: 3; stroke-dasharray: 9 4; }
.activity-node.state-unknown rect { stroke: var(--warning); stroke-width: 3; stroke-dasharray: 1 4; }
.activity-node.type-unknown rect { fill: color-mix(in srgb, var(--warning) 11%, var(--node)); stroke-linejoin: bevel; }
.activity-node.selected rect { filter: drop-shadow(0 0 4px var(--accent)); stroke: var(--accent); }
.integrity-gap path { fill: url(#gap-pattern); stroke: var(--warning); stroke-width: 4; }
.integrity-gap text { fill: var(--warning); font-weight: 700; font-size: 12px; }
#gap-pattern path { stroke: var(--warning); stroke-width: 2; }
@media (prefers-color-scheme: dark) {
  :root { --page: #111419; --panel: #191d24; --ink: #edf0f5; --muted: #aab2c0; --line: #3a414d; --accent: #82aaff; --node: #222833; --running: #82aaff; --completed: #65c99a; --failed: #ff7b7b; --cancelled: #c4a7c8; --warning: #f0b35b; }
}
@media (max-width: 900px) {
  .workspace { grid-template-columns: 1fr; }
  .run-list { display: none; }
  .top-bar { flex-wrap: wrap; }
  .top-bar > label { margin-left: 0; }
  .graph-heading { display: block; }
  .graph-toolbar { margin-top: 0.65rem; justify-content: flex-start; }
}`;
