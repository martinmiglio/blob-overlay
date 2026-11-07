import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { collectBody, normalize, streamFromBytes } from "./key.js";
import {
  DEFAULT_LIST_LIMIT,
  PreconditionFailed,
  type ListOptions,
  type ListPage,
  type ObjectMeta,
  type ObjectStore,
  type StoredObject,
} from "./types.js";

interface Entry {
  readonly bytes: Uint8Array;
  readonly etag: string;
  readonly uploaded: Date;
  readonly httpMetadata?: ObjectMeta["httpMetadata"];
  readonly customMetadata?: Record<string, string>;
}

export interface MemoryStoreOptions {
  /** Seed the store with keys and string/byte values. */
  readonly initial?: Record<string, string | Uint8Array>;
}

function etagOf(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `"${bytes.byteLength.toString(16)}-${hash.toString(16).padStart(8, "0")}"`;
}

const toMeta = (key: string, entry: Entry): ObjectMeta => ({
  key,
  size: entry.bytes.byteLength,
  etag: entry.etag,
  uploaded: entry.uploaded,
  httpMetadata: entry.httpMetadata as ObjectMeta["httpMetadata"],
  customMetadata: entry.customMetadata,
});

/**
 * An in-memory ObjectStore. Useful for tests, examples, and local play.
 */
export function memoryStore(options: MemoryStoreOptions = {}): ObjectStore {
  const entries = new Map<string, Entry>();

  for (const [rawKey, body] of Object.entries(options.initial ?? {})) {
    const bytes =
      typeof body === "string" ? new TextEncoder().encode(body) : body;
    const key = rawKey.replace(/^\/+/, "");
    if (!key) continue;
    entries.set(key, {
      bytes,
      etag: etagOf(bytes),
      uploaded: new Date(0),
    });
  }

  return {
    get: (rawKey) =>
      normalize("get", rawKey).pipe(
        Effect.map((key): StoredObject | null => {
          const entry = entries.get(key);
          if (!entry) return null;
          return {
            ...toMeta(key, entry),
            body: streamFromBytes(entry.bytes),
          };
        }),
      ),

    head: (rawKey) =>
      normalize("head", rawKey).pipe(
        Effect.map((key) => {
          const entry = entries.get(key);
          return entry ? toMeta(key, entry) : null;
        }),
      ),

    put: (rawKey, body, putOptions) =>
      Effect.gen(function* () {
        const key = yield* normalize("put", rawKey);
        const bytes = yield* collectBody(body, key);
        const existing = entries.get(key);

        const onlyIf = putOptions?.onlyIf;
        if (
          onlyIf?.etagMatches !== undefined &&
          existing?.etag !== onlyIf.etagMatches
        ) {
          return yield* Effect.fail(
            new PreconditionFailed({
              key,
              expected: onlyIf.etagMatches,
            }),
          );
        }
        if (
          onlyIf?.etagDoesNotMatch !== undefined &&
          existing?.etag === onlyIf.etagDoesNotMatch
        ) {
          return yield* Effect.fail(
            new PreconditionFailed({
              key,
              expected: onlyIf.etagDoesNotMatch,
            }),
          );
        }

        const uploaded = new Date(yield* Clock.currentTimeMillis);
        const entry: Entry = {
          bytes,
          etag: etagOf(bytes),
          uploaded,
          httpMetadata: putOptions?.httpMetadata,
          customMetadata: putOptions?.customMetadata,
        };
        entries.set(key, entry);
        return toMeta(key, entry);
      }),

    delete: (rawKey) =>
      normalize("delete", rawKey).pipe(
        Effect.tap((key) =>
          Effect.sync(() => {
            entries.delete(key);
          }),
        ),
        Effect.asVoid,
      ),

    list: (listOptions?: ListOptions) =>
      Effect.sync((): ListPage => {
        const all = [...entries.keys()]
          .filter((key) => key.startsWith(listOptions?.prefix ?? ""))
          .sort();
        const afterCursor = listOptions?.cursor
          ? all.filter((key) => key > listOptions.cursor!)
          : all;
        const limit = listOptions?.limit ?? DEFAULT_LIST_LIMIT;
        const page = afterCursor.slice(0, limit);
        const truncated = afterCursor.length > page.length;
        const objects = page.map((key) => toMeta(key, entries.get(key)!));
        return {
          objects,
          truncated,
          ...(truncated && page.length > 0
            ? { cursor: page[page.length - 1]! }
            : {}),
        };
      }),
  };
}
