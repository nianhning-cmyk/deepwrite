import { join } from "node:path";
import {
  BOOK_CHARACTER_OVERVIEW_DOCUMENT_ID,
  createDefaultBookCharacterStructure,
  createDefaultBookPlotStages,
  migrateCatalogDraftDocument,
  type BookProjectDocumentManifest,
  type BookProjectDraftSectionManifest,
  type V2BookProjectManifest,
  type V3BookProjectManifest
} from "@deepwrite/contracts";
import { manifestContentItems } from "./content-items";
import {
  assertJsonByteLength,
  assertTextByteLength,
  atomicWriteJson,
  atomicWriteText,
  portableContentPathKey,
  readProjectMarkdown,
  readRequiredUtf8File,
  secureWritableProjectPath,
  uniqueRelativeMarkdownPath,
  uniqueRelativeMarkdownPathWithSuffix
} from "./paths-io";
import {
  FolderCurrentBookProjectManifestSchema,
  MANIFEST_FILE,
  type FolderCurrentBookProjectManifest,
  type FolderLegacyBookProjectManifest
} from "./types";

export async function migrateLegacyBookProject(
  projectDirectory: string,
  manifest: FolderLegacyBookProjectManifest,
  originalManifestText: string,
  maxMarkdownBytes: number,
  maxManifestBytes: number
): Promise<FolderCurrentBookProjectManifest> {
  const exactDraftIndex = manifest.documents.findIndex(
    (document) => document.id === "draft"
  );
  const draftIndex =
    exactDraftIndex >= 0
      ? exactDraftIndex
      : manifest.documents.findIndex(
          (document) => document.title === "正文编写"
        );
  const draftManifest =
    draftIndex >= 0 ? manifest.documents[draftIndex] : undefined;
  const legacyDraft = draftManifest
    ? {
        id: draftManifest.id,
        title: draftManifest.title,
        content: await readProjectMarkdown(
          projectDirectory,
          draftManifest.path,
          maxMarkdownBytes
        ),
        createdAt: draftManifest.createdAt,
        updatedAt: draftManifest.updatedAt
      }
    : undefined;
  const draft = migrateCatalogDraftDocument(
    legacyDraft,
    manifest.createdAt,
    manifest.updatedAt
  );
  const documents = manifest.documents.filter(
    (_, index) => index !== draftIndex
  );
  const usedPaths = new Set(
    manifest.documents.map(({ path }) => portableContentPathKey(path))
  );
  const pendingFiles: Array<{ path: string; content: string }> = [];
  const sections: BookProjectDraftSectionManifest[] = [];
  for (const section of draft.sections) {
    assertTextByteLength(
      section.body.content,
      maxMarkdownBytes,
      "Draft body Markdown content"
    );
    assertTextByteLength(
      section.characterState.content,
      maxMarkdownBytes,
      "Draft character-state Markdown content"
    );
    const bodyPath = await uniqueRelativeMarkdownPathWithSuffix(
      projectDirectory,
      "stages/draft",
      section.id,
      ".body.md",
      usedPaths
    );
    usedPaths.add(portableContentPathKey(bodyPath));
    const characterStatePath = await uniqueRelativeMarkdownPathWithSuffix(
      projectDirectory,
      "stages/draft",
      section.id,
      ".state.md",
      usedPaths
    );
    usedPaths.add(portableContentPathKey(characterStatePath));
    pendingFiles.push(
      { path: bodyPath, content: section.body.content },
      { path: characterStatePath, content: section.characterState.content }
    );
    sections.push({
      id: section.id,
      title: section.title,
      wordCountRequirement: section.wordCountRequirement,
      body: {
        id: section.body.id,
        title: section.body.title,
        path: bodyPath,
        createdAt: section.body.createdAt,
        updatedAt: section.body.updatedAt
      },
      characterState: {
        id: section.characterState.id,
        title: section.characterState.title,
        path: characterStatePath,
        createdAt: section.characterState.createdAt,
        updatedAt: section.characterState.updatedAt
      },
      createdAt: section.createdAt,
      updatedAt: section.updatedAt
    });
  }
  const plotStages = createDefaultBookPlotStages({ allEnabled: true });
  for (const stage of plotStages) {
    const documentIndex = documents.findIndex(({ id }) => id === stage.id);
    if (documentIndex >= 0) {
      documents[documentIndex] = {
        ...documents[documentIndex]!,
        title: stage.title
      };
      continue;
    }
    const path = await uniqueRelativeMarkdownPath(
      projectDirectory,
      "stages",
      stage.id,
      usedPaths
    );
    usedPaths.add(portableContentPathKey(path));
    pendingFiles.push({ path, content: "" });
    documents.push({
      id: stage.id,
      title: stage.title,
      path,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt
    });
  }
  await appendMissingCharacterOverviewDocument({
    projectDirectory,
    documents,
    usedPaths,
    pendingFiles,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt
  });
  const next = FolderCurrentBookProjectManifestSchema.parse({
    ...manifest,
    schemaVersion: 4,
    characterStructure: createDefaultBookCharacterStructure(),
    plotStages,
    documents,
    draft: {
      id: draft.id,
      title: draft.title,
      sections,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt
    }
  });
  assertJsonByteLength(next, maxManifestBytes);

  // The v1 manifest remains authoritative until every new file is committed.
  // A failure or process stop before the final manifest rename can at worst
  // leave unreferenced recovery files; the original draft.md is never removed.
  for (const file of pendingFiles) {
    const target = await secureWritableProjectPath(projectDirectory, file.path);
    await atomicWriteText(target, file.content);
  }
  const currentManifestText = await readRequiredUtf8File(
    join(projectDirectory, MANIFEST_FILE),
    maxManifestBytes,
    "project manifest"
  );
  const currentLegacyDraftContent = draftManifest
    ? await readProjectMarkdown(
        projectDirectory,
        draftManifest.path,
        maxMarkdownBytes
      )
    : undefined;
  assertLegacyBookMigrationSourcesUnchanged({
    originalManifestText,
    currentManifestText,
    originalLegacyDraftContent: legacyDraft?.content,
    currentLegacyDraftContent
  });
  await atomicWriteJson(
    join(projectDirectory, MANIFEST_FILE),
    next,
    maxManifestBytes
  );
  return next;
}

