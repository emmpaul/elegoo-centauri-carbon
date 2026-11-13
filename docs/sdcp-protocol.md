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

Observed entries cite a recorded fixture as `<fixture>#<seq>`, where
`<fixture>` is a file in `test/fixtures/` and `<seq>` is the `seq` of a frame
in it.

Static pass evidence: REA `analyze_javascript_application` over the scratch
directory (bundles parsed as inert text, never executed), Evidence
`ev_4c8ba51b29405af91d11bcc30c4c66afa498355480d3db15e0a7417c0e6f4d38`
(main, c25, 624, runtime). REA's graph tracing did not resolve the minified
call sites, so the call sites below were located by literal string search over
the same files and read in place.

## Live captures

Live pass, read-only, on 2026-11-13. REA `capture_browser_scenario` launched
a headless Chromium on `http://192.0.2.10/` and only waited (no clicks, no
form input); every frame this project recorded as sent came from Elegoo's web
UI on page load. Those UI frames are Cmd 0, 1, 320, 134, 258, 321, and in
three of the four captures Cmd 386 `{Enable:1}`, which turns the camera
stream on. No other state-changing command was sent.

The printer was in use by its owner during the pass, so the captures cover
more than a plain idle machine. The print start and file upload in
`connect-idle.json` came from another client.

| Fixture | REA Evidence | Printer state during the capture |
| --- | --- | --- |
| `connect-loading.json` | `ev_273fc86943d315c5f04828335af66e1337a246b96349417424c171107b1df20d` | printing, material-change phase: `CurrentStatus` 10 then 1, `PrintInfo.Status` 16 then 20, ticks frozen |
| `connect-printing.json` | `ev_0b2a5ed9541809fdb23aaaedb79c4b47c019335db386e73a7d5f6d9a8eb7b318` | printing: `CurrentStatus` [1], `PrintInfo.Status` 13, progress 53 to 87 |
| `print-complete.json` | `ev_cac2f3eb5eed331806ce07b8f047033146ab834f4fda66d806ede03308a40806` | the job finishes: `CurrentStatus` [1] / 13 to [0] / 9 |
| `connect-idle.json` | `ev_ef7920b458d061eb14599de8b0ff3ee2dc996277c70484026820d21aa5cd893e` | idle with a file upload (2, then 8), idle (0), then a new job starts (1, `PrintInfo.Status` 18 then 1) |

### Control capture (pause, resume, light)

Live pass on 2026-11-13 during the owner's running job `9f0f4d7e` (the job
that starts in `connect-idle.json`). It was recorded by a plain WebSocket
client from this project (a scratch script, not committed). The client
connected to `ws://192.0.2.10:3030/websocket`, sent only Cmd 0 and Cmd 1
(Cmd 0 again after 60 s), and recorded every pushed frame for 81 s. It sent
no control command. The owner pressed pause, then resume, then turned the
chamber light off and on, from Elegoo's web UI in their own browser, which
was a **separate** WebSocket connection to the printer. Stop was not pressed
and stays *static-only*.

| Fixture | Recorded by | Printer state during the capture |
| --- | --- | --- |
| `control-pause-resume-light.json` | this project's passive WebSocket recorder | printing (`CurrentStatus` [1], `PrintInfo.Status` 13); pause 13 → 5 → 6, resume 6 → 20 → 13, light `SecondLight` 1 → 0 → 1 |

What this capture shows and what it cannot show:

- *observed*: the printer's **status pushes** that follow each control
  command (state transitions, light state), as seen by another client.
- not seen: the browser's **request frames** (Cmd 129, 131, 403) and the
  printer's **responses** to them. No response to those commands reached this
  client, only its own Cmd 0/1 responses, so the
  request payloads and the response format of the control commands stay
  *static-only*. The client's own Cmd 0/1 responses in this capture have the
  usual `{Ack: 0}` shape.

This fixture also has `tMs`, the milliseconds since the socket opened, on
each frame.

Each fixture is `{source, frames: [{seq, direction, payload}]}`, with frames
in receipt order and payloads parsed from JSON (the heartbeat stays the string
`"ping"`). `direction` is exactly one of two strings, the same in every
fixture: `"sent"` for a frame from a client to the printer, and
`"received"` for a frame from the printer to the recording client. The fixtures keep the printer's real task ids and mainboard id,
but device and owner details are redacted, here and in this document: the
printer's LAN IP is replaced by the documentation address `192.0.2.10`, its
MAC by `00:00:00:00:00:00`, and every print file name (in `Filename`,
`TaskName`, `TimeLapseVideoUrl`, and the file lists) by `test-print-<n>.gcode`,
with the same original name mapped to the same placeholder in every fixture.

