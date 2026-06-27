import { expect } from "chai";
import { NoteGenerator } from "../src/modules/noteGenerator";
import LLMService, { type LLMGenerateRequest } from "../src/modules/llmService";
import type { LLMEndpoint } from "../src/modules/llmEndpointManager";
import type { LLMResponse } from "../src/modules/llmproviders/types";
import { getDefaultSummaryPrompt } from "../src/utils/prompts";

type MultiModelGenerator = {
  generateSummaryWithEndpoint(params: {
    item: Zotero.Item;
    itemTitle: string;
    endpoint: LLMEndpoint;
    summaryMode: "single";
    pdfContent: string;
    isBase64: boolean;
    pdfAttachmentMode: string;
    prefMode: string;
    promptLanguage: "zh" | "en";
  }): Promise<{ noteHtml: string }>;
};

describe("NoteGenerator bilingual multi-model summaries", function () {
  const generator = NoteGenerator as unknown as MultiModelGenerator;
  const endpoint: LLMEndpoint = {
    id: "endpoint-1",
    name: "Endpoint",
    providerType: "nvinference",
    apiUrl: "https://example.invalid",
    apiKey: "key",
    model: "model",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const item = { id: 1 } as Zotero.Item;
  let originalGenerate: typeof LLMService.generateWithEndpoint;
  let originalPdfMode: typeof LLMService.getEffectivePdfProcessMode;
  let capturedRequest: LLMGenerateRequest | undefined;

  beforeEach(function () {
    originalGenerate = LLMService.generateWithEndpoint;
    originalPdfMode = LLMService.getEffectivePdfProcessMode;
    capturedRequest = undefined;
    LLMService.getEffectivePdfProcessMode = () => "text";
    LLMService.generateWithEndpoint = async (_endpointId, request) => {
      capturedRequest = request;
      return {
        text: "# Result\n\nEnglish summary.",
        providerId: "nvinference",
        providerName: "NVIDIA Inference",
        model: "model",
      } satisfies LLMResponse;
    };
  });

  afterEach(function () {
    LLMService.generateWithEndpoint = originalGenerate;
    LLMService.getEffectivePdfProcessMode = originalPdfMode;
  });

  it("passes the English prompt and renders an English note title", async function () {
    const result = await generator.generateSummaryWithEndpoint({
      item,
      itemTitle: "Paper",
      endpoint,
      summaryMode: "single",
      pdfContent: "",
      isBase64: false,
      pdfAttachmentMode: "default",
      prefMode: "text",
      promptLanguage: "en",
    });

    expect(capturedRequest?.prompt).to.equal(getDefaultSummaryPrompt("en"));
    expect(result.noteHtml).to.include("AI Summary - Paper");
    expect(result.noteHtml).not.to.include("AI 管家 - Paper");
  });
});
