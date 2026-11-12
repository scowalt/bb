---
name: concurrency-limit
description: "Inspect or change global and per-host limits on concurrently running BB threads."
---

# Concurrency limits

Use `bb concurrency-limit status --json` to inspect current limits.

```sh
bb concurrency-limit global [unlimited|<limit>] [--json]
bb concurrency-limit host <host-id> [auto|<limit>] [--json]
```

The overall limit is unlimited by default. The automatic host limit starts
threads while a host has free memory and low CPU and memory pressure; a host
that does not report pressure stall information (macOS, or a kernel without
PSI) allows one thread per available processor. `auto` returns a host override
to that default. In `status --json`, a host on headroom has `effectiveLimit:
null` and a `headroom` object with free memory, the reserve, both pressures,
and whether it is admitting; its `automaticLimit` is the processor fallback.
A limit of `0` pauses new work. Resolve the host with `bb machine list` before
changing a host limit. Omit the value to inspect it; change limits only for the
requested scope and verify the resulting status.
