# SDCP protocol reference (Centauri Carbon)

Reference for the local SDCP protocol as spoken by the Elegoo Centauri Carbon,
built from the printer's own web UI bundle (static pass) and from frames seen
on the wire (live pass). Each entry carries one of these labels:

- *static-only*: read from the web UI bundle, not yet seen on the wire.
- *observed*: seen in live traffic between Elegoo's web UI and the printer.
- *tested*: sent by this project's client and confirmed by the printer.

## Source artifacts

Captured on 2026-11-13 from `http://192.0.2.10/`. The files were downloaded
into a scratch directory outside the repository and treated as untrusted data;
they are not committed.

| Item | Value |
| --- | --- |
| Firmware | `V1.4.49` (UDP discovery reply, `FirmwareVersion`) |
| Protocol version | `V3.0.0` (UDP discovery reply, `ProtocolVersion`) |
| Mainboard id | `40551f980103d46c00004c0000000000` |

| File | Size (bytes) | SHA-256 |
| --- | ---: | --- |
| `main.f1485af82d8237b5b3c1.js` | 805227 | `1d74fa61d2b74efe14eecf1006c1f816e1803848fdb55435e00654bf6e7cb1eb` |
| `runtime.d8e385257819bb9e3f4a.js` | 2787 | `10f8f94977736b6b85a12178febd6631f4e1c9606a2257addb63991e15da18ea` |
| `polyfills.cbade4b333952df5eb42.js` | 33648 | `77843e84d1b61c2b68e282eb01da161d836f86974bc59be17f0b69ef031d666b` |
| `index.html` | 2166 | `333db73dce5ce223f42bb88c3b7e9c073ecf9835f9a0ea2eef68c1d495612527` |
| `25.a66e4a8918f0e5d04852.js` (lazy chunk, control page) | 416037 | `6b7381830a71920b7c152d4fa93d22a78a2cea8a4d19843733ece9814e97bfe6` |
| `624.daeeadece3842f2bd4f0.js` (lazy chunk, route module) | 58322 | `8d0ff2f59664809c62274654a61a8c12e35e2af6bcde6def36521ceda57afb00` |
| `assets/i18n/network-en.json` (UI strings) | 6995 | `c304fa768caf38e0b937b50c30847ad62079d692f767a40b9e67355cf09ffe29` |

The two lazy chunks are listed in `runtime.*.js` (`i.u`); the control page,
with pause, resume, stop, and light, lives in chunk 25, not in `main.*.js`.

When the firmware changes, download the new bundle, compare hashes, and re-run
the static pass (REA `compare_bundles`) before trusting this document.

## How to read the citations

Citations have the form `<file>@<byte offset>`, where `<file>` is `main` (for
`main.f1485af82d8237b5b3c1.js`), `c25` (for `25.a66e4a8918f0e5d04852.js`), or
`i18n` (for `assets/i18n/network-en.json`, cited by JSON path). Offsets are
zero-based byte offsets into the files whose hashes are listed above.

Static pass evidence: REA `analyze_javascript_application` over the scratch
directory (bundles parsed as inert text, never executed), Evidence
`ev_4c8ba51b29405af91d11bcc30c4c66afa498355480d3db15e0a7417c0e6f4d38`
(main, c25, 624, runtime). REA's graph tracing did not resolve the minified
call sites, so the call sites below were located by literal string search over
the same files and read in place.

## Transport

| Item | Value | Label | Source |
| --- | --- | --- | --- |
| WebSocket URL | `ws://<printer-ip>:3030/websocket` | *static-only* | main@783931 (`connect()`) |
| Connect delay | the UI opens the socket 3 s after `createWebSocket()` | *static-only* | main@783970 (`createWebSocket()`) |
| Heartbeat | the UI sends the text frame `ping` every 30 s while `readyState === 1` | *static-only* | main@785449 (`period=3e4` at main@783494) |
| Reconnect | on `onerror`, the UI stops the heartbeat and reconnects | *static-only* | main@785125 (`onError`) |
| Topic routing | inbound JSON has a `Topic` string; the UI routes by substring `sdcp/status`, `sdcp/attributes`, `sdcp/response`, `sdcp/error` | *static-only* | main@784465, main@784631, main@784799, main@784969 |
| Camera | `Cmd 386 {Enable:1}` answers with `Data.Data.VideoUrl`; the UI shows MJPEG when `Attributes.Capabilities` has `VIDEO_STREAM`, WebRTC when it has `VIDEO_WEBRTC` | *static-only* | c25@325607, c25@283220 |

*static-only*: the UI sends no non-JSON frame to port 3030 other than
`ping`. No reply format for `ping` appears in the bundle.

## Request envelope

