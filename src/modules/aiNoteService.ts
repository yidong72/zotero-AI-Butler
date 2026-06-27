import {
  DEEP_READ_NOTE_TAG,
  ENGLISH_NOTE_TAG,
  LEGACY_SUMMARY_NOTE_TAG,
  SUMMARY_NOTE_TAG,
  isDeepReadNote,
  isEnglishNoteVariant,
  isFollowUpChatNote,
  isRegularSummaryNote,
  type NoteTag,
} from "./aiNoteClassifier";
import type { PromptLang } from "../utils/prompts";
import {
  buildFollowUpChatPairNoteHtml,
  normalizeFollowUpChatNoteHtml,
} from "./noteMarkdown";
import {
  LLMNoteMetadataService,
  type LLMNoteMetadata,
} from "./llmNoteMetadata";
import { repairRecoveredDeepReadHtml } from "./deepReadEngine";

export type AiNoteKind = "summary" | "deepRead";

export interface AiNoteRecord {
  note: Zotero.Item;
  rawHtml: string;
}

const NOTE_KIND_TAG: Record<AiNoteKind, string> = {
  summary: SUMMARY_NOTE_TAG,
  deepRead: DEEP_READ_NOTE_TAG,
};

const NOTE_KIND_TITLE: Record<AiNoteKind, string> = {
  summary: "AI 总结",
  deepRead: "AI 精读",
};

const NOTE_KIND_TITLE_EN: Record<AiNoteKind, string> = {
  summary: "AI Summary",
  deepRead: "AI Deep Read",
};

export class AiNoteService {
  public static getTitle(kind: AiNoteKind, lang: PromptLang = "zh"): string {
    return lang === "en" ? NOTE_KIND_TITLE_EN[kind] : NOTE_KIND_TITLE[kind];
  }

  public static getTag(kind: AiNoteKind): string {
    return NOTE_KIND_TAG[kind];
  }

  public static async resolveParentItem(
    item: Zotero.Item,
  ): Promise<Zotero.Item | null> {
    if ((item as any).isAttachment?.()) {
      const parentId = (item as any).parentItemID;
      return parentId
        ? ((await Zotero.Items.getAsync(parentId)) as Zotero.Item)
        : null;
    }
    return item;
  }

  public static async findNote(
    item: Zotero.Item,
    kind: AiNoteKind,
    lang: PromptLang = "zh",
  ): Promise<Zotero.Item | null> {
    const record = await this.findNoteRecord(item, kind, lang);
    return record?.note || null;
  }

  public static async findNoteRecord(
    item: Zotero.Item,
    kind: AiNoteKind,
    lang: PromptLang = "zh",
  ): Promise<AiNoteRecord | null> {
    try {
      const parentItem = await this.resolveParentItem(item);
      if (!parentItem) return null;
      const noteIDs = (parentItem as any).getNotes?.() || [];
      let target: Zotero.Item | null = null;
      let rawHtml = "";

      for (const nid of noteIDs) {
        const note = await Zotero.Items.getAsync(nid);
        if (!note) continue;
        const tags: NoteTag[] = (note as any).getTags?.() || [];
        const noteHtml: string = (note as any).getNote?.() || "";
        const matches =
          kind === "summary"
            ? isRegularSummaryNote(tags, noteHtml)
            : isDeepReadNote(tags, noteHtml);
        if (!matches) continue;
        // 中英文版本按 ENGLISH_NOTE_TAG 区分，避免互相覆盖。
        if (isEnglishNoteVariant(tags, noteHtml) !== (lang === "en")) continue;

        if (!target || compareModified(note, target) > 0) {
          target = note as Zotero.Item;
          rawHtml = noteHtml;
        }
      }

      if (target && kind === "deepRead") {
        try {
          const repairedHtml = repairRecoveredDeepReadHtml(rawHtml);
          if (repairedHtml !== rawHtml) {
            (target as any).setNote?.(repairedHtml);
            await (target as any).saveTx?.();
            rawHtml = ((target as any).getNote?.() as string) || repairedHtml;
            ztoolkit.log(
              `[AI-Butler] 已将旧版 AI 精读恢复内容归位到对应章节: ${target.id}`,
            );
          }
        } catch (error) {
          try {
            if (((target as any).getNote?.() || "") !== rawHtml) {
              (target as any).setNote?.(rawHtml);
            }
          } catch (restoreError) {
            ztoolkit.log(
              `[AI-Butler] 恢复未保存的 AI 精读内存状态失败: ${target.id}`,
              restoreError,
            );
          }
          ztoolkit.log(
            `[AI-Butler] 修复旧版 AI 精读恢复内容失败，继续使用原笔记: ${target.id}`,
            error,
          );
        }
      }

      return target ? { note: target, rawHtml } : null;
    } catch (error) {
      ztoolkit.log(
        `[AI-Butler] 查找 ${NOTE_KIND_TITLE[kind]} 笔记失败:`,
        error,
      );
      return null;
    }
  }

  public static async hasNote(
    item: Zotero.Item,
    kind: AiNoteKind,
    lang: PromptLang = "zh",
  ): Promise<boolean> {
    return !!(await this.findNote(item, kind, lang));
  }

