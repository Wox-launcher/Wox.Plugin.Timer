# Timer

Create countdowns with `timer 5m`, `timer 1h 15m`, or `timer 1m tea`. Start a timer on the desktop or in the background, pause or resume it, edit its note, and delete it from the result actions. Desktop windows can be dragged and closed. Timers are stored locally and running timers use a deadline, so they resume correctly after Wox restarts. Pin state is not restored.

The `start_timer` plugin tool starts a background countdown, with `duration_seconds` and optional `note` arguments.

## Requirements

Node.js 20 or later and a Wox build containing the new `CreateWindow` and `ShowToastMsg` APIs. These APIs are currently under development; the template's `MinWoxVersion` is provisional and must be updated to the first release that includes them before publishing. The locally declared window types should be replaced by the published SDK types at that point.

This independent plugin has its own ID and does not import active timers from the former built-in Timer. Completion shows a Wox toast.

## Develop and package

Install Node.js, pnpm, Python 3 and Make, then run `make install`, `make test`, and `make build`. The build is written to `dist/`. Run `make package` to create a `.wox` file.
