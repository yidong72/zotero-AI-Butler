import { expect } from "chai";
import { ImageNoteGenerator } from "../src/modules/imageNoteGenerator";

describe("ImageNoteGenerator persistence rollback", function () {
  function makeParentItem(): Zotero.Item {
    return {
      id: 17,
      libraryID: 1,
      getField: () => "Paper",
    } as unknown as Zotero.Item;
  }

  it("restores an existing note and erases the imported image when save fails", async function () {
    const originalFindExisting = ImageNoteGenerator.findExistingImageNote;
    const originalImport = Zotero.Attachments.importEmbeddedImage;
    const previousHtml = "<h2>Last valid image summary</h2>";
    let html = previousHtml;
    let tags = [{ tag: "legacy-tag", type: 0 }];
    let attachmentEraseCount = 0;
    let noteEraseCount = 0;
    const existingNote = {
      id: 41,
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
        noteEraseCount++;
      },
    } as unknown as Zotero.Item;
    const attachment = {
      key: "NEWIMAGE",
      eraseTx: async () => {
        attachmentEraseCount++;
      },
    } as unknown as Zotero.Item;

    ImageNoteGenerator.findExistingImageNote = async () => existingNote;
    Zotero.Attachments.importEmbeddedImage = async () => attachment as any;

    try {
      let caught: Error | null = null;
      try {
        await ImageNoteGenerator.createImageNote(
          makeParentItem(),
          "aW1hZ2U=",
          "image/png",
          "en",
        );
      } catch (error) {
        caught = error as Error;
      }

      expect(caught?.message).to.equal("save failed");
      expect(html).to.equal(previousHtml);
      expect(tags).to.deep.equal([{ tag: "legacy-tag", type: 0 }]);
      expect(attachmentEraseCount).to.equal(1);
      expect(noteEraseCount).to.equal(0);
    } finally {
      ImageNoteGenerator.findExistingImageNote = originalFindExisting;
      Zotero.Attachments.importEmbeddedImage = originalImport;
    }
  });

  it("erases a new attachment and placeholder note when final save fails", async function () {
    const originalFindExisting = ImageNoteGenerator.findExistingImageNote;
    const originalImport = Zotero.Attachments.importEmbeddedImage;
    const OriginalItem = Zotero.Item;
    let attachmentEraseCount = 0;
    const createdNote = {
      id: 42,
      libraryID: 0,
      parentID: 0,
      html: "",
      tags: [] as Array<{ tag: string; type: number }>,
      saveCount: 0,
      eraseCount: 0,
      setNote(value: string): void {
        this.html = value;
      },
      addTag(tag: string): void {
        this.tags.push({ tag, type: 0 });
      },
      async saveTx(): Promise<void> {
        this.saveCount++;
        if (this.saveCount === 2) throw new Error("final save failed");
      },
      async eraseTx(): Promise<void> {
        this.eraseCount++;
      },
    };

    const attachment = {
      key: "NEWIMAGE",
      eraseTx: async () => {
        attachmentEraseCount++;
      },
    } as unknown as Zotero.Item;

    ImageNoteGenerator.findExistingImageNote = async () => null;
    Zotero.Attachments.importEmbeddedImage = async () => attachment as any;
    (Zotero as any).Item = function FakeItem() {
      return createdNote;
    };

    try {
      let caught: Error | null = null;
      try {
        await ImageNoteGenerator.createImageNote(
          makeParentItem(),
          "aW1hZ2U=",
          "image/png",
        );
      } catch (error) {
        caught = error as Error;
      }

      expect(caught?.message).to.equal("final save failed");
      expect(createdNote.saveCount).to.equal(2);
      expect(createdNote.eraseCount).to.equal(1);
      expect(attachmentEraseCount).to.equal(1);
    } finally {
      ImageNoteGenerator.findExistingImageNote = originalFindExisting;
      Zotero.Attachments.importEmbeddedImage = originalImport;
      (Zotero as any).Item = OriginalItem;
    }
  });
});