### Discovery capture

Live probe, read-only, on 2026-11-13 (task 3.1). A scratch script from this
project (not committed) sent the plain-text datagram `M99999` once to
`192.0.2.10:3000` (unicast) and recorded the first reply, which came back from
the same address with source port 3000.

| Fixture | Recorded by | Printer state during the capture |
| --- | --- | --- |
| `discovery-reply.json` | this project's UDP probe | not read; the reply carries no state |

*observed* (`discovery-reply.json#2`): the reply is one JSON datagram
`{Id, Data: {Name, MachineName, BrandName, MainboardIP, MainboardID,
ProtocolVersion, FirmwareVersion}}`, with `ProtocolVersion` `V3.0.0` and
`FirmwareVersion` `V1.4.49`. It has no `Topic`, unlike the WebSocket messages.
The fixture uses the same frame schema as the others (`#1` is the probe as
sent, a string). Redaction as above: `MainboardIP` is `192.0.2.10`; the reply
has no MAC and no file names. Broadcast discovery was not tried.

## Transport

| Item | Value | Label | Source |
| --- | --- | --- | --- |
| WebSocket URL | `ws://<printer-ip>:3030/websocket` | *observed* | main@783931 (`connect()`); every fixture's `source.socket` |
| Connect delay | the UI opens the socket 3 s after `createWebSocket()` | *static-only* | main@783970 (`createWebSocket()`) |
| Heartbeat | the UI sends the text frame `ping` every 30 s while `readyState === 1`; **the printer sends no reply** (6 pings across the captures, no non-JSON frame received) | *observed* | main@785449 (`period=3e4` at main@783494); `connect-printing.json#33`, `#46` |
| Reconnect | on `onerror`, the UI stops the heartbeat and reconnects | *static-only* | main@785125 (`onError`) |
| Topic routing | inbound JSON has a `Topic` string of the form `sdcp/<kind>/<MainboardID>`; seen kinds: `status`, `attributes`, `response` | *observed* | main@784465, main@784631, main@784799; `connect-loading.json#11`, `#13`, `#17` |
| `sdcp/error` topic | routed by the UI (main@784969); never seen on the wire | *static-only* | main@784969 |
| Camera | `Cmd 386 {Enable:1}` answers `Data.Data.VideoUrl` = `"192.0.2.10:3031/video"` (host:port/path, **no scheme**); `Attributes.Capabilities` has `VIDEO_STREAM` (MJPEG), not `VIDEO_WEBRTC` | *observed* | c25@325607, c25@283220; `connect-loading.json#10`, `#26`, `#17` |

The UI sends no non-JSON frame to port 3030 other than `ping` (*observed*:
every sent frame in the fixtures is JSON or `ping`).

## Request envelope

Built by `getMsgBodyString(id, cmd, mainboardId = "", data)` (main@775984,
class at main@775747). *observed* exactly in this shape in every sent frame
(for example `connect-loading.json#4`):

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
| `Id` | always `""` | *observed* | main@776059; `connect-loading.json#4` |
| `Data.Cmd` | numeric command id (table below) | *observed* | main@776071; `connect-loading.json#4` |
| `Data.Data` | command payload, `{}` when absent | *observed* | main@776081; `connect-loading.json#4`, `#8` |
| `Data.RequestID` | `uuid()` with `-` removed (32 hex chars) | *observed* | main@776093; `connect-loading.json#4` |
| `Data.MainboardID` | `""` on the connect commands; the Cmd 321 sent for the running job may carry `Attributes.MainboardID` | *observed* | main@776115; `connect-loading.json#38`, `connect-idle.json#35` |
| `Data.TimeStamp` | `Date.now()` in **milliseconds** | *observed* | main@776141; `connect-loading.json#4` |
| `Data.From` | always `1` (web UI) | *observed* | main@776163; `connect-loading.json#4` |

The printer accepts requests with `MainboardID: ""` (*observed*: every
connect command is answered with `Ack: 0`).

## Response envelope

*observed*: example `connect-loading.json#13`:

```json
{
  "Id": "979d4C788A4a78bC777A870F1A02867A",
  "Data": {
    "Cmd": 0,
    "Data": { "Ack": 0 },
    "RequestID": "1d768b7ea6cf4047a4c71e38a2602464",
    "MainboardID": "40551f980103d46c00004c0000000000",
    "TimeStamp": 1794605229
  },
  "Topic": "sdcp/response/40551f980103d46c00004c0000000000"
}
```

