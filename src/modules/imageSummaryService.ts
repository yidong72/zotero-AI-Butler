/**
 * ================================================================
 * 一图总结服务模块
 * ================================================================
 *
 * 整合完整的一图总结工作流：
 * 1. 提取论文 PDF 内容
 * 2. 调用 LLM 生成视觉摘要
 * 3. 调用 Gemini 生成学术概念海报
 * 4. 将图片保存到 Zotero 笔记
 *
 * @module imageSummaryService
 * @author AI-Butler Team
 */

import { PDFExtractor } from "./pdfExtractor";
import LLMService from "./llmService";
import {
  ImageClient,
  ImageGenerationError,
  type ImageGenerationResult,
} from "./imageClient";
import { ImageNoteGenerator } from "./imageNoteGenerator";
import { NoteGenerator } from "./noteGenerator";
import { getPref } from "../utils/prefs";
import {
  LLMEndpointManager,
  type LLMPdfProcessMode,
} from "./llmEndpointManager";
import type { LLMAbortSignal } from "./llmproviders/types";
import {
  getDefaultImageSummaryPrompt,
  getDefaultImageGenerationPrompt,
  type PromptLang,
} from "../utils/prompts";

function logImageSummary(...args: Parameters<ZToolkit["log"]>): void {
  try {
    if (typeof ztoolkit !== "undefined") ztoolkit.log(...args);
  } catch {
    // Logging is best-effort.
  }
}

/**
 * 工作流阶段类型
 */
export type WorkflowStage =
  | "extracting" // 提取 PDF
  | "summarizing" // 生成视觉摘要
  | "generating" // 生成图片
  | "saving" // 保存笔记
  | "completed" // 完成
  | "failed"; // 失败

/**
 * 工作流进度回调
 */
export type WorkflowProgressCallback = (
  stage: WorkflowStage,
  message: string,
  progress: number,
) => void;

type ImageWorkflowCheckpoint = {
  summaryFingerprint?: string;
  visualSummary?: string;
  imageFingerprint?: string;
  imageResult?: ImageGenerationResult;
};

/**
 * 一图总结服务类
 */
export class ImageSummaryService {
  private static readonly workflowCheckpoints = new Map<
    string,
    ImageWorkflowCheckpoint
  >();

  private static getCheckpoint(
    itemId: number,
    lang: PromptLang,
  ): ImageWorkflowCheckpoint {
    const key = `${itemId}:${lang}`;
    let checkpoint = this.workflowCheckpoints.get(key);
    if (!checkpoint) {
      if (this.workflowCheckpoints.size >= 4) {
        const oldest = this.workflowCheckpoints.keys().next().value;
        if (oldest) this.workflowCheckpoints.delete(oldest);
      }
      checkpoint = {};
      this.workflowCheckpoints.set(key, checkpoint);
    }
    return checkpoint;
  }

