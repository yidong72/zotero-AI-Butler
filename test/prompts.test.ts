import { expect } from "chai";
import {
  DEFAULT_CHAPTER_FALLBACKS,
  generateChapterPrompts,
  getBuiltinMultiRoundPromptTemplates,
  mergeMultiRoundPromptTemplates,
  parseChapterStructure,
  parseChapterStructureResult,
  parseManualChapterStructure,
  parseMultiRoundPromptTemplateExport,
  serializeMultiRoundPromptTemplate,
  type MultiRoundPromptTemplate,
} from "../src/utils/prompts";
import {
  buildDeepReadSkeletonHtml,
  countCompletedDeepReadSlots,
  extractDeepReadChaptersFromHtml,
  extractDeepReadPlanMetadata,
  extractRunnableDeepReadSlotIds,
  fillDeepReadSlot,
  getDeepReadSlotBody,
  getDeepReadSlotStatus,
  hasResumableDeepReadSlots,
  isDeepReadSlotDone,
  markDeepReadSlotRunning,
  planDeepReadSlots,
  prepareDeepReadHtmlForPresentation,
  preservesDeepReadDurableMarkers,
  recoverDeepReadFromResidualHtml,
  repairRecoveredDeepReadHtml,
  resetRunningDeepReadSlots,
  shouldRunDeepReadSlot,
  stripDeepReadInternalMarkersForPresentation,
  hasDeepReadV2Slots,
} from "../src/modules/deepReadEngine";

function v2Template(id = "custom"): MultiRoundPromptTemplate {
  return {
    id,
    name: "Custom v2",
    description: "test template",
    version: 2,
    prompts: [],
    phases: [
      {
        id: "chapter_reading",
        title: "阶段一：逐章精读",
        type: "sequential_dynamic",
        description: "read chapters",
        contextStrategy: "last_round",
        planningPrompt: "Return JSON chapters.",
        fixedPrompts: [],
        chapterTemplate: "Read {{title_zh}} / {{title_en}}",
        maxChapters: 2,
      },
      {
        id: "deep_questions",
        title: "阶段二：重点追问",
        type: "independent",
        description: "ask questions",
        parallelizable: false,
        maxConcurrency: 1,
        prompts: [
          { id: "q1", title: "贡献", prompt: "Contribution?", order: 1 },
          { id: "q2", title: "局限", prompt: "Limits?", order: 2 },
        ],
      },
    ],
  };
}

