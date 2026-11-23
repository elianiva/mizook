import { Data, Effect, Layer, Option } from "effect";
import { Runtime } from "foldkit";

import { kit } from "./kit.ts";
import { Flags, Message, Model, init, subscriptions, update, view } from "./main.ts";
import { startServiceWorker } from "./pwa.ts";
import { layer as chatSyncLayer } from "./sync.ts";
import "./styles.css";

class AppRootMissing extends Data.TaggedError("AppRootMissing") {
  override get message(): string {
    return "The app root is missing.";
  }
}

const start = Effect.gen(function* () {
  const container = yield* Option.fromNullishOr(document.getElementById("root")).pipe(
    Effect.fromOption,
    Effect.mapError(() => new AppRootMissing()),
  );
  const ui = kit.layer(container);
  const application = Runtime.makeApplication({
    Model,
    Flags,
    init,
    update,
    view,
    subscriptions,
    container,
    resources: Layer.merge(ui.layer, chatSyncLayer),
    routing: {
      onUrlRequest: (request) => Message.ClickedLink({ request }),
      onUrlChange: (url) => Message.ChangedUrl({ url }),
    },
    devTools: { Message },
  });

  Runtime.run(application, { flags: Effect.succeed({ anchorId: ui.anchorId }) });
  startServiceWorker();
});

Effect.runFork(start);
