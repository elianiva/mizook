import { Schema } from "effect";

// Durable Object storage
export class StorageError extends Schema.TaggedErrorClass<StorageError>()("StorageError", {
  cause: Schema.Defect,
}) {}

// Request handling
export class ScreenshotError extends Schema.TaggedErrorClass<ScreenshotError>()("ScreenshotError", {
  cause: Schema.Defect,
}) {}
