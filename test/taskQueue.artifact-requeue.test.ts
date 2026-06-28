import { expect } from "chai";
import { config } from "../package.json";
import {
  TaskQueueManager,
  TaskStatus,
  getDeepReadTaskId,
  getImageSummaryTaskId,
  getMindmapTaskId,
  getSummaryTaskId,
  getTaskRetryLimit,
  formatDeepReadIncompleteTaskError,
  inferTaskType,
  inferTaskPromptLanguage,
  type TaskItem,
} from "../src/modules/taskQueue";
import type { PromptLang } from "../src/utils/prompts";
import {
  TaskArtifacts,
  type TaskArtifactProbeResult,
  type FixedTaskArtifactType,
} from "../src/modules/taskArtifacts";
import { AiNoteService } from "../src/modules/aiNoteService";

type QueueInternals = {
  tasks: Map<string, TaskItem>;
  progressCallbacks: Set<(...args: any[]) => void>;
  completeCallbacks: Set<(...args: any[]) => void>;
  abortingTasks: Set<string>;
  isRunning: boolean;
  addTask(
    item: Zotero.Item,
    priority?: boolean,
    options?: { summaryMode?: string; forceOverwrite?: boolean },
    lang?: PromptLang,
  ): Promise<string>;
  addDeepReadTask(
    item: Zotero.Item,
    priority?: boolean,
    options?: { summaryMode?: string; forceOverwrite?: boolean },
    lang?: PromptLang,
  ): Promise<string>;
  addImageSummaryTask(
    item: Zotero.Item,
    priority?: boolean,
    lang?: PromptLang,
  ): Promise<string>;
  addMindmapTask(
    item: Zotero.Item,
    priority?: boolean,
    lang?: PromptLang,
  ): Promise<string>;
  maybeAutoTriggerImageSummary(itemId: number, lang: PromptLang): Promise<void>;
  retryTask(taskId: string): Promise<void>;
  loadFromStorage(resetProcessingTasks: boolean): void;
  requeueExistingFixedTask(
    task: TaskItem,
    item: Zotero.Item,
    artifactType: FixedTaskArtifactType,
    priority: boolean,
    options?: TaskItem["options"],
    workflowStage?: string,
  ): Promise<boolean>;
  shouldSkipNewFixedTaskForExistingArtifact(
    item: Zotero.Item,
    artifactType: FixedTaskArtifactType,
    options?: TaskItem["options"],
  ): Promise<boolean>;
  applyStandardTaskFailure(
    task: TaskItem,
    error: unknown,
  ): { willRetry: boolean; isTaskAborted: boolean };
  shouldSuppressTaskRetry(error: unknown, task?: TaskItem): boolean;
  saveToStorage(): Promise<void>;
};

const noteStrategyPref = `${config.prefsPrefix}.noteStrategy`;
const tableStrategyPref = `${config.prefsPrefix}.tableStrategy`;
const maxRetriesPref = `${config.prefsPrefix}.maxRetries`;
const deepReadMaxRetriesPref = `${config.prefsPrefix}.deepReadMaxRetries`;
const taskQueueStoragePref = "extensions.zotero.aibutler.taskQueue";

function createQueueInternals(): QueueInternals {
  const manager = Object.create(TaskQueueManager.prototype) as QueueInternals;
  manager.tasks = new Map();
  manager.progressCallbacks = new Set();
  manager.completeCallbacks = new Set();
  manager.abortingTasks = new Set();
  manager.isRunning = true;
  manager.saveToStorage = async () => {};
  return manager;
}

function createTask(status: TaskStatus): TaskItem {
  return {
    id: "task-1",
    itemId: 1,
    title: "Paper",
    status,
    progress: status === TaskStatus.COMPLETED ? 100 : 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    startedAt: new Date("2026-01-01T00:00:05Z"),
    completedAt: new Date("2026-01-01T00:00:10Z"),
    error: status === TaskStatus.FAILED ? "old error" : undefined,
    retryCount: status === TaskStatus.FAILED ? 2 : 0,
    maxRetries: 3,
    duration: status === TaskStatus.COMPLETED ? 5 : undefined,
  };
}

