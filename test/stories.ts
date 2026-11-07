import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  readText,
  withPrefix,
  type ObjectStore,
  type ObjectStoreError,
} from "../src/index";

export interface LayeredStores {
  readonly base: ObjectStore;
  readonly layer: ObjectStore;
  readonly store: ObjectStore;
}

export type MakeStores = () => Effect.Effect<LayeredStores, ObjectStoreError>;

/**
 * The contract every layered store must satisfy. Running the same stories
 * against memory and R2 keeps the adapters honest.
 */
export function overlayStories(name: string, makeStores: MakeStores): void {
  describe(name, () => {
    it.effect("falls back to the base layer for untouched keys", () =>
      Effect.gen(function* () {
        const { base, store } = yield* makeStores();
        yield* base.put("posts/a.txt", "base");

        const object = yield* store.get("posts/a.txt");
        assert.ok(object);
        assert.strictEqual(yield* readText(object), "base");
        assert.strictEqual(object.size, 4);
      }),
    );

    it.effect("shadows the base layer after an overlay put", () =>
      Effect.gen(function* () {
        const { base, layer, store } = yield* makeStores();
        yield* base.put("posts/a.txt", "base");
        yield* layer.put("posts/a.txt", "override");

        const object = yield* store.get("posts/a.txt");
        assert.ok(object);
        assert.strictEqual(yield* readText(object), "override");

        const baseObject = yield* base.get("posts/a.txt");
        assert.ok(baseObject);
        assert.strictEqual(yield* readText(baseObject), "base");
      }),
    );

    it.effect("hides a base key after an overlay delete", () =>
      Effect.gen(function* () {
        const { base, store } = yield* makeStores();
        yield* base.put("posts/a.txt", "base");

        yield* store.delete("posts/a.txt");

        assert.strictEqual(yield* store.get("posts/a.txt"), null);
        assert.strictEqual(yield* store.head("posts/a.txt"), null);
      }),
    );

    it.effect("reveals an overlay key again after delete then put", () =>
      Effect.gen(function* () {
        const { base, store } = yield* makeStores();
        yield* base.put("posts/a.txt", "base");
        yield* store.delete("posts/a.txt");
        yield* store.put("posts/a.txt", "new");

        const object = yield* store.get("posts/a.txt");
        assert.ok(object);
        assert.strictEqual(yield* readText(object), "new");
      }),
    );

    it.effect("merges layers in a list, preferring the highest copy", () =>
      Effect.gen(function* () {
        const { base, layer, store } = yield* makeStores();
        yield* base.put("posts/a.txt", "a");
        yield* base.put("posts/b.txt", "b");
        yield* base.put("posts/c.txt", "c");
        yield* layer.put("posts/b.txt", "bb");
        yield* layer.put("posts/d.txt", "d");
        yield* store.delete("posts/c.txt");

        const page = yield* store.list({ prefix: "posts/" });
        assert.deepStrictEqual(
          page.objects.map((object) => object.key),
          ["posts/a.txt", "posts/b.txt", "posts/d.txt"],
        );

        const shadow = yield* layer.head("posts/b.txt");
        const listed = page.objects.find(
          (object) => object.key === "posts/b.txt",
        );
        assert.ok(shadow);
        assert.ok(listed);
        assert.strictEqual(listed.etag, shadow.etag);
        assert.strictEqual(listed.size, 2);
      }),
    );

    it.effect("paginates a merged list", () =>
      Effect.gen(function* () {
        const { base, store } = yield* makeStores();
        for (const index of [1, 2, 3, 4, 5]) {
          yield* base.put(`p/${index}.txt`, String(index));
        }

        const seen: string[] = [];
        let cursor: string | undefined;
        for (;;) {
          const page = yield* store.list({ prefix: "p/", limit: 2, cursor });
          seen.push(...page.objects.map((object) => object.key));
          if (!page.truncated) break;
          assert.ok(page.cursor);
          cursor = page.cursor;
        }

        assert.deepStrictEqual(seen, [
          "p/1.txt",
          "p/2.txt",
          "p/3.txt",
          "p/4.txt",
          "p/5.txt",
        ]);
      }),
    );

    it.effect("enforces etag preconditions on put", () =>
      Effect.gen(function* () {
        const { store } = yield* makeStores();
        const first = yield* store.put("cond.txt", "one");
        yield* store.put("cond.txt", "two", {
          onlyIf: { etagMatches: first.etag },
        });

        const error = yield* Effect.flip(
          store.put("cond.txt", "three", {
            onlyIf: { etagMatches: first.etag },
          }),
        );
        assert.strictEqual(error._tag, "PreconditionFailed");
      }),
    );

    it.effect("mounts a store under a transparent prefix", () =>
      Effect.gen(function* () {
        const { base } = yield* makeStores();
        const mounted = withPrefix(base, "mount");

        yield* mounted.put("images/a.jpg", "image");
        const raw = yield* base.head("mount/images/a.jpg");
        assert.ok(raw);

        const listed = yield* mounted.list();
        assert.deepStrictEqual(
          listed.objects.map((object) => object.key),
          ["images/a.jpg"],
        );
      }),
    );
  });
}
