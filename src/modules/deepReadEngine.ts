import { markdownToZoteroNoteHtml, escapeHtml } from "./noteMarkdown";
import {
  generateChapterPrompts,
  type ChapterInfo,
  type DeepReadSlotStatus,
  type MultiRoundIndependentPhase,
  type MultiRoundPromptItem,
  type MultiRoundPromptPhase,
  type MultiRoundPromptTemplate,
  type MultiRoundSequentialDynamicPhase,
  type PromptLang,
} from "../utils/prompts";

export type DeepReadSlot = {
  id: string;
  title: string;
  prompt: string;
  phaseId: string;
  phaseTitle: string;
  phaseType: "sequential_dynamic" | "independent";
  status: DeepReadSlotStatus;
};

export type PlannedDeepRead = {
  chapters: ChapterInfo[];
  slots: DeepReadSlot[];
  sequentialSlots: DeepReadSlot[];
  independentSlots: DeepReadSlot[];
};

export type DeepReadPlanMetadata = {
  templateId: string;
  chapters: ChapterInfo[];
  template?: MultiRoundPromptTemplate;
};

export const DEEP_READ_SLOT_PREFIX = "zab:slot";
const DEEP_READ_DURABLE_SLOT_PREFIX = "zab://slot/";

/**
 * 精读 slot 占位符（“⏳ 等待生成...”/“🔄 正在生成...”）的专用匹配。
 *
 * 必须带 emoji 前缀（⏳ / 🔄），否则会误伤正文里正常出现的“生成”相关文字——
 * 例如关于“数据生成”的论文，章节内容本身就可能包含“正在生成 / 等待生成”等词，
 * 若用裸词匹配会把已正确生成的笔记误判为损坏，导致反复重生的死循环。
 */
const DEEP_READ_PLACEHOLDER_RE = /(?:⏳|🔄)️?\s*(?:等待生成|正在生成)/;
const DEEP_READ_LEGACY_INCOMPLETE_RE =
  /(?:⏳|🔄)️?\s*(?:等待生成|正在生成)|<p[^>]*>\s*❌|已取消，重新运行\s*AI\s*精读时会从这里继续/;
export const DEEP_READ_PLAN_META_PREFIX = "zab:deep-read-plan";
const DEEP_READ_DURABLE_PLAN_PREFIX = "zab://plan/";

export function planDeepReadSlots(
  template: MultiRoundPromptTemplate,
  chapters: ChapterInfo[],
): PlannedDeepRead {
  const slots: DeepReadSlot[] = [];
  const sequentialSlots: DeepReadSlot[] = [];
  const independentSlots: DeepReadSlot[] = [];

  for (const phase of template.phases) {
    if (phase.type === "sequential_dynamic") {
      const phaseSlots = createSequentialSlots(phase, chapters);
      slots.push(...phaseSlots);
      sequentialSlots.push(...phaseSlots);
      continue;
    }

    const phaseSlots = createIndependentSlots(phase);
    slots.push(...phaseSlots);
    independentSlots.push(...phaseSlots);
  }

  validatePlannedSlotIds(slots);
  return { chapters, slots, sequentialSlots, independentSlots };
}

export function buildDeepReadSkeletonHtml(
  itemTitle: string,
  template: MultiRoundPromptTemplate,
  planned: PlannedDeepRead,
  lang: PromptLang = "zh",
): string {
  const noteTitle = lang === "en" ? "AI Deep Read" : "AI 精读";
  const chapterHeading = lang === "en" ? "Chapter Structure" : "章节解析";
  const parts: string[] = [
    buildPlanMetadataComment(template, planned.chapters),
    `<h1>${noteTitle} - ${escapeHtml(truncateTitle(itemTitle))}${buildDurablePlanMarker(
      template,
      planned.chapters,
    )}</h1>`,
    `<h2>${chapterHeading}</h2>`,
    ...buildChapterListHtml(planned.chapters, lang),
  ];

  for (const phase of template.phases) {
    const phaseSlots = planned.slots.filter(
      (slot) => slot.phaseId === phase.id,
    );
    if (!phaseSlots.length) continue;
    for (let index = 0; index < phaseSlots.length; index++) {
      const slot = phaseSlots[index];
      parts.push(buildPendingSlotHtml(slot));
      if (index < phaseSlots.length - 1) {
        parts.push("<hr/>");
      }
    }
  }

  return parts.join("\n");
}

