/**
 * The change contract: what a board tune, edit, move or font pick hands the agent. The
 * board client sends one raw record per changed property on a `tune` prompt; this
 * module is the one place that shapes those records, writes their summary lines, and
 * states the rule the agent follows, so poll, MCP and the agent runner carry the same
 * record (docs/invariants.md).
 */

export const MAX_CHANGE_RECORDS = 60;

const MAX_TEXT = 500;

/**
 * How the agent applies a change record. Poll, MCP and the agent runner all state it
 * from here.
 */
export const CHANGE_CONTRACT_RULE =
  'A prompt tagged "tune" carries `changes`: one record per property the reviewer changed on the board, with the selector, element label, property, old_value, new_value, viewport, scope and, when one drives the value, the CSS custom property behind it (`variable`). The board only previewed these; make each change at its source. When `variable` is set, change that custom property where it is defined (or add a new token) instead of overriding the element. When scope.kind is "repeated", change the shared class, rule or component that all scope.count elements use, not one of them. A change with viewport.only belongs in a media query or a responsive rule for that size. Never paste the board CSS as inline styles or `!important` overrides; edit the variable, class or component that renders the element.';

/** @param {unknown} value @param {number} [max] */
function text(value, max = MAX_TEXT) {
  return (
    String(value ?? "")
      // eslint-disable-next-line no-control-regex -- control characters are what it strips
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim()
      .slice(0, max)
  );
}

/** @param {unknown} value @returns {number | undefined} */
function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

/** @param {unknown} value */
function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/** @param {unknown} value */
function normalizeViewport(value) {
  const entry = plainObject(value);
  if (!entry) return null;
  /** @type {{ width?: number, height?: number, zoom?: number, device?: string, only?: true, media?: string }} */
  const viewport = {};
  const width = positive(entry.width);
  const height = positive(entry.height);
  const zoom = positive(entry.zoom);
  if (width) viewport.width = Math.round(width);
  if (height) viewport.height = Math.round(height);
  if (zoom) viewport.zoom = Math.round(zoom * 1000) / 1000;
  const device = text(entry.device, 20);
  if (/^[a-z]+$/.test(device)) viewport.device = device;
  if (entry.only === true) {
    viewport.only = true;
    const media = text(entry.media, 120);
    if (media.startsWith("@media ")) viewport.media = media;
  }
  return Object.keys(viewport).length > 0 ? viewport : null;
}

/** @param {unknown} value */
function normalizeScope(value) {
  const entry = plainObject(value) || {};
  if (entry.kind === "page") return { kind: "page" };
  if (entry.kind === "repeated") {
    const count = Math.trunc(Number(entry.count));
    const selector = text(entry.selector);
    if (Number.isFinite(count) && count > 1 && selector) return { kind: "repeated", count, selector };
  }
  /** @type {{ kind: "element", count: 1, role?: string, like?: { count: number, selector: string } }} */
  const scope = { kind: "element", count: 1 };
  if (entry.role === "section" || entry.role === "ancestor") scope.role = entry.role;
  const like = plainObject(entry.like);
  const likeCount = Math.trunc(Number(like?.count));
  const likeSelector = text(like?.selector);
  if (like && Number.isFinite(likeCount) && likeCount > 1 && likeSelector) {
    scope.like = { count: likeCount, selector: likeSelector };
  }
  return scope;
}

/** @param {unknown} value */
function normalizeVariable(value) {
  const entry = plainObject(value);
  const name = text(entry?.name, 120);
  if (!entry || !/^--[\w-]+$/.test(name)) return null;
  /** @type {{ name: string, value?: string, declared?: string }} */
  const variable = { name };
  const current = text(entry.value);
  if (current) variable.value = current;
  const declared = text(entry.declared);
  if (declared) variable.declared = declared;
  return variable;
}

/** @param {unknown} value */
function normalizeFrame(value) {
  const entry = plainObject(value);
  if (!entry) return null;
  /** @type {{ item?: string, device?: string, file?: string, page?: string }} */
  const frame = {};
  const item = text(entry.item, 60);
  if (item) frame.item = item;
  const device = text(entry.device, 20);
  if (/^[a-z]+$/.test(device)) frame.device = device;
  const file = text(entry.file);
  if (file && !file.includes("..") && !file.startsWith("/")) frame.file = file;
  const page = text(entry.page);
  if (page.startsWith("/") && !page.startsWith("//") && !/[\s\\]/.test(page)) frame.page = page;
  return Object.keys(frame).length > 0 ? frame : null;
}

