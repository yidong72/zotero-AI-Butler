import { ImageNoteGenerator } from "./imageNoteGenerator";
import { LiteratureReviewService } from "./literatureReviewService";
import { MindmapService } from "./mindmapService";
import { NoteGenerator } from "./noteGenerator";
import { AiNoteService } from "./aiNoteService";
import {
  hasLegacyDeepReadRecoveryArtifacts,
  hasRunnableDeepReadSlots,
  noteHasDeepReadPlaceholderText,
} from "./deepReadEngine";
import type { PromptLang } from "../utils/prompts";

export type FixedTaskArtifactType =
  | "summary"
  | "deepRead"
  | "imageSummary"
  | "mindmap"
  | "tableFill";

export interface TaskArtifactProbeResult {
  exists: boolean;
  probeFailed?: boolean;
  reason?: string;
}

export class TaskArtifacts {
  public static async probe(
    taskType: FixedTaskArtifactType,
    item: Zotero.Item,
    lang: PromptLang = "zh",
  ): Promise<TaskArtifactProbeResult> {
    try {
      switch (taskType) {
        case "summary":
          return this.probeSummary(item, lang);
        case "deepRead":
          return this.probeDeepRead(item, lang);
        case "imageSummary":
          return this.probeImageSummary(item, lang);
        case "mindmap":
          return this.probeMindmap(item, lang);
        case "tableFill":
          return this.probeTable(item);
      }

      return {
        exists: false,
        probeFailed: true,
        reason: "unsupported-task-type",
      };
    } catch (error) {
      ztoolkit.log(
        `[AI-Butler] Failed to probe ${taskType} artifact for item ${item.id}:`,
        error,
      );
      return {
        exists: false,
        probeFailed: true,
        reason: "probe-failed",
      };
    }
  }

  private static async probeSummary(
    item: Zotero.Item,
    lang: PromptLang = "zh",
  ): Promise<TaskArtifactProbeResult> {
    const note = await NoteGenerator.findExistingNote(item, lang);
    if (!note) {
      return { exists: false, reason: "summary-note-missing" };
    }

    return this.noteHasUsableContent(note)
      ? { exists: true }
      : { exists: false, reason: "summary-note-empty" };
  }

  private static async probeDeepRead(
    item: Zotero.Item,
    lang: PromptLang = "zh",
  ): Promise<TaskArtifactProbeResult> {
    const note = await AiNoteService.findNote(item, "deepRead", lang);
    if (!note) {
      return { exists: false, reason: "deep-read-note-missing" };
    }

    if (!this.noteHasUsableContent(note)) {
      return { exists: false, reason: "deep-read-note-empty" };
    }

    const noteHtml: string = (note as any).getNote?.() || "";
    if (hasRunnableDeepReadSlots(noteHtml)) {
      return { exists: false, reason: "deep-read-slots-incomplete" };
    }
    // 标记被清洗丢失但正文仍残留占位符 → 视为损坏未完成，需要整体重生。
    if (noteHasDeepReadPlaceholderText(noteHtml)) {
      return { exists: false, reason: "deep-read-placeholder-residual" };
    }
    if (hasLegacyDeepReadRecoveryArtifacts(noteHtml)) {
      return { exists: false, reason: "deep-read-recovery-residual" };
    }

    return { exists: true };
  }

  private static async probeImageSummary(
    item: Zotero.Item,
    lang: PromptLang = "zh",
  ): Promise<TaskArtifactProbeResult> {
    const note = await ImageNoteGenerator.findExistingImageNote(item, lang);
    if (!note) {
      return { exists: false, reason: "image-note-missing" };
    }

    const image = await ImageNoteGenerator.getImageFromNote(note);
    return image?.trim()
      ? { exists: true }
      : { exists: false, reason: "image-unreadable" };
  }

  private static async probeMindmap(
    item: Zotero.Item,
    lang: PromptLang = "zh",
  ): Promise<TaskArtifactProbeResult> {
    const note = await MindmapService.findExistingMindmapNote(item, lang);
    if (!note) {
      return { exists: false, reason: "mindmap-note-missing" };
    }

    const noteHtml: string = (note as any).getNote?.() || "";
    const markmapMatch = noteHtml.match(/```markmap\s*\n([\s\S]*?)\n```/);
    return markmapMatch?.[1]?.trim()
      ? { exists: true }
      : { exists: false, reason: "mindmap-content-missing" };
  }

  private static async probeTable(
    item: Zotero.Item,
  ): Promise<TaskArtifactProbeResult> {
    const note = await LiteratureReviewService.findTableNoteItem(item);
    if (!note) {
      return { exists: false, reason: "table-note-missing" };
    }

    const content = await LiteratureReviewService.findTableNote(item);
    return content?.trim()
      ? { exists: true }
      : { exists: false, reason: "table-note-empty" };
  }

  private static noteHasUsableContent(note: Zotero.Item): boolean {
    const noteHtml: string = (note as any).getNote?.() || "";
    const textContent = noteHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    return textContent.trim().length > 0;
  }
}

export default TaskArtifacts;