Built by `getMsgBodyString(id, cmd, mainboardId = "", data)` (main@775984,
class at main@775747):

```json
{
  "Id": "",
  "Data": {
    "Cmd": 0,
    "Data": {},
    "RequestID": "<uuid v4 without dashes>",
    "MainboardID": "<mainboard id or empty string>",
    "TimeStamp": 1763050000000,
    "From": 1
  }
}
```

| Field | Notes | Label | Source |
| --- | --- | --- | --- |
| `Id` | always `""` in the builder, even when an id is passed | *static-only* | main@776059 |
| `Data.Cmd` | numeric command id (table below) | *static-only* | main@776071 |
| `Data.Data` | command payload, `{}` when absent | *static-only* | main@776081 |
| `Data.RequestID` | `uuid()` with `-` removed (32 hex chars) | *static-only* | main@776093 |
| `Data.MainboardID` | many calls pass `""`; control calls pass `Attributes.MainboardID` | *static-only* | main@776115 |
| `Data.TimeStamp` | `Date.now()` in **milliseconds** | *static-only* | main@776141 |
| `Data.From` | always `1` (web UI) | *static-only* | main@776163 |

## Response envelope

Read by the response handlers (main@776976 onward, c25@321079). Every point
in this list is *static-only*:

- `Topic` contains `sdcp/response`.
- `Data.Cmd` echoes the request's command id.
- `Data.Data.Ack` is the result: `0` success; other values are failures. Cmd
  131 (resume) treats `Ack === 2` as "blocked, see
  `TaskDetail.ErrorStatusReason`" (c25@321459). Cmd 128 maps `Ack` 0-7 to the
  messages in `i18n:networkDeviceManager.control.printer`.
- `Data.MainboardID` is compared with the attribute's `MainboardID` for file
  lists (main@779200).

Not found statically: whether `Data.RequestID` is echoed in the response. The
UI does not correlate by `RequestID`; it subscribes per command id.

## Command ids

Constant table at main@774974 (module `543`). "Call site" is where the UI
builds and sends the command.

| Cmd | Constant name | Payload | Call site | Notes | Label |
| ---: | --- | --- | --- | --- | --- |
| 0 | `GET_PRINTER_STATUS` | none | main@782822 | sent once on connect | *static-only* |
| 1 | `GET_PRINTER_ATTR` | none | main@782894 | sent once on connect | *static-only* |
| 64 | `SEND_PRINTER_DISCONNECT` | - | none | defined, never sent | *static-only* |
| 128 | `SEND_PRINTER_START_PRINT` | `{Filename, StartLayer:0, Calibration_switch, PrintPlatformType, Tlp_Switch, slot_map}` | c25@33800 (`sendStartPrint`, c25@32772) | out of scope | *static-only* |
| 129 | `SEND_PRINTER_SUSPEND_PRINT` | none | c25@322328 (`stop()`, c25@320381) | **pause**; sent when `PrintInfo.Status !== 6` | *static-only* |
| 130 | `SEND_PRINTER_STOP_PRINT` | none | c25@323551 (`cease()`, c25@322462) | **stop**; the UI asks for no confirmation in code | *static-only* |
| 131 | `SEND_PRINTER_RESTORE_PRINT` | none | c25@322085 (`stop()`) | **resume**; sent when `PrintInfo.Status === 6` | *static-only* |
| 134 | `GET_BLACKOUT_STATUS` | none | main@783040 | sent on connect; `Ack === 1` means an unfinished print after power loss | *static-only* |
| 135 | `SEND_BLACKOUT_ACTION` | `{action: 1 \| 0}` | main@779951 | 1 resume, 0 discard; only after a user dialog | *static-only* |
| 192 | `SEND_PRINTER_EDIT_NAME` | - | none | defined, never sent | *static-only* |
| 255 | `SEND_PRINTER_SEND_FILE_END` | - | none | defined, never sent | *static-only* |
| 257 | `EDIT_PRINTER_FILE_NAME` | file rename | c25@395716 | out of scope | *static-only* |
| 258 | `GET_PRINTER_FILE_LIST` | `{Url: "/local"}` | main@783113 | sent on connect | *static-only* |
| 259 | `DELETE_PRINTER_FILE_LIST` | file list | c25@335583 | out of scope | *static-only* |
| 260 | `GET_PRINTER_FILE_DETAIL` | file name | c25@327761 | answer has `Data.Data.FileInfo` (`EstTime`, `EstWeight`, `TotalLayers`, `ColorNum`) (c25@328317) | *static-only* |
| 320 | `GET_PRINTER_HISTORY_ID` | none | main@782964 | answer `Data.Data.HistoryData` is a list of task ids | *static-only* |
| 321 | `GET_PRINTER_TASK_DETAIL` | `{Id: [<TaskId>, ...]}` | main@780760 | answer `Data.Data.HistoryDetailList[]` with `TaskId`, `TaskName`, `Thumbnail`, `ErrorStatusReason`, `TimeLapseVideoStatus`, `TimeLapseVideoUrl` | *static-only* |
| 322 | `DELETE_PRINTER_HISTORY` | ids | c25@332063 | out of scope | *static-only* |
| 323 | `GET_PRINTER_HISTORY_VIDEO` | id | c25@337975 | out of scope | *static-only* |
| 324 | `GET_MATERIAL_DATA` | - | c25@328736 | AMS material data | *static-only* |
| 386 | `EDIT_PRINTER_VIDEO_STREAMING` | `{Enable: 1 \| 0}` | c25@325607, c25@326443 | the control page enables the camera when the socket connects (c25@319343) | *static-only* |
| 387 | `EDIT_PRINTER_TIME_LAPSE_STATUS` | - | none | defined, never sent | *static-only* |
| 401 | `EDIT_PRINTER_AXIS_NUMBER` | jog | c25@326738 | out of scope | *static-only* |
| 402 | `EDIT_PRINTER_AXIS_ZERO` | `{Axis}` | c25@324257 | out of scope; refused by the UI while printing | *static-only* |
| 403 | `EDIT_PRINTER_STATUS_DATA` | partial status object, see below | c25@119657 (light), c25@118308 (fans), c25@320313 (speed), c25@334237 / c25@334960 (temps) | **light** goes through this command | *static-only* |
| 503 | `GET_FILE_COLOR_DATA` | - | none | defined, never sent | *static-only* |

