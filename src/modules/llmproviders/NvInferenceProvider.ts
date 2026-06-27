/**
 * NVIDIA Inference 统一供应商
 *
 * NVIDIA Inference 网关 (https://inference-api.nvidia.com) 在同一个端点上
 * 托管多个模型家族，但不同家族走不同的 API：
 *   - Claude 系列  → Anthropic Messages API   (/v1/messages)
 *   - GPT 系列     → OpenAI Responses API      (/v1/responses)
 *
 * 本供应商根据所选模型名自动路由到对应的底层实现，使用户在一处
 * 选择模型即可，无需关心底层走哪套接口。
 *
 * 设计：复用现有的 AnthropicProvider / OpenAIProvider，避免重复实现
 * 流式解析等逻辑，仅负责「按模型选择委派目标 + 改写 apiUrl」。
 */
import { ILlmProvider, PdfFileInfo } from "./ILlmProvider";
import {
  ConversationMessage,
  LLMOptions,
  LLMModelInfo,
  ProgressCb,
} from "./types";
import AnthropicProvider from "./AnthropicProvider";
import OpenAIProvider from "./OpenAIProvider";
import {
  requestModelListJson,
  parseModelListResponse,
} from "./shared/modelList";

/** NVIDIA Inference 默认端点 */
export const NV_INFERENCE_DEFAULT_URL = "https://inference-api.nvidia.com";

export function normalizeNvInferenceBaseUrl(value?: string): string {
  const configured = (value || "").trim();
  return (configured || NV_INFERENCE_DEFAULT_URL)
    .replace(/\/+$/, "")
    .replace(
      /\/v1(?:\/(?:responses|messages|models|chat\/completions))?$/i,
      "",
    );
}

export class NvInferenceProvider implements ILlmProvider {
  readonly id = "nvinference";

  private readonly anthropic = new AnthropicProvider();
  private readonly openai = new OpenAIProvider();

  /**
   * 判断模型是否为 Claude（走 Anthropic Messages API）
   */
  static isClaudeModel(model: string): boolean {
    return /anthropic|claude/i.test(model || "");
  }

  /**
   * 判断一个模型 id 是否可用于对话/总结（Claude 走 Messages API，GPT 走 Responses API）。
   * 排除嵌入 / 重排 / 语音 / 视频 / 图片 / 安全护栏等非对话模型。
   */
  static isUsableChatModel(id: string): boolean {
    const s = (id || "").toLowerCase();
    if (
      /embed|rerank|retriever|tts|whisper|audio|sora|moderation|guard|safety|image|magpie|batch|codex/.test(
        s,
      )
    ) {
      return false;
    }
    return /anthropic|claude/.test(s) || /openai|gpt|\bo[1345]\b/.test(s);
  }

  /**
   * 根据模型选择底层实现，并改写 apiUrl 指向正确的子接口。
   *
   * - Claude  → AnthropicProvider，apiUrl 为基础地址（其内部追加 /v1/messages）
   * - 其它    → OpenAIProvider，apiUrl 指向 /v1/responses
   */
  private route(options: LLMOptions): {
    impl: ILlmProvider;
    options: LLMOptions;
  } {
    const base = normalizeNvInferenceBaseUrl(options.apiUrl);
    // NVIDIA Inference 上的新版模型不接受采样参数：Claude 4.x 会报
    // "temperature is deprecated"，GPT-5.x 会报 "top_p cannot be used"。
    // 统一剥离 temperature / topP，仅使用模型默认采样。
    const opts: LLMOptions = { ...options };
    delete opts.temperature;
    delete opts.topP;
    if (NvInferenceProvider.isClaudeModel(options.model || "")) {
      return { impl: this.anthropic, options: { ...opts, apiUrl: base } };
    }
    return {
      impl: this.openai,
      options: { ...opts, apiUrl: `${base}/v1/responses` },
    };
  }

  async generateSummary(
    content: string,
    isBase64: boolean,
    prompt: string | undefined,
    options: LLMOptions,
    onProgress?: ProgressCb,
  ): Promise<string> {
    const { impl, options: opts } = this.route(options);
    return impl.generateSummary(content, isBase64, prompt, opts, onProgress);
  }

  async chat(
    pdfContent: string,
    isBase64: boolean,
    conversation: ConversationMessage[],
    options: LLMOptions,
    onProgress?: ProgressCb,
  ): Promise<string> {
    const { impl, options: opts } = this.route(options);
    return impl.chat(pdfContent, isBase64, conversation, opts, onProgress);
  }

  async testConnection(options: LLMOptions): Promise<string> {
    const { impl, options: opts } = this.route(options);
    return impl.testConnection(opts);
  }

  /**
   * 从 {base}/v1/models 拉取模型列表，过滤出可用于对话/总结的 Claude / GPT 模型。
   * 统一网关只有一个 /v1/models 端点，无需按模型家族分别请求。
   */
  async listModels(options: LLMOptions): Promise<LLMModelInfo[]> {
    const apiKey = (options.apiKey || "").trim();
    const base = normalizeNvInferenceBaseUrl(options.apiUrl);
    if (!base) throw new Error("API URL 未配置");
    if (!apiKey) throw new Error("API Key 未配置");

    const data = await requestModelListJson(
      `${base}/v1/models`,
      { Authorization: `Bearer ${apiKey}` },
      options.requestTimeoutMs ?? 30000,
    );
    const models = parseModelListResponse(data);
    const usable = models.filter((m) =>
      NvInferenceProvider.isUsableChatModel(m.id),
    );
    return usable.length > 0 ? usable : models;
  }

  async generateMultiFileSummary(
    pdfFiles: PdfFileInfo[],
    prompt: string,
    options: LLMOptions,
    onProgress?: ProgressCb,
  ): Promise<string> {
    const { impl, options: opts } = this.route(options);
    if (typeof impl.generateMultiFileSummary !== "function") {
      throw new Error(
        `Model ${options.model} does not support multi-file summary`,
      );
    }
    return impl.generateMultiFileSummary(pdfFiles, prompt, opts, onProgress);
  }
}

// 自注册
import { ProviderRegistry } from "./ProviderRegistry";
ProviderRegistry.register(new NvInferenceProvider());

export default NvInferenceProvider;