export async function migrateV2BookProject(
  projectDirectory: string,
  manifest: V2BookProjectManifest,
  originalManifestText: string,
  maxManifestBytes: number
): Promise<FolderCurrentBookProjectManifest> {
  const plotStages = createDefaultBookPlotStages({ allEnabled: true });
  const documents = manifest.documents.map((document) => ({ ...document }));
  const usedPaths = new Set(
    [
      ...manifest.documents,
      ...manifest.draft.sections.flatMap((section) => [
        section.body,
        section.characterState
      ])
    ].map(({ path }) => portableContentPathKey(path))
  );
  const pendingFiles: Array<{ path: string; content: string }> = [];

  for (const stage of plotStages) {
    const documentIndex = documents.findIndex(({ id }) => id === stage.id);
    if (documentIndex >= 0) {
      documents[documentIndex] = {
        ...documents[documentIndex]!,
        title: stage.title
      };
      continue;
    }
    const path = await uniqueRelativeMarkdownPath(
      projectDirectory,
      "stages",
      stage.id,
      usedPaths
    );
    usedPaths.add(portableContentPathKey(path));
    pendingFiles.push({ path, content: "" });
    documents.push({
      id: stage.id,
      title: stage.title,
      path,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt
    });
  }

  await appendMissingCharacterOverviewDocument({
    projectDirectory,
    documents,
    usedPaths,
    pendingFiles,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt
  });

  const next = FolderCurrentBookProjectManifestSchema.parse({
    ...manifest,
    schemaVersion: 4,
    characterStructure: createDefaultBookCharacterStructure(),
    plotStages,
    documents
  });
  assertJsonByteLength(next, maxManifestBytes);

  // v2 remains authoritative until every missing stage document is durable.
  for (const file of pendingFiles) {
    const target = await secureWritableProjectPath(projectDirectory, file.path);
    await atomicWriteText(target, file.content);
  }
  const currentManifestText = await readRequiredUtf8File(
    join(projectDirectory, MANIFEST_FILE),
    maxManifestBytes,
    "project manifest"
  );
  if (currentManifestText !== originalManifestText) {
    throw new Error("书籍在剧情结构迁移期间被外部修改，已中止迁移。");
  }
  await atomicWriteJson(
    join(projectDirectory, MANIFEST_FILE),
    next,
    maxManifestBytes
  );
  return next;
}

