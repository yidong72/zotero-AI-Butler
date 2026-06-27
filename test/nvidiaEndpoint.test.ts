import { expect } from "chai";
import { normalizeNvInferenceBaseUrl } from "../src/modules/llmproviders/NvInferenceProvider";
import {
  assertOpenAIResponsesComplete,
  OpenAIResponsesStreamCollector,
} from "../src/modules/llmproviders/shared/openaiResponsesStream";

describe("NVIDIA endpoint resilience", function () {
  it("normalizes base, versioned, and concrete NVIDIA endpoint URLs", function () {
    const expected = "https://inference-api.nvidia.com";
    expect(normalizeNvInferenceBaseUrl(expected)).to.equal(expected);
    expect(normalizeNvInferenceBaseUrl(`${expected}/v1`)).to.equal(expected);
    expect(normalizeNvInferenceBaseUrl(`${expected}/v1/responses/`)).to.equal(
      expected,
    );
    expect(normalizeNvInferenceBaseUrl(`${expected}/v1/messages`)).to.equal(
      expected,
    );
    expect(normalizeNvInferenceBaseUrl("   ")).to.equal(expected);
  });

  it("accepts a completed Responses stream split across cumulative XHR updates", function () {
    const collector = new OpenAIResponsesStreamCollector();
    const first =
      'data: {"type":"response.output_text.delta","delta":"Hello"}\n';
    const complete =
      first +
      'data: {"type":"response.output_text.delta","delta":" world"}\n' +
      'data: {"type":"response.completed","response":{"status":"completed"}}';

    expect(collector.consumeCumulative(first)).to.deep.equal(["Hello"]);
    expect(collector.consumeCumulative(complete)).to.deep.equal([" world"]);
    expect(collector.finish()).to.deep.equal([]);
    expect(collector.result()).to.equal("Hello world");
  });

  it("uses output_text.done as a fallback when a gateway emits no deltas", function () {
    const collector = new OpenAIResponsesStreamCollector();
    const response = [
      'data: {"type":"response.output_text.done","text":"final text"}',
      'data: {"type":"response.completed","response":{"status":"completed"}}',
      "",
    ].join("\n");

    expect(collector.consumeCumulative(response)).to.deep.equal(["final text"]);
    expect(collector.result()).to.equal("final text");
  });

  it("rejects partial streams and explicit incomplete responses", function () {
    const partial = new OpenAIResponsesStreamCollector();
    partial.consumeCumulative(
      'data: {"type":"response.output_text.delta","delta":"partial"}\n',
    );
    expect(() => partial.result()).to.throw("未收到完成事件");

    const incomplete = new OpenAIResponsesStreamCollector();
    incomplete.consumeCumulative(
      'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n',
    );
    expect(() => incomplete.result()).to.throw("max_output_tokens");
    expect(() =>
      assertOpenAIResponsesComplete({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    ).to.throw("max_output_tokens");
  });
});
