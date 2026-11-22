import { timeInput } from "@ui-sdk/core/time-input";
import { primitiveOf } from "./internal/render.ts";
import { componentOf, initOf, partsOf, segmentsOf, type State } from "./segmented-input.ts";
import { makeUpdate } from "./core.ts";

export { State, type Segment } from "./segmented-input.ts";
export const init = initOf("minute");
export const component = componentOf("time-input", primitiveOf(timeInput));
export const parts = partsOf(component);
export const update = makeUpdate(component);
export const segments = (state: State) => segmentsOf(component, state);
