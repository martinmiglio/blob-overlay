import * as Effect from "effect/Effect";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll } from "vitest";

import { ObjectStoreError, overlay, withPrefix } from "../src/index.js";
import { r2, type R2BucketLike } from "../src/r2.js";
import { overlayStories, type LayeredStores } from "./stories";

let mf: Miniflare;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    r2Buckets: ["MEDIA"],
  });
});

afterAll(async () => {
  await mf.dispose();
});

overlayStories("overlay over R2 (Miniflare)", () =>
  Effect.gen(function* () {
    const bucket = yield* Effect.tryPromise({
      try: () => mf.getR2Bucket("MEDIA"),
      catch: (cause) => new ObjectStoreError({ operation: "list", cause }),
    });

    const root = `test/${crypto.randomUUID()}`;
    // Miniflare's `getR2Bucket` overload resolves to the wrong type under TS 7.
    // The runtime value is the real local R2 binding.
    const binding = bucket as unknown as R2BucketLike;
    const base = withPrefix(r2(binding), `${root}/base`);
    const layer = withPrefix(r2(binding), `${root}/layer`);

    return { base, layer, store: overlay({ layers: [layer, base] }) };
  }),
);
