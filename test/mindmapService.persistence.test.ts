import { expect } from "chai";
import { MindmapService } from "../src/modules/mindmapService";

type MindmapServiceInternals = {
  createMindmapNote(
    item: Zotero.Item,
    markdown: string,
    metadata?: null,
    lang?: "zh" | "en",
  ): Promise<Zotero.Item>;
};

const internals = MindmapService as unknown as MindmapServiceInternals;
const originalFindExisting = MindmapService.findExistingMindmapNote;

describe("MindmapService note persistence", function () {
  afterEach(function () {
    MindmapService.findExistingMindmapNote = originalFindExisting;
  });

  function makeItem(): Zotero.Item {
    return {
      id: 7,
      libraryID: 1,
      getField: () => "Paper",
    } as unknown as Zotero.Item;
  }

  it("updates an existing note without erasing it", async function () {
    let html = "<h2>Old mind map</h2>";
    let saveCount = 0;
    let eraseCount = 0;
    const tags: string[] = [];
    const existing = {
      getNote: () => html,
      getTags: () => tags.map((tag) => ({ tag, type: 0 })),
      setNote: (value: string) => {
        html = value;
      },
      setTags: (values: Array<{ tag: string }>) => {
        tags.splice(0, tags.length, ...values.map((value) => value.tag));
      },
      addTag: (tag: string) => {
        tags.push(tag);
      },
      saveTx: async () => {
        saveCount += 1;
      },
      eraseTx: async () => {
        eraseCount += 1;
      },
    } as unknown as Zotero.Item;
    MindmapService.findExistingMindmapNote = async () => existing;

    const result = await internals.createMindmapNote(
      makeItem(),
      "# New map",
      null,
      "en",
    );

    expect(result).to.equal(existing);
    expect(saveCount).to.equal(1);
    expect(eraseCount).to.equal(0);
    expect(html).to.include("AI Mindmap - Paper");
    expect(html).to.include("# New map");
    expect(tags).to.include("AI-Mindmap");
    expect(tags).to.include("AI-English");
  });

  it("restores the previous HTML when an update save fails", async function () {
    const previousHtml = "<h2>Last valid mind map</h2>";
    let html = previousHtml;
    let eraseCount = 0;
    let tags = [{ tag: "legacy-tag", type: 0 }];
    const existing = {
      getNote: () => html,
      getTags: () => tags,
      setNote: (value: string) => {
        html = value;
      },
      setTags: (values: Array<{ tag: string; type: number }>) => {
        tags = values;
      },
      addTag: (tag: string) => {
        tags.push({ tag, type: 0 });
      },
      saveTx: async () => {
        throw new Error("save failed");
      },
      eraseTx: async () => {
        eraseCount += 1;
      },
    } as unknown as Zotero.Item;
    MindmapService.findExistingMindmapNote = async () => existing;

    let caught: Error | null = null;
    try {
      await internals.createMindmapNote(
        makeItem(),
        "# Replacement",
        null,
        "zh",
      );
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).to.equal("save failed");
    expect(html).to.equal(previousHtml);
    expect(tags).to.deep.equal([{ tag: "legacy-tag", type: 0 }]);
    expect(eraseCount).to.equal(0);
  });
});
