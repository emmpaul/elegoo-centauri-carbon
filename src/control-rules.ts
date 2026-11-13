// Which control command fits which printer state (design D6). The command
// layer (print-control.ts) enforces these rules before sending anything; the
// dashboard reads the same module, served as /src/control-rules.ts, to enable
// only the buttons that would be accepted. It imports types only, so the
// browser can load it with its types stripped.
import type { PrintStateName, StatusSnapshot } from "./status-store.ts";

export type ControlAction = "pause" | "resume" | "stop" | "light";

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
