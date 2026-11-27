# Browser adapters

The demo bundles the repo's own server code (`src/server`) and runs it in the page. The server
imports a few Node built-ins; for the demo build only, Vite swaps each one for the file here
(see `demo/vite.config.ts`). Nothing in `src/server` is edited.

| File             | Replaces                                                       | Backed by                        |
| ---------------- | -------------------------------------------------------------- | -------------------------------- |
| `sqlite.ts`      | `node:sqlite` (`DatabaseSync`)                                 | sql.js (SQLite compiled to WASM) |
| `crypto.ts`      | `node:crypto` (hashes, HMAC, scrypt, randoms)                  | `@noble/hashes`                  |
| `ticketKeys.ts`  | `src/server/ticketKeys.ts` (same interface)                    | `@noble/curves` Ed25519          |
| `node.ts`        | `node:fs`, `node:path`, `node:url`, `node:events`, `node:util` | tiny stand-ins                   |
| `cookie.ts`      | `hono/cookie`                                                  | a cookie jar kept by the demo    |
| `serveStatic.ts` | `@hono/node-server/serve-static`                               | a no-op                          |
| `layouts.ts`     | `src/server/layouts.ts`                                        | the same JSON files, bundled     |
| `timers.ts`      | the global timers, for two server files                        | adds `.unref()`                  |
