/**
 * 统一 LLM 中间件。
 *
 * 上层功能只描述任务、提示词和内容来源；本层负责：
 * - 读取 Provider 与通用配置
 * - 按 Provider 能力选择 PDF/Base64/Text 输入形态
 * - 执行密钥轮换与重试
 * - 返回统一 LLMResponse
 */
import { getPref } from "../utils/prefs";
import { getDefaultSummaryPrompt } from "../utils/prompts";
import { ApiKeyManager, type ProviderId } from "./apiKeyManager";
import {
  LLMEndpointManager,
  type LLMEndpoint,
  type LLMPdfProcessMode,
} from "./llmEndpointManager";
import { PDFExtractor } from "./pdfExtractor";
import { ProviderRegistry } from "./llmproviders/ProviderRegistry";
import "./llmproviders";
import type { ILlmProvider, PdfFileInfo } from "./llmproviders/ILlmProvider";
import type { ConnectionTestMode } from "./llmproviders/shared/connectionTest";
import {
  normalizeReasoningEffortSetting,
  resolveReasoningEffort,
} from "./llmproviders/shared/reasoning";
import {
  isAbortError,
  normalizeAbortError,
  throwIfAborted,
} from "./llmproviders/shared/requestAbort";
import {
  classifyRequestFailure,
  isPayloadTooLargeFailure,
  normalizeRequestFailureMessage,
  type RequestFailureKind,
} from "./llmproviders/shared/requestFailure";
import type {
  ConversationMessage,
  LLMAbortSignal,
  LLMOptions,
  LLMModelInfo,
  LLMProviderCapabilities,
  LLMReasoningEffortSetting,
  LLMResponse,
  ProgressCb,
} from "./llmproviders/types";

function logLLMService(...args: Parameters<ZToolkit["log"]>): void {
  try {
    if (typeof ztoolkit !== "undefined") ztoolkit.log(...args);
  } catch {
    // Diagnostics must never change request behavior.
  }
}

export type LLMTask =
  | "summary"
  | "mindmap"
  | "table"
  | "literature-review"
  | "chat"
  | "image-summary"
  | "custom";

export type LLMContentPolicy = "auto" | "text" | "pdf-base64" | "mineru";
export type LLMAttachmentMode = "default" | "all";

export type LLMTextContent = {
  kind: "text";
  text: string;
  policy?: LLMContentPolicy;
};

export type LLMZoteroItemContent = {
  kind: "zotero-item";
  item: Zotero.Item;
  policy?: LLMContentPolicy;
  attachmentMode?: LLMAttachmentMode;
  maxAttachments?: number;
};

export type LLMPdfAttachmentContent = {
  kind: "pdf-attachment";
  item?: Zotero.Item;
  attachment: Zotero.Item;
  policy?: LLMContentPolicy;
};

export type LLMPdfFileInput = PdfFileInfo & {
  textContent?: string;
};

export type LLMPdfFilesContent = {
  kind: "pdf-files";
  files: LLMPdfFileInput[];
  policy?: LLMContentPolicy;
  maxAttachments?: number;
};

type LLMLegacyContent = {
  kind: "legacy";
  content: string;
  isBase64: boolean;
  policy?: LLMContentPolicy;
  /** Optional source used to recover with extracted text after a size rejection. */
  fallbackItem?: Zotero.Item;
};

export type LLMContentInput =
  | LLMTextContent
  | LLMZoteroItemContent
  | LLMPdfAttachmentContent
  | LLMPdfFilesContent
  | LLMLegacyContent;

export type LLMGenerationOptions = {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  reasoningEffort?: LLMReasoningEffortSetting;
  verbosity?: string;
  responseFormat?: string;
  vendorOptions?: Record<string, unknown>;
};

export type LLMTransportOptions = {
  stream?: boolean;
  timeoutMs?: number;
  retry?: boolean;
  keyRotation?: boolean;
  abortSignal?: LLMAbortSignal;
};

export type LLMGenerateRequest = {
  task: LLMTask;
  prompt?: string;
  content: LLMContentInput;
  output?: {
    format?: "markdown" | "text" | "json";
  };
  generation?: LLMGenerationOptions;
  transport?: LLMTransportOptions;
  metadata?: Record<string, unknown>;
  onProgress?: ProgressCb;
};

export type LLMChatRequest = {
  content: LLMContentInput;
  conversation: ConversationMessage[];
  generation?: LLMGenerationOptions;
  transport?: LLMTransportOptions;
  metadata?: Record<string, unknown>;
  onProgress?: ProgressCb;
};

type ResolvedSingleContent = {
  mode: "single";
  content: string;
  isBase64: boolean;
  warnings: string[];
};

type ResolvedMultiFileContent = {
  mode: "multi-file";
  files: PdfFileInfo[];
  warnings: string[];
};

type ResolvedContent = ResolvedSingleContent | ResolvedMultiFileContent;

type ResolvedProvider = {
  id: string;
  impl: ILlmProvider;
  endpoint?: LLMEndpoint;
};

// NVIDIA's gateway rejects request bodies above 32 MiB. Keep enough room for
// JSON framing, prompts, and deep-read conversation history.
export const SAFE_INLINE_REQUEST_BYTES = 24 * 1024 * 1024;
const REQUEST_ENVELOPE_RESERVE_BYTES = 64 * 1024;
const MAX_API_ATTEMPTS = 5;

export function estimateBase64Length(rawBytes: number): number {
  if (!Number.isFinite(rawBytes) || rawBytes <= 0) return 0;
  return Math.ceil(rawBytes / 3) * 4;
}

export function utf8ByteLength(value: string): number {
  try {
    return new TextEncoder().encode(value).byteLength;
  } catch {
    return encodeURIComponent(value).replace(/%[0-9A-F]{2}/gi, "x").length;
  }
}

export function estimateInlinePdfRequestBytes(
  inlineBase64Bytes: number,
  requestText: string = "",
): number {
  return (
    Math.max(0, inlineBase64Bytes) +
    utf8ByteLength(requestText) +
    REQUEST_ENVELOPE_RESERVE_BYTES
  );
}

export class LLMRequestTooLargeError extends Error {
  public readonly suppressTaskRetry: boolean;
  public readonly failureKind: RequestFailureKind;
  public readonly estimatedBytes: number;
  public readonly maxBytes: number;
  public readonly originalError?: Error;

  constructor(estimatedBytes: number, maxBytes: number, originalError?: Error) {
    const originalFailure = classifyRequestFailure(originalError);
    const extractionCanRetry = originalFailure.kind === "extraction";
    const estimate = (estimatedBytes / (1024 * 1024)).toFixed(1);
    const limit = (maxBytes / (1024 * 1024)).toFixed(0);
    super(
      originalError
        ? `PDF request exceeded the safe ${limit} MiB payload budget and automatic text extraction failed: ${originalError.message}`
        : `PDF request is approximately ${estimate} MiB, above the safe ${limit} MiB payload budget, and cannot be converted to text automatically.`,
    );
    this.name = "LLMRequestTooLargeError";
    this.failureKind = extractionCanRetry ? "extraction" : "payload-too-large";
    this.suppressTaskRetry = !extractionCanRetry;
    this.estimatedBytes = estimatedBytes;
    this.maxBytes = maxBytes;
    this.originalError = originalError;
  }
}