### Cmd 403 payloads (`EDIT_PRINTER_STATUS_DATA`)

| Purpose | `Data.Data` | Source | Label |
| --- | --- | --- | --- |
| Chamber light | `{LightStatus: <whole Status.LightStatus object>}` after the switch sets `LightStatus.SecondLight` to the new value | c25@122735 (switch), c25@119393 (`changeLight`) | *static-only* |
| Fans | `{TargetFanSpeed: <whole Status.CurrentFanSpeed object>}` with `ModelFan`, `AuxiliaryFan`, `BoxFan` (0-100) | c25@118308, c25@123034 | *static-only* |
| Print speed | `{PrintSpeedPct: 50 \| 100 \| 130 \| 160}` (`i18n:networkDeviceManager.control.speedList`) | c25@320313 | *static-only* |
| Nozzle target | `{TempTargetNozzle: <number>}` | c25@334237 | *static-only* |
| Bed target | `{TempTargetHotbed: <number>}` | c25@334960 | *static-only* |

The UI shows a toast from the `Ack` of the 403 response (c25@318975). The
exact type of `SecondLight` (boolean or 0/1) is not visible statically.

### UI guards before control commands

*static-only*: from `stop()` (c25@320381) and `cease()` (c25@322462), and
the button `disabled-img` bindings at c25@263398:

- pause/resume and stop are ignored while `PrintInfo.Status` is 5, 7, or 12,
  or while a previous command is pending (5 s lockout);
- pause/resume picks 131 when `PrintInfo.Status === 6`, else 129;
- the pause/stop block is shown only when `CurrentStatus` includes 1
  (c25@265917).

## Status message (`sdcp/status`)

Pushed by the printer; the UI stores `msg.Status` as-is (main@782513). Fields
the UI reads (all *static-only*):

| Field | Meaning (from the UI) | Source | Label |
| --- | --- | --- | --- |
| `Status.CurrentStatus` | array of machine-state codes (table below) | c25@266283 (`Gs` template) | *static-only* |
| `Status.PrintInfo.Status` | print-state code (table below) | c25@8626 | *static-only* |
| `Status.PrintInfo.Progress` | percent; the UI shows 100 when `Status === 9` | c25@264786 | *static-only* |
| `Status.PrintInfo.CurrentLayer`, `TotalLayer` | layers | c25@265649 | *static-only* |
| `Status.PrintInfo.CurrentTicks`, `TotalTicks` | seconds elapsed and total; remaining = total - current | c25@265023 | *static-only* |
| `Status.PrintInfo.PrintSpeedPct` | speed percent | c25@320313 | *static-only* |
| `Status.PrintInfo.TaskId` | current job id; the UI uses it to fetch Cmd 321 | main@781286 | *static-only* |
| `Status.TempOfNozzle`, `TempTargetNozzle` | nozzle current/target (deg C) | c25@285924 | *static-only* |
| `Status.TempOfHotbed`, `TempTargetHotbed` | bed current/target | c25@286318 | *static-only* |
| `Status.TempOfBox` | chamber current; **no `TempTargetBox` is read anywhere** | c25@286708 | *static-only* |
| `Status.CurrentFanSpeed.{ModelFan,AuxiliaryFan,BoxFan}` | fan percent | c25@123034 | *static-only* |
| `Status.LightStatus.SecondLight` | chamber light state | c25@124019 | *static-only* |
| `Status.CurrenCoord` | toolhead coordinates (sic) | c25@272342 | *static-only* |
| `Status.AmsConnectStatus` | AMS present | c25@29562 | *static-only* |

