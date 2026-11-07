# blob-overlay

Layered, copy-on-write-style object storage, expressed entirely in
[Effect](https://effect.website).

Give a preview environment its own view of a bucket without copying a byte:
reads fall through to production, writes land in the preview, and deletes hide
the production object instead of resurrecting it.

> **Naming note:** object stores have no symlinks, hard links, or snapshots.
> This package implements the behaviour at the application layer — a prefix
> overlay with tombstones. "Copy-on-write" describes what consumers observe,
> not a storage primitive. See [Semantics](#semantics) for the exact contract.

## Install

```sh
bun add blob-overlay effect
```

`effect` is a peer dependency (v4).

## Usage

```ts
import * as Effect from "effect/Effect";

import {
  overlay,
  readText,
  withPrefix,
  type ObjectStore,
} from "blob-overlay";
import { r2 } from "blob-overlay/r2";

const program = Effect.gen(function* () {
  const prod = r2(env.MEDIA);
  const preview = withPrefix(prod, `preview/${stage}`);

  const media: ObjectStore = overlay({
    layers: [preview, prod],
  });

  // Writes go to `preview/<stage>/...` only.
  yield* media.put("images/new.jpg", bytes);

  // Untouched keys still resolve through to production.
  const existing = yield* media.get("images/old.jpg");
  if (existing) {
    const text = yield* readText(existing);
  }

  // Hides the production object without touching it.
  yield* media.delete("images/removed.jpg");
});
```

Both layers can be the same bucket at different prefixes. They can also be
different buckets, a memory store, or any other `ObjectStore`.

### As a service

```ts
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { overlay, type ObjectStore } from "blob-overlay";

class Media extends Context.Service<Media, ObjectStore>()("app/Media") {}

const MediaLive = Layer.effect(
  Media,
  Effect.succeed(
    overlay({
      layers: [
        withPrefix(r2(env.MEDIA), `preview/${env.STAGE}`),
        r2(env.MEDIA),
      ],
    }),
  ),
);
```

## Semantics

Layers are ordered highest precedence first. Only the first layer is written
to.

| Operation | Behaviour |
| --- | --- |
| `get(key)` / `head(key)` | First layer with the key wins. A tombstone in the writable layer stops the search. |
| `put(key)` | Writes the first layer and removes any tombstone for that key. |
| `delete(key)` | Writes a tombstone in the first layer, then removes the overlay data key. Lower layers are untouched. |
| `list(options)` | Merges every layer, keeps the highest copy, drops tombstoned keys. |

Deletes need tombstones because a plain delete would let the production object
reappear through the fallback.

Tombstones live under `<metaPrefix>/tombstones/<key>` in the writable layer.
The default `metaPrefix` is `.overlay`; it is reserved. If your bucket already
uses that prefix, set a different one.

Conditional writes use R2's `onlyIf` shape:

```ts
yield* store.put("lock.txt", "value", {
  onlyIf: { etagMatches: previous.etag },
});
```

The in-memory adapter enforces the ETag conditions; the R2 adapter forwards the
whole condition object.

## Consistency

- **Reads are live.** An object added to production after a preview starts is
  visible in that preview until the preview overrides it. This is not a
  snapshot.
- **Writes are per-key overrides.** There is no partial object mutation.
- **Deletes are per-key tombstones.** Deleting a prefix is not cascaded; list
  and delete the keys you mean.
- **R2 is strongly consistent**, so fallback reads observe completed writes
  immediately.

If you need snapshot isolation, capture a key list at branch creation and use
it to filter the lower layer. That is on the roadmap, not in v0.

## Performance notes

`list` currently reads every matching key from every layer and merges in
memory. That is fine for preview-sized namespaces (hundreds to low thousands
of keys) and is the reason the API returns a cursor rather than a stream.

`get` costs one lookup per layer until it hits a value or a tombstone. A miss
on a two-layer store is two `get` calls plus one tombstone `head`.

## Testing

Tests are written with `@effect/vitest` and run against both adapters. The
shared contract lives in `test/stories.ts`; `test/memory.test.ts` runs it over
memory and `test/r2.test.ts` runs it over a real local R2 binding via
Miniflare.

```sh
bun run test
bun run typecheck
bun run build
bun run example   # a preview overlay over an in-memory bucket
```

The R2 lane needs no Cloudflare account or credentials.

## Related work

- Linux `overlayfs` — the overlay/tombstone model this borrows from.
- Tigris — managed bucket snapshots and copy-on-write forks. R2 has no
  equivalent.
- LakeFS — git-like branching for data lakes, implemented with object-store
  metadata.
- S3 `CopyObject` — server-side copy, but not an alias. Useful for seeding a
  layer, not for overlaying one.

## Roadmap

- [ ] Streaming, paginated `list` merge (avoid loading all keys)
- [ ] Optional snapshot manifest for true branch isolation
- [ ] `promote` / `reset` helpers (copy an overlay key down, clear a layer)
- [ ] S3 adapter
- [ ] Effect `Layer` constructors for the built-in adapters
- [ ] Tombstone garbage collection helpers

## License

MIT
