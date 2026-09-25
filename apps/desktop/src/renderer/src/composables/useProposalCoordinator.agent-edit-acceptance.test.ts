import { computed, ref, shallowRef } from "vue";
import { describe, expect, it, vi } from "vitest";
import type {
  Book,
  CatalogIndexSnapshot,
  SaveDocumentInput,
  SaveDocumentResult
} from "@deepwrite/contracts";
import type { AgentEditProposal } from "../types/conversation";
import type { WorkspaceDocument } from "../types/workspace";
import type { AgentConversationController } from "./useAgentConversation";
import {
  useProposalCoordinator,
  type ProposalCoordinatorContext
} from "./useProposalCoordinator";

const NOW = "2026-08-30T00:00:00.000Z";
const SESSION_ID = "session-accept-flow";
const RUN_ID = "run-accept-flow";
const BOOK_ID = "book-accept-flow";
const DOCUMENT_ID = "body-accept-flow";
const CATALOG_DOCUMENT_ID = "draft-section:section-1:body";
const DISK_CONTENT = "磁盘上的原正文";
const ACCEPTED_TEXT = "用户接受后的智能体重写正文";
const PROPOSAL_ID = "proposal-accept-flow";

function shortBook(): Book {
  return {
    id: BOOK_ID,
    title: "短篇审阅落盘",
    bookType: "short",
    genre: "其他",
    status: "editing",
    projectRevision: 2,
    documents: [],
    createdAt: NOW,
    updatedAt: NOW
  } as unknown as Book;
}