| Field | Notes | Label | Source |
| --- | --- | --- | --- |
| `Topic` | `sdcp/response/<MainboardID>` | *observed* | `connect-loading.json#13` |
| `Id` | a fixed 32-character value, the same in every response and capture; not the request's `Id` | *observed* | `connect-loading.json#13`, `connect-idle.json#7` |
| `Data.Cmd` | echoes the request's command id | *observed* | `connect-loading.json#13`, `#15` |
| `Data.RequestID` | **echoes the request's `RequestID`**, so responses can be correlated by it | *observed* | `connect-loading.json#4` and `#13`, `#10` and `#26` |
| `Data.MainboardID` | the printer's mainboard id, even when the request sent `""` | *observed* | `connect-loading.json#13` |
| `Data.TimeStamp` | **seconds** (requests use milliseconds) | *observed* | `connect-loading.json#13` |
| `Data.Data.Ack` | `0` success. Other values are failures (*static-only*): Cmd 131 treats `Ack === 2` as "blocked, see `TaskDetail.ErrorStatusReason`" (c25@321459); Cmd 128 maps `Ack` 0-7 to the messages in `i18n:networkDeviceManager.control.printer` | *observed* (`0` only) | main@776976, c25@321079; every response in the fixtures |

Responses arrive out of request order with pushed messages in between
(*observed*: `connect-loading.json#11` is a status push before the Cmd 0
response at `#13`). The web UI itself does not correlate by `RequestID`; it
subscribes per command id (*static-only*).

## Command ids

Constant table at main@774974 (module `543`). "Call site" is where the UI
builds and sends the command. Rows labelled *observed* were sent by the web
UI and answered during the live captures. For the control commands, the
**effect** of 129 (pause), 131 (resume), and 403 (light) is *observed* in the
status pushes of `control-pause-resume-light.json`; their request frames and
responses were sent on the owner's own connection and are *static-only*.
130 (stop) was not exercised and is entirely *static-only*.

