export type RequestFailureKind =
  | "abort"
  | "extraction"
  | "payload-too-large"
  | "timeout"
  | "network"
  | "rate-limit"
  | "server"
  | "permanent"
  | "unknown";

export type RequestFailureInfo = {
  kind: RequestFailureKind;
  retryable: boolean;
  statusCode?: number;
  message: string;
  diagnostic: string;
};

const MAX_NESTED_ERROR_DEPTH = 5;

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function collectFailureParts(
  value: unknown,
  parts: string[],
  statuses: number[],
  seen: Set<unknown>,
  depth: number,
): void {
  if (value === null || value === undefined || depth > MAX_NESTED_ERROR_DEPTH) {
    return;
  }
  if (typeof value !== "object") {
    const text = stringifyValue(value).trim();
    if (text) parts.push(text);
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);

  const record = value as Record<string, unknown>;
  for (const key of [
    "name",
    "message",
    "errorName",
    "errorMessage",
    "code",
    "type",
    "failureKind",
    "statusText",
    "responseBody",
  ]) {
    const text = stringifyValue(record[key]).trim();
    if (record[key] !== undefined && text) parts.push(text);
  }
  for (const key of ["status", "statusCode"]) {
    const status = Number(record[key]);
    if (Number.isFinite(status) && status > 0) statuses.push(status);
  }
  for (const key of [
    "lastError",
    "originalError",
    "cause",
    "details",
    "error",
    "xmlhttp",
  ]) {
    collectFailureParts(record[key], parts, statuses, seen, depth + 1);
  }
}

function decodeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value.replace(/"/g, '\\"')}"`);
  } catch {
    return value.replace(/\\n/g, " ").replace(/\\"/g, '"');
  }
}

function extractGatewayError(text: string): string | null {
  const code = text.match(/["'](?:code|type)["']\s*:\s*["']([^"']+)["']/i)?.[1];
  const message = text.match(
    /["']message["']\s*:\s*["']((?:\\.|[^"'])+)["']/i,
  )?.[1];
  if (!code && !message) return null;
  return [code, message ? decodeJsonString(message) : ""]
    .filter(Boolean)
    .join(": ");
}

function firstUsefulMessage(parts: string[], diagnostic: string): string {
  const gateway = extractGatewayError(diagnostic);
  if (gateway) return gateway;
  return (
    parts.find(
      (part) =>
        part.length > 3 &&
        !/^(?:error|typeerror|networkerror|llmapicallexhaustederror)$/i.test(
          part,
        ) &&
        !/^[a-z][a-z0-9_.-]*error$/i.test(part),
    ) ||
    diagnostic ||
    "Unknown request failure"
  );
}

export function classifyRequestFailure(error: unknown): RequestFailureInfo {
  const parts: string[] = [];
  const statuses: number[] = [];
  collectFailureParts(error, parts, statuses, new Set(), 0);
  const diagnostic = parts.join(" | ") || stringifyValue(error);
  const text = diagnostic.toLowerCase();
  const statusCode =
    statuses.find((status) => status >= 400 && status <= 599) ||
    Number(text.match(/\bhttp[_\s:-]*(\d{3})\b/i)?.[1]) ||
    undefined;
  const message = firstUsefulMessage(parts, diagnostic);

  if (
    /\babort(?:ed|error)?\b|request (?:was )?cancelled|request (?:was )?canceled|请求已终止|用户手动终止/.test(
      text,
    )
  ) {
    return { kind: "abort", retryable: false, statusCode, message, diagnostic };
  }

  if (
    statusCode === 413 ||
    /content_length_limit|request content length exceeded|content length exceeded|payload[-_\s]too[-_\s]large|request entity too large|maximum request (?:body )?size|max(?:imum)? content length/.test(
      text,
    )
  ) {
    return {
      kind: "payload-too-large",
      retryable: false,
      statusCode,
      message,
      diagnostic,
    };
  }

  if (statusCode === 408) {
    return {
      kind: "timeout",
      retryable: true,
      statusCode,
      message,
      diagnostic,
    };
  }

  if (statusCode === 429) {
    return {
      kind: "rate-limit",
      retryable: true,
      statusCode,
      message,
      diagnostic,
    };
  }

  if (statusCode === 409 || (statusCode !== undefined && statusCode >= 500)) {
    return { kind: "server", retryable: true, statusCode, message, diagnostic };
  }

  // Explicit HTTP status semantics take precedence over loose message text.
  // Validation errors often mention fields such as "timeout" or "server",
  // which must not turn a permanent 4xx into a retry storm.
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
    return {
      kind: "permanent",
      retryable: false,
      statusCode,
      message,
      diagnostic,
    };
  }

  if (/\bpdftextextractionerror\b|pdf text extraction failed/.test(text)) {
    return {
      kind: "extraction",
      retryable: true,
      statusCode,
      message,
      diagnostic,
    };
  }

  if (
    /\btimeout\b|timed out|request time.?out|请求超时|请求超过\s*\d+\s*ms/.test(
      text,
    )
  ) {
    return {
      kind: "timeout",
      retryable: true,
      statusCode,
      message,
      diagnostic,
    };
  }

  if (/rate.?limit|too many requests|quota temporarily|资源耗尽/.test(text)) {
    return {
      kind: "rate-limit",
      retryable: true,
      statusCode,
      message,
      diagnostic,
    };
  }

  if (
    /service unavailable|bad gateway|gateway timeout|server error|overloaded|temporar(?:y|ily) unavailable/.test(
      text,
    )
  ) {
    return { kind: "server", retryable: true, statusCode, message, diagnostic };
  }

  if (
    /error connecting to server|check your internet connection|network\s*error|networkerror|xhr onerror|\beconn(?:reset|refused|aborted)?\b|socket (?:hang up|closed)|connection (?:reset|refused|closed|failed|lost)|stream ended before|stream.*premature|流式连接提前结束|未收到 (?:message_stop|完成事件)|返回内容为空|empty response|连接失败|网络错误/.test(
      text,
    )
  ) {
    return {
      kind: "network",
      retryable: true,
      statusCode,
      message,
      diagnostic,
    };
  }

  if (
    /invalid api key|api (?:key|url).*未配置|unauthori[sz]ed|forbidden|authentication|permission denied|model .*not found|unknown model|unsupported|not supported|invalid request|参数不完整|文献条目不存在|没有 pdf|no pdf|no attachments?|配置.*(?:错误|缺失|未配置)/.test(
      text,
    )
  ) {
    return {
      kind: "permanent",
      retryable: false,
      statusCode,
      message,
      diagnostic,
    };
  }

  return { kind: "unknown", retryable: false, statusCode, message, diagnostic };
}

export function isPayloadTooLargeFailure(error: unknown): boolean {
  return classifyRequestFailure(error).kind === "payload-too-large";
}

export function isTransientRequestFailure(error: unknown): boolean {
  return classifyRequestFailure(error).retryable;
}

export function normalizeRequestFailureMessage(error: unknown): string {
  return classifyRequestFailure(error).message;
}
