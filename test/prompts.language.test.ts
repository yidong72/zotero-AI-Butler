import { expect } from "chai";
import {
  buildUserMessage,
  getDefaultImageGenerationPrompt,
  getDefaultImageSummaryPrompt,
} from "../src/utils/prompts";

describe("prompt language isolation", function () {
  it("lets the caller prompt control the response language", function () {
    const message = buildUserMessage("Answer in English only.", "Paper body.");

    expect(message).to.equal(
      "Answer in English only.\n\n<Paper>\nPaper body.\n</Paper>",
    );
    expect(message).not.to.include("请用中文回答");
  });

  it("provides fully English built-in image-summary prompts", function () {
    const summaryPrompt = getDefaultImageSummaryPrompt("en");
    const generationPrompt = getDefaultImageGenerationPrompt("en");

    expect(summaryPrompt).to.include("academic concept poster");
    expect(summaryPrompt).to.include("${context}");
    expect(generationPrompt).to.include("academic paper concept graphic");
    expect(generationPrompt).to.include("${summaryForImage}");
    expect(generationPrompt).to.include("Main text language: ${language}");
    expect(summaryPrompt).not.to.match(/[\u4e00-\u9fff]/);
    expect(generationPrompt).not.to.match(/[\u4e00-\u9fff]/);
  });

  it("keeps the Chinese image-generation template as the default", function () {
    expect(getDefaultImageGenerationPrompt()).to.include(
      "生成一张学术论文概念图",
    );
    expect(getDefaultImageGenerationPrompt("zh")).not.to.equal(
      getDefaultImageGenerationPrompt("en"),
    );
  });
});