| Cmd | Constant name | Payload | Call site | Notes | Label |
| ---: | --- | --- | --- | --- | --- |
| 0 | `GET_PRINTER_STATUS` | none | main@782822 | sent once on connect; answer is only `{Ack:0}`, and the status itself comes as an `sdcp/status` push | *observed* (`connect-loading.json#4`, `#13`, `#11`) |
| 1 | `GET_PRINTER_ATTR` | none | main@782894 | sent once on connect; answer is only `{Ack:0}`, and the attributes come as an `sdcp/attributes` push | *observed* (`connect-loading.json#5`, `#15`, `#17`) |
| 64 | `SEND_PRINTER_DISCONNECT` | - | none | defined, never sent | *static-only* |
| 128 | `SEND_PRINTER_START_PRINT` | `{Filename, StartLayer:0, Calibration_switch, PrintPlatformType, Tlp_Switch, slot_map}` | c25@33800 (`sendStartPrint`, c25@32772) | out of scope | *static-only* |
| 129 | `SEND_PRINTER_SUSPEND_PRINT` | none | c25@322328 (`stop()`, c25@320381) | **pause**; sent when `PrintInfo.Status !== 6`. Effect: `PrintInfo.Status` 13 → 5 (Pausing) → 6 (Paused) about 8 s later | effect *observed* (`control-pause-resume-light.json#11`, `#12`, `#16`); request and response *static-only* |
| 130 | `SEND_PRINTER_STOP_PRINT` | none | c25@323551 (`cease()`, c25@322462) | **stop**; the UI asks for no confirmation in code; not exercised | *static-only* |
| 131 | `SEND_PRINTER_RESTORE_PRINT` | none | c25@322085 (`stop()`) | **resume**; sent when `PrintInfo.Status === 6`. Effect: 6 → 20 (Preparing) → 13 (Printing) about 28 s later | effect *observed* (`control-pause-resume-light.json#16`, `#17`, `#26`); request and response *static-only* |
| 134 | `GET_BLACKOUT_STATUS` | none | main@783040 | sent on connect; `Ack === 1` means an unfinished print after power loss (*static-only*); `Ack: 0` seen with no pending print | *observed* (`connect-loading.json#7`, `#22`) |
| 135 | `SEND_BLACKOUT_ACTION` | `{action: 1 \| 0}` | main@779951 | 1 resume, 0 discard; only after a user dialog | *static-only* |
| 192 | `SEND_PRINTER_EDIT_NAME` | - | none | defined, never sent | *static-only* |
| 255 | `SEND_PRINTER_SEND_FILE_END` | - | none | defined, never sent | *static-only* |
| 257 | `EDIT_PRINTER_FILE_NAME` | file rename | c25@395716 | out of scope | *static-only* |
| 258 | `GET_PRINTER_FILE_LIST` | `{Url: "/local"}` | main@783113 | sent on connect and again after `CurrentStatus` 8 clears; answer `Data.Data.FileList[]` with `name`, `type`, `CreateTime`, `FileSize`, `LayerHeight`, `TotalLayers`, `EstFilamentLength` | *observed* (`connect-loading.json#8`, `#24`; `connect-idle.json#28`) |
| 259 | `DELETE_PRINTER_FILE_LIST` | file list | c25@335583 | out of scope | *static-only* |
| 260 | `GET_PRINTER_FILE_DETAIL` | file name | c25@327761 | answer has `Data.Data.FileInfo` (`EstTime`, `EstWeight`, `TotalLayers`, `ColorNum`) (c25@328317) | *static-only* |
| 320 | `GET_PRINTER_HISTORY_ID` | none | main@782964 | answer `Data.Data.HistoryData` is a list of task ids, newest first; the UI sends it again when a job completes | *observed* (`connect-loading.json#6`, `#19`; `print-complete.json#25`, `#26`) |
| 321 | `GET_PRINTER_TASK_DETAIL` | `{Id: [<TaskId>, ...]}` | main@780760 | answer `Data.Data.HistoryDetailList[]` with `TaskId`, `TaskName`, `BeginTime`, `EndTime` (0 while running), `TaskStatus` (4 while running, 1 after completion), `SliceInformation`, `AlreadyPrintLayer`, `MD5`, `Thumbnail`, `ErrorStatusReason`, `TimeLapseVideoStatus`, `TimeLapseVideoUrl` | *observed* (`connect-loading.json#38`, `#39`; `print-complete.json#28`) |
| 322 | `DELETE_PRINTER_HISTORY` | ids | c25@332063 | out of scope | *static-only* |
| 323 | `GET_PRINTER_HISTORY_VIDEO` | id | c25@337975 | out of scope | *static-only* |
| 324 | `GET_MATERIAL_DATA` | - | c25@328736 | AMS material data | *static-only* |
| 386 | `EDIT_PRINTER_VIDEO_STREAMING` | `{Enable: 1 \| 0}` | c25@325607, c25@326443 | the control page enables the camera when the socket connects (c25@319343); answer `{Ack:0, VideoUrl}`; afterwards `Attributes.NumberOfVideoStreamConnected` goes from 0 to 1 | *observed* (`connect-loading.json#10`, `#26`, `#28`) |
| 387 | `EDIT_PRINTER_TIME_LAPSE_STATUS` | - | none | defined, never sent | *static-only* |
| 401 | `EDIT_PRINTER_AXIS_NUMBER` | jog | c25@326738 | out of scope | *static-only* |
| 402 | `EDIT_PRINTER_AXIS_ZERO` | `{Axis}` | c25@324257 | out of scope; refused by the UI while printing | *static-only* |
| 403 | `EDIT_PRINTER_STATUS_DATA` | partial status object, see below | c25@119657 (light), c25@118308 (fans), c25@320313 (speed), c25@334237 / c25@334960 (temps) | **light** goes through this command. Effect: `LightStatus.SecondLight` 1 → 0 → 1 in the next status push | light effect *observed* (`control-pause-resume-light.json#27`, `#28`, `#30`); request and response, and the other 403 payloads, *static-only* |
| 503 | `GET_FILE_COLOR_DATA` | - | none | defined, never sent | *static-only* |

### Cmd 403 payloads (`EDIT_PRINTER_STATUS_DATA`)

| Purpose | `Data.Data` | Source | Label |
| --- | --- | --- | --- |
| Chamber light | `{LightStatus: <whole Status.LightStatus object>}` after the switch sets `LightStatus.SecondLight` to the new value | c25@122735 (switch), c25@119393 (`changeLight`) | payload *static-only*; the printer applies it while printing (`SecondLight` 1 → 0 → 1, `RgbLight` unchanged) *observed* (`control-pause-resume-light.json#28`, `#30`) |
| Fans | `{TargetFanSpeed: <whole Status.CurrentFanSpeed object>}` with `ModelFan`, `AuxiliaryFan`, `BoxFan` (0-100) | c25@118308, c25@123034 | *static-only* |
| Print speed | `{PrintSpeedPct: 50 \| 100 \| 130 \| 160}` (`i18n:networkDeviceManager.control.speedList`) | c25@320313 | *static-only* |
| Nozzle target | `{TempTargetNozzle: <number>}` | c25@334237 | *static-only* |
| Bed target | `{TempTargetHotbed: <number>}` | c25@334960 | *static-only* |

The UI shows a toast from the `Ack` of the 403 response (c25@318975). The
status message carries `LightStatus` as `{SecondLight: 1, RgbLight: [0,0,0]}`
(*observed*, `connect-loading.json#11`), so `SecondLight` is a number (0/1),
and the whole object the light switch sends back includes `RgbLight`.

