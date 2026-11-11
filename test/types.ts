import type { R2Bucket } from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";

import { r2 } from "../src/r2.js";

// Compile-time check: a real Workers R2 binding must be assignable to the
// adapter without casts.
declare const bucket: R2Bucket;
const store = r2(bucket);

void Effect.gen(function* () {
  yield* store.get("key");
  yield* store.put("key", new Uint8Array());
  yield* store.list({ prefix: "images/" });
});