export class LLMApiCallError extends Error {
  public readonly suppressTaskRetry: boolean;
  public readonly failureKind: RequestFailureKind;
  public readonly endpointId: string;
  public readonly endpointName: string;
  public readonly providerId: string;
  public readonly originalError?: Error;

  constructor(endpoint: LLMEndpoint, error: Error) {
    const failure = classifyRequestFailure(error);
    super(normalizeRequestFailureMessage(error));
    this.name = "LLMApiCallError";
    this.failureKind = failure.kind;
    this.suppressTaskRetry = !failure.retryable;
    this.endpointId = endpoint.id;
    this.endpointName = endpoint.name;
    this.providerId = endpoint.providerType;
    this.originalError = error;
    this.stack = error.stack || this.stack;
  }
}

export class LLMApiExhaustedError extends Error {
  public readonly suppressTaskRetry: boolean;
  public readonly failureKind: RequestFailureKind;
  public readonly attempts: number;
  public readonly lastError?: Error;
  public readonly endpointId?: string;
  public readonly endpointName?: string;
  public readonly providerId?: string;
  public readonly errors: readonly Error[];

  constructor(attempts: number, lastError?: Error, errors: Error[] = []) {
    const outcomes =
      errors.length > 0 ? [...errors] : lastError ? [lastError] : [];
    const retryableError = [...outcomes]
      .reverse()
      .find((error) => classifyRequestFailure(error).retryable);
    const representativeError = retryableError || lastError;
    const failure = classifyRequestFailure(representativeError);
    super(
      lastError
        ? normalizeRequestFailureMessage(lastError)
        : "All configured LLM endpoints failed.",
    );
    this.name = "LLMApiExhaustedError";
    this.failureKind = failure.kind;
    this.suppressTaskRetry = !failure.retryable;
    this.attempts = attempts;
    this.lastError = lastError;
    this.errors = outcomes;
    const apiError = representativeError as
      | {
          endpointId?: string;
          endpointName?: string;
          providerId?: string;
        }
      | undefined;
    this.endpointId = apiError?.endpointId;
    this.endpointName = apiError?.endpointName;
    this.providerId = apiError?.providerId;
    this.stack = lastError?.stack || this.stack;
  }
}

export class LLMService {
  private static readonly forcedTextContentKeys = new Set<string>();

  static getRequestTimeout(): number {
    const raw = (getPref("requestTimeout") as string) || "300000";
    const val = parseInt(raw, 10) || 300000;
    return Math.max(val, 30000);
  }

  static mapToKeyManagerId(providerId: string): ProviderId {
    const id = providerId.toLowerCase();
    if (id === "nvinference") return "nvinference";
    if (id.includes("gemini") || id === "google") return "google";
    if (id.includes("anthropic") || id.includes("claude")) return "anthropic";
    if (id === "openai-compat") return "openai-compat";
    if (id === "openrouter") return "openrouter";
    if (id === "volcanoark") return "volcanoark";
    if (id === "ollama") return "ollama";
    return "openai";
  }

  static resolveProvider(): ResolvedProvider {
    const endpoint = LLMEndpointManager.prepareRoute().endpoints[0];
    const providerId = endpoint.providerType;
    const impl =
      ProviderRegistry.get(providerId) || ProviderRegistry.get("openai");
    if (!impl) {
      const list = ProviderRegistry.list().join(", ");
      const msg = `未知的供应商: ${providerId}。可用: ${list}`;
      this.notifyError(msg);
      throw new Error(msg);
    }
    return { id: providerId, impl, endpoint };
  }

  static getCurrentProvider(): ILlmProvider | null {
    try {
      return this.resolveProvider().impl;
    } catch {
      return null;
    }
  }

  static getProviderCapabilities(
    provider: ILlmProvider,
  ): LLMProviderCapabilities {
    if (provider.capabilities) return provider.capabilities;

    return {
      supportsText: true,
      supportsStreaming: true,
      supportsPdfBase64: true,
      maxPdfFiles:
        typeof provider.generateMultiFileSummary === "function" ? 8 : 1,
      supportsSystemPrompt: true,
      supportedParams: ["temperature", "topP", "maxTokens", "stream"],
    };
  }

  static getEffectivePdfProcessMode(endpoint?: LLMEndpoint): LLMPdfProcessMode {
    if (endpoint) {
      return LLMEndpointManager.getEffectivePdfProcessMode(endpoint);
    }

    try {
      const activeEndpoint = LLMEndpointManager.prepareRoute().endpoints[0];
      return LLMEndpointManager.getEffectivePdfProcessMode(activeEndpoint);
    } catch {
      return LLMEndpointManager.getGlobalPdfProcessMode();
    }
  }

  /** Prepare reusable chat/deep-read content without allocating oversized Base64. */
  static async prepareReusableItemContent(
    item: Zotero.Item,
    mode: LLMPdfProcessMode = this.getEffectivePdfProcessMode(),
  ): Promise<{ content: string; isBase64: boolean }> {
    if (mode === "base64") {
      const attachments = await PDFExtractor.getAllPdfAttachments(item);
      const firstAttachment = attachments[0];
      const rawBytes = firstAttachment
        ? await PDFExtractor.getPdfAttachmentFileSizeBytes(firstAttachment)
        : 0;
      const estimatedBytes = rawBytes
        ? estimateInlinePdfRequestBytes(estimateBase64Length(rawBytes))
        : 0;
      if (estimatedBytes <= SAFE_INLINE_REQUEST_BYTES) {
        return {
          content: await PDFExtractor.extractBase64FromItem(item),
          isBase64: true,
        };
      }
      mode = "text";
    }

    const text = await PDFExtractor.extractTextFromItem(item, mode);
    return { content: this.normalizeText(text), isBase64: false };
  }

