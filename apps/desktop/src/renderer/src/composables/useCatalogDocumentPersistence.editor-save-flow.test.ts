import {
  createShortWorkspaceContentRevision,
  type Book,
  type DeepWriteApi,
  type SaveDocumentInput,
  type SaveDocumentResult
} from "@deepwrite/contracts";
import { ref, shallowRef } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorDraftState, WorkspaceDocument } from "../types/workspace";
import type {
  CatalogDocumentLoadResult,
  CatalogDocumentsLoadResult
} from "./useCatalogDocumentLoader";
import { useCatalogDocumentPersistence } from "./useCatalogDocumentPersistence";
import { useEditorAutoSaveCoordinator } from "./useEditorAutoSaveCoordinator";

const NOW = "2026-08-14T00:00:00.000Z";
const BOOK_ID = "book-1";
const DOCUMENT_ID = "body-1";
const CATALOG_DOCUMENT_ID = "draft-section:section-1:body";
const DISK_CONTENT = "磁盘初始正文";

function workspaceDocument(
  content = DISK_CONTENT,
  patch: Partial<WorkspaceDocument> = {}
): WorkspaceDocument {
  return {
    id: DOCUMENT_ID,
    domain: "creation",
    title: "第一节",
    eyebrow: "短篇 · 小节正文",
    path: ["测试作品", "正文", "第一节", "正文"],
    content,
    workspaceId: BOOK_ID,
    workspaceType: "short",
    workspaceTitle: "测试作品",
    stageId: "draft",
    draftFileKind: "body",
    catalogDocumentId: CATALOG_DOCUMENT_ID,
    catalogProjectRevision: 1,
    catalogContentLoaded: true,
    ...patch
  };
}

function savedDocument(
  input: SaveDocumentInput,
  projectRevision: number
): SaveDocumentResult {
  return {
    id: CATALOG_DOCUMENT_ID,
    title: input.title ?? "第一节",
    content: input.content,
    createdAt: NOW,
    updatedAt: NOW,
    projectRevision
  };
}

function oneResult(document: WorkspaceDocument): CatalogDocumentLoadResult {
  return {
    ok: true,
    requestedIds: [document.id],
    loadedIds: [document.id],
    alreadyLoadedIds: [],
    skippedIds: [],
    retriedIds: [],
    failures: [],
    published: true,
    documents: [document],
    document
  };
}

function manyResult(
  documents: readonly WorkspaceDocument[]
): CatalogDocumentsLoadResult {
  return {
    ok: true,
    requestedIds: documents.map(({ id }) => id),
    loadedIds: documents.map(({ id }) => id),
    alreadyLoadedIds: [],
    skippedIds: [],
    retriedIds: [],
    failures: [],
    published: documents.length > 0,
    documents
  };
}

/**
 * Reproduces the WorkspaceShell wiring for the editor save lane: the
 * persistence module owns durable catalog writes and feeds the auto-save
 * coordinator, while the coordinator owns debouncing and the retry lane.
 */
