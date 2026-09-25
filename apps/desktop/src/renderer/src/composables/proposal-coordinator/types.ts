import type { ComputedRef, Ref, ShallowRef } from "vue";
import type {
  Book,
  CatalogIndexSnapshot,
  CatalogLibrary,
  CatalogLibraryEntry,
  DeepWriteApi,
  LongBookSummary,
  SystemEventEnvelope
} from "@deepwrite/contracts";
import type { CatalogWorkspaceProjection } from "../../data/catalogWorkspace";
import type { AgentEditProposal } from "../../types/conversation";
import type {
  EditorDraftState,
  WorkspaceDocument
} from "../../types/workspace";
import type { AgentEditProposalCommitSnapshot } from "../../utils/agentEditProposalRevisionLane";
import type { WorkspaceDocumentBaseline } from "../../utils/catalogSaveReconciliation";
import type { AgentConversationController } from "../useAgentConversation";
import type { LongWorkspaceProposalEvent } from "../useLongWorkspaceProposals";

export type WorkspaceEditorMutationEvent = Extract<
  SystemEventEnvelope,
  { type: "workspace.editor_mutation" }
>;
export type LibraryEditorMutationEvent = Extract<
  SystemEventEnvelope,
  { type: "library.editor_mutation" }
>;
export type LongWorldbuildingFileMutationEvent = Extract<
  SystemEventEnvelope,
  { type: "long.worldbuilding_file_proposal" }
>;
export type LongCharacterFileMutationEvent = Extract<
  SystemEventEnvelope,
  { type: "long.character_file_proposal" }
>;
export type LongPlotDesignMutationEvent = Extract<
  SystemEventEnvelope,
  { type: "long.mutation_proposal" }
>;
export type LongDraftMutationEvent = Extract<
  SystemEventEnvelope,
  { type: "long.chapter_write_proposal" }
>;

export interface QueuedAgentEdit {
  conversation: AgentConversationController;
  sessionId: string;
  runId: string;
  proposalId: string;
  workspaceId: string;
  automatic: boolean;
  expectedProposedRevision: string;
  decisionToken: string;
  snapshot: AgentEditProposalCommitSnapshot<AgentEditProposal>;
}

export interface ProposalCoordinatorNotifications {
  error(message: string): void;
  info(message: string): void;
  success(message: string): void;
  warning(message: string): void;
}

export interface AgentEditReviewRequest {
  runId: string;
  proposalId: string;
  decision: "accept" | "reject";
}

export interface ProposalCoordinatorContext {
  api(): DeepWriteApi | undefined;
  notifications: ProposalCoordinatorNotifications;
  catalog: {
    snapshot: ShallowRef<CatalogIndexSnapshot | null>;
    projection: ShallowRef<CatalogWorkspaceProjection | null>;
    catalogBook(bookId: string): Book | undefined;
    findCatalogLibrary(
      domain: "material" | "skill",
      libraryId: string
    ): CatalogLibrary | undefined;
    loadSnapshot(): Promise<unknown>;
    applyAcceptedDocumentLocally(
      payload: { id: string; title: string; content: string },
      savedProjectRevision: number | undefined,
      draftAtAccept: EditorDraftState | undefined
    ): void;
    applyCreatedLibraryEntry(
      domain: "material" | "skill",
      libraryId: string,
      created: CatalogLibraryEntry,
      projectRevision: number | undefined
    ): Promise<void>;
    applySavedLibraryEntry(
      domain: "material" | "skill",
      libraryId: string,
      saved: CatalogLibraryEntry,
      projectRevision: number | undefined
    ): Promise<number | undefined>;
    applyUpdatedLibrary(
      domain: "material" | "skill",
      updated: CatalogLibrary
    ): Promise<void>;
    isConflict(error: unknown): boolean;
    refreshBookAfterSave(
      workspaceId: string,
      expectedDocuments: ReadonlyMap<string, WorkspaceDocumentBaseline>,
      minimumProjectRevision?: number
    ): Promise<boolean>;
  };
  editor: {
    documents: ShallowRef<WorkspaceDocument[]>;
    drafts: Ref<Record<string, EditorDraftState>>;
    liveDocuments: ComputedRef<WorkspaceDocument[]>;
    selectedDraftFileKinds: Ref<Record<string, "body" | "character-state">>;
    selectedExpertSectionIds: Ref<Record<string, string>>;
    acceptingWorkspaceIds: Ref<Set<string>>;
    savingDocumentIds: Ref<Set<string>>;
    rememberWorkspaceMutationEvent(eventId: string): boolean;
    setDocumentAccepting(documentId: string, accepting: boolean): void;
    setWorkspaceAccepting(workspaceId: string, accepting: boolean): void;
  };
  conversations: {
    active: ComputedRef<AgentConversationController>;
    activeLong: ComputedRef<AgentConversationController | null>;
    byKey: Map<string, AgentConversationController>;
    all(): AgentConversationController[];
    remove(
      key: string,
      options?: { dispose?: boolean; clearPersistence?: boolean }
    ): AgentConversationController | undefined;
    legacyDraftSectionKeys(workspaceId: string, sectionId: string): string[];
    forLongProposal(
      event: LongWorkspaceProposalEvent | LongDraftMutationEvent
    ): AgentConversationController | undefined;
  };
  longWorkspace: {
    activeBookId: Ref<string | null>;
    books: ShallowRef<readonly LongBookSummary[]>;
    refreshWorkspaceAfterProposal(bookId: string): Promise<boolean>;
    saveActiveEditorChanges(): Promise<boolean>;
  };
  navigation: {
    selectedResourceId: Ref<string>;
    activeCreationResourceId: Ref<string>;
    rightCollapsed: Ref<boolean>;
  };
}
