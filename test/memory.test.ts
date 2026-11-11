import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { memoryStore, overlay } from "../src/index.js";
import { overlayStories, type LayeredStores } from "./stories";

overlayStories("overlay over memory", () =>
  Effect.sync((): LayeredStores => {
    const base = memoryStore();
    const layer = memoryStore();
    return {
      base,
      layer,
      store: overlay({ layers: [layer, base] }),
    };
  }),
);

describe("overlay options", () => {
  it.effect("honours a custom metadata prefix", () =>
    Effect.gen(function* () {
      const base = memoryStore();
      const layer = memoryStore();
      const store = overlay({
        layers: [layer, base],
        metadataPrefix: "_meta",
      });

      yield* base.put("key.txt", "base");
      yield* store.delete("key.txt");

      const tombstone = yield* layer.head("_meta/tombstones/key.txt");
      assert.ok(tombstone);
      assert.strictEqual(yield* store.get("key.txt"), null);
    }),
  );
});