export function fillDeepReadSlot(
  noteHtml: string,
  slotId: string,
  markdown: string,
  slotTitle?: string,
  status: "done" | "error" = "done",
): string {
  const headingHtml = shouldPrependSlotHeading(markdown, slotTitle)
    ? `<h2>${escapeHtml(slotTitle || "")}</h2>\n`
    : "";
  const htmlContent =
    status === "done"
      ? `${headingHtml}${markdownToDeepReadSlotHtml(markdown)}`
      : `${headingHtml}<p>❌ ${escapeHtml(markdown)}</p>`;
  return replaceDeepReadSlotHtml(
    noteHtml,
    slotId,
    addDurableSlotMarkers(htmlContent, slotId, status),
    status,
  );
}

function markdownToDeepReadSlotHtml(markdown: string): string {
  const normalizedMarkdown = normalizeDeepReadSlotMarkdown(markdown);
  const html = markdownToZoteroNoteHtml(normalizedMarkdown);
  return normalizeDeepReadSlotHtml(html);
}

function normalizeDeepReadSlotMarkdown(markdown: string): string {
  return markdown.replace(
    /^(#{1,6})\s+(.+?)\s*#*\s*$/gm,
    (match, markers: string, rawTitle: string) => {
      const title = rawTitle.trim();
      if (!title) return match;
      if (markers.length === 1 && looksLikeProseHeading(title)) {
        return title;
      }
      const level = Math.max(2, markers.length);
      return `${"#".repeat(level)} ${title}`;
    },
  );
}

function normalizeDeepReadSlotHtml(html: string): string {
  return html.replace(/<h1>([\s\S]*?)<\/h1>/g, (_match, title: string) => {
    const plainTitle = stripHtml(title).trim();
    if (looksLikeProseHeading(plainTitle)) {
      return `<p>${title}</p>`;
    }
    return `<h2>${title}</h2>`;
  });
}

function looksLikeProseHeading(text: string): boolean {
  const normalized = text.replace(/\s+/g, "").trim();
  return normalized.length >= 60 && /[。！？.!?]$/.test(normalized);
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function shouldPrependSlotHeading(
  markdown: string,
  slotTitle?: string,
): boolean {
  if (!slotTitle) return false;
  return !/^\s*#{1,2}\s+\S/m.test(markdown);
}

export function replaceDeepReadSlotHtml(
  noteHtml: string,
  slotId: string,
  innerHtml: string,
  status: DeepReadSlotStatus,
): string {
  const pattern = new RegExp(
    `<!-- ${DEEP_READ_SLOT_PREFIX}:${escapeRegExp(slotId)}:(?:pending|running|done|error) -->[\\s\\S]*?<!-- ${DEEP_READ_SLOT_PREFIX}:${escapeRegExp(slotId)}:end -->`,
  );
  if (pattern.test(noteHtml)) {
    return noteHtml.replace(
      pattern,
      `<!-- ${DEEP_READ_SLOT_PREFIX}:${slotId}:${status} -->\n${innerHtml}\n<!-- ${DEEP_READ_SLOT_PREFIX}:${slotId}:end -->`,
    );
  }

  const durableRange = findDurableSlotRange(noteHtml, slotId);
  if (!durableRange) return noteHtml;
  return `${noteHtml.slice(0, durableRange.start)}${innerHtml}${noteHtml.slice(
    durableRange.end,
  )}`;
}

export function getDeepReadSlotStatus(
  noteHtml: string,
  slotId: string,
): DeepReadSlotStatus | null {
  const match = noteHtml.match(
    new RegExp(
      `<!-- ${DEEP_READ_SLOT_PREFIX}:${escapeRegExp(slotId)}:(pending|running|done|error) -->`,
    ),
  );
  if (match?.[1]) return match[1] as DeepReadSlotStatus;

  const durable = noteHtml.match(buildDurableSlotMarkerRegex(slotId, "start"));
  return (durable?.[1] as DeepReadSlotStatus | undefined) || null;
}

/** 提取某个 slot 起止标记之间的正文（含 HTML）；找不到返回 null。 */
export function getDeepReadSlotBody(
  noteHtml: string,
  slotId: string,
): string | null {
  const match = noteHtml.match(
    new RegExp(
      `<!-- ${DEEP_READ_SLOT_PREFIX}:${escapeRegExp(slotId)}:(?:pending|running|done|error) -->([\\s\\S]*?)<!-- ${DEEP_READ_SLOT_PREFIX}:${escapeRegExp(slotId)}:end -->`,
    ),
  );
  if (match) return match[1];

  const range = findDurableSlotRange(noteHtml, slotId);
  return range ? noteHtml.slice(range.start, range.end) : null;
}

/**
 * 判断 slot 正文是否仍是占位符（“等待生成 / 正在生成”）或空内容。
 * 用于识别“标记为 done 但内容并未真正生成”的损坏 slot，使其能被重新生成。
 */
export function isDeepReadSlotBodyPlaceholder(body: string | null): boolean {
  if (body == null) return true;
  if (DEEP_READ_PLACEHOLDER_RE.test(body)) return true;
  const contentText = body
    .replace(/<a\b[^>]*href=["']zab:\/\/slot\/[\s\S]*?<\/a>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#8203;/g, "")
    .replace(/[\u200B-\u200D\uFEFF\s]/g, "");
  return contentText.length === 0;
}

export function shouldRunDeepReadSlot(
  noteHtml: string,
  slotId: string,
): boolean {
  const status = getDeepReadSlotStatus(noteHtml, slotId);
  if (status === "pending" || status === "running" || status === "error") {
    return true;
  }
  // 标记为 done 但正文仍是占位符（损坏的 slot）→ 视为未完成，需要重跑。
  if (status === "done") {
    return isDeepReadSlotBodyPlaceholder(getDeepReadSlotBody(noteHtml, slotId));
  }
  return false;
}

export function isDeepReadSlotDone(noteHtml: string, slotId: string): boolean {
  return getDeepReadSlotStatus(noteHtml, slotId) === "done";
}

export function hasDeepReadV2Slots(noteHtml: string): boolean {
  return (
    noteHtml.includes(`<!-- ${DEEP_READ_SLOT_PREFIX}:`) ||
    noteHtml.includes(DEEP_READ_DURABLE_SLOT_PREFIX)
  );
}

export function hasRunnableDeepReadSlots(noteHtml: string): boolean {
  return extractRunnableDeepReadSlotIds(noteHtml).length > 0;
}

export function countCompletedDeepReadSlots(noteHtml: string): number {
  const ids = new Set<string>();
  const commentPattern =
    /<!-- zab:slot:([^:]+):done -->([\s\S]*?)<!-- zab:slot:\1:end -->/g;
  let match: RegExpExecArray | null;
  while ((match = commentPattern.exec(noteHtml))) {
    if (!isDeepReadSlotBodyPlaceholder(match[2])) ids.add(match[1]);
  }

  const durablePattern = new RegExp(
    `${escapeRegExp(DEEP_READ_DURABLE_SLOT_PREFIX)}([^/"']+)/done/start`,
    "g",
  );
  while ((match = durablePattern.exec(noteHtml))) {
    const slotId = safeDecodeURIComponent(match[1]);
    if (!isDeepReadSlotBodyPlaceholder(getDeepReadSlotBody(noteHtml, slotId))) {
      ids.add(slotId);
    }
  }
  return ids.size;
}

/**
 * 笔记中是否残留“等待生成 / 正在生成”占位文本。
 *
 * Zotero 的笔记会经过 HTML 清洗，有时会丢弃 `<!-- zab:slot:... -->` 注释标记，
 * 导致基于标记的续跑逻辑认为笔记已完整，但正文里仍残留占位符、章节从未真正生成。
 * 这种“标记丢失但有占位符”的损坏笔记需要整体重新生成。
 */
export function noteHasDeepReadPlaceholderText(noteHtml: string): boolean {
  return DEEP_READ_LEGACY_INCOMPLETE_RE.test(noteHtml);
}

/**
 * 返回笔记中所有尚未真正完成的 slot ID：包括 pending/running/error，
 * 以及“标记为 done 但正文仍是占位符”的损坏 slot。
 */
export function extractRunnableDeepReadSlotIds(noteHtml: string): string[] {
  const ids = new Set<string>();
  const pattern =
    /<!-- zab:slot:([^:]+):(pending|running|done|error) -->([\s\S]*?)<!-- zab:slot:\1:end -->/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(noteHtml))) {
    const [, slotId, status, body] = match;
    if (status !== "done" || isDeepReadSlotBodyPlaceholder(body)) {
      ids.add(slotId);
    }
  }

  const durablePattern = new RegExp(
    `${escapeRegExp(DEEP_READ_DURABLE_SLOT_PREFIX)}([^/"']+)/(pending|running|done|error)/start`,
    "g",
  );
  while ((match = durablePattern.exec(noteHtml))) {
    const slotId = safeDecodeURIComponent(match[1]);
    const status = match[2] as DeepReadSlotStatus;
    if (
      status !== "done" ||
      isDeepReadSlotBodyPlaceholder(getDeepReadSlotBody(noteHtml, slotId))
    ) {
      ids.add(slotId);
    }
  }
  return [...ids];
}

export function markDeepReadSlotRunning(
  noteHtml: string,
  slotId: string,
  slotTitle?: string,
): string {
  return replaceDeepReadSlotHtml(
    noteHtml,
    slotId,
    addDurableSlotMarkers(
      `<h2>${escapeHtml(slotTitle || "")}</h2>\n<p>🔄 正在生成...</p>`,
      slotId,
      "running",
    ),
    "running",
  );
}

export function resetRunningDeepReadSlots(noteHtml: string): string {
  let nextHtml = noteHtml.replace(
    /<!-- zab:slot:([^:]+):running -->[\s\S]*?<!-- zab:slot:\1:end -->/g,
    (_match, slotId: string) =>
      `<!-- ${DEEP_READ_SLOT_PREFIX}:${slotId}:pending -->\n${addDurableSlotMarkers(
        "<p>已取消，重新运行 AI 精读时会从这里继续。</p>",
        slotId,
        "pending",
      )}\n<!-- ${DEEP_READ_SLOT_PREFIX}:${slotId}:end -->`,
  );
  const runningIds = extractDurableSlotIdsByStatus(nextHtml, "running");
  for (const slotId of runningIds) {
    nextHtml = replaceDeepReadSlotHtml(
      nextHtml,
      slotId,
      addDurableSlotMarkers(
        "<p>已取消，重新运行 AI 精读时会从这里继续。</p>",
        slotId,
        "pending",
      ),
      "pending",
    );
  }
  return nextHtml;
}

export function extractDeepReadPlanMetadata(
  noteHtml: string,
): DeepReadPlanMetadata | null {
  const commentMatch = noteHtml.match(
    new RegExp(`<!-- ${DEEP_READ_PLAN_META_PREFIX}:([\\s\\S]*?) -->`),
  );
  const durableMatch = noteHtml.match(
    new RegExp(`${escapeRegExp(DEEP_READ_DURABLE_PLAN_PREFIX)}([^"']+)`),
  );
  const encoded = commentMatch?.[1] || durableMatch?.[1];
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(encoded));
    if (!parsed || !Array.isArray(parsed.chapters)) return null;
    return {
      templateId:
        typeof parsed.templateId === "string" ? parsed.templateId : "",
      chapters: parsed.chapters,
      template: parsed.template,
    };
  } catch {
    return null;
  }
}

