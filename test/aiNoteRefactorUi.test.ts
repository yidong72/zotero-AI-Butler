import { expect } from "chai";
import {
  getLibraryScannerTargetLabel,
  getLibraryScannerTaskType,
} from "../src/modules/views/LibraryScannerView";
import {
  addSidebarClipboardBlockBreaks,
  getSidebarMetadataSelectionKey,
  getSidebarNoteCollapsedPrefKey,
  getSidebarNoteElementId,
  getSidebarNoteHeightPrefKey,
  htmlToMarkdown,
} from "../src/modules/ItemPaneSection";
import {
  extractSavedMindmapMarkdown,
  getSavedAiNoteLabel,
} from "../src/modules/views/SummaryView";
import { getCompletedTaskSavedNoteKind } from "../src/modules/views/TaskQueueView";

describe("AI note refactor UI helpers", function () {
  it("maps scanner targets to separate labels and task types", function () {
    expect(getLibraryScannerTargetLabel("summary")).to.equal("AI 总结");
    expect(getLibraryScannerTargetLabel("deepRead")).to.equal("AI 精读");
    expect(getLibraryScannerTaskType("summary")).to.equal("summary");
    expect(getLibraryScannerTaskType("deepRead")).to.equal("deepRead");
  });

  it("keeps sidebar summary and deep-read element IDs separate", function () {
    expect(
      getSidebarNoteElementId("ai-butler-note-content", "summary"),
    ).to.equal("ai-butler-note-content");
    expect(
      getSidebarNoteElementId("ai-butler-note-content", "deepRead"),
    ).to.equal("ai-butler-note-content-deepRead");
  });

  it("keeps sidebar persisted state keys separate with summary fallback keys", function () {
    expect(getSidebarNoteHeightPrefKey("summary")).to.equal(
      "sidebarNoteHeight",
    );
    expect(getSidebarNoteHeightPrefKey("deepRead")).to.equal(
      "sidebarDeepReadHeight",
    );
    expect(getSidebarNoteCollapsedPrefKey("summary")).to.equal(
      "sidebarNoteCollapsed",
    );
    expect(getSidebarNoteCollapsedPrefKey("deepRead")).to.equal(
      "sidebarDeepReadCollapsed",
    );
    expect(getSidebarMetadataSelectionKey(1, 2, "summary")).to.equal(
      "summary:1:2",
    );
    expect(getSidebarMetadataSelectionKey(1, 2, "deepRead")).to.equal(
      "deepRead:1:2",
    );
  });

  it("copies deep-read Markdown without exposing private resume links", function () {
    const markdown = htmlToMarkdown(
      [
        '<h2><a href="zab://slot/chapter_ch1/done/start">&#8203;</a>Introduction</h2>',
        '<p>Body <a href="https://example.com">source</a><a href="zab://slot/chapter_ch1/done/end">&#8203;</a></p>',
      ].join(""),
    );

    expect(markdown).to.include("## Introduction");
    expect(markdown).to.include("[source](https://example.com)");
    expect(markdown).to.not.include("zab://");
    expect(markdown).to.not.include("[​]");
  });

  it("injects stable plain-text breaks between copied block elements", function () {
    const blockAware = addSidebarClipboardBlockBreaks(
      "<h2>Introduction</h2><p>Body</p><ul><li>First</li><li>Second</li></ul>",
    );

    expect(blockAware).to.include("</h2>\n");
    expect(blockAware).to.include("</p>\n");
    expect(blockAware).to.include("\n<li>First</li>\n");
    expect(blockAware).to.include("\n<li>Second</li>\n");
  });

  it("extracts saved mind-map content and only maps supported task artifacts", function () {
    expect(
      extractSavedMindmapMarkdown(
        "<pre>```markmap\r\n# Paper\r\n- Method &amp; Results\r\n```</pre>",
      ),
    ).to.equal("# Paper\r\n- Method & Results");
    expect(getCompletedTaskSavedNoteKind(undefined)).to.equal("summary");
    expect(getCompletedTaskSavedNoteKind("summary")).to.equal("summary");
    expect(getCompletedTaskSavedNoteKind("imageSummary")).to.equal(
      "imageSummary",
    );
    expect(getCompletedTaskSavedNoteKind("tableFill")).to.equal(null);
    expect(getCompletedTaskSavedNoteKind("review")).to.equal(null);
    expect(getCompletedTaskSavedNoteKind("targetedQuestion")).to.equal(null);
    expect(getSavedAiNoteLabel("deepRead", "en")).to.equal("AI deep read");
    expect(getSavedAiNoteLabel("imageSummary", "zh")).to.equal("一图总结");
  });
});
