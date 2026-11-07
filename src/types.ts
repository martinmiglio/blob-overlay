/**
 * A minimal, runtime-agnostic object store contract, expressed entirely in
 * Effect. Every operation is lazy, fallible, and typed.
 *
 * The overlay implementation only depends on these five operations, so it can
 * sit on top of R2, S3, a filesystem, or an in-memory map.
 */

import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

/** A body can be an Effect stream or any of the usual binary/string values. */
export type Body =
  | Stream.Stream<Uint8Array, ObjectStoreError>
  | Uint8Array
  | ArrayBufferView
  | ArrayBuffer
  | string
  | Blob;

export interface HttpMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

export interface ObjectMeta {
  key: string;
  size: number;
  etag: string;
  uploaded?: Date;
  httpMetadata?: HttpMetadata;
  customMetadata?: Record<string, string>;
}

export interface StoredObject extends ObjectMeta {
  /**
   * The object body. It is lazy: the underlying stream is only acquired when
   * this stream is run, and can only be consumed once.
   */
  readonly body: Stream.Stream<Uint8Array, ObjectStoreError>;
}

/**
 * Conditional write, modelled on R2's `onlyIf` option. The in-memory adapter
 * enforces the ETag conditions; the R2 adapter forwards the whole object.
 */
export interface WriteCondition {
  etagMatches?: string;
  etagDoesNotMatch?: string;
  uploadedBefore?: Date;
  uploadedAfter?: Date;
}

export interface PutOptions {
  httpMetadata?: HttpMetadata;
  customMetadata?: Record<string, string>;
  onlyIf?: WriteCondition;
}

export type ListInclude = "httpMetadata" | "customMetadata";

export interface ListOptions {
  /** Only keys beginning with this string. */
  prefix?: string;
  /** Opaque cursor returned by a previous call. */
  cursor?: string;
  /** Maximum keys to return. Defaults to 1000. */
  limit?: number;
  /** Metadata to include in the returned objects. */
  include?: readonly ListInclude[];
}

export interface ListPage {
  objects: ObjectMeta[];
  truncated: boolean;
  /** Pass to the next call when `truncated` is true. */
  cursor?: string;
}

export interface ObjectStore {
  readonly get: (
    key: string,
  ) => Effect.Effect<StoredObject | null, ObjectStoreError>;
  readonly head: (
    key: string,
  ) => Effect.Effect<ObjectMeta | null, ObjectStoreError>;
  readonly put: (
    key: string,
    body: Body,
    options?: PutOptions,
  ) => Effect.Effect<ObjectMeta, StoreError>;
  readonly delete: (key: string) => Effect.Effect<void, ObjectStoreError>;
  readonly list: (
    options?: ListOptions,
  ) => Effect.Effect<ListPage, ObjectStoreError>;
}

/** Any failed store operation. */
export class ObjectStoreError extends Schema.TaggedError<ObjectStoreError>()(
  "ObjectStoreError",
  {
    operation: Schema.Literals(["get", "head", "put", "delete", "list"]),
    key: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/** A conditional write lost its precondition. */
export class PreconditionFailed extends Schema.TaggedError<PreconditionFailed>()(
  "PreconditionFailed",
  {
    key: Schema.String,
    expected: Schema.optional(Schema.String),
  },
) {}

export type StoreError = ObjectStoreError | PreconditionFailed;

export const DEFAULT_LIST_LIMIT = 1000;
