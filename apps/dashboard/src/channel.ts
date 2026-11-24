import { Array, Option, pipe } from "effect";
import { AsyncData } from "foldkit";

import { channelsQuery } from "./api.ts";
import type { Model } from "./model.ts";
import { routeChannel } from "./route.ts";

export const currentChannel = (model: Model): Option.Option<string> =>
  Option.orElse(routeChannel(model.route), () =>
    pipe(
      AsyncData.getData(channelsQuery.read(model.channels)),
      Option.flatMap(Array.head),
      Option.map(({ doName }) => doName),
    ),
  );
