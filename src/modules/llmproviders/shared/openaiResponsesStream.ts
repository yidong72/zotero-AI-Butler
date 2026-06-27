import {
  parseOpenAIResponsesDelta,
  parseOpenAIResponsesText,
} from "./openaiResponses";

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function readResponseStatus(value: unknown): string {
  if (!isRecord(value)) return "";
  const response = isRecord(value.response) ? value.response : value;
  return typeof response.status === "string"
    ? response.status.toLowerCase()
    : "";
}

function readFailureMessage(value: unknown): string {
  if (!isRecord(value)) return "Responses API 请求未完整结束";
  const response = isRecord(value.response) ? value.response : value;
  const error = isRecord(response.error)
    ? response.error
    : isRecord(value.error)
      ? value.error
      : null;
  const details = isRecord(response.incomplete_details)
    ? response.incomplete_details
    : null;
  return String(
    error?.message ||
      details?.reason ||
      response.status ||
      value.type ||
      "Responses API 请求未完整结束",
  );
}

export function assertOpenAIResponsesComplete(data: unknown): void {
  const status = readResponseStatus(data);
  if (!status || status === "completed") return;
  throw new Error(`Responses API 返回未完成结果: ${readFailureMessage(data)}`);
}

/**
 * Stateful parser for a cumulative XHR SSE response. A result is accepted only
 * after a terminal event, so a connection drop cannot turn partial text into a
 * successful model response.
 */
export class OpenAIResponsesStreamCollector {
  private processedLength = 0;
  private remainder = "";
  private readonly parts: string[] = [];
  private terminal = false;
  private failure: string | null = null;

  consumeCumulative(responseText: string): string[] {
    if (responseText.length < this.processedLength) {
      this.processedLength = 0;
      this.remainder = "";
    }
    if (responseText.length === this.processedLength) return [];

    const chunk = this.remainder + responseText.slice(this.processedLength);
    this.processedLength = responseText.length;
    const lines = chunk.split(/\r?\n/);
    this.remainder = lines.pop() || "";
    return lines.flatMap((line) => this.consumeLine(line));
  }

  finish(): string[] {
    if (!this.remainder) return [];
    const line = this.remainder;
    this.remainder = "";
    return this.consumeLine(line);
  }

  result(): string {
    if (this.failure) {
      throw new Error(`Responses API 流式请求失败: ${this.failure}`);
    }
    if (!this.terminal) {
      throw new Error("Responses API 流式连接提前结束，未收到完成事件");
    }
    const text = this.parts.join("");
    if (!text.trim()) throw new Error("Responses API 返回内容为空");
    return text;
  }

  private consumeLine(rawLine: string): string[] {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) return [];
    const data = line.replace(/^data:\s*/, "").trim();
    if (!data) return [];
    if (data === "[DONE]") {
      this.terminal = true;
      return [];
    }

    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      this.failure = "收到无法解析的 SSE 事件";
      return [];
    }

    if (!isRecord(event)) return [];
    const type = String(event.type || "").toLowerCase();
    if (type === "response.completed") {
      const status = readResponseStatus(event);
      if (status && status !== "completed") {
        this.failure = readFailureMessage(event);
      }
      if (this.parts.length === 0 && isRecord(event.response)) {
        const text = parseOpenAIResponsesText(event.response);
        if (text) this.parts.push(text);
      }
      this.terminal = true;
      return [];
    }
    if (
      type === "response.failed" ||
      type === "response.incomplete" ||
      type === "response.cancelled" ||
      type === "error"
    ) {
      this.failure = readFailureMessage(event);
      this.terminal = true;
      return [];
    }

    const delta = parseOpenAIResponsesDelta(event);
    if (delta) {
      this.parts.push(delta);
      return [delta];
    }

    if (type === "response.output_text.done" && this.parts.length === 0) {
      const text =
        typeof event.text === "string"
          ? event.text
          : parseOpenAIResponsesText(event.response);
      if (text) {
        this.parts.push(text);
        return [text];
      }
    }
    return [];
  }
}
