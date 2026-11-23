import type { ConditionalValue } from '../types/system';
import type { ConfigRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type ButtonVariant = {
  tone?: "primary" | "line" | "ghost" | "danger"
  size?: "md" | "sm" | "icon" | "iconSm"
}

export type ButtonVariantProps = {
  [K in keyof ButtonVariant]?: ConditionalValue<ButtonVariant[K]>
}

export type ButtonVariantMap = RecipeVariantMap<ButtonVariant>

export type ButtonRecipe = ConfigRecipeRuntimeFn<ButtonVariantProps, ButtonVariantMap>

export declare const button: ButtonRecipe;