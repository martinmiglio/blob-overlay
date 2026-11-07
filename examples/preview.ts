import * as Effect from "effect/Effect";

import {
  memoryStore,
  overlay,
  readText,
  withPrefix,
} from "../src/index.js";

/**
 * A preview environment over a single bucket.
 *
 * Production lives at the bucket root. The preview writes under
 * `preview/pr-344/` and reads through to production for everything else.
 */
const program = Effect.gen(function* () {
  const bucket = memoryStore();
  const prod = bucket;
  const preview = withPrefix(bucket, "preview/pr-344");
  const media = overlay({ layers: [preview, prod] });

  yield* prod.put("images/hero.jpg", "production hero");
  yield* prod.put("images/about.jpg", "production about");

  const hero = yield* media.get("images/hero.jpg");
  console.log("before override:", hero && (yield* readText(hero)));

  yield* media.put("images/hero.jpg", "preview hero");
  yield* media.delete("images/about.jpg");

  const overridden = yield* media.get("images/hero.jpg");
  const hidden = yield* media.get("images/about.jpg");
  const listed = yield* media.list({ prefix: "images/" });

  console.log("after override: ", overridden && (yield* readText(overridden)));
  console.log("deleted key:   ", hidden);
  console.log(
    "visible keys:  ",
    listed.objects.map((object) => object.key),
  );
});

// The compatibility boundary: Effect in the library, Promise at the edge.
await Effect.runPromise(program);
