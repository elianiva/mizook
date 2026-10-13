import { Type, type Tool } from "@earendil-works/pi-ai";

/**
 * The memory's two tools. Compactions send them too (never called) so they read the turns' prompt
 * cache: tools and system prompt must be the same bytes in both.
 */
export const zoomParameters = Type.Object({
  id: Type.Integer({ minimum: 0, description: "First message of the line, as in id+n." }),
  n: Type.Integer({
    minimum: 1,
    description: "Messages the line covers: a power of 2, and id a multiple of it.",
  }),
});

export const dateParameters = Type.Object({
  id: Type.Integer({ minimum: 0, description: "The message id." }),
});

export const ZOOM_DESCRIPTION =
  "Open line id+n of the view into the two lines it was made from. zoom(id, 1) gives message id whole.";
export const DATE_DESCRIPTION = "The date and time of message id.";

export const memoryTools: Tool[] = [
  { name: "zoom", description: ZOOM_DESCRIPTION, parameters: zoomParameters },
  { name: "date", description: DATE_DESCRIPTION, parameters: dateParameters },
];
