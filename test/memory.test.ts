import * as Effect from "effect/Effect";

import { memoryStore, overlay } from "../src/index";
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