function workspaceDocument(
  patch: Partial<WorkspaceDocument> = {}
): WorkspaceDocument {
  return {
    id: DOCUMENT_ID,
    domain: "creation",
    title: "第一节",
    eyebrow: "短篇 · 小节正文",
    path: ["测试作品", "正文", "第一节", "正文"],
    content: DISK_CONTENT,
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

function pendingProposal(
  approvalMode: NonNullable<AgentEditProposal["approvalMode"]>
): AgentEditProposal {
  return {
    id: PROPOSAL_ID,
    laneId: PROPOSAL_ID,
    generation: 1,
    approvalMode,
    sourceBaseRevision: "v1:1:aaaaaaa",
    runId: RUN_ID,
    workspaceId: BOOK_ID,
    stageId: "draft",
    documentId: DOCUMENT_ID,
    title: "第一节",
    summary: "重写第一节",
    status: "pending",
    baseRevision: "v1:1:aaaaaaa",
    proposedRevision: "v1:2:bbbbbbb",
    proposedText: ACCEPTED_TEXT,
    toolCallIds: ["tool-accept-flow"],
    additions: 2,
    deletions: 2,
    hunks: [],
    createdAt: NOW,
    updatedAt: NOW
  };
}

function saveResult(input: SaveDocumentInput): SaveDocumentResult {
  return {
    id: CATALOG_DOCUMENT_ID,
    title: input.title ?? "第一节",
    content: input.content,
    createdAt: NOW,
    updatedAt: NOW,
    projectRevision: 3
  };
}

function createFixture(
  approvalMode: NonNullable<AgentEditProposal["approvalMode"]>
) {
  let proposal = pendingProposal(approvalMode);
  const statusMessages: (string | undefined)[] = [];
  const syncMessages = () => {
    messages.value = [{ editProposals: [proposal] }];
  };
  const messages = ref<{ editProposals: AgentEditProposal[] }[]>([]);
  const saveDocument = vi.fn(async (input: SaveDocumentInput) =>
    saveResult(input)
  );
  const conversation = {
    sessionId: ref(SESSION_ID),
    isBusy: ref(false),
    messages,
    acceptsRunEvent: () => true,
    approvalModeForRun: () => proposal.approvalMode ?? "request-approval",
    getEditProposal: (runId: string, proposalId: string) =>
      proposal.runId === runId && proposal.id === proposalId
        ? proposal
        : undefined,
    listEditProposals: (runId: string) =>
      proposal.runId === runId ? [proposal] : [],
    updateEditProposal: (
      runId: string,
      proposalId: string,
      patch: Partial<AgentEditProposal>
    ) => {
      if (proposal.runId !== runId || proposal.id !== proposalId) {
        return undefined;
      }
      statusMessages.push(patch.statusMessage);
      proposal = { ...proposal, ...patch };
      syncMessages();
      return proposal;
    }
  } as unknown as AgentConversationController;
  syncMessages();

  const documents = shallowRef<WorkspaceDocument[]>([workspaceDocument()]);
  const acceptingWorkspaceIds = ref(new Set<string>());
  const notifications = {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  };
  const loadSnapshot = vi.fn(async () => undefined);
  const context = {
    api: () => ({ catalog: { saveDocument } }),
    notifications,
    catalog: {
      snapshot: shallowRef({} as CatalogIndexSnapshot),
      projection: shallowRef(null),
      catalogBook: (bookId: string) =>
        bookId === BOOK_ID ? shortBook() : undefined,
      findCatalogLibrary: () => undefined,
      loadSnapshot,
      applyAcceptedDocumentLocally: (
        payload: { id: string; title: string; content: string },
        savedProjectRevision: number | undefined
      ) => {
        documents.value = documents.value.map((document) =>
          document.id === payload.id
            ? {
                ...document,
                title: payload.title,
                content: payload.content,
                ...(savedProjectRevision === undefined
                  ? {}
                  : { catalogProjectRevision: savedProjectRevision })
              }
            : document
        );
      },
      applyCreatedLibraryEntry: vi.fn(async () => undefined),
      applySavedLibraryEntry: vi.fn(async () => undefined),
      applyUpdatedLibrary: vi.fn(async () => undefined),
      isConflict: () => false,
      refreshBookAfterSave: vi.fn(async () => true)
    },
    editor: {
      documents,
      drafts: ref({}),
      liveDocuments: computed(() => documents.value),
      selectedDraftFileKinds: ref({}),
      selectedExpertSectionIds: ref({}),
      acceptingWorkspaceIds,
      savingDocumentIds: ref(new Set<string>()),
      rememberWorkspaceMutationEvent: () => true,
      setDocumentAccepting: vi.fn(),
      setWorkspaceAccepting: (workspaceId: string, accepting: boolean) => {
        const next = new Set(acceptingWorkspaceIds.value);
        if (accepting) next.add(workspaceId);
        else next.delete(workspaceId);
        acceptingWorkspaceIds.value = next;
      }
    },
    conversations: {
      active: computed(() => conversation),
      activeLong: computed(() => null),
      byKey: new Map(),
      all: () => [conversation],
      legacyDraftSectionKeys: () => [],
      forLongProposal: () => undefined
    },
    longWorkspace: {
      activeBookId: ref(null),
      books: shallowRef([]),
      refreshWorkspaceAfterProposal: vi.fn(async () => true),
      saveActiveEditorChanges: vi.fn(async () => true)
    },
    navigation: {
      selectedResourceId: ref(""),
      activeCreationResourceId: ref(""),
      rightCollapsed: ref(false)
    }
  } as unknown as ProposalCoordinatorContext;

  return {
    acceptingWorkspaceIds,
    coordinator: useProposalCoordinator(context),
    documents,
    notifications,
    proposal: () => proposal,
    saveDocument,
    statusMessages
  };
}

describe("agent proposal review to core commit", () => {
  it("accepting a pending proposal writes the accepted text through the catalog save command", async () => {
    const fixture = createFixture("request-approval");

    await fixture.coordinator.reviewAgentEdit({
      runId: RUN_ID,
      proposalId: PROPOSAL_ID,
      decision: "accept"
    });
    await fixture.coordinator.drain();

    expect(fixture.saveDocument).toHaveBeenCalledOnce();
    expect(fixture.saveDocument).toHaveBeenCalledWith({
      bookId: BOOK_ID,
      documentId: CATALOG_DOCUMENT_ID,
      content: ACCEPTED_TEXT,
      force: true
    });
    expect(fixture.documents.value[0]?.content).toBe(ACCEPTED_TEXT);
    expect(fixture.proposal()).toMatchObject({
      status: "accepted",
      proposedText: undefined
    });
    expect(fixture.notifications.success).toHaveBeenCalledWith(
      "已接受并保存智能体修改"
    );
    expect(fixture.notifications.error).not.toHaveBeenCalled();
    // The approval went through the per-workspace commit queue, not straight
    // to the direct apply path.
    expect(fixture.statusMessages).toContain(
      "已批准，正在等待本作品的保存队列…"
    );
    expect(fixture.acceptingWorkspaceIds.value.size).toBe(0);
    expect(fixture.coordinator.hasQueuedAgentEdits()).toBe(false);

    await fixture.coordinator.dispose();
  });

  it("rejecting a pending proposal issues no save command and keeps the persisted text", async () => {
    const fixture = createFixture("request-approval");

    await fixture.coordinator.reviewAgentEdit({
      runId: RUN_ID,
      proposalId: PROPOSAL_ID,
      decision: "reject"
    });
    await fixture.coordinator.drain();

    expect(fixture.saveDocument).not.toHaveBeenCalled();
    expect(fixture.documents.value[0]?.content).toBe(DISK_CONTENT);
    expect(fixture.proposal()).toMatchObject({
      status: "rejected",
      proposedText: undefined
    });
    expect(fixture.notifications.info).toHaveBeenCalledWith(
      "已拒绝智能体修改，原文未改变"
    );
    expect(fixture.notifications.success).not.toHaveBeenCalled();
    expect(fixture.coordinator.hasQueuedAgentEdits()).toBe(false);

    await fixture.coordinator.dispose();
  });

  it("drains an auto-approved proposal through the commit queue without a user decision", async () => {
    const fixture = createFixture("auto-approve");

    fixture.coordinator.resumeRecoveredAutomaticAgentEdits();
    await fixture.coordinator.drain();

    expect(fixture.saveDocument).toHaveBeenCalledOnce();
    expect(fixture.saveDocument.mock.calls[0]![0]).toMatchObject({
      bookId: BOOK_ID,
      documentId: CATALOG_DOCUMENT_ID,
      content: ACCEPTED_TEXT,
      force: true
    });
    expect(fixture.proposal().status).toBe("accepted");
    expect(fixture.statusMessages).toContain("已进入自动保存队列…");
    expect(fixture.coordinator.hasQueuedAgentEdits()).toBe(false);
    expect(fixture.documents.value[0]?.content).toBe(ACCEPTED_TEXT);

    await fixture.coordinator.dispose();
  });

  it("does not resurrect a rejected auto-approved proposal on the next recovery scan", async () => {
    const fixture = createFixture("auto-approve");

    await fixture.coordinator.reviewAgentEdit({
      runId: RUN_ID,
      proposalId: PROPOSAL_ID,
      decision: "reject"
    });
    await fixture.coordinator.drain();
    expect(fixture.saveDocument).not.toHaveBeenCalled();

    fixture.coordinator.resumeRecoveredAutomaticAgentEdits();
    await fixture.coordinator.drain();

    expect(fixture.saveDocument).not.toHaveBeenCalled();
    expect(fixture.proposal().status).toBe("rejected");
    expect(fixture.documents.value[0]?.content).toBe(DISK_CONTENT);

    await fixture.coordinator.dispose();
  });
});
