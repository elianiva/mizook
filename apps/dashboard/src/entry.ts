import { Effect } from "effect";
import { Runtime } from "foldkit";
import { appRoot } from "@mizook/ui/app-root";

import { Message, Model, init, subscriptions, update, view } from "./main.ts";
import "./styles.css";

const start = Effect.map(appRoot, (container) => {
  const application = Runtime.makeApplication({
    Model,
    init,
    update,
    view,
    subscriptions,
    container,
    routing: {
      onUrlRequest: (request) => Message.ClickedLink({ request }),
      onUrlChange: (url) => Message.ChangedUrl({ url }),
    },
    devTools: { Message },
  });

  Runtime.run(application);
});

Effect.runFork(start);
