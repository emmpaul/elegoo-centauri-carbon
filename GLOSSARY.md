# Elegoo Centauri Carbon service

A local service that watches one Elegoo Centauri Carbon printer over the LAN, shows it on
a dashboard, controls it, and sends push notifications about its prints.

## Language

**Snapshot**:
The printer's current status, normalized into one view that everything else reads.
_Avoid_: Status frame, state (for the whole thing)

**Event**:
Something worth telling the owner about a print or the printer: started, finished,
failed, paused, stopped, offline, or online, and the progress Events first-layer
(the first layer is done) and almost-done (about ten minutes left).
_Avoid_: Alert, notification (for the occurrence itself)

**Notification**:
A push message sent to the owner's phone about one Event.
_Avoid_: Alert, push

**Photo**:
One still image from the printer's camera, taken when an Event happens and attached to
its Notification.
_Avoid_: Snapshot, camera snapshot, frame, still

**Reading**:
The printer's measured values at one instant, recorded every ten seconds while the printer
is online: temperatures and their targets, progress, layer, speed, fans, height, state,
and light.
_Avoid_: Sample, metric, data point, snapshot

**Trace**:
The Readings of one print job, from its first Reading until fifteen minutes after it
ends. A Trace with a gap while the service was down is partial.
_Avoid_: Curve, timeline, history
