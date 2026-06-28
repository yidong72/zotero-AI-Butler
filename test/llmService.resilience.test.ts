import { expect } from "chai";
import LLMService from "../src/modules/llmService";
import { PDFExtractor } from "../src/modules/pdfExtractor";
import { ProviderRegistry } from "../src/modules/llmproviders/ProviderRegistry";
import type { ILlmProvider } from "../src/modules/llmproviders/ILlmProvider";
import {
  LLMEndpointManager,
  type LLMEndpoint,
} from "../src/modules/llmEndpointManager";

describe("LLMService payload recovery", function () {
  it("uses file metadata to switch large PDFs to text before Base64 allocation", async function () {
    const originalProvider = ProviderRegistry.get("openai");
    const originalGetAll = PDFExtractor.getAllPdfAttachments;
    const originalSize = PDFExtractor.getPdfAttachmentFileSizeBytes;
    const originalBase64 = PDFExtractor.extractBase64FromItem;
    const originalText = PDFExtractor.extractTextFromItem;
    let base64Reads = 0;
    const modes: boolean[] = [];
    const provider: ILlmProvider = {
      id: "openai",
      capabilities: {
        supportsText: true,
        supportsStreaming: true,
        supportsPdfBase64: true,
        maxPdfFiles: 1,
        supportsSystemPrompt: true,
        supportedParams: ["stream"],
      },
      async generateSummary(_content, isBase64) {
        modes.push(isBase64);
        return "preflight fallback worked";
      },
      async chat() {
        return "unused";
      },
      async testConnection() {
        return "ok";
      },
    };
    const endpoint: LLMEndpoint = {
      id: "payload-preflight-test",
      name: "payload preflight test",
      providerType: "openai",
      apiUrl: "https://example.test/v1/responses",
      apiKey: "test",
      model: "test-model",
      pdfProcessMode: "base64",
      enabled: true,
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
    };
    const item = { id: 62800 } as Zotero.Item;
    const attachment = { id: 62802 } as Zotero.Item;

    ProviderRegistry.register(provider);
    PDFExtractor.getAllPdfAttachments = async () => [attachment];
    PDFExtractor.getPdfAttachmentFileSizeBytes = async () => 19 * 1024 * 1024;
    PDFExtractor.extractBase64FromItem = async () => {
      base64Reads++;
      return "should-not-be-read";
    };
    PDFExtractor.extractTextFromItem = async () => "large paper extracted text";

    try {
      const response = await (LLMService as any).generateOnceWithEndpoint(
        endpoint,
        { task: "summary", content: { kind: "zotero-item", item } },
        "Summarize",
      );
      expect(response.text).to.equal("preflight fallback worked");
      expect(modes).to.deep.equal([false]);
      expect(base64Reads).to.equal(0);
      expect(response.warnings?.join(" ")).to.include("before upload");

      const reusable = await LLMService.prepareReusableItemContent(
        item,
        "base64",
      );
      expect(reusable).to.deep.equal({
        content: "large paper extracted text",
        isBase64: false,
      });
      expect(base64Reads).to.equal(0);
    } finally {
      PDFExtractor.getAllPdfAttachments = originalGetAll;
      PDFExtractor.getPdfAttachmentFileSizeBytes = originalSize;
      PDFExtractor.extractBase64FromItem = originalBase64;
      PDFExtractor.extractTextFromItem = originalText;
      if (originalProvider) ProviderRegistry.register(originalProvider);
    }
  });

  it("retries a noisy content-length rejection once with extracted text", async function () {
    const originalProvider = ProviderRegistry.get("openai");
    const originalGetAll = PDFExtractor.getAllPdfAttachments;
    const originalSize = PDFExtractor.getPdfAttachmentFileSizeBytes;
    const originalBase64 = PDFExtractor.extractBase64FromItem;
    const originalText = PDFExtractor.extractTextFromItem;
    const modes: boolean[] = [];
    let base64Reads = 0;
    let textReads = 0;

    const provider: ILlmProvider = {
      id: "openai",
      capabilities: {
        supportsText: true,
        supportsStreaming: true,
        supportsPdfBase64: true,
        maxPdfFiles: 1,
        supportsSystemPrompt: true,
        supportedParams: ["stream"],
      },
      async generateSummary(_content, isBase64) {
        modes.push(isBase64);
        if (isBase64) {
          throw new Error(
            'None: {"error":{"code":"content_length_limit","message":"Request content length exceeded 32 MB limit."}}No fallback model group found',
          );
        }
        return "Recovered from extracted text";
      },
      async chat() {
        return "unused";
      },
      async testConnection() {
        return "ok";
      },
    };
    const endpoint: LLMEndpoint = {
      id: "payload-fallback-test",
      name: "payload fallback test",
      providerType: "openai",
      apiUrl: "https://example.test/v1/responses",
      apiKey: "test",
      model: "test-model",
      pdfProcessMode: "base64",
      enabled: true,
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
    };
    const item = { id: 62801 } as Zotero.Item;
    const attachment = { id: 62803 } as Zotero.Item;

    ProviderRegistry.register(provider);
    PDFExtractor.getAllPdfAttachments = async () => [attachment];
    PDFExtractor.getPdfAttachmentFileSizeBytes = async () => 1024;
    PDFExtractor.extractBase64FromItem = async () => {
      base64Reads++;
      return "dGlueS1wZGY=";
    };
    PDFExtractor.extractTextFromItem = async () => {
      textReads++;
      return "Extracted OSWORLD paper text";
    };

    try {
      const response = await (LLMService as any).generateOnceWithEndpoint(
        endpoint,
        {
          task: "summary",
          content: { kind: "zotero-item", item },
          transport: { retry: false },
        },
        "Summarize this paper",
      );
      expect(response.text).to.equal("Recovered from extracted text");
      expect(response.warnings?.join(" ")).to.include("extracted text");
      expect(modes).to.deep.equal([true, false]);
      expect(base64Reads).to.equal(1);
      expect(textReads).to.equal(1);
    } finally {
      PDFExtractor.getAllPdfAttachments = originalGetAll;
      PDFExtractor.getPdfAttachmentFileSizeBytes = originalSize;
      PDFExtractor.extractBase64FromItem = originalBase64;
      PDFExtractor.extractTextFromItem = originalText;
      if (originalProvider) ProviderRegistry.register(originalProvider);
    }
  });

  it("recovers oversized follow-up chat from the source item", async function () {
    const originalProvider = ProviderRegistry.get("openai");
    const originalText = PDFExtractor.extractTextFromItem;
    const modes: boolean[] = [];
    const endpoint: LLMEndpoint = {
      id: "chat-payload-fallback-test",
      name: "chat payload fallback test",
      providerType: "openai",
      apiUrl: "https://example.test/v1/responses",
      apiKey: "test",
      model: "test-model",
      pdfProcessMode: "base64",
      enabled: true,
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
    };
    const item = { id: 62804 } as Zotero.Item;
    const provider: ILlmProvider = {
      id: "openai",
      capabilities: {
        supportsText: true,
        supportsStreaming: true,
        supportsPdfBase64: true,
        maxPdfFiles: 1,
        supportsSystemPrompt: true,
        supportedParams: ["stream"],
      },
      async generateSummary() {
        return "unused";
      },
      async chat(content, isBase64) {
        modes.push(isBase64);
        if (isBase64) {
          throw new Error("Request content length exceeded 32 MB limit.");
        }
        return `Recovered chat from ${content}`;
      },
      async testConnection() {
        return "ok";
      },
    };

    ProviderRegistry.register(provider);
    PDFExtractor.extractTextFromItem = async () => "fresh extracted paper text";

    try {
      const response = await (LLMService as any).chatOnceWithEndpoint(
        endpoint,
        {
          content: {
            kind: "legacy",
            content: "dGlueS1wZGY=",
            isBase64: true,
            policy: "pdf-base64",
            fallbackItem: item,
          },
          conversation: [
            { role: "user", content: "What is the contribution?" },
          ],
        },
      );

      expect(response.text).to.equal(
        "Recovered chat from fresh extracted paper text",
      );
      expect(modes).to.deep.equal([true, false]);
    } finally {
      (LLMService as any).forcedTextContentKeys.delete(
        `${endpoint.id}:legacy-item:${item.id}`,
      );
      PDFExtractor.extractTextFromItem = originalText;
      if (originalProvider) ProviderRegistry.register(originalProvider);
    }
  });

  it("bounds timeout retries at two attempts and does not retry permanent 4xx", async function () {
    const originalProvider = ProviderRegistry.get("openai");
    const originalDelay = Zotero.Promise.delay;
    const endpoint: LLMEndpoint = {
      id: "retry-policy-test",
      name: "retry policy test",
      providerType: "openai",
      apiUrl: "https://example.test/v1/responses",
      apiKey: "test",
      model: "test-model",
      pdfProcessMode: "text",
      enabled: true,
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
    };
    let message = "Request timed out after 300000 ms";
    let calls = 0;
    const provider: ILlmProvider = {
      id: "openai",
      capabilities: {
        supportsText: true,
        supportsStreaming: true,
        supportsPdfBase64: true,
        maxPdfFiles: 1,
        supportsSystemPrompt: true,
        supportedParams: ["stream"],
      },
      async generateSummary() {
        calls++;
        throw new Error(message);
      },
      async chat() {
        return "unused";
      },
      async testConnection() {
        return "ok";
      },
    };
    ProviderRegistry.register(provider);
    (Zotero.Promise as any).delay = async () => {};

    try {
      let timeoutError: any;
      try {
        await (LLMService as any).runGenerateWithFixedEndpoint(
          endpoint,
          { task: "summary", content: { kind: "text", text: "paper" } },
          "prompt",
        );
      } catch (error) {
        timeoutError = error;
      }
      expect(timeoutError?.name).to.equal("LLMApiExhaustedError");
      expect(timeoutError?.attempts).to.equal(2);
      expect(timeoutError?.suppressTaskRetry).to.equal(false);
      expect(calls).to.equal(2);

      calls = 0;
      message = "HTTP 401 Unauthorized";
      let authError: any;
      try {
        await (LLMService as any).runGenerateWithFixedEndpoint(
          endpoint,
          { task: "summary", content: { kind: "text", text: "paper" } },
          "prompt",
        );
      } catch (error) {
        authError = error;
      }
      expect(authError?.attempts).to.equal(1);
      expect(authError?.suppressTaskRetry).to.equal(true);
      expect(calls).to.equal(1);
    } finally {
      (Zotero.Promise as any).delay = originalDelay;
      if (originalProvider) ProviderRegistry.register(originalProvider);
    }
  });

  it("keeps routed failures retryable when any endpoint failed transiently", async function () {
    const originalProvider = ProviderRegistry.get("openai");
    const originalPrepareRoute = LLMEndpointManager.prepareRoute;
    const originalMarkAttempted = LLMEndpointManager.markEndpointAttempted;
    const originalDelay = Zotero.Promise.delay;
    const makeEndpoint = (id: string, apiKey: string): LLMEndpoint => ({
      id,
      name: id,
      providerType: "openai",
      apiUrl: "https://example.test/v1/responses",
      apiKey,
      model: "test-model",
      pdfProcessMode: "text",
      enabled: true,
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
    });
    const transient = makeEndpoint("transient-route", "transient");
    const permanent = makeEndpoint("permanent-route", "permanent");
    const third = makeEndpoint("third-route", "third");
    const calls: string[] = [];
    const provider: ILlmProvider = {
      id: "openai",
      async generateSummary(_content, _isBase64, _prompt, options) {
        calls.push(options.apiKey || "");
        if (options.apiKey === "transient") {
          throw new Error("Request timed out after 300000 ms");
        }
        throw new Error("HTTP 401 Unauthorized");
      },
      async chat() {
        return "unused";
      },
      async testConnection() {
        return "ok";
      },
    };

    ProviderRegistry.register(provider);
    LLMEndpointManager.markEndpointAttempted = () => {};
    (Zotero.Promise as any).delay = async () => {};

    try {
      LLMEndpointManager.prepareRoute = () => ({
        endpoints: [transient, permanent],
        strategy: "priority",
        maxAttempts: 2,
      });
      let exhausted: any;
      try {
        await LLMService.generate({
          task: "summary",
          content: { kind: "text", text: "paper" },
        });
      } catch (error) {
        exhausted = error;
      }

      expect(calls).to.deep.equal(["transient", "permanent"]);
      expect(exhausted?.name).to.equal("LLMApiExhaustedError");
      expect(exhausted?.failureKind).to.equal("timeout");
      expect(exhausted?.suppressTaskRetry).to.equal(false);
      expect(exhausted?.errors).to.have.length(2);

      calls.splice(0);
      LLMEndpointManager.prepareRoute = () => ({
        endpoints: [permanent, transient, third],
        strategy: "priority",
        maxAttempts: 2,
      });
      try {
        await LLMService.generate({
          task: "summary",
          content: { kind: "text", text: "paper" },
        });
      } catch {
        // The shared budget is exhausted after the next configured endpoint.
      }
      expect(calls).to.deep.equal(["permanent", "transient"]);

      calls.splice(0);
      LLMEndpointManager.prepareRoute = () => ({
        endpoints: [permanent, transient],
        strategy: "priority",
        maxAttempts: 3,
      });
      try {
        await LLMService.generate({
          task: "summary",
          content: { kind: "text", text: "paper" },
        });
      } catch {
        // Expected after two timeout attempts on the transient endpoint.
      }
      expect(calls).to.deep.equal(["permanent", "transient", "transient"]);
    } finally {
      LLMEndpointManager.prepareRoute = originalPrepareRoute;
      LLMEndpointManager.markEndpointAttempted = originalMarkAttempted;
      (Zotero.Promise as any).delay = originalDelay;
      if (originalProvider) ProviderRegistry.register(originalProvider);
    }
  });

  it("re-extracts current text after remembering a payload fallback", async function () {
    const originalProvider = ProviderRegistry.get("openai");
    const originalGetAll = PDFExtractor.getAllPdfAttachments;
    const originalSize = PDFExtractor.getPdfAttachmentFileSizeBytes;
    const originalBase64 = PDFExtractor.extractBase64FromItem;
    const originalText = PDFExtractor.extractTextFromItem;
    const endpoint: LLMEndpoint = {
      id: "fresh-text-fallback-test",
      name: "fresh text fallback test",
      providerType: "openai",
      apiUrl: "https://example.test/v1/responses",
      apiKey: "test",
      model: "test-model",
      pdfProcessMode: "base64",
      enabled: true,
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
    };
    const item = { id: 62820 } as Zotero.Item;
    const attachment = { id: 62821 } as Zotero.Item;
    const textInputs: string[] = [];
    let currentText = "first extracted version";
    let textReads = 0;
    let base64Reads = 0;
    const provider: ILlmProvider = {
      id: "openai",
      capabilities: {
        supportsText: true,
        supportsStreaming: true,
        supportsPdfBase64: true,
        maxPdfFiles: 1,
        supportsSystemPrompt: true,
        supportedParams: ["stream"],
      },
      async generateSummary(content, isBase64) {
        if (isBase64) {
          throw new Error("Request content length exceeded 32 MB limit.");
        }
        textInputs.push(content);
        return content;
      },
      async chat() {
        return "unused";
      },
      async testConnection() {
        return "ok";
      },
    };

    ProviderRegistry.register(provider);
    PDFExtractor.getAllPdfAttachments = async () => [attachment];
    PDFExtractor.getPdfAttachmentFileSizeBytes = async () => 1024;
    PDFExtractor.extractBase64FromItem = async () => {
      base64Reads++;
      return "dGlueS1wZGY=";
    };
    PDFExtractor.extractTextFromItem = async () => {
      textReads++;
      return currentText;
    };

    try {
      await (LLMService as any).generateOnceWithEndpoint(
        endpoint,
        { task: "summary", content: { kind: "zotero-item", item } },
        "Summarize",
      );
      currentText = "replacement PDF extracted version";
      await (LLMService as any).generateOnceWithEndpoint(
        endpoint,
        { task: "summary", content: { kind: "zotero-item", item } },
        "Summarize",
      );

      expect(base64Reads).to.equal(1);
      expect(textReads).to.equal(2);
      expect(textInputs).to.deep.equal([
        "first extracted version",
        "replacement PDF extracted version",
      ]);
    } finally {
      (LLMService as any).forcedTextContentKeys.delete(
        `${endpoint.id}:item:${item.id}`,
      );
      PDFExtractor.getAllPdfAttachments = originalGetAll;
      PDFExtractor.getPdfAttachmentFileSizeBytes = originalSize;
      PDFExtractor.extractBase64FromItem = originalBase64;
      PDFExtractor.extractTextFromItem = originalText;
      if (originalProvider) ProviderRegistry.register(originalProvider);
    }
  });

  it("lets the task queue retry a temporary large-PDF extraction failure", async function () {
    const originalProvider = ProviderRegistry.get("openai");
    const originalGetAll = PDFExtractor.getAllPdfAttachments;
    const originalSize = PDFExtractor.getPdfAttachmentFileSizeBytes;
    const originalText = PDFExtractor.extractTextFromItem;
    const endpoint: LLMEndpoint = {
      id: "transient-extraction-test",
      name: "transient extraction test",
      providerType: "openai",
      apiUrl: "https://example.test/v1/responses",
      apiKey: "test",
      model: "test-model",
      pdfProcessMode: "base64",
      enabled: true,
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
    };
    const item = { id: 62830 } as Zotero.Item;
    const attachment = { id: 62831 } as Zotero.Item;
    let textReads = 0;
    let providerCalls = 0;
    const provider: ILlmProvider = {
      id: "openai",
      capabilities: {
        supportsText: true,
        supportsStreaming: true,
        supportsPdfBase64: true,
        maxPdfFiles: 1,
        supportsSystemPrompt: true,
        supportedParams: ["stream"],
      },
      async generateSummary(content, isBase64) {
        providerCalls++;
        expect(isBase64).to.equal(false);
        return content;
      },
      async chat() {
        return "unused";
      },
      async testConnection() {
        return "ok";
      },
    };

    ProviderRegistry.register(provider);
    PDFExtractor.getAllPdfAttachments = async () => [attachment];
    PDFExtractor.getPdfAttachmentFileSizeBytes = async () => 19 * 1024 * 1024;
    PDFExtractor.extractTextFromItem = async () => {
      textReads++;
      if (textReads === 1) {
        throw Object.assign(
          new Error(
            "PDF text extraction failed: Unable to extract text from PDF",
          ),
          { name: "PDFTextExtractionError" },
        );
      }
      return "indexed text is now available";
    };

    try {
      let firstError: any;
      try {
        await (LLMService as any).generateOnceWithEndpoint(
          endpoint,
          { task: "summary", content: { kind: "zotero-item", item } },
          "Summarize",
        );
      } catch (error) {
        firstError = error;
      }
      expect(firstError?.name).to.equal("LLMApiCallError");
      expect(firstError?.failureKind).to.equal("extraction");
      expect(firstError?.suppressTaskRetry).to.equal(false);
      expect(providerCalls).to.equal(0);

      const response = await (LLMService as any).generateOnceWithEndpoint(
        endpoint,
        { task: "summary", content: { kind: "zotero-item", item } },
        "Summarize",
      );
      expect(response.text).to.equal("indexed text is now available");
      expect(textReads).to.equal(2);
      expect(providerCalls).to.equal(1);
    } finally {
      (LLMService as any).forcedTextContentKeys.delete(
        `${endpoint.id}:item:${item.id}`,
      );
      PDFExtractor.getAllPdfAttachments = originalGetAll;
      PDFExtractor.getPdfAttachmentFileSizeBytes = originalSize;
      PDFExtractor.extractTextFromItem = originalText;
      if (originalProvider) ProviderRegistry.register(originalProvider);
    }
  });
});