### UI guards before control commands

*static-only*: from `stop()` (c25@320381) and `cease()` (c25@322462), and
the button `disabled-img` bindings at c25@263398:

- pause/resume and stop are ignored while `PrintInfo.Status` is 5, 7, or 12,
  or while a previous command is pending (5 s lockout);
- pause/resume picks 131 when `PrintInfo.Status === 6`, else 129;
- the pause/stop block is shown only when `CurrentStatus` includes 1
  (c25@265917).

## Status message (`sdcp/status`)

*observed*: pushed by the printer without a request, about every 3 s while
printing and while idle, plus extra pushes on state changes (for example
`print-complete.json#23` to `#24`, 1 s apart). It has no `Id` or `Data`
envelope:

```json
{
  "Status": {
    "CurrentStatus": [1],
    "TimeLapseStatus": 0,
    "PlatFormType": 0,
    "AmsConnectStatus": 0,
    "TempOfHotbed": 69.98,
    "TempOfNozzle": 249.73,
    "TempOfBox": 29.29,
    "TempTargetHotbed": 70,
    "TempTargetNozzle": 250,
    "TempTargetBox": 0,
    "CurrenCoord": "202.00,264.50,10.39",
    "CurrentFanSpeed": { "ModelFan": 30, "AuxiliaryFan": 0, "BoxFan": 68 },
    "ZOffset": 0.0,
    "LightStatus": { "SecondLight": 1, "RgbLight": [0, 0, 0] },
    "PrintInfo": {
      "Status": 16, "CurrentLayer": 9, "TotalLayer": 12,
      "CurrentTicks": 298.5, "TotalTicks": 399,
      "Filename": "<file>.gcode", "TaskId": "<uuid>",
      "PrintSpeedPct": 100, "Progress": 48
    }
  },
  "MainboardID": "40551f980103d46c00004c0000000000",
  "TimeStamp": 1794605247,
  "Topic": "sdcp/status/40551f980103d46c00004c0000000000"
}
```

(`connect-loading.json#35`, numbers rounded.) `TimeStamp` is in seconds. The
UI stores `msg.Status` as-is (main@782513).

| Field | Meaning | Source | Label |
| --- | --- | --- | --- |
| `Status.CurrentStatus` | array of machine-state codes (table below); one element in every capture | c25@266283 (`Gs` template); `connect-loading.json#11` | *observed* |
| `Status.PrintInfo.Status` | print-state code (table below) | c25@8626; `connect-printing.json#9` | *observed* |
| `Status.PrintInfo.Progress` | percent while printing; **drops to 0 when the job completes** (the UI shows 100 when `Status === 9`) | c25@264786; `print-complete.json#23`, `#24` | *observed* |
| `Status.PrintInfo.CurrentLayer`, `TotalLayer` | layers; keep the last job's values after completion | c25@265649; `print-complete.json#24` | *observed* |
| `Status.PrintInfo.CurrentTicks`, `TotalTicks` | seconds elapsed and total (floats); remaining = total - current; ticks stop during the material-change phase | c25@265023; `connect-printing.json#9`, `connect-loading.json#11` | *observed* |
| `Status.PrintInfo.PrintSpeedPct` | speed percent | c25@320313; `connect-printing.json#9` | *observed* |
| `Status.PrintInfo.TaskId` | current job id (uuid with dashes); **`""` once the job completes and while idle** | main@781286; `connect-printing.json#9`, `print-complete.json#24` | *observed* |
| `Status.PrintInfo.Filename` | current file name, no `/local/` prefix; `""` when no job | `connect-printing.json#9`, `print-complete.json#24` | *observed* (not read by the UI) |
| `Status.TempOfNozzle`, `TempTargetNozzle` | nozzle current/target (deg C); target 0 when idle | c25@285924; `connect-idle.json#8` | *observed* |
| `Status.TempOfHotbed`, `TempTargetHotbed` | bed current/target | c25@286318; `connect-idle.json#8` | *observed* |
| `Status.TempOfBox` | chamber current | c25@286708; `connect-idle.json#8` | *observed* |
| `Status.TempTargetBox` | present on the wire, always 0 in the captures; not read by the UI | `connect-idle.json#8` | *observed* |
| `Status.CurrentFanSpeed.{ModelFan,AuxiliaryFan,BoxFan}` | fan percent | c25@123034; `connect-loading.json#11` | *observed* |
| `Status.LightStatus.SecondLight` | chamber light state, number: 1 on, 0 off; changes in the next push after a light command | c25@124019; `connect-loading.json#11`, `control-pause-resume-light.json#28`, `#30` | *observed* |
| `Status.LightStatus.RgbLight` | `[r, g, b]`, `[0,0,0]` in every capture; not read by the UI | `connect-loading.json#11` | *observed* |
| `Status.CurrenCoord` | toolhead coordinates as a `"x,y,z"` string (sic) | c25@272342; `connect-loading.json#11` | *observed* |
| `Status.AmsConnectStatus` | AMS present (0 in every capture) | c25@29562; `connect-loading.json#11` | *observed* |
| `Status.TimeLapseStatus`, `PlatFormType`, `ZOffset` | present on the wire, 0 in every capture; not read by the UI | `connect-loading.json#11` | *observed* |

