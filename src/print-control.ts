// Print control: pause, resume, stop, and the chamber light. Every command is
// checked against the current status snapshot here, in one place, before
// anything is sent (design D6); a rejected command sends nothing.
import { Cmd, type SdcpResponse } from "./sdcp-client.ts";
import type { PrintStateName, StatusSnapshot } from "./status-store.ts";

export type ControlAction = "pause" | "resume" | "stop" | "light";

export type RejectReason = "not-allowed" | "confirmation-required";

/** A control command refused before sending: nothing reached the printer. */
export class ControlRejectedError extends Error {
  readonly action: ControlAction;
  readonly reason: RejectReason;
  constructor(action: ControlAction, reason: RejectReason) {
    super(
      reason === "confirmation-required"
        ? `${action} requires explicit confirmation`
        : `${action} is not allowed in the current state`,
    );
    this.name = "ControlRejectedError";
    this.action = action;
    this.reason = reason;
  }
}

/** Sends one SDCP command (a PrinterSession). */
export interface CommandSender {
  send(cmd: number, data?: Record<string, unknown>): Promise<SdcpResponse>;
}

/** Current printer state (a StatusStore). */
export interface ControlStateSource {
  readonly snapshot: StatusSnapshot;
  readonly lightStatus: Record<string, unknown> | null;
}

/**
 * Print states in which each command may be sent. They follow the web UI's
 * guards (docs/sdcp-protocol.md, "UI guards before control commands"): no
 * control while pausing (5), restoring (12), or in the unlabelled code 7
 * ("unknown"); resume only while paused (6); pause otherwise while a job is
 * active. Every idle-side state (idle, stopping, stopped, completed) and every
 * unknown code is refused.
 */
const ALLOWED_PRINT_STATES: Record<Exclude<ControlAction, "light">, ReadonlySet<PrintStateName>> = {
  pause: new Set(["preparing", "file-checking", "printing"]),
  resume: new Set(["paused"]),
  stop: new Set(["preparing", "file-checking", "printing", "paused"]),
};

/**
 * Whether `action` fits the snapshot. Nothing is allowed unless the printer is
 * online, since an offline snapshot is stale. The light needs a known
 * `LightStatus` (`lightKnown`) because its command sends that object back.
 */
export function isAllowed(action: ControlAction, snapshot: StatusSnapshot, lightKnown = snapshot.light !== "unknown"): boolean {
  if (snapshot.connection !== "online") return false;
  if (action === "light") return lightKnown;
  const name = snapshot.printState.name;
  return name !== "unknown" && ALLOWED_PRINT_STATES[action].has(name);
}

export interface StopOptions {
  /** Must be true: a stop without explicit confirmation is rejected. */
  confirm?: boolean;
}

export class PrintControl {
  private readonly sender: CommandSender;
  private readonly state: ControlStateSource;

  constructor(sender: CommandSender, state: ControlStateSource) {
    this.sender = sender;
    this.state = state;
  }

  /** Pauses the running print (Cmd 129). */
  pause(): Promise<SdcpResponse> {
    return this.checked("pause", () => this.sender.send(Cmd.SEND_PRINTER_SUSPEND_PRINT));
  }

  /** Resumes the paused print (Cmd 131). */
  resume(): Promise<SdcpResponse> {
    return this.checked("resume", () => this.sender.send(Cmd.SEND_PRINTER_RESTORE_PRINT));
  }

  /** Stops the current print (Cmd 130); requires `{confirm: true}`. */
  stop(options: StopOptions = {}): Promise<SdcpResponse> {
    if (options.confirm !== true) return Promise.reject(new ControlRejectedError("stop", "confirmation-required"));
    return this.checked("stop", () => this.sender.send(Cmd.SEND_PRINTER_STOP_PRINT));
  }

  /**
   * Turns the chamber light on or off (Cmd 403). Sends the whole last-seen
   * `LightStatus` object with `SecondLight` set, as the web UI does.
   */
  setLight(on: boolean): Promise<SdcpResponse> {
    const lightStatus = this.state.lightStatus;
    return this.checked(
      "light",
      () => this.sender.send(Cmd.EDIT_PRINTER_STATUS_DATA, { LightStatus: { ...lightStatus, SecondLight: on ? 1 : 0 } }),
      lightStatus !== null,
    );
  }

  private checked(action: ControlAction, send: () => Promise<SdcpResponse>, lightKnown?: boolean): Promise<SdcpResponse> {
    if (!isAllowed(action, this.state.snapshot, lightKnown)) {
      return Promise.reject(new ControlRejectedError(action, "not-allowed"));
    }
    return send();
  }
}