/**
 * Migrate a partial note whose HTML comments were removed by Zotero. Completed
 * prose is retained verbatim, while durable link markers are created for the
 * unfinished slots so subsequent runs can resume normally.
 */
export function recoverDeepReadFromResidualHtml(
  existingHtml: string,
  skeletonHtml: string,
  planned: PlannedDeepRead,
): string {
  const placeholders = [
    ...existingHtml.matchAll(new RegExp(DEEP_READ_LEGACY_INCOMPLETE_RE, "g")),
  ];
  if (!placeholders.length) return skeletonHtml;

  const firstPlaceholderIndex = placeholders[0].index || 0;
  const headingMatches = [
    ...existingHtml
      .slice(0, firstPlaceholderIndex)
      .matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi),
  ];
  const pendingTitle = normalizeRenderedText(
    headingMatches[headingMatches.length - 1]?.[1] || "",
  );
  let firstIncompleteIndex = planned.slots.findIndex(
    (slot) => normalizeRenderedText(slot.title) === pendingTitle,
  );
  if (firstIncompleteIndex < 0) {
    firstIncompleteIndex = Math.max(
      0,
      planned.slots.length - placeholders.length,
    );
  }

  let recoveredSkeleton = skeletonHtml;
  for (let index = 0; index < firstIncompleteIndex; index++) {
    const slot = planned.slots[index];
    recoveredSkeleton = fillDeepReadSlot(
      recoveredSkeleton,
      slot.id,
      "本轮已从旧版精读笔记恢复，原始内容完整保留在下方。",
      slot.title,
      "done",
    );
  }

  const cleanedExisting = existingHtml
    .replace(/<!--\s*zab:(?:slot|deep-read-plan):[\s\S]*?-->/g, "")
    .replace(/<h1[^>]*>\s*AI\s*(?:精读|Deep Read)[\s\S]*?<\/h1>/i, "")
    .replace(
      /<h([1-6])[^>]*>(?:(?!<\/h\1>)[\s\S])*?<\/h\1>\s*<p[^>]*>\s*(?:⏳|🔄)️?\s*(?:等待生成|正在生成)\s*\.{0,3}\s*<\/p>/gi,
      "",
    )
    .replace(
      /<p[^>]*>\s*(?:⏳|🔄)️?\s*(?:等待生成|正在生成)\s*\.{0,3}\s*<\/p>/gi,
      "",
    )
    .replace(
      /<h([1-6])[^>]*>(?:(?!<\/h\1>)[\s\S])*?<\/h\1>\s*<p[^>]*>\s*❌[\s\S]*?<\/p>/gi,
      "",
    )
    .replace(/<p[^>]*>\s*❌[\s\S]*?<\/p>/gi, "")
    .replace(
      /<p[^>]*>\s*已取消，重新运行\s*AI\s*精读时会从这里继续。?\s*<\/p>/gi,
      "",
    )
    .trim();

  if (!cleanedExisting) return recoveredSkeleton;
  return `${recoveredSkeleton}\n<hr/>\n<h2>从旧笔记恢复的已完成内容</h2>\n${cleanedExisting}`;
}

