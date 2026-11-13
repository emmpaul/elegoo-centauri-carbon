// Single source of truth for printer state: turns raw `sdcp/status` pushes
// into a normalized snapshot with named states (docs/sdcp-protocol.md,
// "Status message").
import { EventEmitter } from "node:events";
import type { ConnectionState } from "./printer-session.ts";
import type { SdcpResponse, StatusMessage } from "./sdcp-client.ts";

/** A protocol code with its name; `name` is "unknown" for codes the reference does not list. */
export interface NamedCode<Name extends string> {
  name: Name | "unknown";
  code: number | null;
}

export type MachineStateName =
  | "idle"
  | "printing"
  | "file-sending"
  | "leveling"
  | "input-shaping"
  | "busy"
  | "file-checking"
  | "homing"
  | "loading-material"
  | "pid-tuning";

export type PrintStateName =
  | "idle"
  | "stopping"
  | "stopped"
  | "completed"
  | "preparing"
  | "pausing"
  | "paused"
  | "file-checking"
  | "restoring"
  | "printing";

/** `Status.CurrentStatus[]` codes ("Machine state" table). */
const MACHINE_STATES: Record<number, MachineStateName> = {
  0: "idle",
  1: "printing",
  2: "file-sending",
  5: "leveling",
  6: "input-shaping",
  7: "busy",
  8: "file-checking",
  9: "homing",
  10: "loading-material",
  11: "pid-tuning",
};

/** `PrintInfo.Status` codes while no job is active ("Under machine state 0"). */
const PRINT_STATES_IDLE: Record<number, PrintStateName> = {
  0: "idle",
  1: "stopping",
  8: "stopped",
  9: "completed",
  14: "stopped",
};

/**
 * `PrintInfo.Status` codes while a job is active ("Under machine state 1").
 * Code 7 has no label in the reference and maps to "unknown".
 */
const PRINT_STATES_ACTIVE: Record<number, PrintStateName> = {
  0: "preparing",
  1: "preparing",
  5: "pausing",
  6: "paused",
  10: "file-checking",
  12: "restoring",
  13: "printing",
  15: "preparing",
  16: "preparing",
  18: "preparing",
  19: "preparing",
  20: "preparing",
  21: "preparing",
};

/** Machine states during which a job is running (the material change, 10, happens mid-job). */
const ACTIVE_MACHINE_CODES = new Set([1, 10]);

export interface Temperature {
  current: number | null;
  target: number | null;
}

export interface StatusSnapshot {
  connection: ConnectionState;
  machineState: NamedCode<MachineStateName>;
  printState: NamedCode<PrintStateName>;
  /** Current job id; null when the printer reports none. */
  taskId: string | null;
  fileName: string | null;
  progress: number | null;
  layer: { current: number | null; total: number | null };
  /** Seconds. */
  elapsed: number | null;
  /** Seconds. */
  remaining: number | null;
  temperatures: { nozzle: Temperature; bed: Temperature; chamber: Temperature };
  light: "on" | "off" | "unknown";
  /**
   * Raw `ErrorStatusReason` of the current (or last) job from its Cmd 321
   * task detail: 0 means no error. Null until a task detail for that job
   * arrives. Static-only mapping (docs/sdcp-protocol.md, "Error codes").
   */
  errorCode: number | null;
  /** When the last status message arrived (ms since epoch); null before the first. */
  updatedAt: number | null;
}

export function emptySnapshot(connection: ConnectionState = "connecting"): StatusSnapshot {
  const none: Temperature = { current: null, target: null };
  return {
    connection,
    machineState: { name: "unknown", code: null },
    printState: { name: "unknown", code: null },
    taskId: null,
    fileName: null,
    progress: null,
    layer: { current: null, total: null },
    elapsed: null,
    remaining: null,
    temperatures: { nozzle: { ...none }, bed: { ...none }, chamber: { ...none } },
    light: "unknown",
    errorCode: null,
    updatedAt: null,
  };
}

