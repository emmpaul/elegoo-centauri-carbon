---
status: proposed
---

# The photo may turn the chamber light on by itself (opt-in)

Until now only a user action sent a command that changes the printer. A Photo taken with
the chamber light off is dark, so the owner can turn on `ntfy.photoLight`, which is off by
default and has no effect unless `ntfy.photos` is on. With it on, the service turns the
light on before the Photo, waits for a status push that shows it on, takes the Photo, and
turns it off again, unless someone changed the light in the meantime. This command takes
the same print-control path and `control-rules` guard as the dashboard's light button and
does not bypass them: when the guard refuses, the Photo is taken as it is. The only
automatic command is the light, which changes nothing about the print. Nothing automatic
ever pauses, resumes, stops, or starts a print.

## Considered Options

- **Never send an automatic command; take the Photo as it is.** This keeps the rule
  absolute, but a dark Photo is useless to an owner who keeps the light off.
- **Leave the light on afterwards.** This is simpler, but it changes the printer's state
  as a side effect of a notification.