  static buildOptions(
    providerId: string | LLMEndpoint,
    generation?: LLMGenerationOptions,
    transport?: LLMTransportOptions,
    extra?: Partial<LLMOptions>,
  ): LLMOptions {
    const endpoint = typeof providerId === "string" ? undefined : providerId;
    const id = (
      typeof providerId === "string" ? providerId : providerId.providerType
    ).toLowerCase();
    const enableTemperature = getPref("enableTemperature") ?? false;
    const enableMaxTokens = getPref("enableMaxTokens") ?? false;
    const enableTopP = getPref("enableTopP") ?? false;

    const common: LLMOptions = {
      stream: transport?.stream ?? getPref("stream") ?? true,
      requestTimeoutMs: transport?.timeoutMs ?? this.getRequestTimeout(),
      abortSignal: transport?.abortSignal,
      enablePromptCache:
        (getPref("enablePromptCacheOptimization" as any) as boolean) === true,
    };

    if (enableTemperature) {
      common.temperature =
        generation?.temperature ??
        (parseFloat((getPref("temperature") as string) || "0.7") || 0.7);
    }
    if (enableTopP) {
      common.topP =
        generation?.topP ??
        (parseFloat((getPref("topP") as string) || "1.0") || 1.0);
    }
    if (enableMaxTokens) {
      common.maxTokens =
        generation?.maxOutputTokens ??
        (parseInt((getPref("maxTokens") as string) || "81920", 10) || 81920);
    }
    const reasoningEffort = resolveReasoningEffort(
      normalizeReasoningEffortSetting(
        generation?.reasoningEffort ??
          endpoint?.reasoningEffort ??
          getPref("reasoningEffort" as any),
        "default",
      ),
    );
    if (reasoningEffort) {
      common.reasoningEffort = reasoningEffort;
    }
    if (generation?.vendorOptions) {
      common.vendorOptions = generation.vendorOptions;
    }

    if (endpoint) {
      common.apiUrl = endpoint.apiUrl.trim();
      common.apiKey = endpoint.apiKey.trim();
      common.model = endpoint.model.trim();
    } else if (id === "nvinference") {
      // NVIDIA Inference 统一网关：单一端点 + 单一密钥，模型自动路由
      const keyManagerId = this.mapToKeyManagerId(id);
      common.apiUrl = (
        getPref("nvInferenceApiUrl" as any) ||
        "https://inference-api.nvidia.com"
      ).replace(/\/$/, "");
      common.apiKey = ApiKeyManager.getCurrentKey(keyManagerId);
      common.model = (
        getPref("nvInferenceModel" as any) || "azure/anthropic/claude-opus-4-8"
      ).trim();
    } else if (id.includes("gemini") || id === "google") {
      const keyManagerId = this.mapToKeyManagerId(id);
      common.apiUrl = (
        getPref("geminiApiUrl") || "https://generativelanguage.googleapis.com"
      ).replace(/\/$/, "");
      common.apiKey = ApiKeyManager.getCurrentKey(keyManagerId);
      common.model = (getPref("geminiModel") || "gemini-2.5-pro").trim();
    } else if (id.includes("anthropic") || id.includes("claude")) {
      const keyManagerId = this.mapToKeyManagerId(id);
      common.apiUrl = (
        getPref("anthropicApiUrl") || "https://api.anthropic.com"
      ).replace(/\/$/, "");
      common.apiKey = ApiKeyManager.getCurrentKey(keyManagerId);
      common.model = (
        getPref("anthropicModel") || "claude-3-5-sonnet-20241022"
      ).trim();
    } else if (id === "openai-compat") {
      const keyManagerId = this.mapToKeyManagerId(id);
      common.apiUrl = (
        getPref("openaiCompatApiUrl") ||
        "https://api.openai.com/v1/chat/completions"
      ).trim();
      common.apiKey = ApiKeyManager.getCurrentKey(keyManagerId);
      common.model = (
        getPref("openaiCompatModel") ||
        getPref("openaiApiModel") ||
        "gpt-3.5-turbo"
      ).trim();
    } else if (id === "openrouter") {
      const keyManagerId = this.mapToKeyManagerId(id);
      common.apiUrl = (
        getPref("openRouterApiUrl") ||
        "https://openrouter.ai/api/v1/chat/completions"
      ).trim();
      common.apiKey = ApiKeyManager.getCurrentKey(keyManagerId);
      common.model = (
        getPref("openRouterModel") || "google/gemma-3-27b-it"
      ).trim();
    } else if (id === "volcanoark") {
      const keyManagerId = this.mapToKeyManagerId(id);
      common.apiUrl = (
        getPref("volcanoArkApiUrl") ||
        "https://ark.cn-beijing.volces.com/api/v3/responses"
      ).trim();
      common.apiKey = ApiKeyManager.getCurrentKey(keyManagerId);
      common.model = (
        getPref("volcanoArkModel") || "doubao-seed-1-8-251228"
      ).trim();
    } else if (id === "ollama") {
      const keyManagerId = this.mapToKeyManagerId(id);
      common.apiUrl = (
        getPref("ollamaApiUrl") || "http://localhost:11434"
      ).trim();
      common.apiKey = ApiKeyManager.getCurrentKey(keyManagerId);
      common.model = (getPref("ollamaModel") || "llama3.2").trim();
    } else {
      const keyManagerId = this.mapToKeyManagerId(id);
      common.apiUrl = (getPref("openaiApiUrl") || "").trim();
      common.apiKey = ApiKeyManager.getCurrentKey(keyManagerId);
      common.model = (getPref("openaiApiModel") || "gpt-3.5-turbo").trim();
    }

    return { ...common, ...(extra || {}) };
  }

  static getLLMOptions(): LLMOptions {
    const { id, endpoint } = this.resolveProvider();
    return this.buildOptions(endpoint || id);
  }

  static async generate(request: LLMGenerateRequest): Promise<LLMResponse> {
    const prompt = request.prompt ?? this.getDefaultPrompt();
    return this.runGenerateWithEndpointRouting(request, prompt);
  }

  static async generateWithEndpoint(
    endpointId: string,
    request: LLMGenerateRequest,
  ): Promise<LLMResponse> {
    const endpoint = this.getRunnableEndpoint(endpointId);
    const prompt = request.prompt ?? this.getDefaultPrompt();
    return this.runGenerateWithFixedEndpoint(endpoint, request, prompt);
  }

  static async generateText(request: LLMGenerateRequest): Promise<string> {
    return (await this.generate(request)).text;
  }

  static async chat(request: LLMChatRequest): Promise<LLMResponse> {
    const route = LLMEndpointManager.prepareRoute();
    return this.chatWithEndpointRouting(request, route);
  }

  /**
   * 为一次多轮对话会话挑选并固定一个端点。
   *
   * `chat()` 每次调用都会重新执行端点路由。轮询策略下，游标随每个真实请求推进，
   * 会让同一篇论文的多轮精读被分发到不同端点，导致服务端上下文缓存按账号失效。
   * 本方法在会话开始时按当前路由策略选出端点，并仅推进一次游标；会话内后续轮次
   * 通过 `chatWithEndpoint()` 复用该端点。
   */
  static acquireChatSessionEndpoint(): LLMEndpoint {
    const route = LLMEndpointManager.prepareRoute();
    const endpoint = route.endpoints[0];
    LLMEndpointManager.markEndpointAttempted(endpoint.id);
    return endpoint;
  }

  static async chatWithEndpoint(
    endpointId: string,
    request: LLMChatRequest,
  ): Promise<LLMResponse> {
    const endpoint = this.getRunnableEndpoint(endpointId);
    return this.runChatWithFixedEndpoint(endpoint, request);
  }

  /**
   * Keep a multi-round session on its preferred endpoint while sharing one
   * bounded retry budget with every configured fallback endpoint.
   */
  static async chatWithPreferredEndpoint(
    preferredEndpointId: string,
    request: LLMChatRequest,
    allowFallback: boolean = true,
  ): Promise<LLMResponse> {
    let preferred: LLMEndpoint | undefined;
    let preferredError: unknown;
    try {
      preferred = this.getRunnableEndpoint(preferredEndpointId);
    } catch (error) {
      preferredError = error;
      if (!allowFallback) throw error;
    }

    const route = LLMEndpointManager.prepareRoute();
    const endpoints = preferred
      ? [
          preferred,
          ...(allowFallback
            ? route.endpoints.filter(
                (endpoint) => endpoint.id !== preferredEndpointId,
              )
            : []),
        ]
      : route.endpoints;
    if (endpoints.length === 0 && preferredError) throw preferredError;

    return this.chatWithEndpointRouting(
      request,
      { ...route, endpoints },
      false,
    );
  }

  static async chatText(request: LLMChatRequest): Promise<string> {
    return (await this.chat(request)).text;
  }

  static async testConnection(): Promise<string> {
    const { id, impl, endpoint } = this.resolveProvider();
    const options = this.buildConnectionTestOptions(id, impl, endpoint);
    return impl.testConnection(options);
  }