  /**
   * 为文献条目生成一图总结
   *
   * @param item Zotero 文献条目
   * @param progressCallback 进度回调
   * @returns 创建的笔记对象
   */
  public static async generateForItem(
    item: Zotero.Item,
    progressCallback?: WorkflowProgressCallback,
    abortSignal?: LLMAbortSignal,
    lang: PromptLang = "zh",
  ): Promise<Zotero.Item> {
    const itemTitle = item.getField("title") as string;
    const checkpointKey = `${item.id}:${lang}`;
    const checkpoint = this.getCheckpoint(item.id, lang);

    try {
      // ========== 阶段 1: 获取论文内容 ==========
      progressCallback?.("extracting", "正在提取论文内容...", 10);

      let pdfContent = "";
      let sourceItem: Zotero.Item | undefined;
      let sourceNote: Zotero.Item | undefined;
      let isBase64 = false;
      const pdfMode = LLMService.getEffectivePdfProcessMode();

      // 检查是否使用已有 AI 总结
      const useExistingNote =
        (getPref("imageSummaryUseExistingNote" as any) as boolean) || false;

      if (useExistingNote) {
        // 尝试获取已有的 AI 总结内容
        const existingNote = await NoteGenerator.findExistingNote(item, lang);
        if (existingNote) {
          sourceNote = existingNote;
          const noteHtml = (existingNote as any).getNote?.() || "";
          // 简单地去除 HTML 标签
          pdfContent = noteHtml
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          logImageSummary(
            `[AI-Butler] 使用已有 AI 总结，长度: ${pdfContent.length}`,
          );
        } else {
          // 没有已有笔记，回退到 PDF 提取
          logImageSummary("[AI-Butler] 未找到已有 AI 总结，使用 PDF 提取");
          await this.assertPdfSizeAllowed(item, pdfMode);
          sourceItem = item;
          isBase64 = pdfMode === "base64";
        }
      } else {
        // 交给 LLMService 解析，以便大文件自动回退到文本模式。
        await this.assertPdfSizeAllowed(item, pdfMode);
        sourceItem = item;
        isBase64 = pdfMode === "base64";
      }

      const summaryFingerprint = this.createFingerprint({
        version: 1,
        source: await this.describeSource(
          item,
          sourceNote,
          pdfContent,
          pdfMode,
          useExistingNote,
        ),
        title: itemTitle,
        lang,
        promptTemplate: this.getVisualSummaryPromptTemplate(lang),
        llm: this.describeLlmConfiguration(),
      });
      if (checkpoint.summaryFingerprint !== summaryFingerprint) {
        checkpoint.summaryFingerprint = summaryFingerprint;
        checkpoint.visualSummary = undefined;
        checkpoint.imageFingerprint = undefined;
        checkpoint.imageResult = undefined;
      }

      // ========== 阶段 2: 生成视觉摘要 ==========
      progressCallback?.("summarizing", "正在生成视觉摘要...", 30);

      const visualSummary =
        checkpoint.visualSummary ||
        (await this.generateVisualSummary(
          pdfContent,
          isBase64,
          itemTitle,
          abortSignal,
          lang,
          sourceItem,
        ));
      checkpoint.visualSummary = visualSummary;

      logImageSummary(
        `[AI-Butler] 视觉摘要生成完成，长度: ${visualSummary.length}`,
      );

      // ========== 阶段 3: 生成学术概念海报 ==========
      progressCallback?.("generating", "正在生成学术概念海报...", 60);

      const imagePrompt = this.buildImagePrompt(visualSummary, itemTitle, lang);
      const imageFingerprint = this.createFingerprint({
        version: 1,
        prompt: imagePrompt,
        config: this.describeImageConfiguration(),
      });
      if (checkpoint.imageFingerprint !== imageFingerprint) {
        checkpoint.imageFingerprint = imageFingerprint;
        checkpoint.imageResult = undefined;
      }

      const imageResult =
        checkpoint.imageResult ||
        (await ImageClient.generateImage(imagePrompt, { abortSignal }));
      checkpoint.imageResult = imageResult;

      logImageSummary(
        `[AI-Butler] 图片生成完成，大小: ${Math.round(imageResult.imageBase64.length / 1024)} KB`,
      );

      // ========== 阶段 4: 保存笔记 ==========
      progressCallback?.("saving", "正在保存一图总结笔记...", 90);

      const note = await ImageNoteGenerator.createImageNote(
        item,
        imageResult.imageBase64,
        imageResult.mimeType,
        lang,
      );

      progressCallback?.("completed", "一图总结生成完成！", 100);
      this.workflowCheckpoints.delete(checkpointKey);

      return note;
    } catch (error: any) {
      progressCallback?.("failed", `生成失败: ${error.message}`, 0);

      // 记录详细错误日志
      if (error instanceof ImageGenerationError) {
        logImageSummary(
          "[AI-Butler] 一图总结生成失败:",
          ImageClient.formatError(error),
        );
      } else {
        logImageSummary("[AI-Butler] 一图总结生成失败:", error);
      }

      throw error;
    }
  }

