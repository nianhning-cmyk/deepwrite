import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

/**
 * Source line-budget check.
 *
 * Two tiers:
 *
 * 1. `FROZEN_LEGACY_BUDGETS` lists files that already exceeded the budget. Each is
 *    frozen at the size it had when it was listed. A frozen file may shrink freely;
 *    growing one requires editing its number in the same change, which makes the
 *    exemption reviewable instead of silent. AGENTS.md asks that a change touching an
 *    oversized file splits the responsibility out rather than adding to it — a frozen
 *    number is what makes "no new patches on oversized files" enforceable.
 * 2. Every other file follows the AGENTS.md budgets: 400 lines for `.ts`/`.mjs`,
 *    500 for `.vue`, 600 for tests and test-support modules. `.css` files use the
 *    `.vue` budget, since AGENTS.md does not budget stylesheets separately.
 *
 * The list only ever shrinks. Removing a stale entry is expected when its file is
 * split, renamed, or deleted; leaving it behind fails the check.
 */

const repoRoot = resolve(import.meta.dirname, "..");

const FROZEN_LEGACY_BUDGETS = {
  "apps/desktop/src/main/deepwrite-official-model-config.ts": 441,
  "apps/desktop/src/main/index.ts": 2750,
  "apps/desktop/src/main/marketplace-client.test.ts": 601,
  "apps/desktop/src/main/model-usage-store.ts": 833,
  "apps/desktop/src/main/supervisor.ts": 827,
  "apps/desktop/src/preload/catalog-api.ts": 550,
  "apps/desktop/src/preload/index.ts": 1184,
  "apps/desktop/src/renderer/src/components/AgentTeamSettingsPanel.css": 502,
  "apps/desktop/src/renderer/src/components/AgentTeamSettingsPanel.vue": 513,
  "apps/desktop/src/renderer/src/components/LearningImitationDialog.vue": 2338,
  "apps/desktop/src/renderer/src/components/LibraryAgentSettingsPanel.vue": 830,
  "apps/desktop/src/renderer/src/components/LoadSubagentFromSkillDialog.vue": 643,
  "apps/desktop/src/renderer/src/components/LongAgentSettingsPanel.vue": 605,
  "apps/desktop/src/renderer/src/components/LongContinuityProjectionPanel.vue": 513,
  "apps/desktop/src/renderer/src/components/LongForeshadowingWorkspace.vue": 2683,
  "apps/desktop/src/renderer/src/components/LongProposalReview.vue": 942,
  "apps/desktop/src/renderer/src/components/LongStructureManager.vue": 1506,
  "apps/desktop/src/renderer/src/components/LongWorkspaceEditor.vue": 3614,
  "apps/desktop/src/renderer/src/components/model-usage-panel.css": 558,
  "apps/desktop/src/renderer/src/components/OfficialModelsPanel.vue": 738,
  "apps/desktop/src/renderer/src/components/plot-structure-dialog.css": 565,
  "apps/desktop/src/renderer/src/components/RightEditorPane.vue": 1109,
  "apps/desktop/src/renderer/src/components/SkillMarketplacePage.vue": 2561,
  "apps/desktop/src/renderer/src/components/TreeNodeItem.vue": 1114,
  "apps/desktop/src/renderer/src/components/WorkspaceDialogLayer.types.ts": 512,
  "apps/desktop/src/renderer/src/composables/long-structure-transactions/create.ts": 794,
  "apps/desktop/src/renderer/src/composables/long-structure-transactions/tree.ts": 416,
  "apps/desktop/src/renderer/src/composables/useAgentConversation.failures-retries-and-timeouts.test.ts": 761,
  "apps/desktop/src/renderer/src/composables/useAgentConversation.proposal-persistence.test.ts": 1097,
  "apps/desktop/src/renderer/src/composables/useAgentConversation.snapshot-persistence.test.ts": 685,
  "apps/desktop/src/renderer/src/composables/useAgentConversation.streaming-and-tools.test.ts": 1183,
  "apps/desktop/src/renderer/src/composables/useAgentConversation.test-support.ts": 844,
  "apps/desktop/src/renderer/src/composables/useAgentConversation.workspace-context.test.ts": 774,
  "apps/desktop/src/renderer/src/composables/useApprovalNavigationCoordinator.ts": 517,
  "apps/desktop/src/renderer/src/composables/useCatalogDocumentLoader.test.ts": 649,
  "apps/desktop/src/renderer/src/composables/useCatalogDocumentLoader.ts": 564,
  "apps/desktop/src/renderer/src/composables/useCatalogDocumentPersistence.test.ts": 1049,
  "apps/desktop/src/renderer/src/composables/useCatalogDocumentPersistence.ts": 1172,
  "apps/desktop/src/renderer/src/composables/useCatalogLibraryTransactionsCoordinator.test.ts": 658,
  "apps/desktop/src/renderer/src/composables/useCatalogLibraryTransactionsCoordinator.ts": 1037,
  "apps/desktop/src/renderer/src/composables/useCatalogWorkspaceProjectionCoordinator.ts": 500,
  "apps/desktop/src/renderer/src/composables/useLazyLongStructureTransactionsCoordinator.ts": 584,
  "apps/desktop/src/renderer/src/composables/useLearningImitation.ts": 802,
  "apps/desktop/src/renderer/src/composables/useLongBookLifecycleCoordinator.test.ts": 688,
  "apps/desktop/src/renderer/src/composables/useLongBookLifecycleCoordinator.ts": 1087,
  "apps/desktop/src/renderer/src/composables/useLongConversationCoordinator.test.ts": 747,
  "apps/desktop/src/renderer/src/composables/useLongConversationCoordinator.ts": 821,
  "apps/desktop/src/renderer/src/composables/useLongEditorDocumentSession.ts": 877,
  "apps/desktop/src/renderer/src/composables/useLongEditorStructureSelection.ts": 1181,
  "apps/desktop/src/renderer/src/composables/useLongWorkspacePresentationCoordinator.test.ts": 607,
  "apps/desktop/src/renderer/src/composables/useLongWorkspaceProposals.test-support.ts": 604,
  "apps/desktop/src/renderer/src/composables/useLongWorkspaceProposals.ts": 1232,
  "apps/desktop/src/renderer/src/composables/useProposalCoordinator.ts": 4276,
  "apps/desktop/src/renderer/src/composables/useShortBookLifecycleCoordinator.test.ts": 677,
  "apps/desktop/src/renderer/src/composables/useShortBookLifecycleCoordinator.ts": 927,
  "apps/desktop/src/renderer/src/composables/useShortConversationCoordinator.ts": 836,
  "apps/desktop/src/renderer/src/composables/useShortWorkspaceStructureCoordinator.ts": 1235,
  "apps/desktop/src/renderer/src/composables/useWorkspaceDialogModuleCoordinator.test.ts": 767,
  "apps/desktop/src/renderer/src/composables/useWorkspaceDialogModuleCoordinator.ts": 556,
  "apps/desktop/src/renderer/src/composables/useWorkspaceResourceCoordinator.ts": 985,
  "apps/desktop/src/renderer/src/data/catalogWorkspace.test.ts": 1059,
  "apps/desktop/src/renderer/src/data/catalogWorkspace.ts": 1241,
  "apps/desktop/src/renderer/src/data/demoWorkspace.ts": 468,
  "apps/desktop/src/renderer/src/extras/long-book-analysis/long-book-analysis.css": 556,
  "apps/desktop/src/renderer/src/extras/style-comparison/style-comparison.css": 509,
  "apps/desktop/src/renderer/src/stores/longWorkspaceStore.ts": 671,
  "apps/desktop/src/renderer/src/stores/settingsStore.ts": 526,
  "apps/desktop/src/renderer/src/styles.css": 5103,
  "apps/desktop/src/renderer/src/styles/conversation-messages.css": 657,
  "apps/desktop/src/renderer/src/styles/conversation-proposals.css": 776,
  "apps/desktop/src/renderer/src/styles/dialogs.css": 689,
  "apps/desktop/src/renderer/src/styles/left-nav.css": 776,
  "apps/desktop/src/renderer/src/styles/right-editor.css": 549,
  "apps/desktop/src/renderer/src/styles/settings-forms.css": 796,
  "apps/desktop/src/renderer/src/types/longStructureMutations.test.ts": 1070,
  "apps/desktop/src/renderer/src/types/longStructureMutations.ts": 1726,
  "apps/desktop/src/renderer/src/types/longWorkspace.ts": 945,
  "apps/desktop/src/renderer/src/utils/approvalNavigation.test.ts": 704,
  "apps/desktop/src/renderer/src/utils/approvalNavigation.ts": 1029,
  "apps/desktop/src/renderer/src/utils/boundedTextHistory.ts": 670,
  "apps/desktop/src/renderer/src/utils/libraryAgentContext.ts": 442,
  "apps/desktop/src/renderer/src/utils/longWorkspaceResourceTree.ts": 610,
  "apps/desktop/src/renderer/src/WorkspaceShell.vue": 2723,
  "apps/desktop/src/utilities/agent-entry.test.ts": 762,
  "apps/desktop/src/utilities/catalog-store.test.ts": 826,
  "apps/desktop/src/utilities/catalog-store.ts": 1921,
  "apps/desktop/src/utilities/core-entry.ts": 550,
  "apps/desktop/src/utilities/folder-catalog-store.drafts-and-imports.test.ts": 700,
  "apps/desktop/src/utilities/folder-catalog-store.integrity-recovery-and-security.test.ts": 903,
  "apps/desktop/src/utilities/folder-catalog-store.libraries-and-registration.test.ts": 760,
  "apps/desktop/src/utilities/folder-catalog-store.migration-and-projects.test.ts": 1155,
  "apps/desktop/src/utilities/folder-catalog-store.ts": 7210,
  "apps/desktop/src/utilities/folder-catalog-store/draft-sections.ts": 951,
  "apps/desktop/src/utilities/folder-catalog-store/library-entries.ts": 954,
  "apps/desktop/src/utilities/folder-catalog-store/lifecycle.ts": 1199,
  "apps/desktop/src/utilities/folder-catalog-store/manifest.ts": 1060,
  "apps/desktop/src/utilities/folder-catalog-store/paths-io.ts": 462,
  "apps/desktop/src/utilities/folder-catalog-store/plot-stages.ts": 598,
  "apps/desktop/src/utilities/folder-catalog-store/registry.ts": 434,
  "apps/desktop/src/utilities/folder-catalog-store/snapshot.ts": 580,
  "apps/desktop/src/utilities/long-continuation-import.ts": 766,
  "apps/desktop/src/utilities/long-portable-bundle.ts": 866,
  "apps/desktop/src/utilities/long-project-catalog.ts": 997,
  "apps/desktop/src/utilities/long-project-store.creation-and-migration.test.ts": 614,
  "apps/desktop/src/utilities/long-project-store/lifecycle.ts": 444,
  "apps/desktop/src/utilities/long-project-store/migrations/continuity.ts": 607,
  "apps/desktop/src/utilities/long-workspace-service.ts": 989,
  "apps/desktop/src/utilities/project-transaction.test.ts": 731,
  "apps/desktop/src/utilities/write-claw-long-archive.ts": 647,
  "apps/desktop/src/utilities/write-claw-long-import.test.ts": 1111,
  "apps/desktop/src/utilities/write-claw-long-import/plan-plot.ts": 1153,
  "apps/desktop/src/utilities/write-claw-long-sync.ts": 463,
  "packages/contracts/src/catalog.test.ts": 1223,
  "packages/contracts/src/catalog.ts": 2894,
  "packages/contracts/src/catalog/manifests.ts": 510,
  "packages/contracts/src/catalog/mutations.ts": 801,
  "packages/contracts/src/expert-draft.ts": 525,
  "packages/contracts/src/index.commands-models-and-prompts.test.ts": 822,
  "packages/contracts/src/index.events-and-draft-mutations.test.ts": 834,
  "packages/contracts/src/learning-imitation.ts": 462,
  "packages/contracts/src/library-agent.ts": 456,
  "packages/contracts/src/long-workspace-api.test.ts": 740,
  "packages/contracts/src/long-workspace-api.ts": 1422,
  "packages/contracts/src/long-workspace-operations.anchors-concurrency-and-story-plots.test.ts": 729,
  "packages/contracts/src/long-workspace-operations.test-support.ts": 657,
  "packages/contracts/src/long-workspace.test.ts": 1024,
  "packages/contracts/src/long-workspace/continuity.ts": 552,
  "packages/contracts/src/long-workspace/ids.ts": 433,
  "packages/contracts/src/long-workspace/index-validation.ts": 1185,
  "packages/contracts/src/marketplace.ts": 549,
  "packages/contracts/src/preload-api.ts": 423,
  "packages/contracts/src/renderer.ts": 402,
  "packages/contracts/src/session/commands.ts": 490,
  "packages/contracts/src/session/long-proposals.ts": 415,
  "packages/contracts/src/system.ts": 492,
  "packages/contracts/src/workspace.ts": 772,
  "packages/pi-runtime-adapter/src/adapter.ts": 888,
  // Raised by one line to pass `toRuntimeEvents` into `toSubagentRuntimeEvents`,
  // which is what removed the `event-mapping` <-> `subagent-events` runtime cycle.
  "packages/pi-runtime-adapter/src/event-mapping.ts": 682,
  "packages/pi-runtime-adapter/src/index.provider-model-routing.test.ts": 1034,
  "packages/pi-runtime-adapter/src/index.provider-streaming.test.ts": 1008,
  "packages/pi-runtime-adapter/src/index.workspace-prompts.test.ts": 1340,
  "packages/pi-runtime-adapter/src/runtime-types.ts": 556,
  "packages/pi-runtime-adapter/src/subagent-runtime.test.ts": 899
};

