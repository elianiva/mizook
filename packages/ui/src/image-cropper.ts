import { imageCropper } from "@ui-sdk/core/image-cropper";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

export const Crop = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
  /** 0, 90, 180 or 270. */
  rotation: Schema.Finite,
  flipX: Schema.Boolean,
  flipY: Schema.Boolean,
});
export type Crop = typeof Crop.Type;

export const State = Schema.Struct({
  key: Schema.String,
  src: Schema.String,
  /** The crop in image pixels. Null until the image loads and the instance picks one. */
  crop: Schema.NullOr(Crop),
  /** Width over height, or null for a free selection. */
  aspectRatio: Schema.NullOr(Schema.Finite),
});
export type State = typeof State.Type;

export const init = (state: { key: string; src: string; aspectRatio?: number }): State => ({
  key: state.key,
  src: state.src,
  crop: null,
  aspectRatio: state.aspectRatio ?? null,
});

const crop = Schema.decodeUnknownSync(Crop);

type Slot =
  | "root"
  | "viewport"
  | "image"
  | "selection"
  | "grid"
  | "handle"
  | "zoom"
  | "rotate"
  | "flip";

export const component = defineComponent<State, Slot>({
  name: "image-cropper",
  primitive: primitiveOf(imageCropper),
  state: State,
  key: (state) => state.key,
  options: (state) => ({
    src: state.src,
    mode: "box",
    minWidth: 32,
    minHeight: 32,
    ...(state.crop === null ? {} : { crop: { ...state.crop } }),
    ...(state.aspectRatio === null ? {} : { aspectRatio: state.aspectRatio }),
  }),
  controlled: ["crop"],
  callbacks: { onCropChange: "crop" },
  fold: (state, snapshot) => ({
    ...state,
    crop:
      snapshot["crop"] === undefined || snapshot["crop"] === null
        ? state.crop
        : crop(snapshot["crop"]),
  }),
  tags: {
    root: "div",
    viewport: "div",
    image: "img",
    selection: "div",
    grid: "div",
    handle: "div",
    zoom: "input",
    rotate: "button",
    flip: "button",
  },
  bound: ["root", "viewport", "image", "selection", "grid", "handle", "zoom", "rotate", "flip"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
