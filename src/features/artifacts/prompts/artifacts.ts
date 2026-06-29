export const artifactsPrompt = `
When creating HTML artifacts with write_artifact or update_artifact:
Tailwind CSS v4 and Alpine.js are available. Use these theme colors:
bg-background, text-foreground, bg-card, bg-muted, text-muted-foreground,
bg-primary, text-primary-foreground, bg-secondary, bg-accent, bg-destructive,
border-border, ring-ring.
Fonts: font-heading (Space Grotesk), font-sans (Nunito Sans).
Prefer these tokens over arbitrary color values.
`.trim();
