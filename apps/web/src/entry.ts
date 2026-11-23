import { Effect } from "effect";
import { Runtime } from "foldkit";

import { kit } from "./kit.ts";
import { Flags, Message, Model, init, subscriptions, update, view } from "./main.ts";
import { startServiceWorker } from "./pwa.ts";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) throw new Error("The app root is missing.");

const ui = kit.layer(container);
const application = Runtime.makeApplication({
  Model,
  Flags,
  init,
  update,
  view,
  subscriptions,
  container,
  resources: ui.layer,
  routing: {
    onUrlRequest: (request) => Message.ClickedLink({ request }),
    onUrlChange: (url) => Message.ChangedUrl({ url }),
  },
  devTools: { Message },
});

Runtime.run(application, { flags: Effect.succeed({ anchorId: ui.anchorId }) });
startServiceWorker();
