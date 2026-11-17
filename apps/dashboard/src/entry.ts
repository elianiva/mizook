import { Runtime } from "foldkit";

import { Message, Model, init, subscriptions, update, view } from "./main.ts";
import "./styles.css";

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  subscriptions,
  container: document.getElementById("root"),
  routing: {
    onUrlRequest: (request) => Message.ClickedLink({ request }),
    onUrlChange: (url) => Message.ChangedUrl({ url }),
  },
  devTools: { Message },
});

Runtime.run(application);