The current file name is shown from `TaskDetail.TaskName` (Cmd 321), not from
the status message; whether the status message carries a file name is not
visible statically.

### Machine state: `Status.CurrentStatus[]`

Template `Gs` (c25@266283); labels from `i18n:networkDeviceManager.control.status`.

| Code | UI label | Notes | Label |
| ---: | --- | --- | --- |
| 0 | Idle | shows the "idle" print-state group | *static-only* |
| 1 | Printing | shows the "printing" print-state group and the pause/stop controls | *static-only* |
| 2 | File Sending | shown only when it is the only code | *static-only* |
| 5 | Leveling | | *static-only* |
| 6 | Input shaping | | *static-only* |
| 7 | busy | | *static-only* |
| 8 | File Checking | shown only when it is the only code; main refreshes the file list after it clears (main@780227) | *static-only* |
| 9 | Homing | | *static-only* |
| 10 | Incoming or outgoing materials | | *static-only* |
| 11 | Tuning the Nozzle PID | | *static-only* |

Codes 3 and 4 are not referenced.

### Print state: `Status.PrintInfo.Status`

Status groups at c25@8626 (`STATUS_*` arrays), shown under machine state 0
(`_s`, c25@256127) or 1 (`Ls`, c25@257906):

| Code | Under machine state 0 | Under machine state 1 | Label |
| ---: | --- | --- | --- |
| 0 | Idle (`STATUS_WAIT`) | Preparing (`STATUS_LOADING`) | *static-only* |
| 1 | Stopping (`STATUS_STOPING`) | Preparing (`STATUS_LOADING`) | *static-only* |
| 5 | - | Pausing (`STATUS_SUSPENDING`) | *static-only* |
| 6 | - | Paused (`STATUS_SUSPENDED`) | *static-only* |
| 7 | - | not labelled; controls disabled | *static-only* |
| 8 | Stopped (`STATUS_STOPED`) | - | *static-only* |
| 9 | Print Complete (`STATUS_COMPLETE`) | - | *static-only* |
| 10 | - | File Checking (`STATUS_FILE_DETECTION`) | *static-only* |
| 12 | - | Restoring (`STATUS_RECOVERY`); controls disabled | *static-only* |
| 13 | - | Printing (`STATUS_PRINTING`) | *static-only* |
| 14 | Stopped (`STATUS_STOPED`) | - | *static-only* |
| 15, 16, 18, 19, 20, 21 | - | Preparing (`STATUS_LOADING`) | *static-only* |

Codes 2, 3, 4, 11, and 17 are not referenced.

### Error codes

- *static-only*: `TaskDetail.ErrorStatusReason` (Cmd 321 answer): the UI only names code 45,
  "Consumables are about to run out, please replace consumables"
  (`i18n:networkDeviceManager.control.errorStatusReason.45`, main@777696).
  No other error code table ships with the web UI.
- *static-only*: `sdcp/error` messages are routed (main@784969) but no handler reads them.

## Attributes message (`sdcp/attributes`)

The UI merges `msg.Attributes` into its printer record (main@782653). Fields
read: `MainboardID`, `MainboardIP`, `Name`, `Capabilities` (contains
`VIDEO_STREAM` and/or `VIDEO_WEBRTC`), `CameraStatus`. *static-only*.

## Connect sequence used by the web UI

On socket open (main@782801-783113) the UI sends, in this order, all with
`MainboardID: ""`: Cmd 0, Cmd 1, Cmd 320, Cmd 134, Cmd 258 `{Url:"/local"}`.
When `CurrentStatus` includes 1 and `PrintInfo.TaskId` is set, it also sends
Cmd 321 for that task (main@780760). The control page then sends Cmd 386
`{Enable:1}` to start the camera (c25@325607). *static-only*.

## Open points for the live pass

- Response format and `RequestID` echo for each command.
- Whether the printer pushes `sdcp/status` unprompted, and how often.
- Value type of `LightStatus.SecondLight`.
- Meaning of `PrintInfo.Status` 7 and the unreferenced codes.
- Whether `TaskId` is stable across reconnects (design open question).