  static async testConnectionWithKey(apiKey: string): Promise<string> {
    const { id, impl, endpoint } = this.resolveProvider();
    const options = this.buildConnectionTestOptions(id, impl, endpoint);
    options.apiKey = apiKey;
    return impl.testConnection(options);
  }

  static async listModels(
    providerId?: string,
    optionsOverride?: Partial<LLMOptions>,
  ): Promise<LLMModelInfo[]> {
    const id = ((providerId || getPref("provider") || "openai") as string)
      .trim()
      .toLowerCase();
    const impl = ProviderRegistry.get(id) || ProviderRegistry.get("openai");
    if (!impl) {
      throw new Error(`未知的供应商: ${id}`);
    }
    if (typeof impl.listModels !== "function") {
      throw new Error(`Provider ${id} 暂不支持获取模型列表`);
    }

    const options = this.buildOptions(
      id,
      undefined,
      { stream: false },
      {
        ...(optionsOverride || {}),
      },
    );
    return impl.listModels(options);
  }

  static async testEndpointConnection(endpoint: LLMEndpoint): Promise<string> {
    const provider = this.getProviderForEndpoint(endpoint);
    const options = this.buildConnectionTestOptions(
      endpoint.providerType,
      provider,
      endpoint,
    );
    return provider.testConnection(options);
  }

  static endpointSupportsMultiFile(endpoint: LLMEndpoint): boolean {
    const provider = this.getProviderForEndpoint(endpoint);
    return (
      this.getProviderCapabilities(provider).maxPdfFiles > 1 &&
      typeof provider.generateMultiFileSummary === "function"
    );
  }

  static endpointSupportsPdfBase64(endpoint: LLMEndpoint): boolean {
    const provider = this.getProviderForEndpoint(endpoint);
    return this.getProviderCapabilities(provider).supportsPdfBase64;
  }

  private static async waitBeforeRetry(
    completedAttempts: number,
    error: unknown,
    abortSignal?: LLMAbortSignal,
  ): Promise<void> {
    throwIfAborted(abortSignal);
    const failure = classifyRequestFailure(error);
    const baseDelay = failure.kind === "rate-limit" ? 2000 : 1000;
    const delayMs = Math.min(
      baseDelay * Math.pow(2, Math.max(0, completedAttempts - 1)),
      8000,
    );
    await Zotero.Promise.delay(delayMs);
    throwIfAborted(abortSignal);
  }

  private static canRetryFailure(
    error: unknown,
    completedAttempts: number,
    maxAttempts: number,
    errors: readonly Error[] = [],
  ): boolean {
    const failure = classifyRequestFailure(error);
    if (!failure.retryable || completedAttempts >= maxAttempts) return false;
    // Changing endpoints cannot repair local PDF indexing. Let the persisted
    // task queue retry after Zotero has had more time to finish extraction.
    if (failure.kind === "extraction") return false;
    // A five-minute timeout is already expensive. Permit one fresh request,
    // then hand control back to the persisted task queue for delayed recovery.
    const timeoutAttempts = errors.length
      ? errors.filter(
          (candidate) => classifyRequestFailure(candidate).kind === "timeout",
        ).length
      : completedAttempts;
    if (failure.kind === "timeout" && timeoutAttempts >= 2) return false;
    return true;
  }

  private static getRunnableEndpoint(endpointId: string): LLMEndpoint {
    const endpoint = LLMEndpointManager.getEndpoint(endpointId);
    if (!endpoint) {
      throw new Error(`LLM endpoint not found: ${endpointId}`);
    }
    if (!endpoint.enabled) {
      throw new Error(`LLM endpoint is disabled: ${endpoint.name}`);
    }
    return endpoint;
  }

  private static getProviderForEndpoint(endpoint: LLMEndpoint): ILlmProvider {
    const provider = ProviderRegistry.get(endpoint.providerType);
    if (!provider) {
      const list = ProviderRegistry.list().join(", ");
      throw new Error(
        `Unknown provider type for endpoint "${endpoint.name}": ${endpoint.providerType}. Available: ${list}`,
      );
    }
    return provider;
  }

  private static async runGenerateWithEndpointRouting(
    request: LLMGenerateRequest,
    prompt: string,
  ): Promise<LLMResponse> {
    const route = LLMEndpointManager.prepareRoute();
    const useRetry = request.transport?.retry ?? true;
    const maxRetries = useRetry
      ? Math.min(Math.max(route.maxAttempts, 1), MAX_API_ATTEMPTS)
      : 1;
    let lastError: Error | null = null;
    let attempts = 0;
    let cursor = 0;
    const errors: Error[] = [];
    const terminalEndpoints = new Set<string>();

    while (attempts < maxRetries) {
      throwIfAborted(request.transport?.abortSignal);
      let endpoint: LLMEndpoint | undefined;
      for (let checked = 0; checked < route.endpoints.length; checked++) {
        const candidate = route.endpoints[cursor % route.endpoints.length];
        cursor++;
        if (!terminalEndpoints.has(candidate.id)) {
          endpoint = candidate;
          break;
        }
      }
      if (!endpoint) break;
      attempts++;
      try {
        const response = await this.generateOnceWithEndpoint(
          endpoint,
          request,
          prompt,
        );
        LLMEndpointManager.markEndpointAttempted(endpoint.id);
        return response;
      } catch (error: unknown) {
        if (isAbortError(error, request.transport?.abortSignal)) {
          throw normalizeAbortError(error, request.transport?.abortSignal);
        }
        LLMEndpointManager.markEndpointAttempted(endpoint.id);
        lastError = error instanceof Error ? error : new Error(String(error));
        errors.push(lastError);
        logLLMService(
          `[LLMService] API failed via ${endpoint.name} (${attempts}/${maxRetries}): ${lastError.message}`,
        );
        const failure = classifyRequestFailure(lastError);
        if (!failure.retryable) terminalEndpoints.add(endpoint.id);
        const hasCandidate = route.endpoints.some(
          (candidate) => !terminalEndpoints.has(candidate.id),
        );
        if (!hasCandidate) break;
        if (failure.retryable) {
          if (!this.canRetryFailure(lastError, attempts, maxRetries, errors)) {
            break;
          }
          await this.waitBeforeRetry(
            attempts,
            lastError,
            request.transport?.abortSignal,
          );
        }
      }
    }

    throw new LLMApiExhaustedError(attempts, lastError || undefined, errors);
  }

