import { ToolDefinition } from "../types";

export const browserToolDefinition = new ToolDefinition({
  name: "browser",
  description:
    "Capture and send website screenshots via headless browser. Takes URL, optional viewport size, and full-page capture.",
  domain: "browser",
});
