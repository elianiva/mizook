import { formatSize } from "../format";
import { getSharedHeadContent } from "../shared-head";

interface Artifact {
  name: string;
  size: number;
  modified: string;
  href: string;
}

function renderCard(item: Artifact): string {
  return `
    <a href="${item.href}" class="block rounded-xl border border-border bg-card p-5 shadow-sm transition-all hover:shadow-md hover:border-primary/30">
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2.5 mb-2">
            <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <svg class="h-4.5 w-4.5 text-primary" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
              </svg>
            </div>
            <h3 class="font-heading text-sm font-medium tracking-tight truncate">${item.name}</h3>
          </div>
          <div class="flex items-center gap-3 text-xs text-muted-foreground">
            <span>${item.modified}</span>
            <span class="text-border">·</span>
            <span>${formatSize(item.size)}</span>
          </div>
        </div>
        <svg class="h-4 w-4 shrink-0 text-muted-foreground/50 mt-1" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
        </svg>
      </div>
    </a>`;
}

function renderEmpty(): string {
  return '<div class="rounded-xl border border-dashed border-border p-8 text-center"><p class="text-muted-foreground text-sm">No artifacts yet.</p></div>';
}

export function renderArtifactList(items: Artifact[]): string {
  const cards = items.length > 0 ? items.map(renderCard).join("") : renderEmpty();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>mizook</title>
  ${getSharedHeadContent()}
</head>
<body class="bg-background text-foreground font-sans antialiased">
  <main class="max-w-2xl mx-auto px-6 py-20">
    <div class="mb-10">
      <h1 class="font-heading text-3xl font-semibold tracking-tight mb-2">mizook</h1>
      <p class="text-muted-foreground text-sm">${items.length} artifact${items.length === 1 ? "" : "s"}</p>
    </div>
    <div class="grid gap-3">
      ${cards}
    </div>
  </main>
</body>
</html>`;
}
