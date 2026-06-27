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
const DEEP_READ_RECOVERY_NOTICE =
  "本轮已从旧版精读笔记恢复，原始内容完整保留在下方。";
const DEEP_READ_RECOVERY_NOTICE_EN =
  "This section was recovered from a previous deep-read note; its original content is preserved below.";
const DEEP_READ_RECOVERED_CONTENT_TITLES = [
  "从旧笔记恢复的已完成内容",
  "Recovered content from the previous note",
  "未匹配的旧笔记内容",
  "Unmatched content from the previous note",
];

/** Remove only AI Butler's private deep-read state markers from a copy of HTML. */
export function stripDeepReadInternalMarkersForPresentation(
  noteHtml: string,
): string {
  return noteHtml
    .replace(
      /<!--\s*(?:zab:slot:[\s\S]*?|zab:deep-read-plan:[\s\S]*?)-->/gi,
      "",
    )
    .replace(
      /<a\b(?=[^>]*\bhref\s*=\s*(?:"zab:\/\/(?:slot|plan)\/[^"]*"|'zab:\/\/(?:slot|plan)\/[^']*'))[^>]*>(?:\s|&#0*8203;|&#x0*200b;|&ZeroWidthSpace;|[\u200B-\u200D\uFEFF])*<\/a>/gi,
      "",
    )
    .replace(
      /<a\b(?=[^>]*\bhref\s*=\s*(?:"zab:\/\/(?:slot|plan)\/[^"]*"|'zab:\/\/(?:slot|plan)\/[^']*'))[^>]*>/gi,
      "",
    );
}

/** Project stored deep-read HTML into clean user-facing HTML. Raw state is untouched. */
export function prepareDeepReadHtmlForPresentation(noteHtml: string): string {
  let visible = stripDeepReadInternalMarkersForPresentation(noteHtml);
  visible = visible
    .replace(
      /<h([1-6])\b[^>]*>(?:(?!<\/h\1>)[\s\S])*<\/h\1>\s*<p\b[^>]*>([\s\S]*?)<\/p>\s*(?:<hr\s*\/?>\s*)?/gi,
      (section, _level: string, paragraphHtml: string) =>
        isRecoveryNoticeHtml(paragraphHtml) ? "" : section,
    )
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (paragraph, innerHtml: string) => {
      if (!containsRecoveryNotice(innerHtml)) return paragraph;
      const preservedInner = stripRecoveryNoticeLiterals(innerHtml);
      return hasMeaningfulLegacySectionBody(preservedInner)
        ? paragraph.replace(innerHtml, preservedInner)
        : "";
    })
    .replaceAll(DEEP_READ_RECOVERY_NOTICE, "")
    .replaceAll(DEEP_READ_RECOVERY_NOTICE_EN, "")
    .replace(/(?:\s*<hr\s*\/?>\s*){2,}/gi, "\n<hr/>\n")
    .replace(/^\s*<hr\s*\/?>\s*/i, "")
    .replace(/\s*<hr\s*\/?>\s*$/i, "")
    .replace(/(?:&#0*8203;|&#x0*200b;|&ZeroWidthSpace;)/gi, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
  return visible.trim();
}

export function hasLegacyDeepReadRecoveryArtifacts(noteHtml: string): boolean {
  return (
    noteHtml.includes(DEEP_READ_RECOVERY_NOTICE) ||
    noteHtml.includes(DEEP_READ_RECOVERY_NOTICE_EN)
  );
}

/** Guard marker-bearing notes against destructive whole-document editor saves. */
export function preservesDeepReadDurableMarkers(
  originalHtml: string,
  candidateHtml: string,
): boolean {
  const original = extractDeepReadStateMarkerInventory(originalHtml);
  if (!original.length) return true;
  const candidate = extractDeepReadStateMarkerInventory(candidateHtml);
  return (
    original.length === candidate.length &&
    original.every((href, index) => href === candidate[index])
  );
}

function extractDeepReadStateMarkerInventory(noteHtml: string): string[] {
  const markers: string[] = [];
  const pattern =
    /<!--\s*(zab:(?:slot|deep-read-plan):[\s\S]*?)\s*-->|<a\b[^>]*\bhref\s*=\s*(?:"(zab:\/\/(?:slot|plan)\/[^"]*)"|'(zab:\/\/(?:slot|plan)\/[^']*)')[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(noteHtml))) {
    markers.push(
      match[1]
        ? "comment:" + match[1].trim()
        : "link:" + (match[2] || match[3]),
    );
  }
  return markers;
}

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

export function hasResumableDeepReadSlots(noteHtml: string): boolean {
  if (!hasWellFormedDeepReadSlotMarkers(noteHtml)) return false;
  const runnableIds = extractRunnableDeepReadSlotIds(noteHtml);
  return (
    runnableIds.length > 0 &&
    runnableIds.every(
      (slotId) => getDeepReadSlotBody(noteHtml, slotId) !== null,
    )
  );
}

type SlotBoundaryToken = {
  slotId: string;
  status?: DeepReadSlotStatus;
  boundary: "start" | "end";
  index: number;
};

function hasWellFormedDeepReadSlotMarkers(noteHtml: string): boolean {
  const commentTokens: SlotBoundaryToken[] = [];
  const commentPattern =
    /<!--\s*zab:slot:(.+?):(pending|running|done|error|end)\s*-->/gi;
  let match: RegExpExecArray | null;
  while ((match = commentPattern.exec(noteHtml))) {
    const statusOrBoundary = match[2].toLowerCase();
    commentTokens.push({
      slotId: match[1],
      status:
        statusOrBoundary === "end"
          ? undefined
          : (statusOrBoundary as DeepReadSlotStatus),
      boundary: statusOrBoundary === "end" ? "end" : "start",
      index: match.index,
    });
  }

  const rawCommentCount = (noteHtml.match(/<!--\s*zab:slot:/gi) || []).length;
  if (
    rawCommentCount !== commentTokens.length ||
    (commentTokens.length > 0 && !isFlatPairedSlotMarkerStream(commentTokens))
  ) {
    return false;
  }

  const durableTokens = extractDurableSlotMarkers(noteHtml);
  const rawDurableCount = (noteHtml.match(/zab:\/\/slot\//gi) || []).length;
  if (
    rawDurableCount !== durableTokens.length ||
    (durableTokens.length > 0 &&
      !isFlatPairedSlotMarkerStream(durableTokens, true))
  ) {
    return false;
  }

  const commentStatuses = new Map(
    commentTokens
      .filter((token) => token.boundary === "start")
      .map((token) => [token.slotId, token.status]),
  );
  for (const token of durableTokens) {
    if (token.boundary !== "start" || !commentStatuses.has(token.slotId)) {
      continue;
    }
    if (commentStatuses.get(token.slotId) !== token.status) return false;
  }

  const commentRanges = buildSlotMarkerRanges(commentTokens);
  const durableRanges = buildSlotMarkerRanges(durableTokens);
  for (const [commentSlotId, commentRange] of commentRanges) {
    for (const [durableSlotId, durableRange] of durableRanges) {
      const overlaps =
        commentRange.start < durableRange.end &&
        durableRange.start < commentRange.end;
      if (commentSlotId === durableSlotId) {
        if (
          !overlaps ||
          durableRange.start <= commentRange.start ||
          durableRange.end >= commentRange.end
        ) {
          return false;
        }
        continue;
      }
      if (overlaps) {
        return false;
      }
    }
  }

  return commentTokens.length > 0 || durableTokens.length > 0;
}

function buildSlotMarkerRanges(
  tokens: SlotBoundaryToken[],
): Map<string, { start: number; end: number }> {
  const starts = new Map<string, number>();
  const ranges = new Map<string, { start: number; end: number }>();
  for (const token of tokens) {
    if (token.boundary === "start") {
      starts.set(token.slotId, token.index);
      continue;
    }
    const start = starts.get(token.slotId);
    if (start !== undefined) {
      ranges.set(token.slotId, { start, end: token.index });
    }
  }
  return ranges;
}

function isFlatPairedSlotMarkerStream(
  tokens: SlotBoundaryToken[],
  requireMatchingStatus = false,
): boolean {
  const seen = new Set<string>();
  let active: SlotBoundaryToken | null = null;

  for (const token of tokens) {
    if (token.boundary === "start") {
      if (active || seen.has(token.slotId)) return false;
      active = token;
      seen.add(token.slotId);
      continue;
    }

    if (!active || active.slotId !== token.slotId) return false;
    if (
      requireMatchingStatus &&
      active.status !== undefined &&
      token.status !== active.status
    ) {
      return false;
    }
    active = null;
  }

  return active === null;
}

export function countCompletedDeepReadSlots(noteHtml: string): number {
  const ids = new Set<string>();
  const commentPattern =
    /<!-- zab:slot:(.+?):done -->([\s\S]*?)<!-- zab:slot:\1:end -->/g;
  let match: RegExpExecArray | null;
  while ((match = commentPattern.exec(noteHtml))) {
    if (!isDeepReadSlotBodyPlaceholder(match[2])) ids.add(match[1]);
  }

  for (const marker of extractDurableSlotMarkers(noteHtml)) {
    if (marker.status !== "done" || marker.boundary !== "start") continue;
    const slotId = marker.slotId;
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
    /<!-- zab:slot:(.+?):(pending|running|done|error) -->([\s\S]*?)<!-- zab:slot:\1:end -->/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(noteHtml))) {
    const [, slotId, status, body] = match;
    if (status !== "done" || isDeepReadSlotBodyPlaceholder(body)) {
      ids.add(slotId);
    }
  }

  for (const marker of extractDurableSlotMarkers(noteHtml)) {
    if (marker.boundary !== "start") continue;
    const { slotId, status } = marker;
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
    /<!-- zab:slot:(.+?):running -->[\s\S]*?<!-- zab:slot:\1:end -->/g,
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
    /<a\b[^>]*\bhref\s*=\s*(?:"zab:\/\/plan\/([^"]+)"|'zab:\/\/plan\/([^']+)')/i,
  );
  const encoded = commentMatch?.[1] || durableMatch?.[1] || durableMatch?.[2];
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

type LegacyDeepReadSection = {
  index: number;
  headingText: string;
  html: string;
  bodyHtml: string;
  hadIncompleteStatus: boolean;
};

/**
 * Migrate a partial note whose state markers were removed by Zotero. Only
 * sections with an exact normalized title match are restored into slots.
 * Unknown prose is retained once, while unfinished slots remain runnable.
 */
export function recoverDeepReadFromResidualHtml(
  existingHtml: string,
  skeletonHtml: string,
  planned: PlannedDeepRead,
  lang: PromptLang = "zh",
): string {
  if (
    !noteHasDeepReadPlaceholderText(existingHtml) &&
    !hasLegacyDeepReadRecoveryArtifacts(existingHtml) &&
    !extractRunnableDeepReadSlotIds(existingHtml).length
  ) {
    return skeletonHtml;
  }
  return recoverLegacySectionsIntoSlots(
    skeletonHtml,
    existingHtml,
    planned,
    lang,
    new Set(planned.slots.map((slot) => slot.id)),
  );
}

/** Repair notes produced by the older notice-and-append migration in place. */
export function repairRecoveredDeepReadHtml(noteHtml: string): string {
  if (!hasLegacyDeepReadRecoveryArtifacts(noteHtml)) return noteHtml;
  const noticeSlotIds = new Set(
    extractAllDeepReadSlotIds(noteHtml).filter((slotId) =>
      containsRecoveryNotice(getDeepReadSlotBody(noteHtml, slotId)),
    ),
  );
  if (!noticeSlotIds.size) return noteHtml;

  const preservedFragments = Array.from(noticeSlotIds)
    .map((slotId) =>
      stripRecoveryNoticeForPreservation(
        getDeepReadSlotBody(noteHtml, slotId) || "",
      ),
    )
    .map(trimStructuralHtml)
    .filter(hasMeaningfulLegacySectionBody);

  const metadata = extractDeepReadPlanMetadata(noteHtml);
  if (!metadata?.template || !metadata.chapters.length) {
    return resetNoticeSlotsWithoutPlan(
      noteHtml,
      noticeSlotIds,
      preservedFragments,
    );
  }
  const planned = planDeepReadSlots(metadata.template, metadata.chapters);
  const plannedSlotIds = new Set(planned.slots.map((slot) => slot.id));
  const plannedNoticeSlotIds = new Set(
    Array.from(noticeSlotIds).filter((slotId) => plannedSlotIds.has(slotId)),
  );
  if (!plannedNoticeSlotIds.size) {
    return resetNoticeSlotsWithoutPlan(
      noteHtml,
      noticeSlotIds,
      preservedFragments,
    );
  }
  const unknownNoticeSlotIds = new Set(
    Array.from(noticeSlotIds).filter((slotId) => !plannedSlotIds.has(slotId)),
  );
  const repairTarget = unknownNoticeSlotIds.size
    ? resetNoticeSlotsWithoutPlan(noteHtml, unknownNoticeSlotIds, [])
    : noteHtml;

  return recoverLegacySectionsIntoSlots(
    repairTarget,
    extractRecoveredAppendixHtml(noteHtml) || "",
    planned,
    inferDeepReadLanguage(noteHtml),
    plannedNoticeSlotIds,
    preservedFragments,
  );
}

function recoverLegacySectionsIntoSlots(
  targetHtml: string,
  sourceHtml: string,
  planned: PlannedDeepRead,
  lang: PromptLang,
  candidateSlotIds: Set<string>,
  preservedFragments: string[] = [],
): string {
  const sections = extractLegacyDeepReadSections(sourceHtml);
  const matches = matchLegacySectionsToSlots(
    sections,
    planned,
    candidateSlotIds,
  );
  let recovered = removeRecoveredAppendix(targetHtml);

  for (const [slotId, section] of matches) {
    const sectionHtml = trimStructuralHtml(section.html);
    recovered = replaceDeepReadSlotHtml(
      recovered,
      slotId,
      addDurableSlotMarkers(sectionHtml, slotId, "done"),
      "done",
    );
  }

  for (const slot of planned.slots) {
    if (!candidateSlotIds.has(slot.id) || matches.has(slot.id)) continue;
    recovered = replaceDeepReadSlotHtml(
      recovered,
      slot.id,
      addDurableSlotMarkers(
        `<h2>${escapeHtml(slot.title)}</h2>\n<p>⏳ 等待生成...</p>`,
        slot.id,
        "pending",
      ),
      "pending",
    );
  }

  const matchedIndexes = new Set(
    Array.from(matches.values()).map((section) => section.index),
  );
  const unmatched = sections
    .filter((section) => !matchedIndexes.has(section.index))
    .map((section) => trimStructuralHtml(section.html))
    .filter(Boolean);
  for (const fragment of preservedFragments) {
    const normalized = trimStructuralHtml(fragment);
    if (normalized && !unmatched.includes(normalized))
      unmatched.push(normalized);
  }
  if (!unmatched.length) return trimStructuralHtml(recovered);

  const heading =
    lang === "en"
      ? "Unmatched content from the previous note"
      : "未匹配的旧笔记内容";
  return trimStructuralHtml(
    `${recovered}\n<hr/>\n<h2>${heading}</h2>\n${unmatched.join("\n<hr/>\n")}`,
  );
}

function resetNoticeSlotsWithoutPlan(
  noteHtml: string,
  noticeSlotIds: Set<string>,
  preservedFragments: string[],
): string {
  let repaired = noteHtml;
  const lang = inferDeepReadLanguage(noteHtml);
  for (const slotId of noticeSlotIds) {
    const body = getDeepReadSlotBody(repaired, slotId) || "";
    const visibleBody = stripDeepReadInternalMarkersForPresentation(body);
    const heading = visibleBody.match(/<h([1-6])\b[^>]*>[\s\S]*?<\/h\1>/i)?.[0];
    const fallbackTitle = lang === "en" ? "Recovered section" : "恢复章节";
    repaired = replaceDeepReadSlotHtml(
      repaired,
      slotId,
      addDurableSlotMarkers(
        `${heading || `<h2>${fallbackTitle}</h2>`}\n<p>⏳ 等待生成...</p>`,
        slotId,
        "pending",
      ),
      "pending",
    );
  }
  return appendPreservedRecoveryFragments(repaired, preservedFragments, lang);
}

function appendPreservedRecoveryFragments(
  noteHtml: string,
  fragments: string[],
  lang: PromptLang,
): string {
  const unique = fragments
    .map(trimStructuralHtml)
    .filter(
      (fragment, index, all) =>
        !!fragment &&
        all.indexOf(fragment) === index &&
        !noteHtml.includes(fragment),
    );
  if (!unique.length) return trimStructuralHtml(noteHtml);

  const hasRecoveredHeading = Array.from(
    noteHtml.matchAll(/<h([12])\b[^>]*>([\s\S]*?)<\/h\1>/gi),
  ).some((match) =>
    isRecoveredContentHeading(
      decodeBasicHtmlEntities(stripHtml(match[2])).trim(),
    ),
  );
  const heading =
    lang === "en"
      ? "Unmatched content from the previous note"
      : "未匹配的旧笔记内容";
  return trimStructuralHtml(
    `${noteHtml}\n<hr/>\n${hasRecoveredHeading ? "" : `<h2>${heading}</h2>\n`}${unique.join("\n<hr/>\n")}`,
  );
}

function extractLegacyDeepReadSections(
  sourceHtml: string,
): LegacyDeepReadSection[] {
  const html = stripDeepReadInternalMarkersForPresentation(sourceHtml);
  const headingPattern = /<h([12])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  const matches = [...html.matchAll(headingPattern)];
  const sections: LegacyDeepReadSection[] = [];

  const addSection = (
    index: number,
    headingText: string,
    headingHtml: string,
    rawBodyHtml: string,
  ) => {
    const cleaned = cleanLegacyDeepReadSectionBody(rawBodyHtml);
    const bodyHtml = cleaned.html;
    if (!hasMeaningfulLegacySectionBody(bodyHtml)) return;
    sections.push({
      index,
      headingText,
      html: trimStructuralHtml(`${headingHtml}${bodyHtml}`),
      bodyHtml,
      hadIncompleteStatus: cleaned.hadIncompleteStatus,
    });
  };

  const preambleEnd = matches[0]?.index ?? html.length;
  addSection(-1, "", "", html.slice(0, preambleEnd));

  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    if (match.index === undefined) continue;
    const start = match.index;
    const end = matches[index + 1]?.index ?? html.length;
    const bodyStart = start + match[0].length;
    const headingText = decodeBasicHtmlEntities(stripHtml(match[2])).trim();
    const bodyHtml = html.slice(bodyStart, end);
    if (isDeepReadNoteTitle(headingText)) {
      addSection(index, "", "", bodyHtml);
      continue;
    }
    if (isChapterStructureHeading(headingText)) {
      addSection(index, "", "", removeChapterListParagraphs(bodyHtml));
      continue;
    }
    if (isRecoveredContentHeading(headingText)) {
      addSection(index, "", "", bodyHtml);
      continue;
    }
    addSection(index, headingText, match[0], bodyHtml);
  }

  if (matches.length === 0) {
    sections.length = 0;
    addSection(0, "", "", html);
  }

  return sections;
}

function matchLegacySectionsToSlots(
  sections: LegacyDeepReadSection[],
  planned: PlannedDeepRead,
  candidateSlotIds: Set<string>,
): Map<string, LegacyDeepReadSection> {
  const matches = new Map<string, LegacyDeepReadSection>();
  const slotAliases = planned.slots
    .map((slot, index) => ({
      slot,
      aliases: buildDeepReadSlotHeadingAliases(slot, planned, index),
    }))
    .filter(({ slot }) => candidateSlotIds.has(slot.id));

  for (const section of sections) {
    if (!section.headingText || section.hadIncompleteStatus) continue;
    const headingKeys = buildDeepReadHeadingKeys(section.headingText);
    const matchingSlots = slotAliases.filter(
      ({ slot, aliases }) =>
        !matches.has(slot.id) &&
        Array.from(headingKeys).some((key) => aliases.has(key)),
    );
    if (matchingSlots.length !== 1) continue;
    matches.set(matchingSlots[0].slot.id, section);
  }

  return matches;
}

function buildDeepReadSlotHeadingAliases(
  slot: DeepReadSlot,
  planned: PlannedDeepRead,
  slotIndex: number,
): Set<string> {
  const aliases = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    for (const key of buildDeepReadHeadingKeys(value)) aliases.add(key);
  };
  add(slot.title);

  if (slot.id.startsWith("chapter_")) {
    const chapterId = slot.id.slice("chapter_".length);
    const sequentialIndex = planned.sequentialSlots.findIndex(
      (candidate) => candidate.id === slot.id,
    );
    const chapter =
      planned.chapters.find((candidate) => candidate.id === chapterId) ||
      planned.chapters[sequentialIndex >= 0 ? sequentialIndex : slotIndex];
    add(chapter?.title_zh);
    add(chapter?.title_en);
    if (chapter?.title_zh && chapter?.title_en) {
      add(`${chapter.title_zh}（${chapter.title_en}）`);
      add(`${chapter.title_en} (${chapter.title_zh})`);
    }
  }
  aliases.delete("");
  return aliases;
}