The UI shows the file name from `TaskDetail.TaskName` (Cmd 321, with the
`/local/` prefix), but the status message also carries it in
`PrintInfo.Filename` (*observed*).

### Machine state: `Status.CurrentStatus[]`

Template `Gs` (c25@266283); labels from `i18n:networkDeviceManager.control.status`.

| Code | UI label | Notes | Label |
| ---: | --- | --- | --- |
| 0 | Idle | shows the "idle" print-state group | *observed* (`print-complete.json#24`, `connect-idle.json#27`) |
| 1 | Printing | shows the "printing" print-state group and the pause/stop controls | *observed* (`connect-printing.json#9`) |
| 2 | File Sending | shown only when it is the only code; seen while another client uploaded a file | *observed* (`connect-idle.json#8`) |
| 5 | Leveling | | *static-only* |
| 6 | Input shaping | | *static-only* |
| 7 | busy | | *static-only* |
| 8 | File Checking | shown only when it is the only code; main refreshes the file list after it clears (main@780227) | *observed* (`connect-idle.json#25`, then Cmd 258 at `#28`) |
| 9 | Homing | | *static-only* |
| 10 | Incoming or outgoing materials | seen mid-job with `PrintInfo.Status` 16 and 20 and frozen ticks | *observed* (`connect-loading.json#11`, `#45`) |
| 11 | Tuning the Nozzle PID | | *static-only* |

Codes 3 and 4 are not referenced by the UI and were not seen.

### Print state: `Status.PrintInfo.Status`

Status groups at c25@8626 (`STATUS_*` arrays), shown under machine state 0
(`_s`, c25@256127) or 1 (`Ls`, c25@257906):

| Code | Under machine state 0 | Under machine state 1 | Label |
| ---: | --- | --- | --- |
| 0 | Idle (`STATUS_WAIT`) | Preparing (`STATUS_LOADING`) | *observed* under 0, 2, 8, and 1 (`connect-idle.json#8`, `#27`, `#33`) |
| 1 | Stopping (`STATUS_STOPING`) | Preparing (`STATUS_LOADING`) | *observed* under 1, right after a job starts (`connect-idle.json#38`) |
| 5 | - | Pausing (`STATUS_SUSPENDING`) | *observed* under 1, right after pause (`control-pause-resume-light.json#12`) |
| 6 | - | Paused (`STATUS_SUSPENDED`) | *observed* under 1 (`control-pause-resume-light.json#16`) |
| 7 | - | not labelled; controls disabled | *static-only* |
| 8 | Stopped (`STATUS_STOPED`) | - | *static-only* |
| 9 | Print Complete (`STATUS_COMPLETE`) | - | *observed* under 0 (`print-complete.json#24`) |
| 10 | - | File Checking (`STATUS_FILE_DETECTION`) | *static-only* |
| 12 | - | Restoring (`STATUS_RECOVERY`); controls disabled | *static-only* |
| 13 | - | Printing (`STATUS_PRINTING`) | *observed* (`connect-printing.json#9`) |
| 14 | Stopped (`STATUS_STOPED`) | - | *static-only* |
| 15, 16, 18, 19, 20, 21 | - | Preparing (`STATUS_LOADING`) | 16 and 20 *observed* under 10 and 1 (`connect-loading.json#11`, `#43`), and under 1 right after resume (`control-pause-resume-light.json#17`); 18 *observed* under 1 at job start (`connect-idle.json#34`); 15, 19, 21 *static-only* |

Codes 2, 3, 4, 11, and 17 are not referenced by the UI and were not seen.

Observed sequences: job start `CurrentStatus` 0 → 1 with `PrintInfo.Status`
0 → 18 → 1 (`connect-idle.json#32` to `#38`); job end 1/13 → 0/9
(`print-complete.json#23`, `#24`); upload 2 → 8 → 0 (`connect-idle.json#8`,
`#25`, `#27`); pause 1/13 → 1/5 → 1/6 and resume 1/6 → 1/20 → 1/13
(`control-pause-resume-light.json#12`, `#16`, `#17`, `#26`). Stop (130) was
not exercised, so the stopped codes 8 and 14 stay *static-only*.