describe("TaskQueue artifact-aware requeue", function () {
  const item = { id: 1, getField: () => "Paper" } as unknown as Zotero.Item;
  let originalProbe: typeof TaskArtifacts.probe;
  let originalFindNote: typeof AiNoteService.findNote;
  let originalNoteStrategy: string | number | boolean | null | undefined;
  let originalTableStrategy: string | number | boolean | null | undefined;
  let originalMaxRetries: string | number | boolean | null | undefined;
  let originalDeepReadMaxRetries: string | number | boolean | null | undefined;
  let originalTaskQueueStorage: string | number | boolean | null | undefined;

  beforeEach(function () {
    originalProbe = TaskArtifacts.probe;
    originalFindNote = AiNoteService.findNote;
    originalNoteStrategy = Zotero.Prefs.get(noteStrategyPref, true) as
      | string
      | number
      | boolean
      | null
      | undefined;
    originalTableStrategy = Zotero.Prefs.get(tableStrategyPref, true) as
      | string
      | number
      | boolean
      | null
      | undefined;
    originalMaxRetries = Zotero.Prefs.get(maxRetriesPref, true) as
      | string
      | number
      | boolean
      | null
      | undefined;
    originalDeepReadMaxRetries = Zotero.Prefs.get(
      deepReadMaxRetriesPref,
      true,
    ) as string | number | boolean | null | undefined;
    originalTaskQueueStorage = Zotero.Prefs.get(taskQueueStoragePref, true) as
      | string
      | number
      | boolean
      | null
      | undefined;
    Zotero.Prefs.set(noteStrategyPref, "skip", true);
    Zotero.Prefs.set(tableStrategyPref, "skip", true);
    Zotero.Prefs.set(maxRetriesPref, "3", true);
    Zotero.Prefs.set(deepReadMaxRetriesPref, "5", true);
  });

  afterEach(function () {
    TaskArtifacts.probe = originalProbe;
    AiNoteService.findNote = originalFindNote;
    if (originalNoteStrategy == null) {
      Zotero.Prefs.clear(noteStrategyPref, true);
    } else {
      Zotero.Prefs.set(noteStrategyPref, originalNoteStrategy, true);
    }
    if (originalTableStrategy == null) {
      Zotero.Prefs.clear(tableStrategyPref, true);
    } else {
      Zotero.Prefs.set(tableStrategyPref, originalTableStrategy, true);
    }
    if (originalMaxRetries == null) {
      Zotero.Prefs.clear(maxRetriesPref, true);
    } else {
      Zotero.Prefs.set(maxRetriesPref, originalMaxRetries, true);
    }
    if (originalDeepReadMaxRetries == null) {
      Zotero.Prefs.clear(deepReadMaxRetriesPref, true);
    } else {
      Zotero.Prefs.set(
        deepReadMaxRetriesPref,
        originalDeepReadMaxRetries,
        true,
      );
    }
    if (originalTaskQueueStorage == null) {
      Zotero.Prefs.clear(taskQueueStoragePref, true);
    } else {
      Zotero.Prefs.set(taskQueueStoragePref, originalTaskQueueStorage, true);
    }
  });

  function stubProbe(result: TaskArtifactProbeResult): void {
    TaskArtifacts.probe = async () => result;
  }

  it("queues normal summaries with single mode by default", async function () {
    const manager = createQueueInternals();
    stubProbe({ exists: false, reason: "summary-note-missing" });

    const taskId = await manager.addTask(item);
    const task = manager.tasks.get(taskId);

    expect(taskId).to.equal(getSummaryTaskId(item.id));
    expect(task?.taskType).to.equal("summary");
    expect(task?.options?.summaryMode).to.equal("single");
  });

  it("keeps Chinese and English summary tasks independent", async function () {
    const manager = createQueueInternals();
    stubProbe({ exists: false, reason: "summary-note-missing" });

    const zhTaskId = await manager.addTask(item, false, undefined, "zh");
    const enTaskId = await manager.addTask(item, false, undefined, "en");

    expect(zhTaskId).to.equal(getSummaryTaskId(item.id, "zh"));
    expect(enTaskId).to.equal(getSummaryTaskId(item.id, "en"));
    expect(enTaskId).to.not.equal(zhTaskId);
    expect(manager.tasks.get(zhTaskId)?.promptLanguage).to.equal("zh");
    expect(manager.tasks.get(enTaskId)?.promptLanguage).to.equal("en");
  });

  it("preserves English on skipped completed task records", async function () {
    const manager = createQueueInternals();
    let probedLanguage: PromptLang | undefined;
    TaskArtifacts.probe = async (_type, _item, lang) => {
      probedLanguage = lang;
      return { exists: true };
    };

    const taskId = await manager.addTask(item, false, undefined, "en");
    const task = manager.tasks.get(taskId);

    expect(taskId).to.equal(getSummaryTaskId(item.id, "en"));
    expect(task?.status).to.equal(TaskStatus.COMPLETED);
    expect(task?.promptLanguage).to.equal("en");
    expect(probedLanguage).to.equal("en");
  });

  it("keeps bilingual image and mindmap tasks independent", async function () {
    const manager = createQueueInternals();

    const zhImageId = await manager.addImageSummaryTask(item, false, "zh");
    const enImageId = await manager.addImageSummaryTask(item, false, "en");
    const zhMindmapId = await manager.addMindmapTask(item, false, "zh");
    const enMindmapId = await manager.addMindmapTask(item, false, "en");

    expect(zhImageId).to.equal(getImageSummaryTaskId(item.id, "zh"));
    expect(enImageId).to.equal(getImageSummaryTaskId(item.id, "en"));
    expect(zhMindmapId).to.equal(getMindmapTaskId(item.id, "zh"));
    expect(enMindmapId).to.equal(getMindmapTaskId(item.id, "en"));
    expect(manager.tasks.get(enImageId)?.promptLanguage).to.equal("en");
    expect(manager.tasks.get(enMindmapId)?.promptLanguage).to.equal("en");
    expect(manager.tasks.get(enImageId)?.maxRetries).to.equal(3);
    expect(manager.tasks.get(enMindmapId)?.maxRetries).to.equal(3);
  });

  it("recovers English language from legacy persisted task IDs", function () {
    expect(inferTaskPromptLanguage({ id: "summary-task-1-en" })).to.equal("en");
    expect(inferTaskPromptLanguage({ id: "img-task-1-en" })).to.equal("en");
    expect(
      inferTaskPromptLanguage({
        id: "summary-task-1-en",
        promptLanguage: "zh",
      }),
    ).to.equal("en");
    expect(inferTaskPromptLanguage({ id: "summary-task-1" })).to.equal("zh");
  });

  it("carries summary language into automatic image generation", async function () {
    const manager = createQueueInternals();
    const autoImagePref = `${config.prefsPrefix}.autoImageSummaryOnComplete`;
    const originalAutoImage = Zotero.Prefs.get(autoImagePref, true);
    const originalGetAsync = Zotero.Items.getAsync;
    let captured: { priority?: boolean; lang?: PromptLang } | undefined;
    Zotero.Prefs.set(autoImagePref, true, true);
    Zotero.Items.getAsync = async () => item;
    manager.addImageSummaryTask = async (_item, priority, lang) => {
      captured = { priority, lang };
      return getImageSummaryTaskId(item.id, lang);
    };

    try {
      await manager.maybeAutoTriggerImageSummary(item.id, "en");
    } finally {
      Zotero.Items.getAsync = originalGetAsync;
      if (originalAutoImage == null) {
        Zotero.Prefs.clear(autoImagePref, true);
      } else {
        Zotero.Prefs.set(autoImagePref, originalAutoImage, true);
      }
    }

    expect(captured).to.deep.equal({ priority: true, lang: "en" });
  });

  it("routes explicit deep-read mode away from normal summary tasks", async function () {
    const manager = createQueueInternals();
    stubProbe({ exists: false, reason: "deep-read-note-missing" });

    const taskId = await manager.addTask(item, false, {
      summaryMode: "deepRead",
    });
    const task = manager.tasks.get(taskId);

    expect(taskId).to.equal(getDeepReadTaskId(item.id));
    expect(task?.taskType).to.equal("deepRead");
    expect(task?.maxRetries).to.equal(5);
    expect(task?.options?.summaryMode).to.equal("deepRead");
    expect(manager.tasks.has(getSummaryTaskId(item.id))).to.equal(false);
  });

  it("bounds the configurable deep-read no-progress budget", function () {
    expect(getTaskRetryLimit("summary")).to.equal(3);
    expect(getTaskRetryLimit("deepRead")).to.equal(5);

    Zotero.Prefs.set(deepReadMaxRetriesPref, "4", true);
    expect(getTaskRetryLimit("deepRead")).to.equal(4);
    Zotero.Prefs.set(deepReadMaxRetriesPref, "99", true);
    expect(getTaskRetryLimit("deepRead")).to.equal(5);
    Zotero.Prefs.set(deepReadMaxRetriesPref, "invalid", true);
    expect(getTaskRetryLimit("deepRead")).to.equal(5);
  });

  it("bounds general artifact retry budgets and applies them to image and mindmap", function () {
    expect(getTaskRetryLimit("summary")).to.equal(3);
    expect(getTaskRetryLimit("imageSummary")).to.equal(3);
    expect(getTaskRetryLimit("mindmap")).to.equal(3);
    Zotero.Prefs.set(maxRetriesPref, "99", true);
    expect(getTaskRetryLimit("summary")).to.equal(5);
    expect(getTaskRetryLimit("imageSummary")).to.equal(5);
  });

  it("schedules exact connection failures and records truthful pending diagnostics", function () {
    const manager = createQueueInternals();
    const task = createTask(TaskStatus.PROCESSING);
    task.taskType = "mindmap";
    task.retryCount = 0;
    task.maxRetries = 3;

    const outcome = manager.applyStandardTaskFailure(
      task,
      new Error("Error connecting to server. Check your Internet connection."),
    );

    expect(outcome.willRetry).to.equal(true);
    expect(task.status).to.equal(TaskStatus.PENDING);
    expect(task.retryCount).to.equal(1);
    expect(task.workflowStage).to.include("2/3");
    expect(task.completedAt).to.equal(undefined);
    expect(task.errorDetails).to.include("status: pending");
    expect(task.errorDetails).to.include("retryCount: 1");
    expect(task.errorDetails).to.include("failureKind: network");
  });

  it("does not fabricate a queue retry for terminal content-length failures", function () {
    const manager = createQueueInternals();
    const task = createTask(TaskStatus.PROCESSING);
    task.taskType = "imageSummary";
    task.retryCount = 0;
    task.maxRetries = 3;
    const noisy =
      'None: {"error":{"code":"content_length_limit","message":"Request content length exceeded 32 MB limit."}}No fallback model group found';

    const outcome = manager.applyStandardTaskFailure(task, new Error(noisy));

    expect(outcome.willRetry).to.equal(false);
    expect(task.status).to.equal(TaskStatus.FAILED);
    expect(task.retryCount).to.equal(0);
    expect(task.errorDetails).to.include("failureKind: payload-too-large");
  });

  it("reports retry and final deep-read states without false requeue claims", function () {
    const retryMessage = formatDeepReadIncompleteTaskError(
      "deep-read-placeholder-residual",
      "retry",
      3,
      5,
      "zh",
    );
    const failedMessage = formatDeepReadIncompleteTaskError(
      "deep-read-placeholder-residual",
      "failed",
      5,
      5,
      "zh",
    );

    expect(retryMessage).to.include("将自动重试");
    expect(retryMessage).to.include("3/5");
    expect(failedMessage).to.include("已暂停");
    expect(failedMessage).to.include("点击“重试”继续");
    expect(failedMessage).to.not.include("已重新加入队列");
  });

  it("upgrades a persisted failed deep-read task when manually retried", async function () {
    const manager = createQueueInternals();
    const task = createTask(TaskStatus.FAILED);
    task.id = "deepread-task-1";
    task.taskType = undefined;
    task.maxRetries = 3;
    manager.tasks.set(task.id, task);

    await manager.retryTask(task.id);

    expect(inferTaskType(task)).to.equal("deepRead");
    expect(task.taskType).to.equal("deepRead");
    expect(task.status).to.equal(TaskStatus.PRIORITY);
    expect(task.retryCount).to.equal(0);
    expect(task.maxRetries).to.equal(5);
  });

  it("normalizes the old retry budget when loading a persisted failed deep-read task", function () {
    const manager = createQueueInternals();
    Zotero.Prefs.set(
      taskQueueStoragePref,
      JSON.stringify({
        savedAt: "2026-06-27T00:00:00.000Z",
        tasks: [
          {
            ...createTask(TaskStatus.FAILED),
            id: "deepread-task-1",
            taskType: undefined,
            retryCount: 3,
            maxRetries: 3,
            error:
              "AI 精读尚未完整生成（deep-read-placeholder-residual），已重新加入队列补全未完成轮次",
            errorDetails:
              "errorMessage: AI 精读尚未完整生成（deep-read-placeholder-residual），已重新加入队列补全未完成轮次",
          },
        ],
      }),
      true,
    );

    manager.loadFromStorage(false);
    const restored = manager.tasks.get("deepread-task-1");

    expect(restored?.status).to.equal(TaskStatus.FAILED);
    expect(restored?.taskType).to.equal("deepRead");
    expect(restored?.retryCount).to.equal(3);
    expect(restored?.maxRetries).to.equal(5);
    expect(restored?.error).to.include("此前达到旧重试上限并暂停");
    expect(restored?.error).to.include("新的连续无进展上限 5");
    expect(restored?.error).to.not.include("已重新加入队列");
    expect(restored?.errorDetails).to.include("此前达到旧重试上限并暂停");
    expect(restored?.errorDetails).to.not.include("已重新加入队列");
  });

  it("refreshes the retry budget for an already pending deep-read task", async function () {
    const manager = createQueueInternals();
    const task = createTask(TaskStatus.PENDING);
    task.id = "deepread-task-1";
    task.taskType = "deepRead";
    task.maxRetries = 3;

    const shouldRun = await manager.requeueExistingFixedTask(
      task,
      item,
      "deepRead",
      false,
      { summaryMode: "deepRead" },
    );

    expect(shouldRun).to.equal(true);
    expect(task.status).to.equal(TaskStatus.PENDING);
    expect(task.maxRetries).to.equal(5);
  });

  it("requeues a completed summary task when the artifact is missing", async function () {
    const manager = createQueueInternals();
    const task = createTask(TaskStatus.COMPLETED);
    stubProbe({ exists: false, reason: "summary-note-missing" });

    const shouldRun = await manager.requeueExistingFixedTask(
      task,
      item,
      "summary",
      true,
    );

    expect(shouldRun).to.equal(true);
    expect(task.status).to.equal(TaskStatus.PRIORITY);
    expect(task.progress).to.equal(0);
    expect(task.completedAt).to.equal(undefined);
    expect(task.duration).to.equal(undefined);
  });

  it("keeps a completed summary task when the artifact exists and strategy is skip", async function () {
    const manager = createQueueInternals();
    const task = createTask(TaskStatus.COMPLETED);
    stubProbe({ exists: true });

    const shouldRun = await manager.requeueExistingFixedTask(
      task,
      item,
      "summary",
      true,
    );

    expect(shouldRun).to.equal(false);
    expect(task.status).to.equal(TaskStatus.COMPLETED);
  });

  it("skips creating a new deep-read task when a complete artifact exists and strategy is skip", async function () {
    const manager = createQueueInternals();
    stubProbe({ exists: true });

    const shouldSkip = await manager.shouldSkipNewFixedTaskForExistingArtifact(
      item,
      "deepRead",
      { summaryMode: "deepRead" },
    );

    expect(shouldSkip).to.equal(true);
  });

  it("records a completed deep-read task when an existing complete artifact is skipped", async function () {
    const manager = createQueueInternals();
    stubProbe({ exists: true });

    const taskId = await manager.addDeepReadTask(item, true, {
      summaryMode: "deepRead",
    });
    const task = manager.tasks.get(taskId);

    expect(taskId).to.equal(getDeepReadTaskId(1));
    expect(task?.status).to.equal(TaskStatus.COMPLETED);
    expect(task?.progress).to.equal(100);
    expect(task?.taskType).to.equal("deepRead");
  });

  it("does not skip creating a new deep-read task when the artifact is incomplete", async function () {
    const manager = createQueueInternals();
    stubProbe({ exists: false, reason: "deep-read-slots-incomplete" });

    const shouldSkip = await manager.shouldSkipNewFixedTaskForExistingArtifact(
      item,
      "deepRead",
      { summaryMode: "deepRead" },
    );

    expect(shouldSkip).to.equal(false);
  });

  it("does not skip creating a new deep-read task when overwrite is configured", async function () {
    const manager = createQueueInternals();
    stubProbe({ exists: true });
    Zotero.Prefs.set(noteStrategyPref, "overwrite", true);

    const shouldSkip = await manager.shouldSkipNewFixedTaskForExistingArtifact(
      item,
      "deepRead",
      { summaryMode: "deepRead" },
    );

    expect(shouldSkip).to.equal(false);
  });

  it("requeues a completed deep-read task when slots are incomplete", async function () {
    const manager = createQueueInternals();
    const task = createTask(TaskStatus.COMPLETED);
    task.taskType = "deepRead";
    stubProbe({ exists: false, reason: "deep-read-slots-incomplete" });

    const shouldRun = await manager.requeueExistingFixedTask(
      task,
      item,
      "deepRead",
      true,
      { summaryMode: "deepRead" },
    );

    expect(shouldRun).to.equal(true);
    expect(task.status).to.equal(TaskStatus.PRIORITY);
    expect(task.progress).to.equal(0);
    expect(task.completedAt).to.equal(undefined);
  });

  it("requeues a completed summary task when append is configured", async function () {
    const manager = createQueueInternals();
    const task = createTask(TaskStatus.COMPLETED);
    stubProbe({ exists: true });
    Zotero.Prefs.set(noteStrategyPref, "append", true);

    const shouldRun = await manager.requeueExistingFixedTask(
      task,
      item,
      "summary",
      true,
    );

    expect(shouldRun).to.equal(true);
    expect(task.status).to.equal(TaskStatus.PRIORITY);
  });

  it("requeues a completed table task when overwrite is configured", async function () {
    const manager = createQueueInternals();
    const task = createTask(TaskStatus.COMPLETED);
    stubProbe({ exists: true });
    Zotero.Prefs.set(tableStrategyPref, "overwrite", true);

    const shouldRun = await manager.requeueExistingFixedTask(
      task,
      item,
      "tableFill",
      true,
      undefined,
      "等待开始",
    );

    expect(shouldRun).to.equal(true);
    expect(task.status).to.equal(TaskStatus.PRIORITY);
    expect(task.workflowStage).to.equal("等待开始");
  });

  it("keeps processing tasks deduplicated and requeues failed tasks", async function () {
    const manager = createQueueInternals();
    const processingTask = createTask(TaskStatus.PROCESSING);
    const failedTask = createTask(TaskStatus.FAILED);
    stubProbe({ exists: false });

    const processingShouldRun = await manager.requeueExistingFixedTask(
      processingTask,
      item,
      "summary",
      true,
    );
    const failedShouldRun = await manager.requeueExistingFixedTask(
      failedTask,
      item,
      "summary",
      true,
    );

    expect(processingShouldRun).to.equal(false);
    expect(processingTask.status).to.equal(TaskStatus.PROCESSING);
    expect(failedShouldRun).to.equal(true);
    expect(failedTask.status).to.equal(TaskStatus.PRIORITY);
    expect(failedTask.error).to.equal(undefined);
    expect(failedTask.retryCount).to.equal(0);
  });

  it("uses distinct task IDs for summary and deep read", function () {
    expect(getSummaryTaskId(1)).to.equal("summary-task-1");
    expect(getDeepReadTaskId(1)).to.equal("deepread-task-1");
    expect(getSummaryTaskId(1)).to.not.equal(getDeepReadTaskId(1));
    expect(getSummaryTaskId(1, "en")).to.equal("summary-task-1-en");
    expect(getDeepReadTaskId(1, "en")).to.equal("deepread-task-1-en");
  });

  it("treats deep-read notes with runnable slots as incomplete artifacts", async function () {
    AiNoteService.findNote = async () =>
      ({
        getNote: () =>
          [
            "<h1>AI 精读 - Paper</h1>",
            "<!-- zab:slot:method:done -->",
            "<p>已生成</p>",
            "<!-- zab:slot:method:end -->",
            "<!-- zab:slot:result:pending -->",
            "<p>⏳ 等待生成...</p>",
            "<!-- zab:slot:result:end -->",
          ].join("\n"),
      }) as Zotero.Item;

    const result = await TaskArtifacts.probe("deepRead", item);

    expect(result.exists).to.equal(false);
    expect(result.reason).to.equal("deep-read-slots-incomplete");
  });
});
