import { expect } from "chai";
import { ImageSummaryService } from "../src/modules/imageSummaryService";
import LLMService from "../src/modules/llmService";
import { ImageClient } from "../src/modules/imageClient";
import { ImageNoteGenerator } from "../src/modules/imageNoteGenerator";
import { NoteGenerator } from "../src/modules/noteGenerator";
import { PDFExtractor } from "../src/modules/pdfExtractor";
import { clearPref, getPref, setPref } from "../src/utils/prefs";

function restorePref(key: string, value: unknown): void {
  if (value === undefined || value === null) clearPref(key);
  else setPref(key as any, value as any);
}

describe("image summary workflow recovery", function () {
  it("reuses completed LLM and image stages across task retries", async function () {
    const originalMode = LLMService.getEffectivePdfProcessMode;
    const originalGenerateText = LLMService.generateText;
    const originalGenerateImage = ImageClient.generateImage;
    const originalCreateNote = ImageNoteGenerator.createImageNote;
    const originalFindNote = NoteGenerator.findExistingNote;
    let llmCalls = 0;
    let imageCalls = 0;
    let saveCalls = 0;
    const item = {
      id: 62810,
      libraryID: 1,
      getField: () => "OSWORLD 2.0",
    } as unknown as Zotero.Item;

    (ImageSummaryService as any).workflowCheckpoints.clear();
    LLMService.getEffectivePdfProcessMode = () => "text";
    LLMService.generateText = async () => {
      llmCalls++;
      return "visual summary";
    };
    ImageClient.generateImage = async () => {
      imageCalls++;
      if (imageCalls === 1) {
        throw new Error(
          "Error connecting to server. Check your Internet connection.",
        );
      }
      return { imageBase64: "aW1hZ2U=", mimeType: "image/png" };
    };
    ImageNoteGenerator.createImageNote = async () => {
      saveCalls++;
      if (saveCalls === 1) throw new Error("temporary Zotero save failure");
      return { id: 9001 } as Zotero.Item;
    };
    NoteGenerator.findExistingNote = async () => null;

    try {
      let firstError: unknown;
      try {
        await ImageSummaryService.generateForItem(item);
      } catch (error) {
        firstError = error;
      }
      expect((firstError as Error)?.message).to.include("Error connecting");

      let secondError: unknown;
      try {
        await ImageSummaryService.generateForItem(item);
      } catch (error) {
        secondError = error;
      }
      expect((secondError as Error)?.message).to.include("save failure");

      const note = await ImageSummaryService.generateForItem(item);
      expect(note.id).to.equal(9001);
      expect(llmCalls).to.equal(1);
      expect(imageCalls).to.equal(2);
      expect(saveCalls).to.equal(2);
      expect((ImageSummaryService as any).workflowCheckpoints.size).to.equal(0);
    } finally {
      LLMService.getEffectivePdfProcessMode = originalMode;
      LLMService.generateText = originalGenerateText;
      ImageClient.generateImage = originalGenerateImage;
      ImageNoteGenerator.createImageNote = originalCreateNote;
      NoteGenerator.findExistingNote = originalFindNote;
      (ImageSummaryService as any).workflowCheckpoints.clear();
    }
  });

  it("regenerates both stages when the paper source changes", async function () {
    const originalMode = LLMService.getEffectivePdfProcessMode;
    const originalGenerateText = LLMService.generateText;
    const originalGenerateImage = ImageClient.generateImage;
    const originalCreateNote = ImageNoteGenerator.createImageNote;
    const originalFindNote = NoteGenerator.findExistingNote;
    const originalGetAllPdfs = PDFExtractor.getAllPdfAttachments;
    let llmCalls = 0;
    let imageCalls = 0;
    let saveCalls = 0;
    let sourceRevision = "2026-06-01 00:00:00";
    const item = {
      id: 62811,
      libraryID: 1,
      getAttachments: () => [71],
      getField: () => "Mutable paper",
    } as unknown as Zotero.Item;
    const attachment = {
      id: 71,
      key: "PDFSOURCE",
      get dateModified() {
        return sourceRevision;
      },
      getFilePathAsync: async () => "",
    } as unknown as Zotero.Item;

    (ImageSummaryService as any).workflowCheckpoints.clear();
    PDFExtractor.getAllPdfAttachments = async () => [attachment];
    LLMService.getEffectivePdfProcessMode = () => "text";
    LLMService.generateText = async () => `visual summary ${++llmCalls}`;
    ImageClient.generateImage = async () => ({
      imageBase64: `image-${++imageCalls}`,
      mimeType: "image/png",
    });
    ImageNoteGenerator.createImageNote = async () => {
      saveCalls++;
      if (saveCalls === 1) throw new Error("temporary Zotero save failure");
      return { id: 9002 } as Zotero.Item;
    };
    NoteGenerator.findExistingNote = async () => null;

    try {
      try {
        await ImageSummaryService.generateForItem(item);
      } catch (error) {
        expect((error as Error).message).to.include("save failure");
      }

      sourceRevision = "2026-06-02 00:00:00";
      const note = await ImageSummaryService.generateForItem(item);

      expect(note.id).to.equal(9002);
      expect(llmCalls).to.equal(2);
      expect(imageCalls).to.equal(2);
    } finally {
      LLMService.getEffectivePdfProcessMode = originalMode;
      LLMService.generateText = originalGenerateText;
      ImageClient.generateImage = originalGenerateImage;
      ImageNoteGenerator.createImageNote = originalCreateNote;
      NoteGenerator.findExistingNote = originalFindNote;
      PDFExtractor.getAllPdfAttachments = originalGetAllPdfs;
      (ImageSummaryService as any).workflowCheckpoints.clear();
    }
  });

  it("regenerates both stages when the visual-summary prompt changes", async function () {
    const originalMode = LLMService.getEffectivePdfProcessMode;
    const originalGenerateText = LLMService.generateText;
    const originalGenerateImage = ImageClient.generateImage;
    const originalCreateNote = ImageNoteGenerator.createImageNote;
    const originalFindNote = NoteGenerator.findExistingNote;
    const originalPrompt = getPref("imageSummaryPrompt" as any);
    let llmCalls = 0;
    let imageCalls = 0;
    let saveCalls = 0;
    const prompts: string[] = [];
    const item = {
      id: 62812,
      libraryID: 1,
      getField: () => "Prompt-sensitive paper",
    } as unknown as Zotero.Item;

    (ImageSummaryService as any).workflowCheckpoints.clear();
    setPref("imageSummaryPrompt" as any, "Prompt A: ${context}" as any);
    LLMService.getEffectivePdfProcessMode = () => "text";
    LLMService.generateText = async (request) => {
      llmCalls++;
      prompts.push(request.prompt);
      return `visual summary ${llmCalls}`;
    };
    ImageClient.generateImage = async () => ({
      imageBase64: `image-${++imageCalls}`,
      mimeType: "image/png",
    });
    ImageNoteGenerator.createImageNote = async () => {
      saveCalls++;
      if (saveCalls === 1) throw new Error("temporary Zotero save failure");
      return { id: 9003 } as Zotero.Item;
    };
    NoteGenerator.findExistingNote = async () => null;

    try {
      try {
        await ImageSummaryService.generateForItem(item);
      } catch (error) {
        expect((error as Error).message).to.include("save failure");
      }

      setPref("imageSummaryPrompt" as any, "Prompt B: ${context}" as any);
      const note = await ImageSummaryService.generateForItem(item);

      expect(note.id).to.equal(9003);
      expect(llmCalls).to.equal(2);
      expect(imageCalls).to.equal(2);
      expect(prompts[0]).to.include("Prompt A");
      expect(prompts[1]).to.include("Prompt B");
    } finally {
      restorePref("imageSummaryPrompt", originalPrompt);
      LLMService.getEffectivePdfProcessMode = originalMode;
      LLMService.generateText = originalGenerateText;
      ImageClient.generateImage = originalGenerateImage;
      ImageNoteGenerator.createImageNote = originalCreateNote;
      NoteGenerator.findExistingNote = originalFindNote;
      (ImageSummaryService as any).workflowCheckpoints.clear();
    }
  });
});
