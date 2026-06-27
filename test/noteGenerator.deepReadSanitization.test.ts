import { expect } from "chai";
import { NoteGenerator } from "../src/modules/noteGenerator";
import type { LLMResponse } from "../src/modules/llmproviders/types";
import type {
  MultiRoundPromptTemplate,
  PromptLang,
} from "../src/utils/prompts";

type DeepReadGeneratorInternals = {
  generateDeepReadContent(params: {
    item: Zotero.Item;
    existing: Zotero.Item;
    existingHtml: string;
    policy: string;
    pdfContent: string;
    isBase64: boolean;
    itemTitle: string;
    promptLanguage?: PromptLang;
  }): Promise<{ noteHtml: string }>;
  getActiveDeepReadTemplate(lang?: PromptLang): MultiRoundPromptTemplate;
  callDeepReadChat(params: unknown): Promise<LLMResponse>;
};

function stripProgressMarkers(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<a\b[^>]*href=["']zab:\/\/[^"']+["'][^>]*>[\s\S]*?<\/a>/gi, "");
}

describe("NoteGenerator deep-read persistence", function () {
  const internals = NoteGenerator as unknown as DeepReadGeneratorInternals;
  const template: MultiRoundPromptTemplate = {
    id: "sanitization-test",
    name: "Sanitization test",
    description: "Two slots",
    version: 2,
    prompts: [],
    phases: [
      {
        id: "chapters",
        title: "Chapters",
        type: "sequential_dynamic",
        description: "Read chapters",
        contextStrategy: "last_round",
        planningPrompt: "Plan chapters",
        fixedPrompts: [],
        chapterTemplate: "Read {{title_en}}",
        maxChapters: 1,
      },
      {
        id: "questions",
        title: "Questions",
        type: "independent",
        description: "Follow up",
        parallelizable: false,
        maxConcurrency: 1,
        prompts: [
          {
            id: "limitations",
            title: "Limitations",
            prompt: "Analyze limitations",
            order: 1,
          },
        ],
      },
    ],
  };
  let originalTemplate: DeepReadGeneratorInternals["getActiveDeepReadTemplate"];
  let originalChat: DeepReadGeneratorInternals["callDeepReadChat"];

  beforeEach(function () {
    originalTemplate = internals.getActiveDeepReadTemplate;
    originalChat = internals.callDeepReadChat;
  });

  afterEach(function () {
    internals.getActiveDeepReadTemplate = originalTemplate;
    internals.callDeepReadChat = originalChat;
  });

  it("finishes every slot when Zotero strips markers after every save", async function () {
    const residualHtml = [
      "<h1>AI 精读 - Paper</h1>",
      "<h2>章节解析</h2>",
      "<p>第1章：引言（Introduction）</p>",
      "<h2>Chapter 1</h2>",
      "<p>⏳ 等待生成...</p>",
      "<h2>Limitations</h2>",
      "<p>⏳ 等待生成...</p>",
    ].join("\n");
    let persistedHtml = residualHtml;
    let pendingHtml = residualHtml;
    let responseCount = 0;
    const note = {
      getNote: () => persistedHtml,
      setNote: (html: string) => {
        pendingHtml = html;
      },
      saveTx: async () => {
        persistedHtml = stripProgressMarkers(pendingHtml);
      },
    } as unknown as Zotero.Item;

    internals.getActiveDeepReadTemplate = () => template;
    internals.callDeepReadChat = async () => {
      responseCount += 1;
      return {
        text: `Completed response ${responseCount}`,
        providerId: "test",
      };
    };

    const result = await internals.generateDeepReadContent({
      item: { id: 1 } as Zotero.Item,
      existing: note,
      existingHtml: residualHtml,
      policy: "skip",
      pdfContent: "PDF",
      isBase64: false,
      itemTitle: "Paper",
      promptLanguage: "zh",
    });

    expect(responseCount).to.equal(2);
    expect(persistedHtml).to.include("Completed response 1");
    expect(persistedHtml).to.include("Completed response 2");
    expect(persistedHtml).not.to.match(/(?:⏳|🔄).*?(?:等待生成|正在生成)/);
    expect(result.noteHtml).not.to.match(/(?:⏳|🔄).*?(?:等待生成|正在生成)/);
  });
});
