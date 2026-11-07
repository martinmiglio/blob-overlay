import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { concatBytes } from "./key.js";
import type { ObjectStoreError, StoredObject } from "./types.js";

/** Read a stored object body into memory. */
export const readBytes = (
  object: StoredObject,
): Effect.Effect<Uint8Array, ObjectStoreError> =>
  Stream.runCollect(object.body).pipe(
    Effect.map((chunks) =>
      concatBytes(chunks as ReadonlyArray<Uint8Array>),
    ),
  );

/** Read a stored object body as UTF-8 text. */
export const readText = (
  object: StoredObject,
): Effect.Effect<string, ObjectStoreError> =>
  readBytes(object).pipe(Effect.map((bytes) => new TextDecoder().decode(bytes)));
