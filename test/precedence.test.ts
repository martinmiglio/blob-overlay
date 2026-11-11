import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { memoryStore, overlay, readText, withPrefix } from "../src/index.js";

describe("three-layer overlay", () => {
  it.effect("reads the highest layer that has the key", () =>
    Effect.gen(function* () {
      const base = memoryStore();
      const middle = memoryStore();
      const top = memoryStore();
      const store = overlay({ layers: [top, middle, base] });

      yield* base.put("shared.txt", "base");
      yield* middle.put("shared.txt", "middle");
      yield* top.put("shared.txt", "top");
      yield* middle.put("middle.txt", "middle only");

      const shared = yield* store.get("shared.txt");
      assert.ok(shared);
      assert.strictEqual(yield* readText(shared), "top");

      const middleOnly = yield* store.get("middle.txt");
      assert.ok(middleOnly);
      assert.strictEqual(yield* readText(middleOnly), "middle only");
    }),
  );

  it.effect("hides every layer after a delete in the top layer", () =>
    Effect.gen(function* () {
      const base = memoryStore();
      const middle = memoryStore();
      const top = memoryStore();
      const store = overlay({ layers: [top, middle, base] });

      yield* base.put("shared.txt", "base");
      yield* middle.put("shared.txt", "middle");
      yield* top.put("shared.txt", "top");

      yield* store.delete("shared.txt");

      assert.strictEqual(yield* store.get("shared.txt"), null);
      assert.strictEqual(yield* store.head("shared.txt"), null);

      // The lower layers still hold their copies; only the view hides them.
      assert.ok(yield* base.head("shared.txt"));
      assert.ok(yield* middle.head("shared.txt"));
    }),
  );

  it.effect("lists with shadowing and tombstones across three layers", () =>
    Effect.gen(function* () {
      const base = memoryStore();
      const middle = memoryStore();
      const top = memoryStore();
      const store = overlay({ layers: [top, middle, base] });

      yield* base.put("posts/a.txt", "base a");
      yield* base.put("posts/b.txt", "base b");
      yield* base.put("posts/shared.txt", "base shared");
      yield* middle.put("posts/c.txt", "middle c");
      yield* middle.put("posts/shared.txt", "middle shared");
      yield* top.put("posts/shared.txt", "top shared");

      yield* store.delete("posts/a.txt");

      const page = yield* store.list({ prefix: "posts/" });
      assert.deepStrictEqual(
        page.objects.map((object) => object.key),
        ["posts/b.txt", "posts/c.txt", "posts/shared.txt"],
      );

      const shadow = yield* top.head("posts/shared.txt");
      const listed = page.objects.find(
        (object) => object.key === "posts/shared.txt",
      );
      assert.ok(shadow);
      assert.ok(listed);
      assert.strictEqual(listed.etag, shadow.etag);
      assert.strictEqual(listed.size, "top shared".length);
    }),
  );
});

describe("prefixed pagination", () => {
  it.effect("follows a cursor and strips the mount prefix", () =>
    Effect.gen(function* () {
      const base = memoryStore();
      yield* base.put("mount/p/1.txt", "1");
      yield* base.put("mount/p/2.txt", "2");
      yield* base.put("mount/p/3.txt", "3");
      yield* base.put("mount/p/4.txt", "4");

      const mounted = withPrefix(base, "mount");
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;

      for (;;) {
        const page = yield* mounted.list({ prefix: "p/", limit: 2, cursor });
        pages += 1;
        seen.push(...page.objects.map((object) => object.key));
        if (!page.truncated) break;
        assert.ok(page.cursor);
        cursor = page.cursor;
      }

      assert.strictEqual(pages, 2);
      assert.deepStrictEqual(seen, [
        "p/1.txt",
        "p/2.txt",
        "p/3.txt",
        "p/4.txt",
      ]);
    }),
  );
});