  /**
   * 提取 PDF 内容
   */
  private static async assertPdfSizeAllowed(
    item: Zotero.Item,
    mode: LLMPdfProcessMode,
  ): Promise<void> {
    if (mode !== "base64") return;
    const enableSizeLimit =
      (getPref("enablePdfSizeLimit" as any) as boolean) ?? false;
    if (!enableSizeLimit) return;
    const maxPdfSizeMB = parseFloat(
      (getPref("maxPdfSizeMB" as any) as string) || "50",
    );
    const fileSizeMB = await PDFExtractor.getPdfFileSize(item);
    if (fileSizeMB > maxPdfSizeMB) {
      throw new Error(
        `PDF 文件过大 (${fileSizeMB.toFixed(1)} MB)，超过设置的阈值 ${maxPdfSizeMB} MB`,
      );
    }
  }

  private static getVisualSummaryPromptTemplate(lang: PromptLang): string {
    return lang === "en"
      ? getDefaultImageSummaryPrompt("en")
      : (getPref("imageSummaryPrompt" as any) as string) ||
          getDefaultImageSummaryPrompt();
  }

  private static getImagePromptTemplate(lang: PromptLang): string {
    return lang === "en"
      ? getDefaultImageGenerationPrompt("en")
      : (getPref("imageSummaryImagePrompt" as any) as string) ||
          getDefaultImageGenerationPrompt();
  }

  private static createFingerprint(value: unknown): string {
    const serialized = JSON.stringify(value);
    let left = 0x811c9dc5;
    let right = 0x9e3779b9;
    for (let index = 0; index < serialized.length; index++) {
      const code = serialized.charCodeAt(index);
      left = Math.imul(left ^ code, 0x01000193);
      right = Math.imul(right ^ code, 0x85ebca6b);
    }
    return `${(left >>> 0).toString(36)}:${(right >>> 0).toString(36)}:${serialized.length}`;
  }

  private static describeLlmConfiguration(): unknown {
    try {
      return {
        endpoints: LLMEndpointManager.getEnabledEndpoints().map((endpoint) => ({
          id: endpoint.id,
          providerType: endpoint.providerType,
          apiUrl: endpoint.apiUrl,
          apiKey: endpoint.apiKey,
          model: endpoint.model,
          reasoningEffort: endpoint.reasoningEffort,
          pdfProcessMode: endpoint.pdfProcessMode,
        })),
        routingStrategy: LLMEndpointManager.getRoutingStrategy(),
        maxAttempts: LLMEndpointManager.getMaxAttemptCount(),
        sampling: {
          enableTemperature: getPref("enableTemperature" as any),
          temperature: getPref("temperature" as any),
          enableTopP: getPref("enableTopP" as any),
          topP: getPref("topP" as any),
          enableMaxTokens: getPref("enableMaxTokens" as any),
          maxTokens: getPref("maxTokens" as any),
          reasoningEffort: getPref("reasoningEffort" as any),
        },
      };
    } catch {
      return {
        endpoints: getPref("llmEndpoints" as any),
        provider: getPref("provider" as any),
      };
    }
  }

  private static describeImageConfiguration(): unknown {
    return {
      requestMode: getPref("imageSummaryRequestMode" as any),
      apiUrl: getPref("imageSummaryApiUrl" as any),
      apiKey: getPref("imageSummaryApiKey" as any),
      model: getPref("imageSummaryModel" as any),
      aspectRatioEnabled: getPref("imageSummaryAspectRatioEnabled" as any),
      aspectRatio: getPref("imageSummaryAspectRatio" as any),
      resolutionEnabled: getPref("imageSummaryResolutionEnabled" as any),
      resolution: getPref("imageSummaryResolution" as any),
      customHeaders: getPref("imageSummaryCustomHeaders" as any),
    };
  }