  private static async generateOnceWithEndpoint(
    endpoint: LLMEndpoint,
    request: LLMGenerateRequest,
    prompt: string,
  ): Promise<LLMResponse> {
    const provider = this.getProviderForEndpoint(endpoint);
    const warnings: string[] = [];
    throwIfAborted(request.transport?.abortSignal);
    let resolved: ResolvedContent;
    try {
      resolved = await this.resolveContentForRequest(
        provider,
        request.content,
        warnings,
        true,
        endpoint,
        prompt,
      );
    } catch (error: unknown) {
      if (isAbortError(error, request.transport?.abortSignal)) {
        throw normalizeAbortError(error, request.transport?.abortSignal);
      }
      throw this.toApiCallError(endpoint, error);
    }
    throwIfAborted(request.transport?.abortSignal);
    const options = this.buildOptions(
      endpoint,
      request.generation,
      request.transport,
    );
    const invokeProvider = async (
      content: ResolvedContent,
    ): Promise<string> => {
      if (content.mode === "multi-file") {
        if (typeof provider.generateMultiFileSummary !== "function") {
          throw new Error(
            `Provider ${endpoint.providerType} does not support multi-file generation`,
          );
        }
        return provider.generateMultiFileSummary(
          content.files,
          prompt,
          options,
          request.onProgress,
        );
      }
      return provider.generateSummary(
        content.content,
        content.isBase64,
        prompt,
        options,
        request.onProgress,
      );
    };

    let text: string;
    try {
      text = await invokeProvider(resolved);
    } catch (error: unknown) {
      if (isAbortError(error, options.abortSignal)) {
        throw normalizeAbortError(error, options.abortSignal);
      }
      if (
        isPayloadTooLargeFailure(error) &&
        this.hasInlinePdfContent(resolved)
      ) {
        try {
          const fallback = await this.resolveTextFallbackAfterProviderRejection(
            provider,
            request.content,
            warnings,
            true,
            endpoint,
          );
          if (fallback) {
            resolved = fallback;
            text = await invokeProvider(resolved);
          } else {
            throw error;
          }
        } catch (fallbackError: unknown) {
          if (isAbortError(fallbackError, options.abortSignal)) {
            throw normalizeAbortError(fallbackError, options.abortSignal);
          }
          throw this.toApiCallError(endpoint, fallbackError);
        }
      } else {
        throw this.toApiCallError(endpoint, error);
      }
    }
    return this.toResponse(
      text,
      endpoint.providerType,
      endpoint,
      options,
      warnings,
    );
  }

