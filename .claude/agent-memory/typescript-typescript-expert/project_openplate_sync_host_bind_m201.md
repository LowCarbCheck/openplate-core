---
name: openplate-sync-host-bind-m201
description: HOST is an opt-in bind address whose default must stay null; express app.listen takes an options object through the listen(handle, cb) overload
metadata:
  type: project
---

`src/config.ts` carries `host: string | null`, where `null` means bind every
interface. `src/main.ts` uses
`app.listen({ port: config.port, host: config.host ?? undefined }, cb)`.

**Why:** production runs in a container behind Traefik, so the only route in is
the container network address. `0.0.0.0` is not an acceptable written-out
default either, because it is IPv4 only while the no-host form of `listen`
also binds IPv6. The variable exists for a development machine, where an
unconstrained bind published a seeded database and the `/v1/admin` tree to the
whole LAN.

**How to apply:** express 4's typings have no explicit `listen(options, cb)`
overload; the call typechecks through `listen(handle: any, listeningListener?)`.
No cast and no `SAFETY:` comment are needed, so the anti-slop assertion rule
does not fire.

`tests/unit/config.test.ts` has no frozen list of known environment variables,
so adding one needs no other test updated. `.env.example` is the operator-facing
counterpart named in the `config.ts` module header, and it does need the entry.

To prove a new config assertion can go red, mutate `src/config.ts` in place
(return `null` always, drop the `.trim()`, return `'0.0.0.0'`), run
`node --import tsx --test tests/unit/config.test.ts`, and grep the output for
`✖`. The single-file run needs `--import tsx` or the whole file reports as
failing.

Related: [[openplate-sync-gate-and-toolbox]].
