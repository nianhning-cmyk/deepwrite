import type { FolderCatalogProjectManifest } from "./types";

/**
 * Every content file the manifest points at, as `{ id, path }` pairs.
 *
 * This lives apart from `manifest.ts` because `migrations.ts` needs it while
 * `manifest.ts` needs the migrations to read old manifests. Keeping the shared
 * enumeration here is what stops those two modules from importing each other.
 */
export function manifestContentItems(
  manifest: FolderCatalogProjectManifest
): Array<{ id: string; path: string }> {
  if (manifest.kind === "deepwrite.book") {
    return manifest.schemaVersion !== 1
      ? [
          ...manifest.documents,
          ...manifest.draft.sections.flatMap((section) => [
            section.body,
            section.characterState
          ])
        ]
      : [...manifest.documents];
  }
  if (
    manifest.kind === "deepwrite.material-library" ||
    manifest.kind === "deepwrite.skill-library"
  ) {
    return [...manifest.entries];
  }
  return [];
}