export function extractDeepReadChaptersFromHtml(
  noteHtml: string,
): ChapterInfo[] {
  const chapters: ChapterInfo[] = [];
  const seen = new Set<string>();
  const pattern = /第\s*(\d+)\s*章\s*[：:]\s*([^<\n\r]+)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(noteHtml))) {
    const index = Number(match[1]);
    const rawTitle = decodeBasicHtmlEntities(stripHtml(match[2])).trim();
    if (!Number.isInteger(index) || index <= 0 || !rawTitle) continue;

    const parsed = parseRenderedChapterTitle(rawTitle);
    const id = `ch${index}`;
    if (seen.has(id)) continue;
    seen.add(id);
    chapters.push({ id, ...parsed });
  }

  return chapters;
}

function parseRenderedChapterTitle(title: string): {
  title_zh: string;
  title_en: string;
} {
  const normalized = title.replace(/\s+/g, " ").trim();
  const pair = normalized.match(/^(.+?)（(.+?)）$/);
  if (pair) {
    return { title_zh: pair[1].trim(), title_en: pair[2].trim() };
  }

  const asciiPair = normalized.match(/^(.+?)\((.+?)\)$/);
  if (asciiPair) {
    return { title_zh: asciiPair[1].trim(), title_en: asciiPair[2].trim() };
  }

  return { title_zh: normalized, title_en: "" };
}

function decodeBasicHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function buildPlanMetadataComment(
  template: MultiRoundPromptTemplate,
  chapters: ChapterInfo[],
): string {
  return `<!-- ${DEEP_READ_PLAN_META_PREFIX}:${encodeURIComponent(
    JSON.stringify({ templateId: template.id, template, chapters }),
  )} -->`;
}

function buildDurablePlanMarker(
  template: MultiRoundPromptTemplate,
  chapters: ChapterInfo[],
): string {
  const encoded = encodeURIComponent(
    JSON.stringify({ templateId: template.id, template, chapters }),
  );
  return `<a href="${DEEP_READ_DURABLE_PLAN_PREFIX}${encoded}">&#8203;</a>`;
}

function validatePlannedSlotIds(slots: DeepReadSlot[]): void {
  const seen = new Set<string>();
  for (const slot of slots) {
    if (seen.has(slot.id)) {
      throw new Error(`精读模板 slot ID 重复: ${slot.id}`);
    }
    seen.add(slot.id);
  }
}

function createSequentialSlots(
  phase: MultiRoundSequentialDynamicPhase,
  chapters: ChapterInfo[],
): DeepReadSlot[] {
  const maxChapters = phase.maxChapters || chapters.length;
  const prompts = [
    ...phase.fixedPrompts,
    ...generateChapterPrompts(
      chapters,
      phase.chapterTemplate,
      phase.fixedPrompts.length,
      maxChapters,
    ),
  ].sort((left, right) => left.order - right.order);

  return prompts.map((prompt) => promptToSlot(prompt, phase));
}