function buildDeepReadHeadingKeys(value: string): Set<string> {
  const plain = decodeBasicHtmlEntities(stripHtml(value))
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
  const candidates = [plain];
  const pair = plain.match(/^(.+?)[（(]([^()（）]+)[）)]$/);
  if (pair) candidates.push(pair[1].trim(), pair[2].trim());
  return new Set(candidates.map(normalizeDeepReadHeadingKey).filter(Boolean));
}

function normalizeDeepReadHeadingKey(value: string): string {
  let normalized = value;
  try {
    normalized = normalized.normalize("NFKC");
  } catch {
    // Older runtimes may not expose String.prototype.normalize.
  }
  return normalized
    .replace(
      /^(?:(?:第\s*\d+\s*章(?:\s*精读)?|chapter\s*\d+(?:\s*(?:close\s*reading|reading))?|section\s*\d+)\s*(?:[:：.\-–—]\s*)?|\d+(?:\.\d+)*\s*[:：.\-–—]\s*)/i,
      "",
    )
    .toLocaleLowerCase()
    .replace(/[\s/:：;；,，.。!！?？'"“”‘’()（）【】{}<>《》_\\–—-]+/g, "")
    .trim();
}

function hasMeaningfulLegacySectionBody(bodyHtml: string): boolean {
  return (
    normalizeRenderedText(bodyHtml.replace(/<hr\s*\/?>/gi, "")).length > 0 ||
    /<(?:img|svg|math|table|iframe|video|audio|object)\b/i.test(bodyHtml)
  );
}

function cleanLegacyDeepReadSectionBody(bodyHtml: string): {
  html: string;
  hadIncompleteStatus: boolean;
} {
  let hadIncompleteStatus = false;
  let cleaned = bodyHtml.replace(
    /<p\b[^>]*>([\s\S]*?)<\/p>/gi,
    (paragraph, innerHtml: string) => {
      if (containsRecoveryNotice(innerHtml)) {
        hadIncompleteStatus = true;
        const preservedInner = stripRecoveryNoticeLiterals(innerHtml);
        return hasMeaningfulLegacySectionBody(preservedInner)
          ? paragraph.replace(innerHtml, preservedInner)
          : "";
      }
      if (!isLegacyStatusText(normalizeVisibleText(innerHtml)))
        return paragraph;
      hadIncompleteStatus = true;
      return "";
    },
  );
  if (isLegacyStatusText(normalizeVisibleText(cleaned))) {
    cleaned = "";
    hadIncompleteStatus = true;
  }
  return {
    html: trimStructuralHtml(cleaned),
    hadIncompleteStatus,
  };
}

function removeChapterListParagraphs(bodyHtml: string): string {
  return bodyHtml.replace(
    /<p\b[^>]*>([\s\S]*?)<\/p>/gi,
    (paragraph, innerHtml: string) =>
      /^(?:第\s*\d+\s*章\s*[：:]|chapter\s*\d+\s*[：:])/i.test(
        normalizeVisibleText(innerHtml),
      )
        ? ""
        : paragraph,
  );
}

function normalizeVisibleText(html: string): string {
  return decodeBasicHtmlEntities(stripHtml(html))
    .replace(/(?:&#0*8203;|&#x0*200b;|&ZeroWidthSpace;)/gi, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isLegacyStatusText(text: string): boolean {
  if (!text) return false;
  if (/^(?:⏳|🔄)️?\s*(?:等待生成|正在生成)\s*\.{0,3}$/u.test(text)) {
    return true;
  }
  if (/^❌(?:\s+.*)?$/u.test(text)) return true;
  if (/^已取消，重新运行\s*AI\s*精读时会从这里继续。?$/i.test(text)) {
    return true;
  }
  return (
    text === DEEP_READ_RECOVERY_NOTICE || text === DEEP_READ_RECOVERY_NOTICE_EN
  );
}

function containsRecoveryNotice(value: string | null): boolean {
  return (
    !!value &&
    (value.includes(DEEP_READ_RECOVERY_NOTICE) ||
      value.includes(DEEP_READ_RECOVERY_NOTICE_EN))
  );
}

function stripRecoveryNoticeLiterals(value: string): string {
  return value
    .split(DEEP_READ_RECOVERY_NOTICE)
    .join("")
    .split(DEEP_READ_RECOVERY_NOTICE_EN)
    .join("");
}

function stripRecoveryNoticeForPreservation(value: string): string {
  const withoutMarkers = stripDeepReadInternalMarkersForPresentation(value);
  const withoutNotice = stripRecoveryNoticeLiterals(withoutMarkers).replace(
    /<p\b[^>]*>\s*<\/p>/gi,
    "",
  );
  const withoutHeadings = withoutNotice.replace(
    /<h([1-6])\b[^>]*>[\s\S]*?<\/h\1>/gi,
    "",
  );
  return hasMeaningfulLegacySectionBody(withoutHeadings)
    ? trimStructuralHtml(withoutNotice)
    : "";
}

function isRecoveryNoticeHtml(value: string): boolean {
  const text = normalizeVisibleText(value);
  return (
    text === DEEP_READ_RECOVERY_NOTICE || text === DEEP_READ_RECOVERY_NOTICE_EN
  );
}

function isDeepReadNoteTitle(title: string): boolean {
  return /^AI\s*(?:精读|Deep\s*Read)\s*-/i.test(title);
}

function isChapterStructureHeading(title: string): boolean {
  const normalized = normalizeDeepReadHeadingKey(title);
  return normalized === "章节解析" || normalized === "chapterstructure";
}

function isRecoveredContentHeading(title: string): boolean {
  const normalized = normalizeDeepReadHeadingKey(title);
  return DEEP_READ_RECOVERED_CONTENT_TITLES.some(
    (candidate) => normalizeDeepReadHeadingKey(candidate) === normalized,
  );
}

function extractRecoveredAppendixHtml(noteHtml: string): string | null {
  const headingPattern = /<h([12])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  for (const match of noteHtml.matchAll(headingPattern)) {
    if (match.index === undefined) continue;
    const title = decodeBasicHtmlEntities(stripHtml(match[2])).trim();
    if (!isRecoveredContentHeading(title)) continue;
    return noteHtml.slice(match.index + match[0].length);
  }
  return null;
}

function removeRecoveredAppendix(noteHtml: string): string {
  const headingPattern = /<h([12])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  for (const match of noteHtml.matchAll(headingPattern)) {
    if (match.index === undefined) continue;
    const title = decodeBasicHtmlEntities(stripHtml(match[2])).trim();
    if (!isRecoveredContentHeading(title)) continue;
    return trimStructuralHtml(noteHtml.slice(0, match.index));
  }
  return noteHtml;
}

function trimStructuralHtml(html: string): string {
  let output = html.trim();
  const leading = /^(?:\s|<br\s*\/?>|<hr\s*\/?>)+/i;
  const trailing = /(?:\s|<br\s*\/?>|<hr\s*\/?>)+$/i;
  let previous = "";
  while (previous !== output) {
    previous = output;
    output = output.replace(leading, "").replace(trailing, "").trim();
  }
  return output;
}

function inferDeepReadLanguage(noteHtml: string): PromptLang {
  return /<h1\b[^>]*>\s*AI\s*Deep\s*Read\b/i.test(noteHtml) ? "en" : "zh";
}

export function extractDeepReadChaptersFromHtml(
  noteHtml: string,
  lang: PromptLang = "zh",
): ChapterInfo[] {
  const chapters: ChapterInfo[] = [];
  const seen = new Set<string>();
  const rendered = extractChapterStructureSectionHtml(
    stripDeepReadInternalMarkersForPresentation(noteHtml),
  );
  if (!rendered) return chapters;
  const matches: Array<{
    index: number;
    chapterIndex: number;
    title: string;
    sourceLang: PromptLang;
  }> = [];
  for (const [pattern, sourceLang] of [
    [/第\s*(\d+)\s*章\s*[：:]\s*([^<\n\r]+)/g, "zh"],
    [/Chapter\s*(\d+)\s*[：:]\s*([^<\n\r]+)/gi, "en"],
  ] as const) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(rendered))) {
      matches.push({
        index: match.index,
        chapterIndex: Number(match[1]),
        title: match[2],
        sourceLang,
      });
    }
  }

  matches.sort((left, right) => {
    if (left.chapterIndex === right.chapterIndex) {
      if (left.sourceLang === lang && right.sourceLang !== lang) return -1;
      if (right.sourceLang === lang && left.sourceLang !== lang) return 1;
    }
    return left.index - right.index;
  });

  for (const match of matches) {
    const index = match.chapterIndex;
    const rawTitle = decodeBasicHtmlEntities(stripHtml(match.title)).trim();
    if (!Number.isInteger(index) || index <= 0 || !rawTitle) continue;

    const parsed = parseRenderedChapterTitle(rawTitle, match.sourceLang);
    const id = `ch${index}`;
    if (seen.has(id)) continue;
    seen.add(id);
    chapters.push({ id, ...parsed });
  }

  return chapters;
}

function parseRenderedChapterTitle(
  title: string,
  lang: PromptLang = "zh",
): {
  title_zh: string;
  title_en: string;
} {
  const normalized = title.replace(/\s+/g, " ").trim();
  const pair = normalized.match(/^(.+?)[（(]([^()（）]+)[）)]$/);
  if (pair) {
    const outside = pair[1].trim();
    const inside = pair[2].trim();
    const outsideHasCjk = containsCjk(outside);
    const insideHasCjk = containsCjk(inside);
    if (outsideHasCjk !== insideHasCjk) {
      return outsideHasCjk
        ? { title_zh: outside, title_en: inside }
        : { title_zh: inside, title_en: outside };
    }
  }

  return lang === "en"
    ? { title_zh: "", title_en: normalized }
    : { title_zh: normalized, title_en: "" };
}

function extractChapterStructureSectionHtml(noteHtml: string): string | null {
  const headingPattern = /<h([12])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  const headings = [...noteHtml.matchAll(headingPattern)];
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];
    if (heading.index === undefined) continue;
    const title = decodeBasicHtmlEntities(stripHtml(heading[2])).trim();
    if (!isChapterStructureHeading(title)) continue;
    const start = heading.index + heading[0].length;
    const end = headings[index + 1]?.index ?? noteHtml.length;
    return noteHtml.slice(start, end);
  }
  return null;
}