  public static async saveGeneratedNote(options: {
    item: Zotero.Item;
    kind: AiNoteKind;
    html: string;
    existing?: Zotero.Item | null;
    policy?: string;
    lang?: PromptLang;
  }): Promise<Zotero.Item> {
    const parentItem =
      (await this.resolveParentItem(options.item)) || options.item;
    const tag = NOTE_KIND_TAG[options.kind];
    const existing = options.existing || null;
    const isEnglish = options.lang === "en";

    if (existing) {
      const oldHtml = (existing as any).getNote?.() || "";
      const finalHtml =
        options.policy === "append"
          ? `${oldHtml}\n<hr/>\n${options.html}`
          : options.html;
      (existing as any).setNote?.(finalHtml);
      this.ensureTag(existing, tag);
      if (options.kind === "summary")
        this.ensureTag(existing, SUMMARY_NOTE_TAG);
      if (isEnglish) this.ensureTag(existing, ENGLISH_NOTE_TAG);
      await (existing as any).saveTx?.();
      return existing;
    }

    const note = new Zotero.Item("note");
    note.libraryID = parentItem.libraryID;
    note.parentID = parentItem.id;
    note.setNote(options.html);
    note.addTag(tag);
    if (isEnglish) note.addTag(ENGLISH_NOTE_TAG);
    await note.saveTx();
    return note;
  }

  public static async appendFollowUpPair(options: {
    item: Zotero.Item;
    pairId: string;
    userMessage: string;
    assistantMessage: string;
    metadata?: LLMNoteMetadata | null;
    sourceLabel?: string;
  }): Promise<Zotero.Item> {
    const note = await this.getOrCreateDeepReadNote(options.item);
    const noteHtml = (note as any).getNote?.() || "";
    const normalizedNoteHtml = normalizeFollowUpChatNoteHtml(noteHtml);

    if (
      normalizedNoteHtml.includes(
        `AI_BUTLER_CHAT_PAIR_START id=${options.pairId}`,
      )
    ) {
      if (normalizedNoteHtml !== noteHtml) {
        (note as any).setNote(normalizedNoteHtml);
        await (note as any).saveTx();
      }
      return note;
    }

    const blockContent = buildFollowUpChatPairNoteHtml({
      pairId: options.pairId,
      userMessage: options.userMessage,
      assistantMessage: options.assistantMessage,
      sourceLabel: options.sourceLabel,
    });
    const block = options.metadata
      ? LLMNoteMetadataService.wrapHtml(blockContent, options.metadata)
      : blockContent;

    (note as any).setNote(`${normalizedNoteHtml}${block}`);
    this.ensureTag(note, DEEP_READ_NOTE_TAG);
    await (note as any).saveTx();
    return note;
  }

  public static async findLegacyChatNote(
    item: Zotero.Item,
  ): Promise<Zotero.Item | null> {
    try {
      const parentItem = await this.resolveParentItem(item);
      if (!parentItem) return null;
      const noteIDs = (parentItem as any).getNotes?.() || [];
      for (const nid of noteIDs) {
        const note = await Zotero.Items.getAsync(nid);
        if (!note) continue;
        const tags: NoteTag[] = (note as any).getTags?.() || [];
        const html: string = (note as any).getNote?.() || "";
        if (isFollowUpChatNote(tags, html)) return note as Zotero.Item;
      }
    } catch (error) {
      ztoolkit.log("[AI-Butler] 查找旧追问笔记失败:", error);
    }
    return null;
  }

  public static async removeFollowUpPair(
    item: Zotero.Item,
    pairId: string,
  ): Promise<void> {
    const notes = [
      await this.findNote(item, "deepRead"),
      await this.findLegacyChatNote(item),
    ].filter((note): note is Zotero.Item => !!note);

    const startMarker = `<!-- AI_BUTLER_CHAT_PAIR_START id=${pairId} -->`;
    const endMarker = `<!-- AI_BUTLER_CHAT_PAIR_END id=${pairId} -->`;

    for (const note of notes) {
      let html = (note as any).getNote?.() || "";
      const startIdx = html.indexOf(startMarker);
      const endIdx = html.indexOf(endMarker);
      if (startIdx === -1 || endIdx === -1) continue;
      html = html.slice(0, startIdx) + html.slice(endIdx + endMarker.length);
      (note as any).setNote(html);
      await (note as any).saveTx();
    }
  }

  private static async getOrCreateDeepReadNote(
    item: Zotero.Item,
  ): Promise<Zotero.Item> {
    const existing = await this.findNote(item, "deepRead");
    if (existing) return existing;

    const parentItem = (await this.resolveParentItem(item)) || item;
    const title = (parentItem.getField("title") as string) || "文献";
    const note = new Zotero.Item("note");
    note.libraryID = parentItem.libraryID;
    note.parentID = parentItem.id;
    note.setNote(`<h1>AI 精读 - ${escapeHtml(title)}</h1>`);
    note.addTag(DEEP_READ_NOTE_TAG);
    await note.saveTx();
    return note;
  }

  private static ensureTag(note: Zotero.Item, tag: string): void {
    const tags: NoteTag[] = (note as any).getTags?.() || [];
    if (!tags.some((entry) => entry.tag === tag)) {
      note.addTag(tag);
    }
  }
}

function compareModified(a: Zotero.Item, b: Zotero.Item): number {
  const aModified = Date.parse(String((a as any).dateModified || "")) || 0;
  const bModified = Date.parse(String((b as any).dateModified || "")) || 0;
  return aModified - bModified;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default AiNoteService;
