import { expect } from "chai";
import { OpenAICompatProvider } from "../src/modules/llmproviders/OpenAICompatProvider";
import { OpenAIProvider } from "../src/modules/llmproviders/OpenAIProvider";
import type {
  ConversationMessage,
  LLMOptions,
} from "../src/modules/llmproviders/types";

type StreamFailure = "network" | "timeout" | null;

const options: LLMOptions = {
  apiUrl: "https://example.test/v1/chat/completions",
  apiKey: "test-key",
  model: "test-model",
  stream: true,
  requestTimeoutMs: 300000,
};

const conversation: ConversationMessage[] = [
  { role: "user", content: "Summarize the paper." },
];

const deltaEvent =
  'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
const finishEvent =
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
const doneEvent = "data: [DONE]\n\n";
const unterminatedFinishEvent = finishEvent.trimEnd();
const unterminatedDoneEvent = doneEvent.trimEnd();

async function withMockedChatStream<T>(
  events: string[],
  failure: StreamFailure,
  run: () => Promise<T>,
): Promise<T> {
  const zotero = Zotero as any;
  const originalHttp = zotero.HTTP;
  const originalRequest = originalHttp?.request;
  const http = originalHttp || {};
  zotero.HTTP = http;

  http.request = async (_method: string, _url: string, request: any) => {
    const xhr: any = {
      status: 200,
      statusText: "OK",
      response: "",
      abort() {},
    };
    request.requestObserver?.(xhr);

    for (const event of events) {
      xhr.response += event;
      xhr.onprogress?.({ target: xhr });
    }

    if (failure === "network") {
      xhr.onerror?.();
      throw new Error(
        "Error connecting to server. Check your Internet connection.",
      );
    }
    if (failure === "timeout") {
      xhr.ontimeout?.();
      throw new Error("Request timed out after 300000 ms");
    }

    return { status: 200, statusText: "OK", response: xhr.response };
  };

  try {
    return await run();
  } finally {
    if (originalRequest) {
      http.request = originalRequest;
    } else {
      delete http.request;
    }
    if (!originalHttp) delete zotero.HTTP;
  }
}

async function captureError(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }

  throw new Error("Expected stream operation to fail");
}

function runChat(
  provider: OpenAICompatProvider | OpenAIProvider,
  onProgress: (chunk: string) => void,
): Promise<string> {
  return provider.chat("paper text", false, conversation, options, onProgress);
}