/** Where in the source the element comes from, when the board knows. @param {unknown} value */
function normalizeSource(value) {
  const entry = plainObject(value);
  const file = text(entry?.file);
  if (!entry || !file) return null;
  /** @type {{ file: string, line?: number, column?: number }} */
  const source = { file };
  const line = Math.trunc(Number(entry.line));
  if (Number.isFinite(line) && line > 0) source.line = line;
  const column = Math.trunc(Number(entry.column));
  if (Number.isFinite(column) && column > 0) source.column = column;
  return source;
}

/**
 * The one line a person reads for a change record.
 * @param {ReturnType<typeof normalizeChangeRecord> & {}} change
 */
export function changeSummary(change) {
  const before = change.old_value || "(unset)";
  const parts = [`${change.label}: ${change.property} ${before} → ${change.new_value}`];
  const scope = change.scope;
  if (scope.kind === "repeated") parts.push(`on all ${scope.count} matching \`${scope.selector}\``);
  else if (scope.kind === "page") parts.push("on the page");
  else parts.push(`on \`${change.selector}\` only`);
  if (change.variable) parts.push(`(driven by ${change.variable.name})`);
  const viewport = change.viewport;
  if (viewport?.width) {
    const size = viewport.height ? `${viewport.width}×${viewport.height}` : `${viewport.width}px wide`;
    parts.push(viewport.only ? `at ${size} only` : `seen at ${size}`);
  }
  return parts.join(" ");
}

/**
 * @param {unknown} value one raw record from the board client
 * @returns {{
 *   selector: string, label: string, property: string, old_value: string, new_value: string,
 *   scope: ReturnType<typeof normalizeScope>, viewport?: NonNullable<ReturnType<typeof normalizeViewport>>,
 *   variable?: NonNullable<ReturnType<typeof normalizeVariable>>, font_import?: string,
 *   frame?: NonNullable<ReturnType<typeof normalizeFrame>>, source?: NonNullable<ReturnType<typeof normalizeSource>>,
 *   summary: string,
 * } | null}
 */
export function normalizeChangeRecord(value) {
  const entry = plainObject(value);
  if (!entry) return null;
  const selector = text(entry.selector);
  const property = text(entry.property, 120);
  if (!selector || !/^-{0,2}[a-zA-Z][\w-]*$/.test(property)) return null;
  const record = {
    selector,
    label: text(entry.label, 120) || selector,
    property,
    old_value: text(entry.old_value),
    new_value: text(entry.new_value),
    scope: normalizeScope(entry.scope),
  };
  const viewport = normalizeViewport(entry.viewport);
  const variable = normalizeVariable(entry.variable);
  const fontImport = text(entry.font_import);
  const frame = normalizeFrame(entry.frame);
  const source = normalizeSource(entry.source);
  const change = {
    ...record,
    ...(viewport ? { viewport } : {}),
    ...(variable ? { variable } : {}),
    ...(fontImport.startsWith("https://fonts.googleapis.com/") ? { font_import: fontImport } : {}),
    ...(frame ? { frame } : {}),
    ...(source ? { source } : {}),
  };
  return { ...change, summary: changeSummary(/** @type {any} */ (change)) };
}

/**
 * The change records a prompt carries, normalized. An absent or unusable field is no
 * changes, not an error: the prompt text still says what changed.
 * @param {unknown} value
 */
export function normalizeChangeRecords(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_CHANGE_RECORDS)
    .map(normalizeChangeRecord)
    .filter((change) => change !== null);
}

/**
 * The change records as the agent runner shows them under a note: the summary line,
 * then the record itself, so a headless agent reads the same record poll and MCP return.
 * @param {unknown} changes
 * @returns {string[]}
 */
export function changeRecordLines(changes) {
  if (!Array.isArray(changes) || changes.length === 0) return [];
  const lines = ["   Changes (apply at the source; see the rule above):"];
  for (const change of changes) {
    if (!change || typeof change !== "object") continue;
    lines.push(`   - ${change.summary || ""}`, `     Record: ${JSON.stringify(change)}`);
  }
  return lines;
}