  private static async describeSource(
    item: Zotero.Item,
    sourceNote: Zotero.Item | undefined,
    noteText: string,
    pdfMode: LLMPdfProcessMode,
    preferExistingNote: boolean,
  ): Promise<unknown> {
    if (sourceNote) {
      return {
        kind: "summary-note",
        id: sourceNote.id,
        key: (sourceNote as any).key,
        dateModified: (sourceNote as any).dateModified,
        content: noteText,
      };
    }

    let attachmentDescription: unknown = null;
    try {
      if (typeof (item as any).getAttachments === "function") {
        const attachment = (await PDFExtractor.getAllPdfAttachments(item))[0];
        if (attachment) {
          const filePath = await (attachment as any).getFilePathAsync?.();
          let fileInfo: FileInfo | null = null;
          if (filePath && typeof IOUtils !== "undefined") {
            try {
              fileInfo = await IOUtils.stat(filePath);
            } catch {
              // Item metadata still provides a stable fallback fingerprint.
            }
          }
          attachmentDescription = {
            id: attachment.id,
            key: (attachment as any).key,
            dateAdded: (attachment as any).dateAdded,
            dateModified: (attachment as any).dateModified,
            version: (attachment as any).version,
            filePath,
            size: fileInfo?.size,
            lastModified: fileInfo?.lastModified,
          };
        }
      }
    } catch (error) {
      logImageSummary(
        "[AI-Butler] Failed to fingerprint image-summary PDF source:",
        error,
      );
    }

    return {
      kind: preferExistingNote ? "pdf-fallback" : "pdf",
      itemId: item.id,
      itemKey: (item as any).key,
      pdfMode,
      mineruModelVersion:
        pdfMode === "mineru" ? getPref("mineruModelVersion" as any) : undefined,
      attachment: attachmentDescription,
    };
  }

  /**
   * 生成视觉摘要
   */
  private static async generateVisualSummary(
    pdfContent: string,
    isBase64: boolean,
    itemTitle: string,
    abortSignal?: LLMAbortSignal,
    lang: PromptLang = "zh",
    sourceItem?: Zotero.Item,
  ): Promise<string> {
    // 获取视觉提取提示词；英文入口忽略中文自定义提示词，直接用内置英文模板
    let prompt = this.getVisualSummaryPromptTemplate(lang);

    // 替换变量
    prompt = prompt.replace(
      /\$\{context\}/g,
      sourceItem
        ? "[Paper content is provided separately]"
        : isBase64
          ? "[PDF 文件内容]"
          : pdfContent.substring(0, 5000),
    );
    prompt = prompt.replace(/\$\{title\}/g, itemTitle);
    prompt = prompt.replace(
      /\$\{language\}/g,
      lang === "en" ? "English" : "中文",
    );

    // 调用 LLM 生成视觉摘要 (使用带重试的方法，支持 API 密钥轮换)
    const summary = await LLMService.generateText({
      task: "image-summary",
      prompt,
      content: sourceItem
        ? {
            kind: "zotero-item",
            item: sourceItem,
            attachmentMode: "default",
          }
        : { kind: "text", text: pdfContent, policy: "text" },
      transport: { abortSignal },
    });

    return summary;
  }

  /**
   * 构建生图提示词
   */
  private static buildImagePrompt(
    visualSummary: string,
    itemTitle: string,
    lang: PromptLang = "zh",
  ): string {
    // 获取生图提示词模板；英文入口忽略中文自定义提示词
    let prompt = this.getImagePromptTemplate(lang);

    // 获取语言设置；英文入口强制英文输出
    const language =
      lang === "en"
        ? "English"
        : (getPref("imageSummaryLanguage" as any) as string) || "中文";

    // 替换变量
    prompt = prompt.replace(/\$\{summaryForImage\}/g, visualSummary);
    prompt = prompt.replace(/\$\{title\}/g, itemTitle);
    prompt = prompt.replace(/\$\{language\}/g, language);

    return prompt;
  }
}

export default ImageSummaryService;
