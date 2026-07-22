import { Schema } from "effect";

export class ToolDefinition extends Schema.Class<ToolDefinition>("ToolDefinition")({
  name: Schema.String,
  description: Schema.String,
  domain: Schema.String,
}) {}