function createIndependentSlots(
  phase: MultiRoundIndependentPhase,
): DeepReadSlot[] {
  return phase.prompts
    .slice()
    .sort((left, right) => left.order - right.order)
    .map((prompt) => promptToSlot(prompt, phase));
}

function promptToSlot(
  prompt: MultiRoundPromptItem,
  phase: MultiRoundPromptPhase,
): DeepReadSlot {
  return {
    id: prompt.id,
    title: normalizeDeepReadPromptTitle(prompt.title),
    prompt: prompt.prompt,
    phaseId: phase.id,
    phaseTitle: phase.title,
    phaseType: phase.type,
    status: "pending",
  };
}

function normalizeDeepReadPromptTitle(title: string): string {
  return title.trim() === "\u7efc\u8ff0\u6458\u8981\u7cbe\u8bfb"
    ? "\u6587\u7ae0\u6574\u4f53\u901a\u8bfb"
    : title;
}

function buildPendingSlotHtml(slot: DeepReadSlot): string {
  const content = addDurableSlotMarkers(
    `<h2>${escapeHtml(slot.title)}</h2>\n<p>⏳ 等待生成...</p>`,
    slot.id,
    "pending",
  );
  return [
    `<!-- ${DEEP_READ_SLOT_PREFIX}:${slot.id}:pending -->`,
    content,
    `<!-- ${DEEP_READ_SLOT_PREFIX}:${slot.id}:end -->`,
  ].join("\n");
}

function addDurableSlotMarkers(
  html: string,
  slotId: string,
  status: DeepReadSlotStatus,
): string {
  const startMarker = buildDurableSlotMarker(slotId, status, "start");
  const endMarker = buildDurableSlotMarker(slotId, status, "end");
  let marked = html.replace(/(<(?:h[1-6]|p)\b[^>]*>)/i, `$1${startMarker}`);
  if (marked === html) marked = `<p>${startMarker}</p>${html}`;

  const closingPattern =
    /<\/(?:h[1-6]|p|li|ul|ol|blockquote|pre|td|th|table)>/gi;
  const closings = [...marked.matchAll(closingPattern)];
  const last = closings[closings.length - 1];
  if (!last || last.index === undefined) return `${marked}<p>${endMarker}</p>`;
  return `${marked.slice(0, last.index)}${endMarker}${marked.slice(last.index)}`;
}