Status pushes are not strictly periodic: while paused the printer pushed
nothing for 16.5 s (`control-pause-resume-light.json#16` to `#17`), and
during the resume preparation nothing for 18 s until this client's Cmd 0
(`#21` to `#24`); transitions come with bursts of pushes about 130 ms apart
(`#17` to `#21`) (*observed*).

### Error codes

- *static-only*: `TaskDetail.ErrorStatusReason` (Cmd 321 answer): the UI only names code 45,
  "Consumables are about to run out, please replace consumables"
  (`i18n:networkDeviceManager.control.errorStatusReason.45`, main@777696).
  No other error code table ships with the web UI. *observed*: `0` on
  completed and running jobs (`print-complete.json#28`).
- *static-only*: `sdcp/error` messages are routed (main@784969) but no handler reads them;
  none were seen during the live pass.

## Attributes message (`sdcp/attributes`)

*observed*: pushed after Cmd 1 and again when an attribute changes (for
example `NumberOfVideoStreamConnected` after Cmd 386), same outer shape as
the status message (`Attributes`, `MainboardID`, `TimeStamp` in seconds,
`Topic: sdcp/attributes/<MainboardID>`). Example `connect-loading.json#17`.
The UI merges `msg.Attributes` into its printer record (main@782653).

| Field | Value seen | Label |
| --- | --- | --- |
| `Name`, `MachineName`, `BrandName` | `Centauri Carbon`, `Centauri Carbon`, `ELEGOO` | *observed* |
| `ProtocolVersion`, `FirmwareVersion` | `V3.0.0`, `V1.4.49` | *observed* |
| `MainboardID`, `MainboardIP`, `MainboardMAC` | the printer's id, IP, and MAC | *observed* |
| `XYZsize` | `"218.88x128.88x220"` | *observed* |
| `Capabilities` | `["FILE_TRANSFER","PRINT_CONTROL","VIDEO_STREAM"]` | *observed* |
| `SupportFileType` | `["gcode"]` | *observed* |
| `CameraStatus` | `1` | *observed* |
| `NumberOfVideoStreamConnected`, `MaximumVideoStreamAllowed` | 0 then 1 after Cmd 386; max `4` | *observed* (`connect-loading.json#17`, `#28`) |
| `SDCPStatus`, `MaximumCloudSDCPSercicesAllowed` (sic), `NumberOfCloudSDCPServicesConnected` | `0`, `0`, `0` | *observed* |
| `NetworkStatus`, `UsbDiskStatus`, `RemainingMemory` | `"wlan"`, `0`, bytes free | *observed* |
| `DevicesStatus` | `{SgStatus, ZMotorStatus, XMotorStatus, YMotorStatus}`, all `1` | *observed* |
| `TLPNoCapPos`, `TLPStartCapPos`, `TLPInterLayers` | `0` | *observed* |

The UI reads `MainboardID`, `MainboardIP`, `Name`, `Capabilities`, and
`CameraStatus` (*static-only* for which fields it reads).

## Connect sequence used by the web UI

*observed* (`connect-loading.json#4` to `#10`, all four fixtures): on socket
open the UI sends, in this order and within 1 ms, all with `MainboardID: ""`:
Cmd 0, Cmd 1, Cmd 320, Cmd 134, Cmd 258 `{Url:"/local"}`, then Cmd 386
`{Enable:1}` from the control page (c25@325607). Cmd 386 was not sent in
`connect-idle.json`; the bundle does not explain why from these captures.

The printer answers each request and, after Cmd 0 and Cmd 1, pushes one
status and one attributes message. The UI then sends Cmd 321 for the full
history list (from Cmd 320) and, when `CurrentStatus` includes 1 and
`PrintInfo.TaskId` is set, Cmd 321 for that task (main@780760;
`connect-loading.json#30`, `#38`).

## Open points for the live pass

Task 2.4 is accepted with the gaps below. This section is the single record of
what the live pass did and did not confirm for the control commands; the
per-command rows above carry the same labels.

| Cmd | Action | Request frame | Response frame | Effect on status pushes |
| --- | --- | --- | --- | --- |
| 129 | pause | *static-only* (c25@322328) | *static-only* | *observed*: `PrintInfo.Status` 13 → 5 → 6 (`control-pause-resume-light.json#11`, `#12`, `#16`) |
| 130 | stop | *static-only* (c25@323551) | *static-only* | **not captured**: stop was never pressed |
| 131 | resume | *static-only* (c25@322085) | *static-only* | *observed*: `PrintInfo.Status` 6 → 20 → 13 (`control-pause-resume-light.json#16`, `#17`, `#26`) |
| 403 | light | *static-only* (c25@119393) | *static-only* | *observed*: `LightStatus.SecondLight` 1 → 0 → 1 (`control-pause-resume-light.json#28`, `#30`) |

