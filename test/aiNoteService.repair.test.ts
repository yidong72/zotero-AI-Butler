import { expect } from "chai";
import { AiNoteService } from "../src/modules/aiNoteService";
import { DEEP_READ_NOTE_TAG } from "../src/modules/aiNoteClassifier";
import {
  DEFAULT_CHAPTER_FALLBACKS,
  getBuiltinMultiRoundPromptTemplates,
} from "../src/utils/prompts";
import {
  buildDeepReadSkeletonHtml,
  fillDeepReadSlot,
  planDeepReadSlots,
} from "../src/modules/deepReadEngine";

describe("AI note legacy repair", function () {
  it("returns the existing note when best-effort repair cannot be saved", async function () {
    const scope = globalThis as typeof globalThis & {
      ztoolkit?: { log: (...args: unknown[]) => void };
    };
    const originalZtoolkit = scope.ztoolkit;
    if (!scope.ztoolkit) scope.ztoolkit = { log: () => undefined };
    const template = getBuiltinMultiRoundPromptTemplates()[0];
    const planned = planDeepReadSlots(template, DEFAULT_CHAPTER_FALLBACKS);
    const notice = "本轮已从旧版精读笔记恢复，原始内容完整保留在下方。";
    const originalHtml = `${fillDeepReadSlot(
      buildDeepReadSkeletonHtml("Paper", template, planned),
      "chapter_ch1",
      notice,
      "引言",
    )}\n<hr/>\n<h2>从旧笔记恢复的已完成内容</h2>\n<h2>引言</h2>\n<p>Recovered prose.</p>`;
    let currentHtml = originalHtml;
    let saveAttempted = false;
    const note = {
      id: 99,
      dateModified: "2026-06-27 00:00:00",
      getTags: () => [{ tag: DEEP_READ_NOTE_TAG }],
      getNote: () => currentHtml,
      setNote: (html: string) => {
        currentHtml = html;
      },
      saveTx: async () => {
        saveAttempted = true;
        throw new Error("read-only library");
      },
    } as unknown as Zotero.Item;
    const parent = {
      id: 1,
      isAttachment: () => false,
      getNotes: () => [99],
    } as unknown as Zotero.Item;
    const originalGetAsync = Zotero.Items.getAsync;
    Zotero.Items.getAsync = async (id: number) =>
      id === 99 ? note : (null as unknown as Zotero.Item);

    try {
      const record = await AiNoteService.findNoteRecord(
        parent,
        "deepRead",
        "zh",
      );

      expect(saveAttempted).to.equal(true);
      expect(record?.note).to.equal(note);
      expect(record?.rawHtml).to.equal(originalHtml);
      expect((record?.note as any)?.getNote?.()).to.equal(originalHtml);
    } finally {
      Zotero.Items.getAsync = originalGetAsync;
      if (originalZtoolkit) {
        scope.ztoolkit = originalZtoolkit;
      } else {
        delete scope.ztoolkit;
      }
    }
  });
});