/** Builds the status part of a snapshot from one raw `Status` object. */
export function normalizeStatus(
  status: Record<string, unknown>,
  connection: ConnectionState,
  updatedAt: number,
  errorCode: number | null = null,
): StatusSnapshot {
  const codes = Array.isArray(status.CurrentStatus) ? status.CurrentStatus.filter(isNumber) : [];
  const machineCode = codes[0] ?? null;
  const active = codes.some((code) => ACTIVE_MACHINE_CODES.has(code));
  const info = isObject(status.PrintInfo) ? status.PrintInfo : {};
  const printCode = num(info.Status);
  const printName = printCode === null ? undefined : (active ? PRINT_STATES_ACTIVE : PRINT_STATES_IDLE)[printCode];
  const currentTicks = num(info.CurrentTicks);
  const totalTicks = num(info.TotalTicks);
  const light = isObject(status.LightStatus) ? num(status.LightStatus.SecondLight) : null;
  const rawProgress = num(info.Progress);

  return {
    connection,
    machineState: { name: (machineCode !== null && MACHINE_STATES[machineCode]) || "unknown", code: machineCode },
    printState: { name: printName ?? "unknown", code: printCode },
    taskId: nonEmpty(info.TaskId),
    fileName: nonEmpty(info.Filename),
    // The printer resets Progress to 0 on completion; the web UI shows 100 then.
    progress: printName === "completed" ? 100 : rawProgress,
    layer: { current: num(info.CurrentLayer), total: num(info.TotalLayer) },
    elapsed: currentTicks === null ? null : Math.round(currentTicks),
    remaining: currentTicks === null || totalTicks === null ? null : Math.max(0, Math.round(totalTicks - currentTicks)),
    temperatures: {
      nozzle: { current: temp(status.TempOfNozzle), target: temp(status.TempTargetNozzle) },
      bed: { current: temp(status.TempOfHotbed), target: temp(status.TempTargetHotbed) },
      chamber: { current: temp(status.TempOfBox), target: temp(status.TempTargetBox) },
    },
    light: light === 1 ? "on" : light === 0 ? "off" : "unknown",
    errorCode,
    updatedAt,
  };
}

/** Anything that reports connection state changes and status pushes (a PrinterSession). */
export interface StatusSource {
  on(event: "state", listener: (state: ConnectionState) => void): unknown;
  on(event: "status", listener: (message: StatusMessage) => void): unknown;
}

type StoreEvents = { change: [StatusSnapshot] };

/** Holds the latest snapshot and emits "change" whenever it changes. */
export class StatusStore extends EventEmitter<StoreEvents> {
  private current: StatusSnapshot = emptySnapshot();
  private raw: Record<string, unknown> = {};
  /** Task id of the current or last job; status pushes drop it once a job completes. */
  private jobId: string | null = null;

  get snapshot(): StatusSnapshot {
    return structuredClone(this.current);
  }

  /** Follows a session's state changes and status pushes. */
  attach(source: StatusSource): void {
    source.on("state", (state) => this.setConnection(state));
    source.on("status", (message) => this.applyStatus(message));
  }

  /**
   * Applies one status push. Fields the push leaves out keep their previous
   * raw value, so a partial push does not blank the snapshot.
   */
  applyStatus(message: StatusMessage, now: number = Date.now()): void {
    const previousInfo = isObject(this.raw.PrintInfo) ? this.raw.PrintInfo : {};
    const nextInfo = isObject(message.Status.PrintInfo) ? message.Status.PrintInfo : {};
    this.raw = { ...this.raw, ...message.Status, PrintInfo: { ...previousInfo, ...nextInfo } };
    const taskId = nonEmpty(isObject(this.raw.PrintInfo) ? this.raw.PrintInfo.TaskId : undefined);
    let errorCode = this.current.errorCode;
    if (taskId !== null && taskId !== this.jobId) {
      this.jobId = taskId;
      errorCode = null;
    }
    this.current = normalizeStatus(this.raw, this.current.connection, now, errorCode);
    this.emit("change", this.snapshot);
  }

  /**
   * Applies a Cmd 321 (task detail) answer: takes `ErrorStatusReason` of the
   * entry for the current or last job as the raw error code. Other commands
   * and other tasks' entries are ignored.
   */
  applyTaskDetail(response: SdcpResponse): void {
    if (response.Data.Cmd !== 321 || this.jobId === null) return;
    const list = response.Data.Data.HistoryDetailList;
    if (!Array.isArray(list)) return;
    const entry = list.find((item): item is Record<string, unknown> => isObject(item) && item.TaskId === this.jobId);
    if (!entry) return;
    const errorCode = num(entry.ErrorStatusReason);
    if (errorCode === this.current.errorCode) return;
    this.current = { ...this.current, errorCode };
    this.emit("change", this.snapshot);
  }

  setConnection(connection: ConnectionState): void {
    if (this.current.connection === connection) return;
    this.current = { ...this.current, connection };
    this.emit("change", this.snapshot);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function num(value: unknown): number | null {
  return isNumber(value) ? value : null;
}

function temp(value: unknown): number | null {
  return isNumber(value) ? Math.round(value * 10) / 10 : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