- **Request frames and responses of 129, 130, 131, and 403 were not seen.**
  The browser that sent them used its own connection, and the printer sends
  responses only to the requesting connection (see Concurrent clients), so the
  recorder saw only the state changes. The `{Ack}` response shape is assumed
  from the other commands (`Ack: 0` success; Cmd 131 `Ack: 2` blocked, from the
  bundle) and is **unconfirmed** for the control commands.
- **Stop (130) was not captured at all**, so neither its effect nor the
  stopped print-state codes 8 and 14 (`STATUS_STOPED`) were seen on the wire.
  They stay *static-only*.
- **Task 8.1 confirms them.** When this project's own client first sends pause,
  resume, light, and stop to the printer during the 8.1 test print, record the
  response frames and the stop transition, and relabel these entries *tested*
  (stop included, so that 8 or 14 is seen).
- **Later tasks must treat the control response format as unconfirmed.**
  Result reporting (task 4.2) relies only on what is common to every observed
  response: correlate by `Data.RequestID`, read `Data.Data.Ack` (0 is
  acknowledged, any other value is failed with that code), and report a timeout
  when no response arrives within 10 s. It must not depend on any other
  response field, and its fake-printer tests are built on this assumed shape,
  not on a recorded control response. The stopped event (task 7.1) likewise
  rests on the *static-only* codes 8 and 14 until 8.1.
- Meaning of `PrintInfo.Status` 7 and the other codes not seen yet.
- Whether `TaskId` is stable: answered below.

## Answers to the design open questions

### Is `TaskId` a stable job id?

**Yes, while the job runs** (*observed*). The same `TaskId` was seen:

- `c735768d-8d67-4ae2-8d07-05c0c05c4aa2` in the status push and in the Cmd
  321 answer over three separate connections during one job
  (`connect-loading.json`, `connect-printing.json`, `print-complete.json`);
- `9f0f4d7e-826e-45df-998e-ea24f6815410` from the job start in
  `connect-idle.json#38`, again on a later connection in
  `control-pause-resume-light.json#4`, and unchanged through pause and resume
  (`#12` to `#34`).

Caveat: `TaskId` is `""` from the completion push on (`print-complete.json#24`)
and while idle, so the completed, stopped, and failed events cannot read it
from the push that reports them. The event detector keeps the last non-empty
`TaskId` it saw for the job and uses that as the dedupe key; the D4 fallback
(file name + start time) is only needed when the service connects after the job
has already ended. No spec change.

### Can the chamber light be controlled through SDCP?

**Yes** (*observed* effect). The owner turned the light off and on from
Elegoo's web UI during a running print; the next status pushes showed
`LightStatus.SecondLight` 1 → 0 → 1 (`control-pause-resume-light.json#28`,
`#30`). The UI sends this as Cmd 403 with `{LightStatus: {SecondLight, RgbLight}}`
(c25@119393). That request payload and its response are *static-only*, because
they travel on the sender's own connection; this project's client confirms them
when it first sends the command (task 8.1). The print-control light requirement
stays as it is; no spec change.

### Concurrent clients

*observed* behavior with more than one client connected to port 3030:

- **Several SDCP WebSocket clients can connect at once.** The control capture
  ran this project's recorder alongside the owner's browser on Elegoo's web UI,
  and the read-only captures ran a headless browser while another client
  uploaded a file and started a job (`connect-idle.json#8`, `#32`). Neither
  connection was refused or dropped. `MaximumCloudSDCPSercicesAllowed` is `0`
  and `MaximumVideoStreamAllowed` is `4` in the attributes; no limit on local
  SDCP clients is advertised, and only two at once were tried.
- **Status pushes are broadcast to every client.** The recorder received the
  state changes caused by the other client's pause, resume, and light commands
  (`control-pause-resume-light.json#12`, `#17`, `#28`).
- **Responses go only to the requesting connection.** The recorder received
  responses to its own Cmd 0 and Cmd 1 (`#3`, `#5`, `#23`) and none for the
  other client's Cmd 129, 131, and 403. A client therefore cannot learn another
  client's command result; it sees only the resulting state change.
- **No attributes push followed the other client's actions** in the control
  capture, so whether attribute pushes after a change (for example after Cmd
  386) reach every client or only the requester is not settled.

Consequences for this project: the service's commands and those sent from
Elegoo's UI or the slicer coexist, and the status store sees every client's
effect. The "acknowledged" result in the command-result requirement comes from
the response on the service's own connection, correlated by `RequestID`.