function containsCjk(value: string): boolean {
  return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u.test(value);
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
  return `<!-- ${DEEP_READ_PLAN_META_PREFIX}:${encodeDeepReadMarkerComponent(
    JSON.stringify({ templateId: template.id, template, chapters }),
  )} -->`;
}

function buildDurablePlanMarker(
  template: MultiRoundPromptTemplate,
  chapters: ChapterInfo[],
): string {
  const encoded = encodeDeepReadMarkerComponent(
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
  const trailing = marked.slice(last.index + last[0].length);
  if (hasMeaningfulLegacySectionBody(trailing)) {
    return `${marked}<p>${endMarker}</p>`;
  }
  return `${marked.slice(0, last.index)}${endMarker}${marked.slice(last.index)}`;
}

function buildDurableSlotMarker(
  slotId: string,
  status: DeepReadSlotStatus,
  boundary: "start" | "end",
): string {
  return `<a href="${DEEP_READ_DURABLE_SLOT_PREFIX}${encodeDeepReadMarkerComponent(
    slotId,
  )}/${status}/${boundary}">&#8203;</a>`;
}

function buildDurableSlotMarkerRegex(
  slotId: string,
  boundary: "start" | "end",
): RegExp {
  const encodedIds = [
    encodeDeepReadMarkerComponent(slotId),
    encodeURIComponent(slotId),
  ];
  const encodedIdPattern = Array.from(new Set(encodedIds))
    .map(escapeRegExp)
    .join("|");
  return new RegExp(
    `<a\\b[^>]*href=["']${escapeRegExp(
      DEEP_READ_DURABLE_SLOT_PREFIX,
    )}(?:${encodedIdPattern})/(pending|running|done|error)/${boundary}["'][^>]*>[\\s\\S]*?<\\/a>`,
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
  return extractDurableSlotMarkers(noteHtml)
    .filter((marker) => marker.status === status && marker.boundary === "start")
    .map((marker) => marker.slotId);
}

type DurableSlotMarker = {
  slotId: string;
  status: DeepReadSlotStatus;
  boundary: "start" | "end";
  index: number;
};

function extractDurableSlotMarkers(noteHtml: string): DurableSlotMarker[] {
  const markers: DurableSlotMarker[] = [];
  const pattern =
    /<a\b[^>]*\bhref\s*=\s*(?:"zab:\/\/slot\/([^"/]+)\/(pending|running|done|error)\/(start|end)"|'zab:\/\/slot\/([^'/]+)\/(pending|running|done|error)\/(start|end)')[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(noteHtml))) {
    markers.push({
      slotId: safeDecodeURIComponent(match[1] || match[4]),
      status: (match[2] || match[5]) as DeepReadSlotStatus,
      boundary: (match[3] || match[6]) as "start" | "end",
      index: match.index,
    });
  }
  return markers;
}

function extractAllDeepReadSlotIds(noteHtml: string): string[] {
  const ids = new Set<string>();
  const commentPattern =
    /<!--\s*zab:slot:(.+?):(?:pending|running|done|error|end)\s*-->/gi;
  let match: RegExpExecArray | null;
  while ((match = commentPattern.exec(noteHtml))) ids.add(match[1]);
  for (const marker of extractDurableSlotMarkers(noteHtml)) {
    ids.add(marker.slotId);
  }
  return Array.from(ids);
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

function encodeDeepReadMarkerComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
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