describe("OpenAI Chat Completions interrupted streams", function () {
  for (const [label, createProvider] of [
    ["OpenAI Compat", () => new OpenAICompatProvider()],
    ["OpenAI Chat Completions", () => new OpenAIProvider()],
  ] as const) {
    describe(`${label} stream completion`, function () {
      it("rejects a network error after partial deltas", async function () {
        const progress: string[] = [];
        const error = await captureError(() =>
          withMockedChatStream([deltaEvent], "network", () =>
            runChat(createProvider(), (chunk) => progress.push(chunk)),
          ),
        );

        expect(progress).to.deep.equal(["partial"]);
        expect(error.message).to.include("NetworkError");
      });

      it("rejects a timeout after partial deltas", async function () {
        const error = await captureError(() =>
          withMockedChatStream([deltaEvent], "timeout", () =>
            runChat(createProvider(), () => {}),
          ),
        );

        expect(error.message).to.include("Timeout");
        expect(error.message).to.include("300000");
      });

      it("rejects a partial stream that ends without an error event", async function () {
        const error = await captureError(() =>
          withMockedChatStream([deltaEvent], null, () =>
            runChat(createProvider(), () => {}),
          ),
        );

        expect(error.message).to.include("terminal completion marker");
      });

      it("accepts finish_reason before a trailing network error", async function () {
        const result = await withMockedChatStream(
          [deltaEvent, finishEvent],
          "network",
          () => runChat(createProvider(), () => {}),
        );

        expect(result).to.equal("partial");
      });

      it("accepts a DONE marker before a trailing timeout", async function () {
        const result = await withMockedChatStream(
          [deltaEvent, doneEvent],
          "timeout",
          () => runChat(createProvider(), () => {}),
        );

        expect(result).to.equal("partial");
      });

      it("accepts an unterminated finish_reason after clean completion", async function () {
        const result = await withMockedChatStream(
          [deltaEvent, unterminatedFinishEvent],
          null,
          () => runChat(createProvider(), () => {}),
        );

        expect(result).to.equal("partial");
      });

      it("accepts an unterminated DONE marker after clean completion", async function () {
        const result = await withMockedChatStream(
          [deltaEvent, unterminatedDoneEvent],
          null,
          () => runChat(createProvider(), () => {}),
        );

        expect(result).to.equal("partial");
      });
    });
  }

  describe("OpenAI Compat non-chat streaming operations", function () {
    it("rejects an interrupted summary after partial deltas", async function () {
      const provider = new OpenAICompatProvider();
      const error = await captureError(() =>
        withMockedChatStream([deltaEvent], "network", () =>
          provider.generateSummary(
            "paper",
            false,
            "Summarize",
            options,
            () => {},
          ),
        ),
      );

      expect(error.message).to.include("NetworkError");
    });

    it("accepts a summary with a terminal DONE marker", async function () {
      const provider = new OpenAICompatProvider();
      const result = await withMockedChatStream(
        [deltaEvent, doneEvent],
        "network",
        () =>
          provider.generateSummary(
            "paper",
            false,
            "Summarize",
            options,
            () => {},
          ),
      );

      expect(result).to.equal("partial");
    });

    it("accepts a summary with an unterminated DONE marker", async function () {
      const provider = new OpenAICompatProvider();
      const result = await withMockedChatStream(
        [deltaEvent, unterminatedDoneEvent],
        null,
        () =>
          provider.generateSummary(
            "paper",
            false,
            "Summarize",
            options,
            () => {},
          ),
      );

      expect(result).to.equal("partial");
    });

    it("rejects an interrupted multi-PDF stream", async function () {
      const provider = new OpenAICompatProvider();
      const error = await captureError(() =>
        withMockedChatStream([deltaEvent], "timeout", () =>
          provider.generateMultiFileSummary(
            [
              {
                filePath: "/tmp/paper.pdf",
                displayName: "paper.pdf",
                base64Content: "cGRm",
              },
            ],
            "Summarize",
            options,
            () => {},
          ),
        ),
      );

      expect(error.message).to.include("Timeout");
    });

    it("accepts a completed multi-PDF stream", async function () {
      const provider = new OpenAICompatProvider();
      const result = await withMockedChatStream(
        [deltaEvent, finishEvent],
        "network",
        () =>
          provider.generateMultiFileSummary(
            [
              {
                filePath: "/tmp/paper.pdf",
                displayName: "paper.pdf",
                base64Content: "cGRm",
              },
            ],
            "Summarize",
            options,
            () => {},
          ),
      );

      expect(result).to.equal("partial");
    });

    it("accepts an unterminated multi-PDF finish reason", async function () {
      const provider = new OpenAICompatProvider();
      const result = await withMockedChatStream(
        [deltaEvent, unterminatedFinishEvent],
        null,
        () =>
          provider.generateMultiFileSummary(
            [
              {
                filePath: "/tmp/paper.pdf",
                displayName: "paper.pdf",
                base64Content: "cGRm",
              },
            ],
            "Summarize",
            options,
            () => {},
          ),
      );

      expect(result).to.equal("partial");
    });
  });

  describe("OpenAI Chat Completions summary streaming", function () {
    it("rejects an interrupted summary after partial deltas", async function () {
      const provider = new OpenAIProvider();
      const error = await captureError(() =>
        withMockedChatStream([deltaEvent], "network", () =>
          provider.generateSummary(
            "paper",
            false,
            "Summarize",
            options,
            () => {},
          ),
        ),
      );

      expect(error.message).to.include("NetworkError");
    });

    it("accepts a summary with a terminal finish reason", async function () {
      const provider = new OpenAIProvider();
      const result = await withMockedChatStream(
        [deltaEvent, finishEvent],
        "network",
        () =>
          provider.generateSummary(
            "paper",
            false,
            "Summarize",
            options,
            () => {},
          ),
      );

      expect(result).to.equal("partial");
    });

    it("accepts a summary with an unterminated finish reason", async function () {
      const provider = new OpenAIProvider();
      const result = await withMockedChatStream(
        [deltaEvent, unterminatedFinishEvent],
        null,
        () =>
          provider.generateSummary(
            "paper",
            false,
            "Summarize",
            options,
            () => {},
          ),
      );

      expect(result).to.equal("partial");
    });

    it("accepts a summary with an unterminated DONE marker", async function () {
      const provider = new OpenAIProvider();
      const result = await withMockedChatStream(
        [deltaEvent, unterminatedDoneEvent],
        null,
        () =>
          provider.generateSummary(
            "paper",
            false,
            "Summarize",
            options,
            () => {},
          ),
      );

      expect(result).to.equal("partial");
    });
  });
});
