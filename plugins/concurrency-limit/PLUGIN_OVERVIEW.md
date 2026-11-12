Keep bb from starting more agent threads than your machines can handle. When a limit is reached, new turns wait in line and start as soon as a running thread goes idle.

## What you get

- An automatic limit for each host. A Linux host that reports pressure stall information starts threads while it has free memory and low CPU and memory pressure. Any other host, such as a Mac, allows one running thread per available processor.
- A per-host override. Set a fixed number, or set it back to `auto`.
- An overall limit across all hosts, or `unlimited`.
- A Settings section that lists every host with its capacity, its free memory and pressure where known, and its limit.

## How it works

Before bb sends a message to an idle thread, the plugin checks the overall limit against the threads that are running, then the host. A host with a fixed limit, or without a fresh load sample, counts its running threads against that limit. A host with a fresh sample waits when its memory pressure or CPU pressure is high, or when starting one more thread would eat into the memory reserve, which is 2 GB or a tenth of the host's memory, whichever is larger. Each thread admitted in the last 30 seconds counts as 1 GB until its memory shows up in a later sample; a thread counts once however often it is re-admitted, and stops counting if another plugin then holds it back. The thread shows why it waits. A message to a thread that is already running is not held. When a thread goes idle, fails, or is archived, or a new sample shows headroom again, the plugin rechecks the line.

The plugin samples a load-reporting host every 5 seconds while it is connected, and gives up on a host that does not answer within 10 seconds so one slow host cannot delay the others' samples. A sample older than 30 seconds no longer counts, and the host falls back to one thread per processor until the next one, when the plugin rechecks the line again.

## For agents and scripts

Use the `bb concurrency-limit` command:

- `bb concurrency-limit status` shows the effective limits.
- `bb concurrency-limit global unlimited|<limit>` sets the overall limit.
- `bb concurrency-limit host <host-id> auto|<limit>` sets one host.

Add `--json` for machine-readable output. Limits go from 0 to 10000. A limit of 0 holds every new turn in that scope.
