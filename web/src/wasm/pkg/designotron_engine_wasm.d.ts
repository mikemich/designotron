/* tslint:disable */
/* eslint-disable */
export class WasmEngine {
  free(): void;
  /**
   * Local changes since the last call, for collaborators (`{full}` the first time).
   */
  collabDelta(): string;
  /**
   * Starts the collaboration baseline at the current document; `ordered` when the relay
   * acknowledges changes in order, `granular` when it also takes pages, styles and variables
   * per id (see `Engine::collab_reset`).
   */
  collabReset(ordered: boolean, granular: boolean): void;
  /**
   * JSON array of this editor's unacknowledged and unsent changes, oldest first.
   */
  collabUnsent(): string;
  /**
   * Whether this engine reads and writes pages, styles and variables per id in deltas (what
   * an editor tells the room it can do when joining).
   */
  collabGranular(): boolean;
  /**
   * JSON `{order, changed}`: only top-level layers changed since the last call are re-rendered.
   */
  renderIncremental(page: string, hidden: string, reset: boolean): string;
  constructor(seed: number);
  rev(): number;
  load(json: string): void;
  save(): string;
  query(q: string): string;
  state(): string;
  /**
   * SVG markup for a page; `hidden` is a JSON array of node ids to paint invisibly.
   */
  render(page: string, hidden: string): string;
  /**
   * Executes a JSON command; returns the JSON result or throws the error message.
   */
  dispatch(cmd: string): string;
  /**
   * JSON delta of the document since the last call (`{full}` or `{nodes, removed, meta}`).
   */
  docDelta(full: boolean): string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_wasmengine_free: (a: number, b: number) => void;
  readonly wasmengine_collabDelta: (a: number) => [number, number];
  readonly wasmengine_collabGranular: (a: number) => number;
  readonly wasmengine_collabReset: (a: number, b: number, c: number) => void;
  readonly wasmengine_collabUnsent: (a: number) => [number, number];
  readonly wasmengine_dispatch: (a: number, b: number, c: number) => [number, number, number, number];
  readonly wasmengine_docDelta: (a: number, b: number) => [number, number];
  readonly wasmengine_load: (a: number, b: number, c: number) => [number, number];
  readonly wasmengine_new: (a: number) => number;
  readonly wasmengine_query: (a: number, b: number, c: number) => [number, number, number, number];
  readonly wasmengine_render: (a: number, b: number, c: number, d: number, e: number) => [number, number];
  readonly wasmengine_renderIncremental: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
  readonly wasmengine_rev: (a: number) => number;
  readonly wasmengine_save: (a: number) => [number, number];
  readonly wasmengine_state: (a: number) => [number, number];
  readonly __wbindgen_export_0: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
