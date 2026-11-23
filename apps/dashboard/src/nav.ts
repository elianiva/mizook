import { defineTaggedUnion } from "foldkit/schema";

/** The sections menu on narrow screens. It shuts whenever the route changes. */
export const NavState = defineTaggedUnion({ Closed: {}, Open: {} });
export type NavState = typeof NavState.Type;