function createHarness(
  options: {
    saveDocument?: DeepWriteApi["catalog"]["saveDocument"];
    debounceMs?: number;
    retryMs?: number;
  } = {}
) {
  const documents = shallowRef<WorkspaceDocument[]>([workspaceDocument()]);
  const drafts = shallowRef<Record<string, EditorDraftState>>({});
  const savingDocumentIds = ref<Set<string>>(new Set());
  let timestamp = 0;
  let projectRevision = 1;
  const notifications = {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  };
  const saveDocument = vi.fn(
    options.saveDocument ??
      (async (input: SaveDocumentInput) =>
        savedDocument(input, (input.baseProjectRevision ?? 1) + 1))
  );
  const loader = {
    preserveAuthoritativeBodyForNextProjection: vi.fn(),
    ensureOne: vi.fn(async (target: string | WorkspaceDocument) =>
      oneResult(
        documents.value.find(
          (document) =>
            document.id === (typeof target === "string" ? target : target.id)
        )!
      )
    ),
    ensureLoaded: vi.fn(
      async (
        targets: readonly (string | WorkspaceDocument)[] = documents.value
      ) =>
        manyResult(
          targets.map((target) =>
            typeof target === "string"
              ? documents.value.find((document) => document.id === target)!
              : target
          )
        )
    ),
    invalidate: vi.fn(() => false)
  };

  // Mirrors the WorkspaceShell declaration order: the persistence module takes
  // the coordinator's schedule function through a closure, so the two call
  // sites stay mutually recursive exactly like production.
  let scheduleEditorAutoSave: (documentId: string) => void = () => undefined;
  const persistence = useCatalogDocumentPersistence({
    api: () => ({ saveDocument }) as unknown as DeepWriteApi["catalog"],
    documents,
    drafts,
    acceptingWorkspaceIds: ref(new Set<string>()),
    loader,
    catalog: {
      refreshIndex: vi.fn(async () => {
        projectRevision += 1;
        return true;
      }),
      findBook: (bookId) =>
        ({ id: bookId, projectRevision }) as unknown as Book,
      findLibrary: () => undefined
    },
    nextRecoveryTimestamp: () => `${NOW}:${++timestamp}`,
    scheduleAutoSave: (documentId) => scheduleEditorAutoSave(documentId),
    notifications
  });
  const autosave = useEditorAutoSaveCoordinator({
    enabled: ref(true),
    drafts,
    documents,
    timer: {
      setTimeout: (callback, delay) =>
        globalThis.setTimeout(callback, delay) as unknown as number,
      clearTimeout: (timerId) =>
        globalThis.clearTimeout(
          timerId as unknown as ReturnType<typeof globalThis.setTimeout>
        )
    },
    persist: persistence.persistEditorDocumentWithOutcome,
    isConflicted: () => persistence.saveConflict.value !== null,
    isWriteBlocked: () => savingDocumentIds.value.size > 0,
    onIdle: async () => {
      await persistence.retryPendingBookReconciliations();
    },
    onUnexpectedError: (error) =>
      notifications.error(
        error instanceof Error ? error.message : "保存编辑器草稿失败。"
      ),
    debounceMs: options.debounceMs ?? 20,
    retryMs: options.retryMs ?? 10
  });
  scheduleEditorAutoSave = (documentId) => autosave.schedule(documentId);

  /** Mirrors WorkspaceShell.stageEditorDraft for one keystroke. */
  function stageEdit(content: string, title = "第一节"): void {
    const persisted = documents.value.find(
      (document) => document.id === DOCUMENT_ID
    )!;
    const existingDraft = drafts.value[DOCUMENT_ID];
    drafts.value = {
      ...drafts.value,
      [DOCUMENT_ID]: {
        title,
        content,
        dirty: true,
        recoveryUpdatedAt: `${NOW}:edit`,
        ...(existingDraft?.baseRevision
          ? { baseRevision: existingDraft.baseRevision }
          : {
              baseRevision: createShortWorkspaceContentRevision(
                persisted.content
              )
            }),
        ...(existingDraft?.baseProjectRevision !== undefined
          ? { baseProjectRevision: existingDraft.baseProjectRevision }
          : persisted.catalogProjectRevision === undefined
            ? {}
            : { baseProjectRevision: persisted.catalogProjectRevision })
      }
    };
  }

  return {
    autosave,
    documents,
    drafts,
    notifications,
    persistence,
    saveDocument,
    stageEdit,
    /** Mirrors WorkspaceShell.handleLiveDocumentChange for one keystroke. */
    editAndSchedule(content: string, title = "第一节"): void {
      stageEdit(content, title);
      autosave.schedule(DOCUMENT_ID);
    }
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("editor edit to saved document", () => {
  it("issues the catalog save command with the edited text and the draft revision base", async () => {
    vi.useFakeTimers();
    const harness = createHarness();

    harness.editAndSchedule("用户改写后的正文");
    expect(harness.saveDocument).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20);
    await harness.autosave.drain();

    expect(harness.saveDocument).toHaveBeenCalledOnce();
    expect(harness.saveDocument).toHaveBeenCalledWith({
      bookId: BOOK_ID,
      documentId: CATALOG_DOCUMENT_ID,
      title: "第一节",
      content: "用户改写后的正文",
      baseRevision: createShortWorkspaceContentRevision(DISK_CONTENT),
      baseProjectRevision: 1
    });
    expect(harness.drafts.value[DOCUMENT_ID]).toBeUndefined();
    expect(harness.documents.value[0]?.content).toBe("用户改写后的正文");
    // The debounced lane writes silently; only an explicit save announces.
    expect(harness.notifications.success).not.toHaveBeenCalled();
    expect(harness.notifications.error).not.toHaveBeenCalled();
    expect(harness.persistence.saveConflict.value).toBeNull();

    await harness.autosave.dispose();
  });

  it("announces a manual save and clears the manual-saving flag once the write lands", async () => {
    let resolveSave!: (value: SaveDocumentResult) => void;
    const pendingSave = new Promise<SaveDocumentResult>((resolve) => {
      resolveSave = resolve;
    });
    const harness = createHarness({ saveDocument: () => pendingSave });

    harness.stageEdit("手动保存的正文");
    harness.autosave.apply({
      id: DOCUMENT_ID,
      title: "第一节",
      content: "手动保存的正文"
    });

    await vi.waitFor(() => expect(harness.saveDocument).toHaveBeenCalledOnce());
    expect(
      harness.autosave.manualSavingDocumentIds.value.has(DOCUMENT_ID)
    ).toBe(true);
    expect(harness.saveDocument).toHaveBeenCalledWith({
      bookId: BOOK_ID,
      documentId: CATALOG_DOCUMENT_ID,
      title: "第一节",
      content: "手动保存的正文",
      baseRevision: createShortWorkspaceContentRevision(DISK_CONTENT),
      baseProjectRevision: 1
    });

    resolveSave(savedDocument(harness.saveDocument.mock.calls[0]![0], 2));
    await harness.autosave.drain();

    expect(harness.autosave.manualSavingDocumentIds.value.size).toBe(0);
    expect(harness.notifications.success).toHaveBeenCalledWith(
      "文稿已保存到本机"
    );
    expect(harness.drafts.value[DOCUMENT_ID]).toBeUndefined();

    await harness.autosave.dispose();
  });

  it("persists only the latest keystroke when the user keeps typing inside the debounce window", async () => {
    vi.useFakeTimers();
    const harness = createHarness();

    harness.editAndSchedule("第一次改写");
    await vi.advanceTimersByTimeAsync(10);
    harness.editAndSchedule("第二次改写，仍在输入");
    await vi.advanceTimersByTimeAsync(19);
    expect(harness.saveDocument).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await harness.autosave.drain();

    expect(harness.saveDocument).toHaveBeenCalledOnce();
    expect(harness.saveDocument.mock.calls[0]![0]).toMatchObject({
      content: "第二次改写，仍在输入"
    });
    expect(harness.drafts.value[DOCUMENT_ID]).toBeUndefined();

    await harness.autosave.dispose();
  });
});

describe("editor save failure keeps the draft", () => {
  it("keeps the edited draft dirty, reports the failure, and leaves disk untouched when the write is rejected", async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      saveDocument: async () => {
        throw new Error("本机文件写入失败：目标磁盘不可写");
      }
    });

    harness.editAndSchedule("后端拒绝的改写正文");
    await vi.advanceTimersByTimeAsync(20);
    await harness.autosave.drain();

    expect(harness.saveDocument).toHaveBeenCalledOnce();
    expect(harness.saveDocument.mock.calls[0]![0]).toMatchObject({
      content: "后端拒绝的改写正文"
    });
    expect(harness.drafts.value[DOCUMENT_ID]).toMatchObject({
      title: "第一节",
      content: "后端拒绝的改写正文",
      dirty: true
    });
    expect(harness.documents.value[0]?.content).toBe(DISK_CONTENT);
    expect(harness.notifications.error).toHaveBeenCalledWith(
      "本机文件写入失败：目标磁盘不可写"
    );
    expect(harness.notifications.success).not.toHaveBeenCalled();
    expect(harness.persistence.saveConflict.value).toBeNull();

    await harness.autosave.dispose();
  });

  it("recovers the retained draft on the retry lane instead of dropping the user's text", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const harness = createHarness({
      saveDocument: async (input) => {
        attempt += 1;
        if (attempt === 1) throw new Error("瞬时写入失败");
        return savedDocument(input, (input.baseProjectRevision ?? 1) + 1);
      }
    });

    harness.editAndSchedule("失败后仍需落盘的正文");
    await vi.advanceTimersByTimeAsync(20);
    await harness.autosave.drain();

    expect(harness.saveDocument).toHaveBeenCalledOnce();
    expect(harness.drafts.value[DOCUMENT_ID]).toMatchObject({
      content: "失败后仍需落盘的正文",
      dirty: true
    });

    await vi.advanceTimersByTimeAsync(10);
    await harness.autosave.drain();

    expect(harness.saveDocument).toHaveBeenCalledTimes(2);
    expect(harness.saveDocument.mock.calls[1]![0]).toMatchObject({
      content: "失败后仍需落盘的正文"
    });
    expect(harness.drafts.value[DOCUMENT_ID]).toBeUndefined();
    expect(harness.documents.value[0]?.content).toBe("失败后仍需落盘的正文");
    expect(harness.notifications.error).toHaveBeenCalledWith("瞬时写入失败");

    await harness.autosave.dispose();
  });
});
