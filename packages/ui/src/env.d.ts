// The one slice of Vite's `import.meta.env` the kit reads. Written as the
// literal `import.meta.env.DEV` so Vite and Vitest both replace it.
interface ImportMeta {
  readonly env?: { readonly DEV?: boolean }
}
