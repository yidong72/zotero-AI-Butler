import { expect } from "chai";
import LLMService from "../src/modules/llmService";
import {
  LLMEndpointManager,
  type LLMEndpoint,
  type LLMEndpointRoute,
} from "../src/modules/llmEndpointManager";
import { ProviderRegistry } from "../src/modules/llmproviders/ProviderRegistry";
import type { ILlmProvider } from "../src/modules/llmproviders/ILlmProvider";

function makeEndpoint(id: string): LLMEndpoint {
  return {
    id,
    name: `Endpoint ${id}`,
    providerType: "openai",
    apiUrl: "https://example.test/v1/responses",
    apiKey: "test",
    model: id,
    pdfProcessMode: "text",
    enabled: true,
    createdAt: "2026-06-28T00:00:00.000Z",
    updatedAt: "2026-06-28T00:00:00.000Z",
  };
}

const BUDGET_ENDPOINTS = [
  makeEndpoint("a"),
  makeEndpoint("b"),
  makeEndpoint("c"),
];

describe("deep-read endpoint retry budget", function () {
  const endpoints = BUDGET_ENDPOINTS;
  const manager = LLMEndpointManager as unknown as {
    prepareRoute(): LLMEndpointRoute;
    getEndpoint(id: string): LLMEndpoint | undefined;
  };
  let originalProvider: ILlmProvider | undefined;
  let originalPrepareRoute: typeof manager.prepareRoute;
  let originalGetEndpoint: typeof manager.getEndpoint;
  let originalDelay: typeof Zotero.Promise.delay;

  beforeEach(function () {
    originalProvider = ProviderRegistry.get("openai");
    originalPrepareRoute = manager.prepareRoute;
    originalGetEndpoint = manager.getEndpoint;
    originalDelay = Zotero.Promise.delay;
    manager.getEndpoint = (id) =>
      endpoints.find((endpoint) => endpoint.id === id);
    (Zotero.Promise as any).delay = async () => {};
  });

  afterEach(function () {
    manager.prepareRoute = originalPrepareRoute;
    manager.getEndpoint = originalGetEndpoint;
    (Zotero.Promise as any).delay = originalDelay;
    if (originalProvider) ProviderRegistry.register(originalProvider);
  });

  it("reaches later fallbacks within one shared attempt budget", async function () {
    const calls: string[] = [];
    manager.prepareRoute = () => ({
      endpoints,
      strategy: "priority",
      maxAttempts: 3,
    });
    ProviderRegistry.register({
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
      async chat(_content, _isBase64, _conversation, options) {
        calls.push(options.model);
        if (options.model !== "c") {
          throw new Error(
            "Error connecting to server. Check your Internet connection.",
          );
        }
        return "fallback succeeded";
      },
      async testConnection() {
        return "ok";
      },
    });

    const response = await LLMService.chatWithPreferredEndpoint(
      "a",
      {
        content: { kind: "text", text: "paper" },
        conversation: [{ role: "user", content: "analyze" }],
      },
      true,
    );

    expect(calls).to.deep.equal(["a", "b", "c"]);
    expect(response.endpointId).to.equal("c");
    expect(response.text).to.equal("fallback succeeded");
  });

  it("never multiplies the configured budget across fallbacks", async function () {
    const calls: string[] = [];
    manager.prepareRoute = () => ({
      endpoints,
      strategy: "priority",
      maxAttempts: 5,
    });
    ProviderRegistry.register({
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
      async chat(_content, _isBase64, _conversation, options) {
        calls.push(options.model);
        throw new Error(
          "Error connecting to server. Check your Internet connection.",
        );
      },
      async testConnection() {
        return "ok";
      },
    });

    let caught: unknown;
    try {
      await LLMService.chatWithPreferredEndpoint(
        "a",
        {
          content: { kind: "text", text: "paper" },
          conversation: [{ role: "user", content: "analyze" }],
        },
        true,
      );
    } catch (error) {
      caught = error;
    }

    expect(calls).to.deep.equal(["a", "b", "c", "a", "b"]);
    expect((caught as { attempts?: number })?.attempts).to.equal(5);
  });
});