const IMPLEMENTATION_BUDGET = 400;
const COMPONENT_BUDGET = 500;
const TEST_BUDGET = 600;

const SOURCE_EXTENSIONS = new Set([".ts", ".vue", ".css", ".mjs"]);
const TEST_PATTERN = /\.test(?:-support)?\./;

function posixPath(filePath) {
  return filePath.split("\\").join("/");
}

function countLines(source) {
  if (source.length === 0) return 0;
  const newlines = source.match(/\n/g);
  const newlineCount = newlines ? newlines.length : 0;
  return source.endsWith("\n") ? newlineCount : newlineCount + 1;
}

function isTestFile(relPath) {
  return TEST_PATTERN.test(relPath) || relPath.includes("/__tests__/");
}

function budgetFor(relPath) {
  if (isTestFile(relPath)) return TEST_BUDGET;
  const extension = extname(relPath);
  if (extension === ".vue" || extension === ".css") return COMPONENT_BUDGET;
  return IMPLEMENTATION_BUDGET;
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "out" ||
      entry.name === "release"
    ) {
      continue;
    }
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
      continue;
    }
    if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

const frozenBudgets = new Map(Object.entries(FROZEN_LEGACY_BUDGETS));

const scanRoots = [
  resolve(repoRoot, "apps/desktop/src"),
  resolve(repoRoot, "packages")
];