  private static async runGenerateWithFixedEndpoint(
    endpoint: LLMEndpoint,
    request: LLMGenerateRequest,
    prompt: string,
  ): Promise<LLMResponse> {
    const useRetry = request.transport?.retry ?? true;
    const maxAttempts = useRetry
      ? Math.min(LLMEndpointManager.getMaxAttemptCount(), MAX_API_ATTEMPTS)
      : 1;
    let lastError: Error | null = null;
    let attempts = 0;
    const errors: Error[] = [];

    while (attempts < maxAttempts) {
      throwIfAborted(request.transport?.abortSignal);
      attempts++;
      try {
        return await this.generateOnceWithEndpoint(endpoint, request, prompt);
      } catch (error: unknown) {
        if (isAbortError(error, request.transport?.abortSignal)) {
          throw normalizeAbortError(error, request.transport?.abortSignal);
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        errors.push(lastError);
        logLLMService(
          `[LLMService] API failed via ${endpoint.name} (${attempts}/${maxAttempts}): ${lastError.message}`,
        );
        if (!this.canRetryFailure(lastError, attempts, maxAttempts, errors)) {
          break;
        }
        await this.waitBeforeRetry(
          attempts,
          lastError,
          request.transport?.abortSignal,
        );
      }
    }

    throw new LLMApiExhaustedError(attempts, lastError || undefined, errors);
  }

  private static async chatWithEndpointRouting(
    request: LLMChatRequest,
    route: ReturnType<typeof LLMEndpointManager.prepareRoute>,
    trackRoundRobinAttempts: boolean = true,
  ): Promise<LLMResponse> {
    const useRetry = request.transport?.retry ?? true;
    const maxRetries = useRetry
      ? Math.min(Math.max(route.maxAttempts, 1), MAX_API_ATTEMPTS)
      : 1;
    let lastError: Error | null = null;
    let attempts = 0;
    let cursor = 0;
    const errors: Error[] = [];
    const terminalEndpoints = new Set<string>();

    while (attempts < maxRetries) {
      throwIfAborted(request.transport?.abortSignal);
      let endpoint: LLMEndpoint | undefined;
      for (let checked = 0; checked < route.endpoints.length; checked++) {
        const candidate = route.endpoints[cursor % route.endpoints.length];
        cursor++;
        if (!terminalEndpoints.has(candidate.id)) {
          endpoint = candidate;
          break;
        }
      }
      if (!endpoint) break;
      attempts++;
      try {
        const response = await this.chatOnceWithEndpoint(endpoint, request);
        if (trackRoundRobinAttempts) {
          LLMEndpointManager.markEndpointAttempted(endpoint.id);
        }
        return response;
      } catch (error: unknown) {
        if (isAbortError(error, request.transport?.abortSignal)) {
          throw normalizeAbortError(error, request.transport?.abortSignal);
        }
        if (trackRoundRobinAttempts) {
          LLMEndpointManager.markEndpointAttempted(endpoint.id);
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        errors.push(lastError);
        logLLMService(
          `[LLMService] Chat API failed via ${endpoint.name} (${attempts}/${maxRetries}): ${lastError.message}`,
        );
        const failure = classifyRequestFailure(lastError);
        if (!failure.retryable) terminalEndpoints.add(endpoint.id);
        const hasCandidate = route.endpoints.some(
          (candidate) => !terminalEndpoints.has(candidate.id),
        );
        if (!hasCandidate) break;
        if (failure.retryable) {
          if (!this.canRetryFailure(lastError, attempts, maxRetries, errors)) {
            break;
          }
          await this.waitBeforeRetry(
            attempts,
            lastError,
            request.transport?.abortSignal,
          );
        }
      }
    }

    throw new LLMApiExhaustedError(attempts, lastError || undefined, errors);
  }

  private static async chatOnceWithEndpoint(
    endpoint: LLMEndpoint,
    request: LLMChatRequest,
  ): Promise<LLMResponse> {
    const provider = this.getProviderForEndpoint(endpoint);
    const warnings: string[] = [];
    throwIfAborted(request.transport?.abortSignal);
    const conversationText = request.conversation
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n");
    let resolved: ResolvedContent;
    try {
      resolved = await this.resolveContentForRequest(
        provider,
        request.content,
        warnings,
        false,
        endpoint,
        conversationText,
      );
    } catch (error: unknown) {
      if (isAbortError(error, request.transport?.abortSignal)) {
        throw normalizeAbortError(error, request.transport?.abortSignal);
      }
      throw this.toApiCallError(endpoint, error);
    }
    throwIfAborted(request.transport?.abortSignal);
    if (resolved.mode !== "single") {
      throw new Error("Chat requests do not support multi-file input.");
    }
    const options = this.buildOptions(
      endpoint,
      request.generation,
      request.transport,
    );
    const invokeProvider = (content: ResolvedSingleContent) =>
      provider.chat(
        content.content,
        content.isBase64,
        request.conversation,
        options,
        request.onProgress,
      );

    let text: string;
    try {
      text = await invokeProvider(resolved);
    } catch (error: unknown) {
      if (isAbortError(error, options.abortSignal)) {
        throw normalizeAbortError(error, options.abortSignal);
      }
      if (isPayloadTooLargeFailure(error) && resolved.isBase64) {
        try {
          const fallback = await this.resolveTextFallbackAfterProviderRejection(
            provider,
            request.content,
            warnings,
            false,
            endpoint,
          );
          if (!fallback || fallback.mode !== "single") throw error;
          resolved = fallback;
          text = await invokeProvider(resolved);
        } catch (fallbackError: unknown) {
          if (isAbortError(fallbackError, options.abortSignal)) {
            throw normalizeAbortError(fallbackError, options.abortSignal);
          }
          throw this.toApiCallError(endpoint, fallbackError);
        }
      } else {
        throw this.toApiCallError(endpoint, error);
      }
    }
    return this.toResponse(
      text,
      endpoint.providerType,
      endpoint,
      options,
      warnings,
    );
  }

  private static async runChatWithFixedEndpoint(
    endpoint: LLMEndpoint,
    request: LLMChatRequest,
  ): Promise<LLMResponse> {
    const useRetry = request.transport?.retry ?? true;
    const maxAttempts = useRetry
      ? Math.min(LLMEndpointManager.getMaxAttemptCount(), MAX_API_ATTEMPTS)
      : 1;
    let lastError: Error | null = null;
    let attempts = 0;
    const errors: Error[] = [];

    while (attempts < maxAttempts) {
      throwIfAborted(request.transport?.abortSignal);
      attempts++;
      try {
        return await this.chatOnceWithEndpoint(endpoint, request);
      } catch (error: unknown) {
        if (isAbortError(error, request.transport?.abortSignal)) {
          throw normalizeAbortError(error, request.transport?.abortSignal);
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        errors.push(lastError);
        logLLMService(
          `[LLMService] Chat API failed via ${endpoint.name} (${attempts}/${maxAttempts}): ${lastError.message}`,
        );
        if (!this.canRetryFailure(lastError, attempts, maxAttempts, errors)) {
          break;
        }
        await this.waitBeforeRetry(
          attempts,
          lastError,
          request.transport?.abortSignal,
        );
      }
    }

    throw new LLMApiExhaustedError(attempts, lastError || undefined, errors);
  }

  private static toApiCallError(
    endpoint: LLMEndpoint,
    error: unknown,
  ): LLMApiCallError {
    return new LLMApiCallError(
      endpoint,
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  private static async runWithRetry(
    providerId: string,
    provider: ILlmProvider,
    request: LLMGenerateRequest,
    resolved: ResolvedContent,
    prompt: string,
    warnings: string[],
  ): Promise<LLMResponse> {
    const keyManagerId = this.mapToKeyManagerId(providerId);
    const useRetry = request.transport?.retry ?? true;
    const useKeyRotation = request.transport?.keyRotation ?? true;
    const maxRetries = useRetry ? ApiKeyManager.getMaxSwitchCount() : 1;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      throwIfAborted(request.transport?.abortSignal);
      try {
        const options = this.buildOptions(
          providerId,
          request.generation,
          request.transport,
        );
        let text: string;
        if (resolved.mode === "multi-file") {
          if (typeof provider.generateMultiFileSummary !== "function") {
            throw new Error(`Provider ${providerId} 不支持多文件摘要生成`);
          }
          text = await provider.generateMultiFileSummary(
            resolved.files,
            prompt,
            options,
            request.onProgress,
          );
        } else {
          text = await provider.generateSummary(
            resolved.content,
            resolved.isBase64,
            prompt,
            options,
            request.onProgress,
          );
        }
        if (useKeyRotation) ApiKeyManager.advanceToNextKey(keyManagerId);
        return this.toResponse(text, providerId, options, warnings);
      } catch (error: unknown) {
        if (isAbortError(error, request.transport?.abortSignal)) {
          throw normalizeAbortError(error, request.transport?.abortSignal);
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        logLLMService(
          `[LLMService] API 调用失败 (尝试 ${attempt + 1}/${maxRetries}): ${lastError.message}`,
        );
        if (!useKeyRotation) break;
        const rotated = ApiKeyManager.rotateToNextKey(keyManagerId);
        if (!rotated) break;
      }
    }

    throw lastError || new Error("所有 API 密钥均已耗尽");
  }

  private static getContentFallbackKey(
    input: LLMContentInput,
    endpoint?: LLMEndpoint,
  ): string | null {
    const endpointKey = endpoint?.id || endpoint?.providerType || "default";
    if (input.kind === "zotero-item") {
      return `${endpointKey}:item:${input.item.id}`;
    }
    if (input.kind === "pdf-attachment") {
      return `${endpointKey}:attachment:${input.attachment.id}`;
    }
    if (input.kind === "pdf-files") {
      const files = input.files
        .map((file) => file.filePath || file.displayName)
        .join("|");
      return `${endpointKey}:files:${files}`;
    }
    if (input.kind === "legacy" && input.fallbackItem) {
      return `${endpointKey}:legacy-item:${input.fallbackItem.id}`;
    }
    return null;
  }

  private static rememberTextFallback(
    input: LLMContentInput,
    endpoint?: LLMEndpoint,
  ): void {
    const key = this.getContentFallbackKey(input, endpoint);
    if (!key) return;
    if (this.forcedTextContentKeys.size >= 512) {
      const oldest = this.forcedTextContentKeys.values().next().value;
      if (oldest) {
        this.forcedTextContentKeys.delete(oldest);
      }
    }
    this.forcedTextContentKeys.add(key);
  }

  private static shouldForceTextFallback(
    input: LLMContentInput,
    endpoint?: LLMEndpoint,
  ): boolean {
    const key = this.getContentFallbackKey(input, endpoint);
    return !!key && this.forcedTextContentKeys.has(key);
  }

  private static canResolveContentAsText(input: LLMContentInput): boolean {
    if (input.kind === "legacy") return !!input.fallbackItem;
    if (input.kind === "zotero-item" || input.kind === "pdf-attachment") {
      return true;
    }
    if (input.kind === "pdf-files") {
      return input.files.some((file) => !!file.textContent?.trim());
    }
    return false;
  }

  private static hasInlinePdfContent(resolved: ResolvedContent): boolean {
    if (resolved.mode === "single") return resolved.isBase64;
    return resolved.files.some((file) => !!file.base64Content);
  }

  private static estimateResolvedRequestBytes(
    resolved: ResolvedContent,
    requestText: string,
  ): number {
    let inlineBytes = 0;
    if (resolved.mode === "single") {
      if (resolved.isBase64) inlineBytes = resolved.content.length;
    } else {
      inlineBytes = resolved.files.reduce(
        (total, file) => total + (file.base64Content?.length || 0),
        0,
      );
    }
    if (inlineBytes === 0) return 0;
    return estimateInlinePdfRequestBytes(inlineBytes, requestText);
  }

  private static async estimateInputInlinePdfBytes(
    provider: ILlmProvider,
    input: LLMContentInput,
    allowMultiFile: boolean,
    endpoint: LLMEndpoint,
    requestText: string,
  ): Promise<number> {
    if (input.kind === "text") return 0;
    if (input.kind === "legacy") {
      return input.isBase64
        ? estimateInlinePdfRequestBytes(input.content.length, requestText)
        : 0;
    }

    const capabilities = this.getProviderCapabilities(provider);
    const policy = this.choosePolicy(input.policy, capabilities, endpoint);
    if (policy !== "pdf-base64") return 0;

    let encodedBytes = 0;
    if (input.kind === "pdf-attachment") {
      encodedBytes = estimateBase64Length(
        await PDFExtractor.getPdfAttachmentFileSizeBytes(input.attachment),
      );
    } else if (input.kind === "pdf-files") {
      const limit = Math.min(
        input.maxAttachments || Infinity,
        allowMultiFile ? capabilities.maxPdfFiles : 1,
      );
      const sizes = await Promise.all(
        input.files
          .slice(0, limit)
          .map(async (file) =>
            file.base64Content
              ? file.base64Content.length
              : estimateBase64Length(
                  await PDFExtractor.getFileSizeBytes(file.filePath),
                ),
          ),
      );
      encodedBytes = sizes.reduce((total, size) => total + size, 0);
    } else {
      const attachmentMode =
        input.attachmentMode ||
        (getPref("pdfAttachmentMode") as string) ||
        "default";
      const allPdfs = await PDFExtractor.getAllPdfAttachments(input.item);
      const maxAttachments = Math.max(input.maxAttachments || Infinity, 1);
      const selected =
        allowMultiFile && attachmentMode === "all"
          ? allPdfs.slice(0, Math.min(maxAttachments, capabilities.maxPdfFiles))
          : allPdfs.slice(0, 1);
      const sizes = await Promise.all(
        selected.map((attachment) =>
          PDFExtractor.getPdfAttachmentFileSizeBytes(attachment),
        ),
      );
      encodedBytes = sizes.reduce(
        (total, size) => total + estimateBase64Length(size),
        0,
      );
    }

    return encodedBytes > 0
      ? estimateInlinePdfRequestBytes(encodedBytes, requestText)
      : 0;
  }

  private static async resolveContentForRequest(
    provider: ILlmProvider,
    input: LLMContentInput,
    warnings: string[],
    allowMultiFile: boolean,
    endpoint: LLMEndpoint,
    requestText: string,
  ): Promise<ResolvedContent> {
    const forceText = this.shouldForceTextFallback(input, endpoint);
    const preflightBytes = forceText
      ? 0
      : await this.estimateInputInlinePdfBytes(
          provider,
          input,
          allowMultiFile,
          endpoint,
          requestText,
        );
    if (preflightBytes > SAFE_INLINE_REQUEST_BYTES) {
      if (!this.canResolveContentAsText(input)) {
        throw new LLMRequestTooLargeError(
          preflightBytes,
          SAFE_INLINE_REQUEST_BYTES,
        );
      }
      this.rememberTextFallback(input, endpoint);
      warnings.push(
        "PDF payload was too large for a reliable request and was automatically converted to extracted text before upload.",
      );
      try {
        return await this.resolveContent(
          provider,
          input,
          warnings,
          allowMultiFile,
          endpoint,
          "text",
        );
      } catch (error: unknown) {
        throw new LLMRequestTooLargeError(
          preflightBytes,
          SAFE_INLINE_REQUEST_BYTES,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    const resolved = await this.resolveContent(
      provider,
      input,
      warnings,
      allowMultiFile,
      endpoint,
      forceText ? "text" : undefined,
    );
    if (forceText || !this.hasInlinePdfContent(resolved)) return resolved;

    const estimatedBytes = this.estimateResolvedRequestBytes(
      resolved,
      requestText,
    );
    if (estimatedBytes <= SAFE_INLINE_REQUEST_BYTES) return resolved;
    if (!this.canResolveContentAsText(input)) {
      throw new LLMRequestTooLargeError(
        estimatedBytes,
        SAFE_INLINE_REQUEST_BYTES,
      );
    }

    this.rememberTextFallback(input, endpoint);
    warnings.push(
      "PDF payload was too large for a reliable request and was automatically converted to extracted text.",
    );
    try {
      return await this.resolveContent(
        provider,
        input,
        warnings,
        allowMultiFile,
        endpoint,
        "text",
      );
    } catch (error: unknown) {
      throw new LLMRequestTooLargeError(
        estimatedBytes,
        SAFE_INLINE_REQUEST_BYTES,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private static async resolveTextFallbackAfterProviderRejection(
    provider: ILlmProvider,
    input: LLMContentInput,
    warnings: string[],
    allowMultiFile: boolean,
    endpoint: LLMEndpoint,
  ): Promise<ResolvedContent | null> {
    if (!this.canResolveContentAsText(input)) return null;
    this.rememberTextFallback(input, endpoint);
    warnings.push(
      "The provider rejected the PDF request size; AI Butler retried this request with extracted text.",
    );
    return await this.resolveContent(
      provider,
      input,
      warnings,
      allowMultiFile,
      endpoint,
      "text",
    );
  }

  private static toResponse(
    text: string,
    providerId: string,
    endpointOrOptions: LLMEndpoint | LLMOptions,
    optionsOrWarnings: LLMOptions | string[],
    maybeWarnings?: string[],
  ): LLMResponse {
    if (!text || !text.trim()) {
      throw new Error("LLM 接口返回内容为空，将自动重试");
    }
    const endpoint =
      "providerType" in endpointOrOptions ? endpointOrOptions : undefined;
    const options = endpoint
      ? (optionsOrWarnings as LLMOptions)
      : (endpointOrOptions as LLMOptions);
    const warnings = endpoint
      ? maybeWarnings || []
      : (optionsOrWarnings as string[]);
    return {
      text,
      providerId,
      endpointId: endpoint?.id,
      providerName:
        endpoint?.name || LLMEndpointManager.providerLabel(providerId),
      model: options.model,
      generatedAt: new Date().toISOString(),
      finishReason:
        typeof options.vendorOptions?.responseFinishReason === "string"
          ? options.vendorOptions.responseFinishReason
          : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  private static async resolveContent(
    provider: ILlmProvider,
    input: LLMContentInput,
    warnings: string[],
    allowMultiFile: boolean,
    endpoint?: LLMEndpoint,
    policyOverride?: LLMContentPolicy,
  ): Promise<ResolvedContent> {
    if (input.kind === "text") {
      return { mode: "single", content: input.text, isBase64: false, warnings };
    }

    if (input.kind === "legacy") {
      if (policyOverride === "text" && input.fallbackItem) {
        const text = await PDFExtractor.extractTextFromItem(
          input.fallbackItem,
          "text",
        );
        const normalized = this.normalizeText(text);
        return {
          mode: "single",
          content: normalized,
          isBase64: false,
          warnings,
        };
      }
      return {
        mode: "single",
        content: input.isBase64
          ? input.content
          : this.normalizeText(input.content),
        isBase64: input.isBase64,
        warnings,
      };
    }

    const capabilities = this.getProviderCapabilities(provider);
    const policy = policyOverride
      ? this.choosePolicy(policyOverride, capabilities, endpoint)
      : this.choosePolicy(input.policy, capabilities, endpoint);

    if (input.kind === "zotero-item") {
      return this.resolveZoteroItemContent(
        provider,
        input,
        policy,
        capabilities,
        warnings,
        allowMultiFile,
      );
    }

    if (input.kind === "pdf-attachment") {
      return this.resolvePdfAttachmentContent(input, policy, warnings);
    }

    return this.resolvePdfFilesContent(
      provider,
      input,
      policy,
      capabilities,
      warnings,
      allowMultiFile,
    );
  }

  private static choosePolicy(
    requestedPolicy: LLMContentPolicy | undefined,
    capabilities: LLMProviderCapabilities,
    endpoint?: LLMEndpoint,
  ): LLMContentPolicy {
    const rawMode = (
      requestedPolicy || LLMEndpointManager.getEffectivePdfProcessMode(endpoint)
    )
      .trim()
      .toLowerCase();
    let policy: LLMContentPolicy;
    if (rawMode === "text") policy = "text";
    else if (rawMode === "mineru") policy = "mineru";
    else if (rawMode === "auto") {
      policy = capabilities.supportsPdfBase64 ? "pdf-base64" : "text";
    } else {
      policy = capabilities.supportsPdfBase64 ? "pdf-base64" : "text";
    }

    return policy;
  }

  private static async resolveZoteroItemContent(
    provider: ILlmProvider,
    input: LLMZoteroItemContent,
    policy: LLMContentPolicy,
    capabilities: LLMProviderCapabilities,
    warnings: string[],
    allowMultiFile: boolean,
  ): Promise<ResolvedContent> {
    const attachmentMode =
      input.attachmentMode ||
      (getPref("pdfAttachmentMode") as string) ||
      "default";
    const maxAttachments = Math.max(input.maxAttachments || Infinity, 1);

    if (allowMultiFile && policy === "pdf-base64" && attachmentMode === "all") {
      const allPdfs = await PDFExtractor.getAllPdfAttachments(input.item);
      if (allPdfs.length > 1) {
        if (
          capabilities.maxPdfFiles <= 1 ||
          typeof provider.generateMultiFileSummary !== "function"
        ) {
          throw new Error(
            "当前 Provider 不支持多 PDF 上传。请将“多 PDF 附件模式”切换为“仅默认 PDF”，或更换支持多 PDF 的 Provider。",
          );
        }

        const limit = Math.min(maxAttachments, capabilities.maxPdfFiles);
        const selected = allPdfs.slice(0, limit);
        if (allPdfs.length > selected.length) {
          warnings.push(
            `PDF 附件数量超过 Provider 限制，已只发送前 ${selected.length} 个`,
          );
        }
        const files = await Promise.all(
          selected.map(async (pdf, index) => ({
            filePath: (await pdf.getFilePathAsync()) || "",
            displayName:
              String(pdf.getField("title") || "").trim() || `PDF-${index + 1}`,
            base64Content: await PDFExtractor.extractBase64FromAttachment(pdf),
          })),
        );
        return { mode: "multi-file", files, warnings };
      }
    }

    if (policy === "pdf-base64") {
      const content = await PDFExtractor.extractBase64FromItem(input.item);
      return { mode: "single", content, isBase64: true, warnings };
    }

    if (attachmentMode === "all") {
      const allPdfs = await PDFExtractor.getAllPdfAttachments(input.item);
      const selected = allPdfs.slice(0, maxAttachments);
      const parts = await Promise.all(
        selected.map(async (pdf, index) => {
          const title =
            String(pdf.getField("title") || "").trim() || `PDF-${index + 1}`;
          const text = await PDFExtractor.extractTextFromAttachment(pdf);
          return `\n\n=== ${title} ===\n${this.normalizeText(text)}`;
        }),
      );
      return {
        mode: "single",
        content: this.normalizeText(parts.join("\n")),
        isBase64: false,
        warnings,
      };
    }

    const text = await PDFExtractor.extractTextFromItem(input.item, policy);
    return {
      mode: "single",
      content: this.normalizeText(text),
      isBase64: false,
      warnings,
    };
  }

  private static async resolvePdfAttachmentContent(
    input: LLMPdfAttachmentContent,
    policy: LLMContentPolicy,
    warnings: string[],
  ): Promise<ResolvedContent> {
    if (policy === "pdf-base64") {
      const content = await PDFExtractor.extractBase64FromAttachment(
        input.attachment,
      );
      return { mode: "single", content, isBase64: true, warnings };
    }

    const text =
      policy === "mineru" && input.item
        ? await PDFExtractor.extractTextFromItem(input.item, "mineru")
        : await PDFExtractor.extractTextFromAttachment(input.attachment);
    return {
      mode: "single",
      content: this.normalizeText(text),
      isBase64: false,
      warnings,
    };
  }

  private static resolvePdfFilesContent(
    provider: ILlmProvider,
    input: LLMPdfFilesContent,
    policy: LLMContentPolicy,
    capabilities: LLMProviderCapabilities,
    warnings: string[],
    allowMultiFile: boolean,
  ): ResolvedContent {
    if (
      allowMultiFile &&
      policy === "pdf-base64" &&
      capabilities.maxPdfFiles > 1 &&
      typeof provider.generateMultiFileSummary === "function"
    ) {
      const limit = Math.min(
        input.maxAttachments || Infinity,
        capabilities.maxPdfFiles,
      );
      const files = input.files.slice(0, limit);
      if (files.length < input.files.length) {
        warnings.push(
          `PDF 附件数量超过 Provider 限制，已只发送前 ${files.length} 个`,
        );
      }
      return { mode: "multi-file", files, warnings };
    }

    const first = input.files[0];
    if (!first) throw new Error("没有可用的 PDF 内容");

    if (
      policy === "pdf-base64" &&
      input.files.length > 1 &&
      (!allowMultiFile ||
        capabilities.maxPdfFiles <= 1 ||
        typeof provider.generateMultiFileSummary !== "function")
    ) {
      throw new Error(
        "当前 Provider 不支持多 PDF 上传。请将“多 PDF 附件模式”切换为“仅默认 PDF”，或更换支持多 PDF 的 Provider。",
      );
    }

    if (policy === "pdf-base64" && first.base64Content) {
      return {
        mode: "single",
        content: first.base64Content,
        isBase64: true,
        warnings,
      };
    }

    if (policy === "pdf-base64") {
      throw new Error("当前输入缺少可上传的 PDF/Base64 内容。");
    }

    const textParts = input.files
      .map((file) =>
        file.textContent
          ? `\n\n=== ${file.displayName} ===\n${file.textContent}`
          : "",
      )
      .filter((part) => part.trim().length > 0);
    if (textParts.length === 0) {
      throw new Error("当前输入缺少可用文本或可上传的 PDF/Base64 内容");
    }

    return {
      mode: "single",
      content: this.normalizeText(textParts.join("\n")),
      isBase64: false,
      warnings,
    };
  }

  private static normalizeText(text: string): string {
    return PDFExtractor.truncateText(PDFExtractor.cleanText(text));
  }

  private static buildConnectionTestOptions(
    providerId: string,
    provider: ILlmProvider,
    endpoint?: LLMEndpoint,
  ): LLMOptions {
    return this.buildOptions(
      endpoint || providerId,
      undefined,
      { stream: false },
      {
        maxTokens: 16,
        reasoningEffort: undefined,
        vendorOptions: {
          connectionTestMode: this.getConnectionTestMode(provider, endpoint),
        },
      },
    );
  }

  private static getConnectionTestMode(
    provider: ILlmProvider,
    endpoint?: LLMEndpoint,
  ): ConnectionTestMode {
    const policy = this.choosePolicy(
      undefined,
      this.getProviderCapabilities(provider),
      endpoint,
    );
    return policy === "pdf-base64" ? "pdf-base64" : "text";
  }

  private static getDefaultPrompt(): string {
    const saved = (getPref("summaryPrompt") as string) || "";
    return saved.trim() ? saved : getDefaultSummaryPrompt();
  }

  private static notifyError(message: string): void {
    try {
      new ztoolkit.ProgressWindow("AI Butler", {
        closeOtherProgressWindows: false,
      })
        .createLine({ text: message, type: "default" })
        .show();
    } catch {
      try {
        Zotero.log(message);
      } catch {
        // 忽略通知失败
      }
    }
  }
}

export default LLMService;
