# blob-overlay

Layered object storage for preview environments.

Reads fall through to a base bucket; writes and deletes stay in the overlay.
Branch a bucket per pull request without copying it. This is an application-level
overlay: object stores have no symlinks or snapshots.

## Install

```sh
bun add github:martinmiglio/blob-overlay#v0.1.0 effect
```

`effect` is a peer dependency (v4). The package ships TypeScript source, so it
needs a bundler or a TypeScript runtime (Bun, Vite, Workers, tsx).

## Usage

```ts
import * as Effect from "effect/Effect";

import { overlay, readText, withPrefix } from "@martinmiglio/blob-overlay";
import { r2 } from "@martinmiglio/blob-overlay/r2";

const media = overlay({
  layers: [
    withPrefix(r2(env.MEDIA), `preview/${stage}`),
    r2(env.MEDIA),
  ],
});

const program = Effect.gen(function* () {
  // Writes only under preview/<stage>/.
  yield* media.put("images/new.jpg", bytes);

  // Hides the production object without touching it.
  yield* media.delete("images/old.jpg");

  // Untouched keys fall through to production.
  const hero = yield* media.get("images/hero.jpg");
  if (hero) {
    console.log(yield* readText(hero));
  }
});
```

Layers are ordered highest precedence first. Only the first layer is written to.

## Semantics

| Operation      | Behaviour                                                          |
| -------------- | ------------------------------------------------------------------ |
| `get` / `head` | First layer with the key wins. A tombstone stops the search.        |
| `put`          | Writes the first layer and clears any tombstone for that key.       |
| `delete`       | Writes a tombstone in the first layer, then removes the overlay key. |
| `list`         | Merges layers, keeps the highest copy, hides tombstoned keys.       |

## API

- `overlay({ layers, metadataPrefix? })` — build a layered store.
- `withPrefix(store, prefix)` — mount a store under a transparent prefix.
- `r2(bucket)` — R2 adapter (`@martinmiglio/blob-overlay/r2`).
- `memoryStore({ initial? })` — in-memory adapter for tests.
- `readBytes(object)` / `readText(object)` — consume a stored body.
- `ObjectStore`, `ObjectStoreError`, `PreconditionFailed`.

Wrap the store in your own `Context.Service` when wiring it into an Effect app.

## Limits

- Reads are live, not a snapshot. New base objects appear in existing overlays.
- `list` reads every matching key from every layer and merges in memory.
- `.overlay/tombstones/` is reserved in the writable layer. Use `metadataPrefix`
  to change it.
- No cascade delete or partial object updates.

## Development

```sh
bun install
bun run test
bun run typecheck
bun run build
bun run example
```

The R2 tests run against a local binding via Miniflare; no Cloudflare account is
needed.

## License

MIT
