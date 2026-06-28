import { expect } from "chai";
import {
  classifyRequestFailure,
  normalizeRequestFailureMessage,
} from "../src/modules/llmproviders/shared/requestFailure";
import {
  LLMApiCallError,
  LLMApiExhaustedError,
  LLMRequestTooLargeError,
  SAFE_INLINE_REQUEST_BYTES,
  estimateBase64Length,
  estimateInlinePdfRequestBytes,
} from "../src/modules/llmService";
import type { LLMEndpoint } from "../src/modules/llmEndpointManager";

const endpoint: LLMEndpoint = {
  id: "nvidia-test",
  name: "NVIDIA test",
  providerType: "nvinference",
  apiUrl: "https://inference-api.nvidia.com",
  apiKey: "test",
  model: "azure/anthropic/claude-opus-4-8",
  enabled: true,
  createdAt: "2026-06-28T00:00:00.000Z",
  updatedAt: "2026-06-28T00:00:00.000Z",
};

describe("request failure resilience", function () {
  it("classifies the exact OSWORLD connection error as transient", function () {
    const result = classifyRequestFailure(
      new Error("Error connecting to server. Check your Internet connection."),
    );
    expect(result.kind).to.equal("network");
    expect(result.retryable).to.equal(true);
  });

  it("classifies the exact 300000 ms timeout as transient", function () {
    const result = classifyRequestFailure(
      new Error("Request timed out after 300000 ms"),
    );
    expect(result.kind).to.equal("timeout");
    expect(result.retryable).to.equal(true);
  });

  it("reads transient details from image-generation errors", function () {
    const result = classifyRequestFailure({
      name: "ImageGenerationError",
      message: "图片生成请求失败",
      details: {
        errorName: "NetworkError",
        errorMessage:
          "Error connecting to server. Check your Internet connection.",
      },
    });
    expect(result.kind).to.equal("network");
    expect(result.retryable).to.equal(true);
  });

  it("extracts content_length_limit from noisy NVIDIA gateway text", function () {
    const noisy =
      'None: {"error":{"code":"content_length_limit","message":"Request content length exceeded 32 MB limit.","details":"Request content length exceeded 32 MB limit."}}' +
      "No fallback model group found for original model_group=azure/anthropic/claude-opus-4-8.";
    const result = classifyRequestFailure(new Error(noisy));
    expect(result.kind).to.equal("payload-too-large");
    expect(result.retryable).to.equal(false);
    expect(normalizeRequestFailureMessage(new Error(noisy))).to.equal(
      "content_length_limit: Request content length exceeded 32 MB limit.",
    );
  });

  it("keeps auth and invalid requests terminal while retrying server errors", function () {
    expect(
      classifyRequestFailure(new Error("HTTP 401 Unauthorized")).retryable,
    ).to.equal(false);
    expect(
      classifyRequestFailure(new Error("HTTP 400 invalid request")).retryable,
    ).to.equal(false);
    expect(
      classifyRequestFailure(new Error("HTTP 429 Too Many Requests")).kind,
    ).to.equal("rate-limit");
    expect(
      classifyRequestFailure(new Error("HTTP 503 Service Unavailable")).kind,
    ).to.equal("server");
  });

  it("lets explicit permanent 4xx statuses override transient-looking text", function () {
    const invalidTimeout = classifyRequestFailure({
      status: 400,
      message: "Invalid request: timeout must be an integer",
    });
    const unauthorizedGateway = classifyRequestFailure({
      statusCode: 401,
      message: "Authentication server error",
    });

    expect(invalidTimeout.kind).to.equal("permanent");
    expect(invalidTimeout.retryable).to.equal(false);
    expect(unauthorizedGateway.kind).to.equal("permanent");
    expect(unauthorizedGateway.retryable).to.equal(false);
  });

  it("preserves retryability when an oversized PDF is waiting for text extraction", function () {
    const extractionError = Object.assign(
      new Error("PDF text extraction failed: Unable to extract text from PDF"),
      { name: "PDFTextExtractionError" },
    );
    const oversized = new LLMRequestTooLargeError(
      30 * 1024 * 1024,
      SAFE_INLINE_REQUEST_BYTES,
      extractionError,
    );

    expect(classifyRequestFailure(extractionError).kind).to.equal("extraction");
    expect(classifyRequestFailure(oversized).kind).to.equal("extraction");
    expect(oversized.failureKind).to.equal("extraction");
    expect(oversized.suppressTaskRetry).to.equal(false);
  });

  it("preserves transient retryability through nested LLM errors", function () {
    const apiError = new LLMApiCallError(
      endpoint,
      new Error("Error connecting to server. Check your Internet connection."),
    );
    const exhausted = new LLMApiExhaustedError(3, apiError);
    expect(apiError.suppressTaskRetry).to.equal(false);
    expect(exhausted.failureKind).to.equal("network");
    expect(exhausted.suppressTaskRetry).to.equal(false);
    expect(exhausted.attempts).to.equal(3);
  });

  it("preflights raw and aggregate PDF sizes below the 32 MiB endpoint cap", function () {
    const raw24MiB = 24 * 1024 * 1024;
    const encoded = estimateBase64Length(raw24MiB);
    expect(encoded).to.equal(32 * 1024 * 1024);
    expect(estimateInlinePdfRequestBytes(encoded, "prompt")).to.be.greaterThan(
      SAFE_INLINE_REQUEST_BYTES,
    );

    const twoEncoded13MiB = estimateBase64Length(13 * 1024 * 1024) * 2;
    expect(
      estimateInlinePdfRequestBytes(twoEncoded13MiB, "multi-file prompt"),
    ).to.be.greaterThan(SAFE_INLINE_REQUEST_BYTES);
  });
});
