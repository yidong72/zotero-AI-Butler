/**
 * ================================================================
 * 一图总结笔记生成器模块
 * ================================================================
 *
 * 本模块负责将 AI 生成的学术概念海报图片插入 Zotero 笔记
 *
 * 主要职责:
 * 1. 将 Base64 编码的图片嵌入 Zotero 笔记
 * 2. 创建独立的"一图总结"笔记条目
 * 3. 管理已存在的一图总结笔记(避免重复)
 *
 * @module imageNoteGenerator
 * @author AI-Butler Team
 */

import { ENGLISH_NOTE_TAG, isEnglishNoteVariant } from "./aiNoteClassifier";
import type { PromptLang } from "../utils/prompts";

function logImageNote(...args: Parameters<ZToolkit["log"]>): void {
  try {
    if (typeof ztoolkit !== "undefined") ztoolkit.log(...args);
  } catch {
    // Logging must not turn a successful note transaction into a failure.
  }
}

/**
 * 一图总结笔记生成器类
 *
 * 提供静态方法集合，封装图片笔记生成的核心逻辑
 */
export class ImageNoteGenerator {
  /** 一图总结笔记的标识标签 */
  private static readonly IMAGE_NOTE_TAG = "AI-Image-Summary";

  /** 一图总结笔记标题前缀 */
  private static readonly NOTE_TITLE_PREFIX = "AI 管家一图总结 - ";

  /** English image-summary note title prefix. */
  private static readonly NOTE_TITLE_PREFIX_EN = "AI Image Summary - ";

  /**
   * 创建一图总结笔记
   *
   * 使用 Zotero 官方 API 将图片作为独立附件存储，笔记中只保留引用
   * 这样可以大幅减小笔记大小，解决 WebDAV 同步限制问题
   *
   * @param item Zotero 文献条目对象
   * @param imageBase64 Base64 编码的图片数据 (不含 data URI 前缀)
   * @param mimeType 图片 MIME 类型，如 "image/png"
   * @returns 创建的笔记对象
   */
  public static async createImageNote(
    item: Zotero.Item,
    imageBase64: string,
    mimeType: string = "image/png",
    lang: PromptLang = "zh",
  ): Promise<Zotero.Item> {
    const itemTitle = item.getField("title") as string;

    // 检查是否已存在同语言的一图总结笔记（中英文版本互不覆盖）
    let note = await this.findExistingImageNote(item, lang);
    const isUpdate = !!note;
    const previousHtml = note
      ? ((note as any).getNote?.() as string) || ""
      : null;
    const previousTags = note
      ? (
          ((note as any).getTags?.() || []) as Array<{
            tag: string;
            type?: number;
          }>
        ).map(({ tag, type }) => ({ tag, type: type ?? 0 }))
      : null;
    let placeholderPersisted = false;
    let attachment: Zotero.Item | null = null;

    try {
      if (!note) {
        // Embedded images require a persisted parent note. Roll this placeholder
        // back if any later stage fails.
        note = new Zotero.Item("note");
        note.libraryID = item.libraryID;
        note.parentID = item.id;
        note.setNote(
          lang === "en"
            ? "<p>Generating image summary...</p>"
            : "<p>正在生成一图总结...</p>",
        );
        note.addTag(this.IMAGE_NOTE_TAG);
        if (lang === "en") note.addTag(ENGLISH_NOTE_TAG);
        await note.saveTx();
        placeholderPersisted = true;
        logImageNote(`[AI-Butler] 创建新的一图总结笔记: ${note.id}`);
      } else {
        note.addTag(this.IMAGE_NOTE_TAG);
        if (lang === "en") note.addTag(ENGLISH_NOTE_TAG);
      }

      // 将 base64 转换为 Blob
      const normalizedMimeType = this.normalizeImageMimeTypeForEmbedding(
        imageBase64,
        mimeType,
      );
      if (normalizedMimeType !== mimeType) {
        logImageNote(
          `[AI-Butler] Normalize image MIME for embedded note: ${mimeType || "unknown"} -> ${normalizedMimeType}`,
        );
      }

      const blob = this.base64ToBlob(imageBase64, normalizedMimeType);

      // 使用官方 API 创建 embedded-image attachment
      // 这样图片作为独立附件存储，笔记中只保留 data-attachment-key 引用
      attachment = await Zotero.Attachments.importEmbeddedImage({
        blob: blob,
        parentItemID: note.id,
      });

      logImageNote(
        `[AI-Butler] 创建图片附件: key=${attachment.key}, noteID=${note.id}`,
      );

      // 格式化笔记内容（使用 data-attachment-key 引用）
      const noteContent = this.formatImageNoteContentWithAttachment(
        itemTitle,
        attachment.key,
        lang,
      );

      // 更新笔记内容
      note.setNote(noteContent);
      await note.saveTx();
    } catch (error) {
      if (isUpdate && previousHtml !== null) {
        try {
          note?.setNote(previousHtml);
          if (previousTags) (note as any)?.setTags?.(previousTags);
        } catch (restoreError) {
          this.logCleanupFailure(
            "restore the previous image note",
            restoreError,
          );
        }
      }

      if (attachment) {
        await this.eraseAfterFailure(attachment, "new embedded image");
      }
      if (!isUpdate && placeholderPersisted && note) {
        await this.eraseAfterFailure(note, "image-summary placeholder note");
      }
      throw error;
    }

    logImageNote(
      `[AI-Butler] ${isUpdate ? "更新" : "创建"}一图总结笔记完成: ${note.id}`,
    );
    return note;
  }