export async function migrateV3BookProject(
  projectDirectory: string,
  manifest: V3BookProjectManifest,
  originalManifestText: string,
  maxManifestBytes: number
): Promise<FolderCurrentBookProjectManifest> {
  const documents = manifest.documents.map((document) => ({ ...document }));
  const usedPaths = new Set(
    manifestContentItems(manifest).map(({ path }) =>
      portableContentPathKey(path)
    )
  );
  const pendingFiles: Array<{ path: string; content: string }> = [];
  await appendMissingCharacterOverviewDocument({
    projectDirectory,
    documents,
    usedPaths,
    pendingFiles,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt
  });
  const next = FolderCurrentBookProjectManifestSchema.parse({
    ...manifest,
    schemaVersion: 4,
    characterStructure: createDefaultBookCharacterStructure(),
    documents
  });
  assertJsonByteLength(next, maxManifestBytes);
  for (const file of pendingFiles) {
    const target = await secureWritableProjectPath(projectDirectory, file.path);
    await atomicWriteText(target, file.content);
  }
  const currentManifestText = await readRequiredUtf8File(
    join(projectDirectory, MANIFEST_FILE),
    maxManifestBytes,
    "project manifest"
  );
  if (currentManifestText !== originalManifestText) {
    throw new Error("书籍在人物结构迁移期间被外部修改，已中止迁移。");
  }
  await atomicWriteJson(
    join(projectDirectory, MANIFEST_FILE),
    next,
    maxManifestBytes
  );
  return next;
}

export async function appendMissingCharacterOverviewDocument(input: {
  projectDirectory: string;
  documents: BookProjectDocumentManifest[];
  usedPaths: Set<string>;
  pendingFiles: Array<{ path: string; content: string }>;
  createdAt: string;
  updatedAt: string;
}): Promise<void> {
  if (
    input.documents.some(({ id }) => id === BOOK_CHARACTER_OVERVIEW_DOCUMENT_ID)
  ) {
    return;
  }
  const path = await uniqueRelativeMarkdownPath(
    input.projectDirectory,
    "stages",
    BOOK_CHARACTER_OVERVIEW_DOCUMENT_ID,
    input.usedPaths
  );
  input.usedPaths.add(portableContentPathKey(path));
  input.pendingFiles.push({ path, content: "" });
  input.documents.push({
    id: BOOK_CHARACTER_OVERVIEW_DOCUMENT_ID,
    title: "人物设计",
    path,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt
  });
}

export function assertLegacyBookMigrationSourcesUnchanged(input: {
  originalManifestText: string;
  currentManifestText: string;
  originalLegacyDraftContent: string | undefined;
  currentLegacyDraftContent: string | undefined;
}): void {
  if (
    input.originalManifestText !== input.currentManifestText ||
    input.originalLegacyDraftContent !== input.currentLegacyDraftContent
  ) {
    throw new Error("旧版书籍在正文迁移期间被外部修改，已中止迁移。");
  }
}
