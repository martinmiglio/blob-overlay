import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { normalize } from "./key.js";
import type { Body } from "./types.js";
import {
  ObjectStoreError,
  PreconditionFailed,
  type HttpMetadata,
  type ListOptions,
  type ObjectMeta,
  type ObjectStore,
  type StoredObject,
} from "./types.js";

/**
 * The subset of the R2 binding this adapter uses. Kept structural so the
 * package does not depend on Workers types at runtime.
 */
export interface R2ObjectLike {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly uploaded?: Date;
  readonly httpMetadata?: HttpMetadata;
  readonly customMetadata?: Record<string, string>;
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  readonly body: ReadableStream;
}

export interface R2BucketLike {
  get(
    key: string,
    options?: unknown,
  ): Promise<R2ObjectLike | R2ObjectBodyLike | null>;
  head(key: string, options?: unknown): Promise<R2ObjectLike | null>;
  put(
    key: string,
    value: unknown,
    options?: unknown,
  ): Promise<R2ObjectLike | null>;
  delete(key: string | string[]): Promise<void>;
  list(options?: unknown): Promise<{
    objects: R2ObjectLike[];
    truncated: boolean;
    cursor?: string;
  }>;
}

const toMeta = (object: R2ObjectLike, key = object.key): ObjectMeta => ({
  key,
  size: object.size,
  etag: object.etag,
  uploaded: object.uploaded,
  httpMetadata: object.httpMetadata,
  customMetadata: object.customMetadata,
});

const isPreconditionFailure = (cause: unknown): boolean => {
  if (typeof cause !== "object" || cause === null) return false;
  const candidate = cause as { code?: unknown; status?: unknown };
  return (
    candidate.code === "PreconditionFailed" || candidate.status === 412
  );
};

const attempt = <A>(
  operation: "get" | "head" | "delete" | "list",
  key: string | undefined,
  evaluate: () => Promise<A>,
): Effect.Effect<A, ObjectStoreError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new ObjectStoreError({ operation, key, cause }),
  });

/**
 * Wrap an R2 bucket binding as an ObjectStore.
 *
 * All I/O is lazy and typed. The caller owns the binding; this adapter never
 * closes or mutates the bucket itself.
 */
export function r2(bucket: R2BucketLike): ObjectStore {
  return {
    get: (rawKey) =>
      Effect.gen(function* () {
        const key = yield* normalize("get", rawKey);
        const object = yield* attempt("get", key, () => bucket.get(key));
        if (!object) return null;
        if (!("body" in object)) {
          return yield* Effect.fail(
            new ObjectStoreError({
              operation: "get",
              key,
              cause: new Error("R2 get returned an object without a body"),
            }),
          );
        }

        return {
          ...toMeta(object, key),
          body: Stream.fromReadableStream<Uint8Array, ObjectStoreError>({
            evaluate: () => object.body as ReadableStream<Uint8Array>,
            onError: (cause) =>
              new ObjectStoreError({ operation: "get", key, cause }),
          }),
        } satisfies StoredObject;
      }),

    head: (rawKey) =>
      Effect.gen(function* () {
        const key = yield* normalize("head", rawKey);
        const object = yield* attempt("head", key, () => bucket.head(key));
        return object ? toMeta(object, key) : null;
      }),

    put: (rawKey, body, options) =>
      Effect.gen(function* () {
        const key = yield* normalize("put", rawKey);
        const value = yield* toR2Body(body, key);

        const object = yield* Effect.tryPromise({
          try: () => bucket.put(key, value, options),
          catch: (cause) =>
            isPreconditionFailure(cause)
              ? new PreconditionFailed({ key })
              : new ObjectStoreError({ operation: "put", key, cause }),
        });

        if (!object) {
          return yield* Effect.fail(new PreconditionFailed({ key }));
        }

        return toMeta(object, key);
      }),

    delete: (rawKey) =>
      Effect.gen(function* () {
        const key = yield* normalize("delete", rawKey);
        yield* attempt("delete", key, () => bucket.delete(key));
      }),

    list: (options?: ListOptions) =>
      attempt("list", options?.prefix, () =>
        bucket.list({
          prefix: options?.prefix,
          cursor: options?.cursor,
          limit: options?.limit,
          include: options?.include ? [...options.include] : undefined,
        }),
      ).pipe(
        Effect.map((page) => ({
          objects: page.objects.map((object) => toMeta(object)),
          truncated: page.truncated,
          ...(page.cursor ? { cursor: page.cursor } : {}),
        })),
      ),
  };
}

const toR2Body = (
  body: Body,
  key: string,
): Effect.Effect<unknown, ObjectStoreError> => {
  if (!Stream.isStream(body)) {
    return Effect.succeed(body);
  }
  return Stream.toReadableStreamEffect(
    body as Stream.Stream<Uint8Array, ObjectStoreError>,
  ).pipe(
    Effect.mapError(
      (cause) => new ObjectStoreError({ operation: "put", key, cause }),
    ),
  );
};