  private static async eraseAfterFailure(
    item: Zotero.Item,
    label: string,
  ): Promise<void> {
    try {
      await (item as any).eraseTx?.();
    } catch (error) {
      this.logCleanupFailure(`erase ${label}`, error);
    }
  }

  private static logCleanupFailure(action: string, error: unknown): void {
    logImageNote(`[AI-Butler] Failed to ${action}:`, error);
  }

  /**
   * 将 Base64 字符串转换为 Blob 对象
   *
   * @param base64 Base64 编码的数据 (不含 data URI 前缀)
   * @param mimeType MIME 类型
   * @returns Blob 对象
   */
  private static base64ToBlob(base64: string, mimeType: string): Blob {
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mimeType });
  }

  private static normalizeImageMimeType(value: unknown): string | null {
    const mime = String(value || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!mime) return null;
    if (mime === "image/jpg") return "image/jpeg";
    if (
      mime === "image/png" ||
      mime === "image/jpeg" ||
      mime === "image/webp" ||
      mime === "image/gif"
    ) {
      return mime;
    }
    return null;
  }

  private static guessMimeTypeFromBase64(base64: string): string | null {
    const normalized = (base64 || "").replace(/\s+/g, "");
    if (!normalized) return null;

    try {
      const prefixLength = Math.min(normalized.length, 64);
      const alignedLength = Math.max(4, Math.floor(prefixLength / 4) * 4);
      const binary = atob(normalized.slice(0, alignedLength));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return this.guessMimeTypeFromBytes(bytes);
    } catch {
      return null;
    }
  }

  private static guessMimeTypeFromBytes(bytes: Uint8Array): string | null {
    if (
      bytes.byteLength >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    ) {
      return "image/png";
    }

    if (
      bytes.byteLength >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    ) {
      return "image/jpeg";
    }

    if (bytes.byteLength >= 6) {
      const signature = String.fromCharCode(
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
      );
      if (signature === "GIF87a" || signature === "GIF89a") {
        return "image/gif";
      }
    }

    if (bytes.byteLength >= 12) {
      const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
      const webp = String.fromCharCode(
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
      );
      if (riff === "RIFF" && webp === "WEBP") {
        return "image/webp";
      }
    }

    return null;
  }

  private static normalizeImageMimeTypeForEmbedding(
    imageBase64: string,
    mimeType: string,
  ): string {
    const explicitMime = this.normalizeImageMimeType(mimeType);
    if (explicitMime) return explicitMime;

    const sniffedMime = this.guessMimeTypeFromBase64(imageBase64);
    if (sniffedMime) return sniffedMime;

    throw new Error(
      `Unsupported generated image content type: ${mimeType || "unknown"}`,
    );
  }

  /**
   * 格式化使用附件引用的图片笔记 HTML 内容
   *
   * @param itemTitle 文献标题
   * @param attachmentKey 图片附件的 key
   * @returns 格式化后的 HTML 内容
   */
  private static formatImageNoteContentWithAttachment(
    itemTitle: string,
    attachmentKey: string,
    lang: PromptLang = "zh",
  ): string {
    // 截断过长的标题
    const maxTitleLength = 80;
    let truncatedTitle = itemTitle;
    if (truncatedTitle.length > maxTitleLength) {
      truncatedTitle = truncatedTitle.substring(0, maxTitleLength) + "...";
    }

    const titlePrefix =
      lang === "en" ? this.NOTE_TITLE_PREFIX_EN : this.NOTE_TITLE_PREFIX;
    const imageAlt = lang === "en" ? "Academic concept poster" : "学术概念海报";
    const footer =
      lang === "en"
        ? "Academic concept poster generated by AI Butler"
        : "由 AI 管家自动生成的学术概念海报";

    // 构建笔记 HTML，使用 data-attachment-key 引用图片
    return `<h2>${titlePrefix}${this.escapeHtml(truncatedTitle)}</h2>
<div style="text-align: center; padding: 10px;">
  <img data-attachment-key="${attachmentKey}" alt="${imageAlt}" style="max-width: 100%; height: auto;" />
</div>
<p style="text-align: center; color: #666; font-size: 12px;">
  ${footer}
</p>`;
  }

  /**
   * 使用本地文件路径创建一图总结笔记 (测试用)
   *
   * 读取本地图片文件并转换为 Base64 后创建笔记
   *
   * @param item Zotero 文献条目对象
   * @param imagePath 本地图片文件的绝对路径
   * @returns 创建的笔记对象
   */
  public static async createImageNoteFromFile(
    item: Zotero.Item,
    imagePath: string,
  ): Promise<Zotero.Item> {
    try {
      // 使用 Zotero 的文件 API 读取图片
      const file = Zotero.File.pathToFile(imagePath);
      if (!file.exists()) {
        throw new Error(`图片文件不存在: ${imagePath}`);
      }

      // 读取文件内容为字节数组
      const contents = await Zotero.File.getBinaryContentsAsync(imagePath);

      // 将字节数组转换为 Base64
      // 使用 btoa 进行 Base64 编码
      const base64 = btoa(contents);

      // 根据文件扩展名确定 MIME 类型
      const ext = imagePath.toLowerCase().split(".").pop();
      const mimeMap: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
      };
      const mimeType = mimeMap[ext || "png"] || "image/png";

      return this.createImageNote(item, base64, mimeType);
    } catch (error: any) {
      ztoolkit.log(`[AI-Butler] 从文件创建一图总结笔记失败:`, error);
      throw new Error(`读取图片文件失败: ${error.message || error}`);
    }
  }

  /**
   * 查找已有的一图总结笔记
   *
   * 通过标签或标题标识查找文献条目下已存在的一图总结笔记
   *
   * @param item Zotero 文献条目对象
   * @returns 找到的笔记对象，如果不存在则返回 null
   */
  public static async findExistingImageNote(
    item: Zotero.Item,
    lang: PromptLang = "zh",
  ): Promise<Zotero.Item | null> {
    try {
      const noteIDs = (item as any).getNotes?.() || [];
      ztoolkit.log(`[AI-Butler] 查找一图总结笔记，共 ${noteIDs.length} 个笔记`);

      for (const nid of noteIDs) {
        const n = await Zotero.Items.getAsync(nid);
        if (!n) continue;

        // 检查是否有一图总结标签
        const tags: Array<{ tag: string }> = (n as any).getTags?.() || [];
        const hasTag = tags.some((t) => t.tag === this.IMAGE_NOTE_TAG);
        // 中英文版本按 ENGLISH_NOTE_TAG 区分，互不覆盖
        // 检查标题是否匹配 (多种模式)
        const noteHtml: string = (n as any).getNote?.() || "";
        if (isEnglishNoteVariant(tags, noteHtml) !== (lang === "en")) continue;

        // 模式1: 精确匹配 "AI 管家一图总结 -"
        const titleMatch1 = new RegExp(
          `<h2>\\s*${this.escapeRegExp(this.NOTE_TITLE_PREFIX)}`,
        ).test(noteHtml);

        // 模式2: 宽松匹配 "一图总结"
        const titleMatch2 = /<h2>[^<]*一图总结[^<]*<\/h2>/i.test(noteHtml);

        // 模式3: 匹配标题中包含 "AI 管家一图总结"
        const titleMatch3 = noteHtml.includes("AI 管家一图总结");

        // 模式4: 英文标题
        const titleMatch4 = /<h2>\s*AI\s*Image\s+Summary\s*-/i.test(noteHtml);

        if (
          hasTag ||
          titleMatch1 ||
          titleMatch2 ||
          titleMatch3 ||
          titleMatch4
        ) {
          ztoolkit.log(
            `[AI-Butler] 找到一图总结笔记: ID=${nid}, hasTag=${hasTag}, titleMatch1=${titleMatch1}, titleMatch2=${titleMatch2}, titleMatch3=${titleMatch3}, titleMatch4=${titleMatch4}`,
          );
          return n as Zotero.Item;
        }
      }

      ztoolkit.log(`[AI-Butler] 未找到一图总结笔记`);
      return null;
    } catch (error) {
      ztoolkit.log(`[AI-Butler] 查找一图总结笔记失败:`, error);
      return null;
    }
  }

  /**
   * 从笔记中提取图片 data URI 或附件路径
   *
   * @param note Zotero 笔记对象
   * @returns 图片的 data URI 或 null，如果是附件则返回附件信息
   */
  public static extractImageFromNote(note: Zotero.Item): string | null {
    try {
      const noteHtml: string = (note as any).getNote?.() || "";

      // 尝试多种匹配模式
      // 模式1: 标准 img src 属性 (data URI)
      let match = noteHtml.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (match && match[1]) {
        return match[1];
      }

      // 模式2: src 属性没有引号
      match = noteHtml.match(/<img[^>]+src=([^\s>]+)/i);
      if (match && match[1]) {
        return match[1].replace(/["']/g, "");
      }

      // 模式3: 直接查找 data:image
      match = noteHtml.match(/(data:image\/[^"'\s]+)/i);
      if (match && match[1]) {
        return match[1];
      }

      ztoolkit.log(
        "[AI-Butler] 笔记中未找到图片，HTML 内容:",
        noteHtml.substring(0, 500),
      );
      return null;
    } catch (error) {
      ztoolkit.log("[AI-Butler] 提取笔记图片失败:", error);
      return null;
    }
  }

  /**
   * 从笔记中提取图片附件 key
   *
   * @param note Zotero 笔记对象
   * @returns 附件 key，如果未找到则返回 null
   */
  public static extractAttachmentKeyFromNote(note: Zotero.Item): string | null {
    try {
      const noteHtml: string = (note as any).getNote?.() || "";

      // 匹配 data-attachment-key 属性
      const match = noteHtml.match(/data-attachment-key=["']([^"']+)["']/i);
      if (match && match[1]) {
        ztoolkit.log(`[AI-Butler] 找到附件 key: ${match[1]}`);
        return match[1];
      }

      return null;
    } catch (error) {
      ztoolkit.log("[AI-Butler] 提取附件 key 失败:", error);
      return null;
    }
  }

  /**
   * 从笔记中获取图片（支持 data URI 和附件引用）
   *
   * @param note Zotero 笔记对象
   * @returns 图片的 data URI，如果未找到则返回 null
   */
  public static async getImageFromNote(
    note: Zotero.Item,
  ): Promise<string | null> {
    try {
      // 首先尝试提取内嵌的 data URI
      const dataUri = this.extractImageFromNote(note);
      if (dataUri && dataUri.startsWith("data:")) {
        return dataUri;
      }

      // 然后尝试从附件获取
      const attachmentKey = this.extractAttachmentKeyFromNote(note);
      if (attachmentKey) {
        // 通过 key 查找附件
        const libraryID = note.libraryID;
        const attachment = await Zotero.Items.getByLibraryAndKeyAsync(
          libraryID,
          attachmentKey,
        );

        if (attachment && (attachment as any).isFileAttachment?.()) {
          const filePath = await (attachment as any).getFilePathAsync?.();
          if (filePath) {
            ztoolkit.log(`[AI-Butler] 附件文件路径: ${filePath}`);

            // 读取文件并转换为 Base64
            const contents = await Zotero.File.getBinaryContentsAsync(filePath);
            const base64 = btoa(contents);

            // 根据文件扩展名确定 MIME 类型
            const ext = filePath.toLowerCase().split(".").pop() || "png";
            const mimeMap: Record<string, string> = {
              png: "image/png",
              jpg: "image/jpeg",
              jpeg: "image/jpeg",
              gif: "image/gif",
              webp: "image/webp",
            };
            const mimeType = mimeMap[ext] || "image/png";

            return `data:${mimeType};base64,${base64}`;
          }
        }
      }

      ztoolkit.log("[AI-Butler] 无法从笔记获取图片");
      return null;
    } catch (error) {
      ztoolkit.log("[AI-Butler] 获取笔记图片失败:", error);
      return null;
    }
  }

  /**
   * 获取笔记中图片附件的文件路径
   *
   * @param note Zotero 笔记对象
   * @returns 图片附件的文件路径，如果未找到则返回 null
   */
  public static async getImageAttachmentPath(
    note: Zotero.Item,
  ): Promise<string | null> {
    try {
      // 尝试从附件获取文件路径
      const attachmentKey = this.extractAttachmentKeyFromNote(note);
      if (attachmentKey) {
        // 通过 key 查找附件
        const libraryID = note.libraryID;
        const attachment = await Zotero.Items.getByLibraryAndKeyAsync(
          libraryID,
          attachmentKey,
        );

        if (attachment && (attachment as any).isFileAttachment?.()) {
          const filePath = await (attachment as any).getFilePathAsync?.();
          if (filePath) {
            ztoolkit.log(`[AI-Butler] 获取图片附件路径: ${filePath}`);
            return filePath;
          }
        }
      }

      ztoolkit.log("[AI-Butler] 无法获取图片附件路径");
      return null;
    } catch (error) {
      ztoolkit.log("[AI-Butler] 获取图片附件路径失败:", error);
      return null;
    }
  }

  /**
   * 格式化图片笔记的 HTML 内容
   *
   * @param itemTitle 文献标题
   * @param imageDataUri 图片的 data URI (含完整前缀)
   * @returns 格式化后的 HTML 内容
   */
  private static formatImageNoteContent(
    itemTitle: string,
    imageDataUri: string,
  ): string {
    // 截断过长的标题
    const maxTitleLength = 80;
    let truncatedTitle = itemTitle;
    if (truncatedTitle.length > maxTitleLength) {
      truncatedTitle = truncatedTitle.substring(0, maxTitleLength) + "...";
    }

    // 构建笔记 HTML
    // 使用简单的 HTML 结构，确保 Zotero 兼容性
    return `<h2>${this.NOTE_TITLE_PREFIX}${this.escapeHtml(truncatedTitle)}</h2>
<div style="text-align: center; padding: 10px;">
  <img src="${imageDataUri}" alt="学术概念海报" style="max-width: 100%; height: auto;" />
</div>
<p style="text-align: center; color: #666; font-size: 12px;">
  由 AI 管家自动生成的学术概念海报
</p>`;
  }

  /**
   * HTML 转义工具函数
   *
   * @param text 待转义的文本
   * @returns 转义后的安全 HTML 文本
   */
  private static escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * 正则转义工具函数
   *
   * @param str 待转义的字符串
   * @returns 转义后可用于正则的字符串
   */
  private static escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}

export default ImageNoteGenerator;