describe("multi-round prompt templates v2", function () {
  it("uses a builtin v2 default template", function () {
    const [builtin] = getBuiltinMultiRoundPromptTemplates();

    expect(builtin.version).to.equal(2);
    expect(builtin.phases.map((phase) => phase.type)).to.deep.equal([
      "sequential_dynamic",
      "independent",
    ]);
    expect(builtin.prompts).to.deep.equal([]);
  });

  it("exports and imports a v2 phase template", function () {
    const imported = parseMultiRoundPromptTemplateExport(
      serializeMultiRoundPromptTemplate(v2Template()),
    );

    expect(imported.id).to.equal("custom");
    expect(imported.version).to.equal(2);
    expect(imported.phases[0].type).to.equal("sequential_dynamic");
    expect(imported.phases[1].type).to.equal("independent");
  });

  it("rejects invalid v2 templates", function () {
    expect(() =>
      parseMultiRoundPromptTemplateExport(
        JSON.stringify({ schema: "wrong", version: 2, template: {} }),
      ),
    ).to.throw("schema");

    const missingPlanning = v2Template();
    if (missingPlanning.phases[0].type === "sequential_dynamic") {
      missingPlanning.phases[0].planningPrompt = "";
    }
    expect(() =>
      parseMultiRoundPromptTemplateExport(
        serializeMultiRoundPromptTemplate(missingPlanning),
      ),
    ).to.throw("planningPrompt");

    const duplicated = v2Template();
    if (duplicated.phases[1].type === "independent") {
      duplicated.phases[1].prompts[0].id = "q2";
    }
    expect(() =>
      parseMultiRoundPromptTemplateExport(
        serializeMultiRoundPromptTemplate(duplicated),
      ),
    ).to.throw("q2");
  });

  it("merges templates by id without duplicates", function () {
    const merged = mergeMultiRoundPromptTemplates(
      [v2Template("same")],
      [{ ...v2Template("same"), name: "New" }],
    );

    expect(merged).to.have.length(1);
    expect(merged[0].name).to.equal("New");
  });

  it("normalizes replacement characters in imported prompt titles", function () {
    const template = v2Template();
    if (template.phases[1].type === "independent") {
      template.phases[1].prompts[0].title =
        "\u6280\u672f\u6c34\u5e73\uFFFD\u521b\u65b0\u6027\uFFFD\u5c55\u671b";
    }

    const imported = parseMultiRoundPromptTemplateExport(
      serializeMultiRoundPromptTemplate(template),
    );

    if (imported.phases[1].type !== "independent") {
      throw new Error("Expected independent phase");
    }
    expect(imported.phases[1].prompts[0].title).to.equal(
      "\u6280\u672f\u6c34\u5e73\u00b7\u521b\u65b0\u6027\u00b7\u5c55\u671b",
    );
  });

  it("parses chapter JSON from plain JSON and markdown fences", function () {
    const plain = parseChapterStructure(
      '{"chapters":[{"id":"intro","title_zh":"引言","title_en":"Introduction"}]}',
    );
    const fenced = parseChapterStructure(
      '```json\n{"chapters":[{"id":"method","title_zh":"方法","title_en":"Method"}]}\n```',
    );

    expect(plain[0]).to.include({ id: "intro", title_zh: "引言" });
    expect(fenced[0]).to.include({ id: "method", title_en: "Method" });
  });

  it("extracts malformed JSON with regex and falls back to two chapters", function () {
    const malformed = parseChapterStructure(
      'chapters: [{"title_zh":"背景", "title_en":"Background"}]',
    );
    const fallback = parseChapterStructure("not chapters at all");

    expect(malformed[0]).to.include({ title_zh: "背景" });
    expect(fallback).to.deep.equal(DEFAULT_CHAPTER_FALLBACKS);
  });

  it("reports chapter parse source and parses manual chapter input", function () {
    const parsed = parseChapterStructureResult(
      'chapters: [{"title_zh":"??", "title_en":"Background"}]',
    );
    const manual = parseManualChapterStructure(
      "Introduction\nChapter 2: Method (Method)",
    );

    expect(parsed.source).to.equal("regex");
    expect(manual.map((chapter) => chapter.title_zh)).to.deep.equal([
      "Introduction",
      "Method",
    ]);
    expect(manual[1].title_en).to.equal("Method");
  });

  it("renders only the first two chapter prompts", function () {
    const prompts = generateChapterPrompts(
      [
        { id: "ch1", title_zh: "引言", title_en: "Introduction" },
        { id: "ch2", title_zh: "方法", title_en: "Method" },
        { id: "ch3", title_zh: "实验", title_en: "Experiments" },
      ],
      "Read {{chapter_index}}. {{title_zh}} / {{title_en}}",
      0,
      2,
    );

    expect(prompts.map((prompt) => prompt.id)).to.deep.equal([
      "chapter_ch1",
      "chapter_ch2",
    ]);
    expect(prompts[1].prompt).to.equal("Read 2. 方法 / Method");
  });

  it("builds and fills ordered deep-read slots", function () {
    const template = v2Template();
    const planned = planDeepReadSlots(template, DEFAULT_CHAPTER_FALLBACKS);
    const html = buildDeepReadSkeletonHtml("Paper", template, planned);
    const filled = fillDeepReadSlot(html, "chapter_ch1", "### Done", "引言");

    expect(planned.slots.map((slot) => slot.id)).to.deep.equal([
      "chapter_ch1",
      "chapter_ch2",
      "q1",
      "q2",
    ]);
    expect(getDeepReadSlotStatus(filled, "chapter_ch1")).to.equal("done");
    expect(html).to.match(/<h1>AI 精读 - Paper[\s\S]*?<\/h1>/);
    expect(html).to.include("<h2>章节解析</h2>");
    expect(html).to.include("<p>第1章：引言（Introduction）</p>");
    expect(html).to.not.include("逐章精读 ⓘ");
    expect(filled).to.match(/<h2>[\s\S]*?引言<\/h2>/);
    expect(shouldRunDeepReadSlot(filled, "chapter_ch1")).to.equal(false);
    expect(shouldRunDeepReadSlot(filled, "chapter_ch2")).to.equal(true);
  });

  it("renders an English deep-read skeleton without changing Chinese defaults", function () {
    const template = v2Template();
    const planned = planDeepReadSlots(template, DEFAULT_CHAPTER_FALLBACKS);
    const html = buildDeepReadSkeletonHtml("Paper", template, planned, "en");

    expect(html).to.match(/<h1>AI Deep Read - Paper[\s\S]*?<\/h1>/);
    expect(html).to.include("<h2>Chapter Structure</h2>");
    expect(html).to.include("<p>Chapter 1: Introduction (引言)</p>");
  });

  it("persists plan metadata and marks running slots", function () {
    const template = v2Template();
    const planned = planDeepReadSlots(template, DEFAULT_CHAPTER_FALLBACKS);
    const html = buildDeepReadSkeletonHtml("Paper", template, planned);
    const running = markDeepReadSlotRunning(html, "chapter_ch1", "Intro");
    const metadata = extractDeepReadPlanMetadata(html);

    expect(metadata?.templateId).to.equal("custom");
    expect(metadata?.chapters).to.deep.equal(DEFAULT_CHAPTER_FALLBACKS);
    expect(metadata?.template?.id).to.equal("custom");
    expect(getDeepReadSlotStatus(running, "chapter_ch1")).to.equal("running");
    expect(isDeepReadSlotDone(running, "chapter_ch1")).to.equal(false);
    const reset = resetRunningDeepReadSlots(running);
    expect(getDeepReadSlotStatus(reset, "chapter_ch1")).to.equal("pending");
    expect(reset).to.include("<!-- zab:slot:chapter_ch1:pending -->");
  });

  it("resumes from durable markers after Zotero removes HTML comments", function () {
    const template = v2Template();
    const planned = planDeepReadSlots(template, DEFAULT_CHAPTER_FALLBACKS);
    const html = fillDeepReadSlot(
      buildDeepReadSkeletonHtml("Paper", template, planned),
      "chapter_ch1",
      "## Introduction\n\nCompleted content",
      "引言",
    );
    const sanitized = html.replace(/<!--[\s\S]*?-->/g, "");

    expect(hasDeepReadV2Slots(sanitized)).to.equal(true);
    expect(getDeepReadSlotStatus(sanitized, "chapter_ch1")).to.equal("done");
    expect(countCompletedDeepReadSlots(sanitized)).to.equal(1);
    expect(extractRunnableDeepReadSlotIds(sanitized)).to.deep.equal([
      "chapter_ch2",
      "q1",
      "q2",
    ]);
    expect(extractDeepReadPlanMetadata(sanitized)?.templateId).to.equal(
      "custom",
    );

    const resumed = fillDeepReadSlot(
      sanitized,
      "chapter_ch2",
      "Second chapter completed",
      "第二章",
    );
    expect(resumed).to.include("Completed content");
    expect(getDeepReadSlotStatus(resumed, "chapter_ch2")).to.equal("done");
    expect(countCompletedDeepReadSlots(resumed)).to.equal(2);
  });

  it("migrates commentless residual notes without discarding completed prose", function () {
    const template = v2Template();
    const planned = planDeepReadSlots(template, DEFAULT_CHAPTER_FALLBACKS);
    const skeleton = buildDeepReadSkeletonHtml("Paper", template, planned);
    const legacy = [
      "<h1>AI 精读 - Paper</h1>",
      "<h2>引言</h2>",
      "<p>Previously completed analysis.</p>",
      "<hr/>",
      "<h2>第二章</h2>",
      "<p>⏳ 等待生成...</p>",
      "<hr/>",
      "<h2>贡献</h2>",
      "<p>⏳ 等待生成...</p>",
      "<hr/>",
      "<h2>局限</h2>",
      "<p>⏳ 等待生成...</p>",
    ].join("\n");

    const recovered = recoverDeepReadFromResidualHtml(
      legacy,
      skeleton,
      planned,
    );

    expect(recovered).to.include("Previously completed analysis.");
    expect(recovered).to.not.include("本轮已从旧版精读笔记恢复");
    expect(recovered).to.not.include("从旧笔记恢复的已完成内容");
    expect(getDeepReadSlotBody(recovered, "chapter_ch1")).to.include(
      "Previously completed analysis.",
    );
    expect(getDeepReadSlotStatus(recovered, "chapter_ch1")).to.equal("done");
    expect(getDeepReadSlotStatus(recovered, "chapter_ch2")).to.equal("pending");
    expect(countCompletedDeepReadSlots(recovered)).to.equal(1);
  });

  it("migrates commentless failed slots as unfinished work", function () {
    const template = v2Template();
    const planned = planDeepReadSlots(template, DEFAULT_CHAPTER_FALLBACKS);
    const skeleton = buildDeepReadSkeletonHtml("Paper", template, planned);
    const legacy = [
      "<h1>AI 精读 - Paper</h1>",
      "<h2>引言</h2>",
      "<p>Previously completed analysis.</p>",
      "<h2>第二章</h2>",
      "<p>❌ upstream connection reset</p>",
    ].join("\n");

    const recovered = recoverDeepReadFromResidualHtml(
      legacy,
      skeleton,
      planned,
    );

    expect(recovered).to.include("Previously completed analysis.");
    expect(recovered).to.not.include("upstream connection reset");
    expect(getDeepReadSlotStatus(recovered, "chapter_ch1")).to.equal("done");
    expect(getDeepReadSlotStatus(recovered, "chapter_ch2")).to.equal("pending");
  });

  it("keeps partial prose while removing trailing legacy status blocks", function () {
    const template = v2Template();
    const planned = planDeepReadSlots(template, DEFAULT_CHAPTER_FALLBACKS);
    const skeleton = buildDeepReadSkeletonHtml("Paper", template, planned);
    const legacy = [
      "<h1>AI 精读 - Paper</h1>",
      "<h2>引言</h2>",
      "<p>Useful partial analysis.</p>",
      "<p>⏳ 等待生成...</p>",
      "<h2>第二章</h2>",
      "<p>❌ upstream reset</p>",
    ].join("\n");

    const recovered = recoverDeepReadFromResidualHtml(
      legacy,
      skeleton,
      planned,
    );

    expect(getDeepReadSlotStatus(recovered, "chapter_ch1")).to.equal("pending");
    expect(getDeepReadSlotStatus(recovered, "chapter_ch2")).to.equal("pending");
    expect(recovered).to.include("未匹配的旧笔记内容");
    expect(recovered.match(/Useful partial analysis\./g)).to.have.length(1);
    expect(recovered).to.not.include("upstream reset");
  });

  it("maps English legacy headings into their exact chapter slots", function () {
    const template = v2Template();
    const chapters = [
      { id: "intro", title_zh: "Introduction", title_en: "Introduction" },
      {
        id: "related",
        title_zh: "Related Work",
        title_en: "Related Work",
      },
    ];
    const planned = planDeepReadSlots(template, chapters);
    const skeleton = buildDeepReadSkeletonHtml(
      "Paper",
      template,
      planned,
      "en",
    );
    const legacy = [
      "<h1>AI Deep Read - Paper</h1>",
      "<h2>Chapter 1: Introduction</h2>",
      "<p>Recovered introduction.</p>",
      "<h3>Background</h3>",
      "<p>Nested subsection stays in the same slot.</p>",
      "<h2>Chapter 2 Reading: Related Work</h2>",
      "<p>Recovered related work.</p>",
      "<h2>Contribution</h2>",
      "<p>⏳ 等待生成...</p>",
    ].join("\n");

    const recovered = recoverDeepReadFromResidualHtml(
      legacy,
      skeleton,
      planned,
      "en",
    );

    expect(getDeepReadSlotBody(recovered, "chapter_intro")).to.include(
      "Recovered introduction.",
    );
    expect(getDeepReadSlotBody(recovered, "chapter_intro")).to.include(
      "Nested subsection stays in the same slot.",
    );
    expect(getDeepReadSlotBody(recovered, "chapter_related")).to.include(
      "Recovered related work.",
    );
    expect(getDeepReadSlotStatus(recovered, "chapter_intro")).to.equal("done");
    expect(getDeepReadSlotStatus(recovered, "chapter_related")).to.equal(
      "done",
    );
    expect(getDeepReadSlotStatus(recovered, "q1")).to.equal("pending");
  });

  it("preserves unmatched legacy sections exactly once", function () {
    const template = v2Template();
    const planned = planDeepReadSlots(template, DEFAULT_CHAPTER_FALLBACKS);
    const skeleton = buildDeepReadSkeletonHtml("Paper", template, planned);
    const legacy = [
      "<h1>AI 精读 - Paper</h1>",
      "<h2>Author Notes</h2>",
      "<p>Keep this material.</p>",
      "<h2>引言</h2>",
      "<p>Recovered introduction.</p>",
      "<h2>第二章</h2>",
      "<p>⏳ 等待生成...</p>",
    ].join("\n");

    const recovered = recoverDeepReadFromResidualHtml(
      legacy,
      skeleton,
      planned,
    );

    expect(recovered).to.include("<h2>未匹配的旧笔记内容</h2>");
    expect(recovered.match(/Author Notes/g)).to.have.length(1);
    expect(recovered.match(/Keep this material\./g)).to.have.length(1);
    expect(getDeepReadSlotStatus(recovered, "chapter_ch2")).to.equal("pending");
  });

  it("preserves leading prose and image-only legacy material", function () {
    const template = v2Template();
    const planned = planDeepReadSlots(template, DEFAULT_CHAPTER_FALLBACKS);
    const skeleton = buildDeepReadSkeletonHtml("Paper", template, planned);
    const legacy = [
      "<h1>AI 精读 - Paper</h1>",
      "<p>Personal preface before the first section.</p>",
      "<h2>Author Figure</h2>",
      '<p><img src="data:image/png;base64,abc" alt="diagram"/></p>',
      "<h2>引言</h2>",
      "<p>⏳ 等待生成...</p>",
    ].join("\n");

    const recovered = recoverDeepReadFromResidualHtml(
      legacy,
      skeleton,
      planned,
    );

    expect(recovered.match(/Personal preface/g)).to.have.length(1);
    expect(recovered.match(/data:image\/png/g)).to.have.length(1);
    expect(recovered).to.include("未匹配的旧笔记内容");
  });

  it("leaves ambiguous duplicate headings unmatched", function () {
    const template = v2Template();
    const chapters = [
      { id: "method_a", title_zh: "方法", title_en: "Methods" },
      { id: "method_b", title_zh: "方法", title_en: "Methods" },
    ];
    const planned = planDeepReadSlots(template, chapters);
    const skeleton = buildDeepReadSkeletonHtml("Paper", template, planned);
    const legacy = [
      "<h1>AI 精读 - Paper</h1>",
      "<h2>Methods</h2>",
      "<p>Uncertain method prose.</p>",
      "<h2>贡献</h2>",
      "<p>⏳ 等待生成...</p>",
    ].join("\n");

    const recovered = recoverDeepReadFromResidualHtml(
      legacy,
      skeleton,
      planned,
    );

    expect(getDeepReadSlotStatus(recovered, "chapter_method_a")).to.equal(
      "pending",
    );
    expect(getDeepReadSlotStatus(recovered, "chapter_method_b")).to.equal(
      "pending",
    );
    expect(recovered.match(/Uncertain method prose/g)).to.have.length(1);
  });

  it("repairs previously migrated notice slots without another model response", function () {
    const template = v2Template();
    const planned = planDeepReadSlots(template, DEFAULT_CHAPTER_FALLBACKS);
    const skeleton = buildDeepReadSkeletonHtml("Paper", template, planned);
    const notice = "本轮已从旧版精读笔记恢复，原始内容完整保留在下方。";
    const noticeSlot = fillDeepReadSlot(
      skeleton,
      "chapter_ch1",
      notice,
      "引言",
    ).replace(
      "<!-- zab:slot:chapter_ch1:end -->",
      "<p>Manual note beside the recovery notice.</p>\n<!-- zab:slot:chapter_ch1:end -->",
    );
    const migrated = `${noticeSlot}\n<hr/>\n<h2>从旧笔记恢复的已完成内容</h2>\n<h2>Introduction (引言)</h2>\n<p>Actual recovered prose.</p>`;

    const repaired = repairRecoveredDeepReadHtml(migrated);

    expect(getDeepReadSlotBody(repaired, "chapter_ch1")).to.include(
      "Actual recovered prose.",
    );
    expect(repaired).to.not.include(notice);
    expect(repaired).to.not.include("从旧笔记恢复的已完成内容");
    expect(
      repaired.match(/Manual note beside the recovery notice\./g),
    ).to.have.length(1);
    expect(repairRecoveredDeepReadHtml(repaired)).to.equal(repaired);
  });

  it("removes an inline recovery notice while preserving its annotation", function () {
    const template = v2Template();
    const planned = planDeepReadSlots(template, DEFAULT_CHAPTER_FALLBACKS);
    const skeleton = buildDeepReadSkeletonHtml("Paper", template, planned);
    const notice = "本轮已从旧版精读笔记恢复，原始内容完整保留在下方。";
    const noticeSlot = fillDeepReadSlot(
      skeleton,
      "chapter_ch1",
      `${notice} Keep this inline annotation.`,
      "引言",
    );
    const migrated = `${noticeSlot}\n<hr/>\n<h2>从旧笔记恢复的已完成内容</h2>\n<h2>引言</h2>\n<p>Recovered chapter prose.</p>`;

    const repaired = repairRecoveredDeepReadHtml(migrated);

    expect(repaired).to.not.include(notice);
    expect(repaired.match(/Keep this inline annotation\./g)).to.have.length(1);
    expect(getDeepReadSlotStatus(repaired, "chapter_ch1")).to.equal("done");
  });

  it("resets unmatched migrated notice slots so resume can regenerate them", function () {
    const template = v2Template();
    const planned = planDeepReadSlots(template, DEFAULT_CHAPTER_FALLBACKS);
    const skeleton = buildDeepReadSkeletonHtml("Paper", template, planned);
    const notice = "本轮已从旧版精读笔记恢复，原始内容完整保留在下方。";
    const migrated = `${fillDeepReadSlot(
      fillDeepReadSlot(skeleton, "chapter_ch1", notice, "引言"),
      "chapter_ch2",
      notice,
      "第二章",
    )}\n<hr/>\n<h2>从旧笔记恢复的已完成内容</h2>\n<h2>Introduction (引言)</h2>\n<p>Recovered introduction.</p>\n<h2>Unknown old section</h2>\n<p>Preserve me once.</p>`;

    const repaired = repairRecoveredDeepReadHtml(migrated);

    expect(getDeepReadSlotStatus(repaired, "chapter_ch1")).to.equal("done");
    expect(getDeepReadSlotStatus(repaired, "chapter_ch2")).to.equal("pending");
    expect(getDeepReadSlotBody(repaired, "chapter_ch2")).to.include("等待生成");
    expect(repaired).to.not.include(notice);
    expect(repaired.match(/Preserve me once\./g)).to.have.length(1);
    expect(repairRecoveredDeepReadHtml(repaired)).to.equal(repaired);
  });

  it("resets a notice-only migrated slot even when its appendix is missing", function () {
    const template = v2Template();
    const planned = planDeepReadSlots(template, DEFAULT_CHAPTER_FALLBACKS);
    const notice = "本轮已从旧版精读笔记恢复，原始内容完整保留在下方。";
    const migrated = fillDeepReadSlot(
      buildDeepReadSkeletonHtml("Paper", template, planned),
      "chapter_ch1",
      notice,
      "引言",
    )
      .replace(
        "<!-- zab:slot:chapter_ch1:end -->",
        "<p>Keep my manual annotation.</p>\n<!-- zab:slot:chapter_ch1:end -->",
      )
      .replace(/<!-- zab:deep-read-plan:[\s\S]*? -->\n?/, "")
      .replace(/<a\b[^>]*href="zab:\/\/plan\/[^"]*"[^>]*>[\s\S]*?<\/a>/i, "");

    const repaired = repairRecoveredDeepReadHtml(migrated);

    expect(getDeepReadSlotStatus(repaired, "chapter_ch1")).to.equal("pending");
    expect(repaired).to.not.include(notice);
    expect(repaired.match(/Keep my manual annotation\./g)).to.have.length(1);
    expect(repairRecoveredDeepReadHtml(repaired)).to.equal(repaired);
  });

  it("recovers notice-and-append notes even when every state marker was stripped", function () {
    const template = v2Template();
    const planned = planDeepReadSlots(template, DEFAULT_CHAPTER_FALLBACKS);
    const notice = "本轮已从旧版精读笔记恢复，原始内容完整保留在下方。";
    const migrated = `${fillDeepReadSlot(
      buildDeepReadSkeletonHtml("Paper", template, planned),
      "chapter_ch1",
      notice,
      "引言",
    )}\n<hr/>\n<h2>从旧笔记恢复的已完成内容</h2>\n<h2>Introduction (引言)</h2>\n<p>Only surviving recovered prose.</p>`;
    const markerless = stripDeepReadInternalMarkersForPresentation(migrated);
    const skeleton = buildDeepReadSkeletonHtml("Paper", template, planned);

    const recovered = recoverDeepReadFromResidualHtml(
      markerless,
      skeleton,
      planned,
    );

    expect(getDeepReadSlotStatus(recovered, "chapter_ch1")).to.equal("done");
    expect(getDeepReadSlotBody(recovered, "chapter_ch1")).to.include(
      "Only surviving recovered prose.",
    );
    expect(recovered).to.not.include(notice);
  });

  it("strips private markers only from presentation copies", function () {
    const template = v2Template();
    const planned = planDeepReadSlots(template, DEFAULT_CHAPTER_FALLBACKS);
    const raw = fillDeepReadSlot(
      buildDeepReadSkeletonHtml("Paper", template, planned),
      "chapter_ch1",
      "Read [the source](https://example.com).",
      "引言",
    );
    const visible = prepareDeepReadHtmlForPresentation(raw);

    expect(raw).to.include("zab://slot/");
    expect(visible).to.not.include("zab://");
    expect(visible).to.not.include("zab:slot:");
    expect(visible).to.not.include("&#8203;");
    expect(visible).to.include("https://example.com");
    expect(stripDeepReadInternalMarkersForPresentation(visible)).to.equal(
      visible,
    );
    expect(preservesDeepReadDurableMarkers(raw, raw)).to.equal(true);
    expect(preservesDeepReadDurableMarkers(raw, visible)).to.equal(false);
  });

  it("does not hide valid sections before or after a recovery notice", function () {
    const notice = "本轮已从旧版精读笔记恢复，原始内容完整保留在下方。";
    const visible = prepareDeepReadHtmlForPresentation(
      [
        "<h2>Chapter Structure</h2>",
        "<p>Chapter 1: Introduction</p>",
        "<h2>Introduction</h2>",
        `<p><span>${notice}</span></p>`,
        "<hr/>",
        "<h2>Related Work</h2>",
        "<p>Valid generated prose.</p>",
      ].join("\n"),
    );

    expect(visible).to.include("Chapter Structure");
    expect(visible).to.include("Chapter 1: Introduction");
    expect(visible).to.include("Related Work");
    expect(visible).to.include("Valid generated prose.");
    expect(visible).to.not.include(notice);
  });

  it("hides an inline recovery notice but keeps adjacent user text", function () {
    const notice = "本轮已从旧版精读笔记恢复，原始内容完整保留在下方。";
    const visible = prepareDeepReadHtmlForPresentation(
      `<h2>Introduction</h2><p>${notice} Keep this annotation.</p>`,
    );

    expect(visible).to.include("Introduction");
    expect(visible).to.include("Keep this annotation.");
    expect(visible).to.not.include(notice);
  });

  it("preserves visible content around malformed private marker anchors", function () {
    const visible = prepareDeepReadHtmlForPresentation(
      [
        "<a data-state=\"x\" href='zab://slot/ch1/done/start'>&#x200B;</a>",
        "<p>Keep this paragraph.</p>",
        '<a href="zab://slot/ch1/done/end">',
        '<a href="https://example.com">ordinary source</a>',
        "\u200B",
      ].join(""),
    );

    expect(visible).to.not.include("zab://");
    expect(visible).to.not.include("200B");
    expect(visible).to.not.include("\u200B");
    expect(visible).to.include("Keep this paragraph.");
    expect(visible).to.include("https://example.com");
    expect(visible).to.include("ordinary source");
  });

  it("rejects reordered and comment-only state marker loss", function () {
    const commentOnly = [
      "<!-- zab:slot:first:pending -->",
      "<p>One</p>",
      "<!-- zab:slot:first:end -->",
      "<!-- zab:slot:second:pending -->",
      "<p>Two</p>",
      "<!-- zab:slot:second:end -->",
    ].join("\n");
    const reordered = commentOnly
      .replace(/first/g, "temporary")
      .replace(/second/g, "first")
      .replace(/temporary/g, "second");

    expect(preservesDeepReadDurableMarkers(commentOnly, commentOnly)).to.equal(
      true,
    );
    expect(preservesDeepReadDurableMarkers(commentOnly, reordered)).to.equal(
      false,
    );
    expect(
      preservesDeepReadDurableMarkers(
        commentOnly,
        commentOnly.replace(/<!--[\s\S]*?-->/g, ""),
      ),
    ).to.equal(false);
  });

  it("restores sanitized marker URLs containing apostrophes", function () {
    const template = v2Template("reader's-template");
    template.description = "Read the paper's structure.";
    const chapters = [
      {
        id: "author's-method",
        title_zh: "作者方法",
        title_en: "Author's Method",
      },
    ];
    const planned = planDeepReadSlots(template, chapters);
    const raw = buildDeepReadSkeletonHtml("Paper", template, planned, "en");
    const legacySanitized = raw
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/%27/gi, "'");

    expect(
      extractDeepReadPlanMetadata(legacySanitized)?.template?.description,
    ).to.equal("Read the paper's structure.");
    expect(
      getDeepReadSlotStatus(legacySanitized, "chapter_author's-method"),
    ).to.equal("pending");
    expect(extractRunnableDeepReadSlotIds(legacySanitized)).to.include(
      "chapter_author's-method",
    );
    expect(prepareDeepReadHtmlForPresentation(legacySanitized)).to.not.include(
      "zab://",
    );
  });

  it("recovers instead of resuming a slot whose end marker was lost", function () {
    const template = v2Template();
    const planned = planDeepReadSlots(template, DEFAULT_CHAPTER_FALLBACKS);
    const notice = "本轮已从旧版精读笔记恢复，原始内容完整保留在下方。";
    const migrated = `${fillDeepReadSlot(
      buildDeepReadSkeletonHtml("Paper", template, planned),
      "chapter_ch1",
      notice,
      "引言",
    )}\n<hr/>\n<h2>从旧笔记恢复的已完成内容</h2>\n<h2>引言</h2>\n<p>Recovered after marker damage.</p>`;
    const damaged = migrated
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(
        /<a\b[^>]*href="zab:\/\/slot\/chapter_ch1\/done\/end"[^>]*>[\s\S]*?<\/a>/i,
        "",
      );

    expect(hasResumableDeepReadSlots(damaged)).to.equal(false);
    expect(extractRunnableDeepReadSlotIds(damaged)).to.include("chapter_ch1");

    const recovered = recoverDeepReadFromResidualHtml(
      damaged,
      buildDeepReadSkeletonHtml("Paper", template, planned),
      planned,
    );
    expect(getDeepReadSlotBody(recovered, "chapter_ch1")).to.include(
      "Recovered after marker damage.",
    );
  });

  it("rejects crossed and duplicated slot marker ranges before resume", function () {
    const crossed = [
      "<!-- zab:slot:a:pending -->",
      '<h2><a href="zab://slot/a/pending/start">&#8203;</a>A</h2>',
      "<!-- zab:slot:b:pending -->",
      '<h2><a href="zab://slot/b/pending/start">&#8203;</a>B</h2>',
      "<!-- zab:slot:a:end -->",
      '<p><a href="zab://slot/a/pending/end">&#8203;</a></p>',
      "<!-- zab:slot:b:end -->",
      '<p><a href="zab://slot/b/pending/end">&#8203;</a></p>',
    ].join("\n");
    const duplicated = [
      "<!-- zab:slot:a:pending -->",
      "<h2>A</h2>",
      "<!-- zab:slot:a:pending -->",
      "<p>⏳ 等待生成...</p>",
      "<!-- zab:slot:a:end -->",
    ].join("\n");
    const conflictingStatus = [
      "<!-- zab:slot:a:pending -->",
      '<h2><a href="zab://slot/a/done/start">&#8203;</a>A</h2>',
      '<p>⏳ 等待生成...<a href="zab://slot/a/done/end">&#8203;</a></p>',
      "<!-- zab:slot:a:end -->",
    ].join("\n");
    const crossedChannels = [
      "<!-- zab:slot:a:pending -->",
      '<h2><a href="zab://slot/b/pending/start">&#8203;</a>A</h2>',
      '<p><a href="zab://slot/b/pending/end">&#8203;</a></p>',
      "<!-- zab:slot:a:end -->",
      "<!-- zab:slot:b:pending -->",
      '<h2><a href="zab://slot/a/pending/start">&#8203;</a>B</h2>',
      '<p><a href="zab://slot/a/pending/end">&#8203;</a></p>',
      "<!-- zab:slot:b:end -->",
    ].join("\n");
    const mixedChannelOverlap = [
      "<!-- zab:slot:a:pending -->",
      '<h2><a href="zab://slot/b/pending/start">&#8203;</a>A</h2>',
      '<p>⏳ 等待生成...<a href="zab://slot/b/pending/end">&#8203;</a></p>',
      "<!-- zab:slot:a:end -->",
    ].join("\n");
    const disjointSameSlotChannels = [
      "<!-- zab:slot:a:pending -->",
      "<h2>A</h2><p>⏳ 等待生成...</p>",
      "<!-- zab:slot:a:end -->",
      '<h2><a href="zab://slot/a/pending/start">&#8203;</a>Stale A</h2>',
      '<p><a href="zab://slot/a/pending/end">&#8203;</a></p>',
    ].join("\n");

    expect(extractRunnableDeepReadSlotIds(crossed)).to.include.members([
      "a",
      "b",
    ]);
    expect(getDeepReadSlotBody(crossed, "a")).to.not.equal(null);
    expect(hasResumableDeepReadSlots(crossed)).to.equal(false);
    expect(hasResumableDeepReadSlots(duplicated)).to.equal(false);
    expect(hasResumableDeepReadSlots(conflictingStatus)).to.equal(false);
    expect(hasResumableDeepReadSlots(crossedChannels)).to.equal(false);
    expect(hasResumableDeepReadSlots(mixedChannelOverlap)).to.equal(false);
    expect(hasResumableDeepReadSlots(disjointSameSlotChannels)).to.equal(false);
  });

  it("supports colon-bearing slot IDs when only comments survive", function () {
    const template = v2Template();
    if (template.phases[1].type !== "independent") {
      throw new Error("Expected independent phase");
    }
    template.phases[1].prompts[0].id = "round:1";
    const planned = planDeepReadSlots(template, DEFAULT_CHAPTER_FALLBACKS);
    const commentOnly = buildDeepReadSkeletonHtml(
      "Paper",
      template,
      planned,
    ).replace(
      /<a\b[^>]*href="zab:\/\/(?:slot|plan)\/[^"]*"[^>]*>[\s\S]*?<\/a>/gi,
      "",
    );

    expect(extractRunnableDeepReadSlotIds(commentOnly)).to.include("round:1");
    expect(getDeepReadSlotStatus(commentOnly, "round:1")).to.equal("pending");
  });

  it("extracts English chapter lists with the correct title orientation", function () {
    const chapters = extractDeepReadChaptersFromHtml(
      [
        "<h1>AI Deep Read - Paper</h1>",
        "<h2>Chapter Structure</h2>",
        "<p>Chapter 1: Introduction (引言)</p>",
        "<p>Chapter 2: Related Work (相关工作)</p>",
      ].join("\n"),
      "en",
    );

    expect(chapters).to.deep.equal([
      { id: "ch1", title_zh: "引言", title_en: "Introduction" },
      { id: "ch2", title_zh: "相关工作", title_en: "Related Work" },
    ]);
  });

  it("scopes chapter recovery and keeps monolingual parentheses intact", function () {
    const chapters = extractDeepReadChaptersFromHtml(
      [
        "<h1>AI Deep Read - Paper</h1>",
        "<h2>Chapter Structure</h2>",
        "<p>Chapter 1: Analysis (Special Case)</p>",
        "<h2>Discussion</h2>",
        "<p>Chapter 2: This is generated prose, not a plan entry.</p>",
      ].join("\n"),
      "en",
    );

    expect(chapters).to.deep.equal([
      {
        id: "ch1",
        title_zh: "",
        title_en: "Analysis (Special Case)",
      },
    ]);
  });

  it("recovers chapters from rendered deep-read notes when metadata is missing", function () {
    const template = v2Template();
    const planned = planDeepReadSlots(template, DEFAULT_CHAPTER_FALLBACKS);
    const html = buildDeepReadSkeletonHtml("Paper", template, planned).replace(
      /<!-- zab:deep-read-plan:[\s\S]*? -->\n?/,
      "",
    );

    const chapters = extractDeepReadChaptersFromHtml(html);

    expect(chapters).to.deep.equal(DEFAULT_CHAPTER_FALLBACKS);
    expect(planDeepReadSlots(template, chapters).slots[0].id).to.equal(
      "chapter_ch1",
    );
  });

  it("rejects duplicate dynamically planned slot ids", function () {
    expect(() =>
      planDeepReadSlots(v2Template(), [
        { id: "same", title_zh: "A", title_en: "A" },
        { id: "same", title_zh: "B", title_en: "B" },
      ]),
    ).to.throw("slot ID");
  });

  it("does not duplicate model-provided top-level slot headings", function () {
    const template = v2Template();
    const planned = planDeepReadSlots(template, DEFAULT_CHAPTER_FALLBACKS);
    const html = buildDeepReadSkeletonHtml("Paper", template, planned);
    const filled = fillDeepReadSlot(
      html,
      "chapter_ch1",
      "## 第1章精读：Introduction\n\n### Done",
      "引言",
    );

    expect(filled).to.not.include("<h2>引言</h2>");
    expect(filled).to.match(/<h2>[\s\S]*?第1章精读：Introduction<\/h2>/);
  });

  it("keeps deep-read prose from becoming a top-level heading", function () {
    const template = v2Template();
    const planned = planDeepReadSlots(template, DEFAULT_CHAPTER_FALLBACKS);
    const html = buildDeepReadSkeletonHtml("Paper", template, planned);
    const prose =
      "在互联网安全领域，基于域名系统（DNS）的反射放大分布式拒绝服务（DRDoS）攻击一直是一项严峻的挑战。尽管学术界和工业界已经提出了诸如服务器屏蔽、访问控制、速率限制等多种防御措施，但开放DNS（ODNS）基础设施依然频繁被攻击者滥用。";
    const filled = fillDeepReadSlot(
      html,
      "q1",
      `## 综述精读\n\n### 论文概述与核心背景\n\n# ${prose}`,
      "综述摘要精读",
    );

    expect(filled).to.match(/<h2>[\s\S]*?综述精读<\/h2>/);
    expect(filled).to.include("<h3>论文概述与核心背景</h3>");
    expect(filled).to.include(`<p>${prose}`);
    expect(filled).to.not.include(`<h1>${prose}</h1>`);
  });
});
