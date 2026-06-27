import { expect } from "chai";
import {
  CollectionAiNoteCleaner,
  type CollectionAiNoteCleanPlan,
  type RegeneratableAiNoteType,
} from "../src/modules/collectionAiNoteCleaner";
import type { PromptLang } from "../src/utils/prompts";

type CleanerInternals = {
  getRegenerationLanguages(
    plan: CollectionAiNoteCleanPlan,
    itemId: number,
    type: RegeneratableAiNoteType,
  ): PromptLang[];
};

describe("CollectionAiNoteCleaner bilingual regeneration", function () {
  const cleaner = CollectionAiNoteCleaner as unknown as CleanerInternals;

  it("regenerates every language variant that was deleted", function () {
    const plan = {
      notes: [
        {
          noteId: 11,
          itemId: 1,
          itemTitle: "Paper",
          type: "summary",
          lang: "zh",
        },
        {
          noteId: 12,
          itemId: 1,
          itemTitle: "Paper",
          type: "summary",
          lang: "en",
        },
      ],
    } as CollectionAiNoteCleanPlan;

    expect(
      cleaner.getRegenerationLanguages(plan, 1, "summary"),
    ).to.have.same.members(["zh", "en"]);
    expect(cleaner.getRegenerationLanguages(plan, 1, "deepRead")).to.deep.equal(
      ["zh"],
    );
  });
});