function buildDurableSlotMarker(
  slotId: string,
  status: DeepReadSlotStatus,
  boundary: "start" | "end",
): string {
  return `<a href="${DEEP_READ_DURABLE_SLOT_PREFIX}${encodeURIComponent(
    slotId,
  )}/${status}/${boundary}">&#8203;</a>`;
}

function buildDurableSlotMarkerRegex(
  slotId: string,
  boundary: "start" | "end",
): RegExp {
  return new RegExp(
    `<a\\b[^>]*href=["']${escapeRegExp(
      `${DEEP_READ_DURABLE_SLOT_PREFIX}${encodeURIComponent(slotId)}/`,
    )}(pending|running|done|error)/${boundary}["'][^>]*>[\\s\\S]*?<\\/a>`,
    "i",
  );
}

function findDurableSlotRange(
  noteHtml: string,
  slotId: string,
): { start: number; end: number } | null {
  const startMatch = buildDurableSlotMarkerRegex(slotId, "start").exec(
    noteHtml,
  );
  if (!startMatch || startMatch.index === undefined) return null;
  const endPattern = buildDurableSlotMarkerRegex(slotId, "end");
  const remainder = noteHtml.slice(startMatch.index + startMatch[0].length);
  const endMatch = endPattern.exec(remainder);
  if (!endMatch || endMatch.index === undefined) return null;

  const beforeStart = noteHtml.slice(0, startMatch.index);
  const openingBlocks = [
    ...beforeStart.matchAll(
      /<(?:h[1-6]|p|div|li|blockquote|pre|ul|ol|table)\b[^>]*>/gi,
    ),
  ];
  const opening = openingBlocks[openingBlocks.length - 1];
  const start = opening?.index ?? startMatch.index;
  const markerEnd =
    startMatch.index +
    startMatch[0].length +
    endMatch.index +
    endMatch[0].length;
  const closing = noteHtml
    .slice(markerEnd)
    .match(/<\/(?:h[1-6]|p|div|li|blockquote|pre|td|th|ul|ol|table)>/i);
  const end =
    closing?.index === undefined
      ? markerEnd
      : markerEnd + closing.index + closing[0].length;
  return { start, end };
}

function extractDurableSlotIdsByStatus(
  noteHtml: string,
  status: DeepReadSlotStatus,
): string[] {
  const ids: string[] = [];
  const pattern = new RegExp(
    `${escapeRegExp(DEEP_READ_DURABLE_SLOT_PREFIX)}([^/"']+)/${status}/start`,
    "g",
  );
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(noteHtml))) {
    ids.push(safeDecodeURIComponent(match[1]));
  }
  return ids;
}

function normalizeRenderedText(html: string): string {
  return decodeBasicHtmlEntities(stripHtml(html))
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function buildChapterListHtml(
  chapters: ChapterInfo[],
  lang: PromptLang = "zh",
): string[] {
  if (!chapters.length) {
    return [
      lang === "en"
        ? "<p>No chapter structure was identified.</p>"
        : "<p>未识别到章节结构。</p>",
    ];
  }

  return chapters.map((chapter, index) => {
    const title = formatChapterTitle(chapter, lang);
    return lang === "en"
      ? `<p>Chapter ${index + 1}: ${escapeHtml(title)}</p>`
      : `<p>第${index + 1}章：${escapeHtml(title)}</p>`;
  });
}

function formatChapterTitle(
  chapter: ChapterInfo,
  lang: PromptLang = "zh",
): string {
  const titleZh = chapter.title_zh.trim();
  const titleEn = chapter.title_en.trim();
  if (titleZh && titleEn && titleZh !== titleEn) {
    return lang === "en"
      ? `${titleEn} (${titleZh})`
      : `${titleZh}（${titleEn}）`;
  }
  return (
    (lang === "en" ? titleEn || titleZh : titleZh || titleEn) ||
    (lang === "en" ? "Untitled chapter" : "未命名章节")
  );
}

function truncateTitle(title: string): string {
  return title.length > 100 ? `${title.slice(0, 100)}...` : title;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
