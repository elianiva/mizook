import { createRecipe } from './runtime';

const buttonConfig = {"name":"button","className":"btn","defaultVariants":{"size":"md","tone":"line"},"variantMap":{"tone":["primary","line","ghost","danger"],"size":["md","sm","icon","iconSm"]}}

export const button = /* @__PURE__ */ createRecipe(buttonConfig)