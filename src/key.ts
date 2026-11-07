import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { ObjectStoreError, type Body } from "./types.js";

export function normalizeKey(key: string): string {
  const normalized = key.replace(/^\/+/, "");
  if (!normalized) {
    throw new Error("Object key must not be empty");
  }
  return normalized;
}

export function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

export function joinKey(prefix: string, key: string): string {
  const normalizedPrefix = normalizePrefix(prefix);
  const normalizedKey = key.replace(/^\/+/, "");
  if (!normalizedPrefix) return normalizedKey;
  if (!normalizedKey) return normalizedPrefix;
  return `${normalizedPrefix}/${normalizedKey}`;
}

export function streamFromBytes(bytes: Uint8Array): Stream.Stream<Uint8Array> {
  return Stream.fromIterable([bytes]);
}

export function isBlob(value: unknown): value is Blob {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Blob).arrayBuffer === "function" &&
    typeof (value as Blob).type === "string"
  );
}

export function concatBytes(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Read any accepted body into bytes. Stream bodies keep their typed failure;
 * the other shapes cannot fail.
 */
export const collectBody = (
  body: Body,
  key: string,
): Effect.Effect<Uint8Array, ObjectStoreError> => {
  if (typeof body === "string") {
    return Effect.succeed(new TextEncoder().encode(body));
  }
  if (ArrayBuffer.isView(body)) {
    return Effect.succeed(
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    );
  }
  if (Object.prototype.toString.call(body) === "[object ArrayBuffer]") {
    return Effect.succeed(new Uint8Array(body as ArrayBuffer));
  }
  if (isBlob(body)) {
    return Effect.tryPromise({
      try: () => body.arrayBuffer(),
      catch: (cause) => new ObjectStoreError({ operation: "put", key, cause }),
    }).pipe(Effect.map((buffer) => new Uint8Array(buffer)));
  }
  if (Stream.isStream(body)) {
    return Stream.runCollect(body).pipe(
      Effect.map((chunks) =>
        concatBytes(Array.from(chunks) as ReadonlyArray<Uint8Array>),
      ),
      Effect.mapError(
        (cause) => new ObjectStoreError({ operation: "put", key, cause }),
      ),
    );
  }
  return Effect.fail(
    new ObjectStoreError({
      operation: "put",
      key,
      cause: new TypeError("Unsupported body type"),
    }),
  );
};

/** Normalize a key as a typed Effect, so empty keys never become defects. */
export const normalize = (
  operation: "get" | "head" | "put" | "delete",
  key: string,
): Effect.Effect<string, ObjectStoreError> =>
  Effect.try({
    try: () => normalizeKey(key),
    catch: (cause) => new ObjectStoreError({ operation, key, cause }),
  });