const files = [];
for (const root of scanRoots) {
  files.push(...(await collectFiles(root)));
}

const violations = [];
const seenFrozen = new Set();
let frozenTotal = 0;

for (const file of files.sort()) {
  const relPath = posixPath(relative(repoRoot, file));
  const source = await readFile(file, "utf8");
  const lines = countLines(source);
  const frozenBudget = frozenBudgets.get(relPath);

  if (frozenBudget === undefined) {
    const budget = budgetFor(relPath);
    if (lines > budget) {
      violations.push(
        `${relPath} has ${lines} lines (budget ${budget}). Split it, or list it in FROZEN_LEGACY_BUDGETS with the reason it cannot be split yet.`
      );
    }
    continue;
  }

  seenFrozen.add(relPath);
  frozenTotal += lines;
  if (lines > frozenBudget) {
    violations.push(
      `${relPath} has ${lines} lines and grew past its frozen budget of ${frozenBudget}. Split the touched responsibility back out, or raise the frozen number in the same change.`
    );
  } else if (lines < frozenBudget) {
    violations.push(
      `${relPath} has ${lines} lines, below its frozen budget of ${frozenBudget}. Lower the frozen number so the improvement cannot be spent again.`
    );
  }
}

for (const relPath of frozenBudgets.keys()) {
  if (!seenFrozen.has(relPath)) {
    violations.push(
      `${relPath} is listed in FROZEN_LEGACY_BUDGETS but no longer exists. Remove the stale entry.`
    );
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  console.error(
    `\n${violations.length} source line-budget violation(s). See AGENTS.md "代码体量、拆分与耦合".`
  );
  process.exit(1);
}

console.log(
  `Source line-budget check passed: ${frozenBudgets.size} frozen legacy file(s) (${frozenTotal} lines) held at or below their recorded size; all other files within ${IMPLEMENTATION_BUDGET}/${COMPONENT_BUDGET}/${TEST_BUDGET} lines (implementation/vue+css/test).`
);
