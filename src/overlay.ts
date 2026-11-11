import * as Effect from "effect/Effect";

import { joinKey, normalize, normalizePrefix } from "./key.js";
import {
  DEFAULT_LIST_LIMIT,
  ObjectStoreError,
  type ListOptions,
  type ListPage,
  type ObjectMeta,
  type ObjectStore,
  type StoreError,
  type StoredObject,
} from "./types.js";

export interface OverlayOptions {
  /**
   * Layers from highest precedence to lowest. The first layer receives every
   * write; reads fall through until one layer has the key.
   */
  readonly layers: readonly [ObjectStore, ...ObjectStore[]];
  /**
   * Reserved namespace in the writable layer that holds tombstones. Must not
   * overlap application keys.
   *
   * @default ".overlay"
   */
  readonly metadataPrefix?: string;
}

const listAll = (
  store: ObjectStore,
  options: ListOptions,
): Effect.Effect<ObjectMeta[], ObjectStoreError> =>
  Effect.gen(function* () {
    const objects: ObjectMeta[] = [];
    let cursor = options.cursor;
    for (;;) {
      const page = yield* store.list({ ...options, cursor });
      objects.push(...page.objects);
      if (!page.truncated || !page.cursor) break;
      cursor = page.cursor;
    }
    return objects;
  });

const asStoreError = (
  error: StoreError,
  operation: "put" | "delete",
  key: string,
): ObjectStoreError =>
  error._tag === "PreconditionFailed"
    ? new ObjectStoreError({ operation, key, cause: error })
    : error;

/**
 * Build a layered, copy-on-write-style view over one or more object stores.
 *
 * Reads fall through the layers. Writes always land in the first layer.
 * Deletes write a tombstone into the first layer so a lower layer's object
 * does not reappear.
 */
export function overlay(options: OverlayOptions): ObjectStore {
  const layers = options.layers;
  const top = layers[0];
  const metadataPrefix = normalizePrefix(options.metadataPrefix ?? ".overlay");

  if (!metadataPrefix) {
    throw new Error("metadataPrefix must not be empty");
  }

  const tombstonePrefix = joinKey(metadataPrefix, "tombstones");
  const tombstoneKey = (key: string) => joinKey(tombstonePrefix, key);
  const isMetaKey = (key: string) =>
    key === metadataPrefix || key.startsWith(`${metadataPrefix}/`);

  const getAt = (
    index: number,
    key: string,
  ): Effect.Effect<StoredObject | null, ObjectStoreError> =>
    Effect.gen(function* () {
      const layer = layers[index]!;
      const object = yield* layer.get(key);
      if (object) return object;

      if (index === 0) {
        const tombstone = yield* layer.head(tombstoneKey(key));
        if (tombstone) return null;
      }

      if (index + 1 >= layers.length) return null;
      return yield* getAt(index + 1, key);
    });

  const headAt = (
    index: number,
    key: string,
  ): Effect.Effect<ObjectMeta | null, ObjectStoreError> =>
    Effect.gen(function* () {
      const layer = layers[index]!;
      const meta = yield* layer.head(key);
      if (meta) return meta;

      if (index === 0) {
        const tombstone = yield* layer.head(tombstoneKey(key));
        if (tombstone) return null;
      }

      if (index + 1 >= layers.length) return null;
      return yield* headAt(index + 1, key);
    });

  return {
    get: (rawKey) =>
      normalize("get", rawKey).pipe(Effect.flatMap((key) => getAt(0, key))),

    head: (rawKey) =>
      normalize("head", rawKey).pipe(Effect.flatMap((key) => headAt(0, key))),

    put: (rawKey, body, putOptions) =>
      Effect.gen(function* () {
        const key = yield* normalize("put", rawKey);
        const meta = yield* top.put(key, body, putOptions);
        // A tombstone in the same layer would never win over the data key, so
        // this is housekeeping rather than correctness.
        yield* top.delete(tombstoneKey(key));
        return meta;
      }),

    delete: (rawKey) =>
      Effect.gen(function* () {
        const key = yield* normalize("delete", rawKey);
        // Write the tombstone before removing the data key: if the process
        // dies in between, the object is still hidden at the next read.
        yield* top
          .put(tombstoneKey(key), new Uint8Array())
          .pipe(Effect.mapError((error) => asStoreError(error, "put", key)));
        yield* top.delete(key);
      }),

    list: (listOptions?: ListOptions) =>
      Effect.gen(function* () {
        const dataPrefix = listOptions?.prefix ?? "";

        const layerObjects = yield* Effect.forEach(
          layers,
          (layer) =>
            listAll(layer, {
              prefix: dataPrefix,
              include: listOptions?.include,
            }),
          { concurrency: "unbounded" },
        );

        const tombstones = yield* listAll(top, {
          prefix: joinKey(tombstonePrefix, dataPrefix),
        });
        const tombstoneRoot = `${tombstonePrefix}/`;

        const resolved = new Map<string, ObjectMeta | null>();

        for (const [index, objects] of layerObjects.entries()) {
          for (const object of objects) {
            if (isMetaKey(object.key)) continue;
            if (!resolved.has(object.key)) {
              resolved.set(object.key, object);
            }
          }

          if (index === 0) {
            for (const tombstone of tombstones) {
              const key = tombstone.key.startsWith(tombstoneRoot)
                ? tombstone.key.slice(tombstoneRoot.length)
                : tombstone.key;
              if (isMetaKey(key)) continue;
              if (!resolved.has(key)) {
                resolved.set(key, null);
              }
            }
          }
        }

        const visible = [...resolved.entries()]
          .filter((entry): entry is [string, ObjectMeta] => entry[1] !== null)
          .map(([, meta]) => meta)
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

        const afterCursor = listOptions?.cursor
          ? visible.filter((object) => object.key > listOptions.cursor!)
          : visible;
        const limit = listOptions?.limit ?? DEFAULT_LIST_LIMIT;
        const page = afterCursor.slice(0, limit);
        const truncated = afterCursor.length > page.length;

        return {
          objects: page,
          truncated,
          ...(truncated && page.length > 0
            ? { cursor: page[page.length - 1]!.key }
            : {}),
        } satisfies ListPage;
      }),
  };
}

/**
 * Mount an existing store under a key prefix. The prefix is transparent to
 * callers of the returned store.
 */
export function withPrefix(store: ObjectStore, prefix: string): ObjectStore {
  const normalized = normalizePrefix(prefix);
  if (!normalized) return store;

  const name = (key: string) => joinKey(normalized, key);
  const stripPrefix = `${normalized}/`;

  return {
    get: (key) => store.get(name(key)),
    head: (key) => store.head(name(key)),
    put: (key, body, options) => store.put(name(key), body, options),
    delete: (key) => store.delete(name(key)),
    list: (options) =>
      Effect.gen(function* () {
        const page = yield* store.list({
          ...options,
          prefix: options?.prefix
            ? joinKey(normalized, options.prefix)
            : stripPrefix,
        });

        return {
          ...page,
          objects: page.objects.map((object) => ({
            ...object,
            key: object.key.startsWith(stripPrefix)
              ? object.key.slice(stripPrefix.length)
              : object.key,
          })),
        };
      }),
  };
}
