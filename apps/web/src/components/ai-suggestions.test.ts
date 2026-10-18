import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AiSettingsDto, AiSuggestionDto, AiSuggestionStateDto } from "@platform/shared";
import { AiSettingsView } from "./ai-settings-panel";
import { AiSuggestionsView, UNAVAILABLE_TEXT } from "./ai-suggestions-panel";

const incident = { version: 3, severity: "sev1" as const };
const noop = () => undefined;
const settings = (over: Partial<AiSettingsDto> = {}): AiSettingsDto => ({
  serverEnabled: true, organizationOptIn: true, dailyLimit: 20, usedToday: 2, remainingToday: 18, canGenerate: true, unavailableReason: null, ...over,
});
const suggestion = (over: Partial<AiSuggestionDto> = {}): AiSuggestionDto => ({
  id: "s1", incidentId: "i1", status: "pending", incidentVersion: 3, model: "fake-grounded-1", promptVersion: "grounded-suggestion-v1", errorCode: null,
  appliedTarget: null, createdAt: "2026-10-18T00:00:00.000Z", completedAt: "2026-10-18T00:00:01.000Z",
  content: {
    summary: { text: "Looks like <script>alert(1)</script> pool exhaustion", citations: [{ incidentId: "i2", quote: "Fix applied: Expanded the pool" }] },
    severity: { value: "sev2", rationale: "Same impact.", citations: [] },
    nextSteps: [{ text: "Expand the pool", citations: [{ incidentId: "gone", quote: "Fix applied: x" }] }],
    relatedIncidents: [{ incidentId: "i2", reason: "Retrieved by M8 similar-incident search." }],
  },
  sources: { i2: { number: 7, title: "Gateway pool exhaustion" }, gone: null },
  ...over,
});
const render = (state: AiSuggestionStateDto | null, over: { canUse?: boolean; error?: string | null; busy?: boolean } = {}) =>
  renderToStaticMarkup(
    createElement(AiSuggestionsView, { state, incident, canUse: over.canUse ?? true, busy: over.busy ?? false, error: over.error ?? null, onRequest: noop, onApply: noop, onDismiss: noop }),
  );

describe("AI suggestions panel", () => {
  it("explains why generating is unavailable, and offers no button", () => {
    for (const reason of ["server_disabled", "org_not_opted_in", "quota_exhausted"] as const) {
      const html = render({ settings: settings({ canGenerate: false, unavailableReason: reason, serverEnabled: reason !== "server_disabled", organizationOptIn: reason === "quota_exhausted" }), items: [] });
      assert.ok(html.includes(UNAVAILABLE_TEXT[reason].replace(/'/g, "&#x27;")), reason);
      assert.ok(!html.includes("Suggest with AI"), reason);
    }
  });

  it("shows the generate button to responders only, with the allowance and redaction caveat", () => {
    const state = { settings: settings(), items: [] };
    assert.ok(render(state).includes("Suggest with AI"));
    assert.ok(render(state).includes("18 of 20"));
    assert.ok(render(state).includes("best-effort"));
    assert.ok(!render(state, { canUse: false }).includes("Suggest with AI"));
  });

  it("shows progress while queued or running, with no second generate button", () => {
    for (const status of ["queued", "running"] as const) {
      const html = render({ settings: settings(), items: [suggestion({ status, content: null })] });
      assert.ok(html.includes(status === "queued" ? "Queued" : "Generating"));
      assert.ok(!html.includes("Generate a new suggestion"));
    }
  });

  it("renders a pending suggestion as escaped plain text with a verify warning, source links and draft actions", () => {
    const html = render({ settings: settings(), items: [suggestion()] });
    assert.ok(!html.includes("<script>"), "model text must never become markup");
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(html.includes("verify before use"));
    assert.ok(html.includes('href="/incidents/i2"') && html.includes("#7 Gateway pool exhaustion"));
    assert.ok(html.includes("Incident no longer available"));
    assert.ok(html.includes("Use severity as draft") && html.includes("Use next steps as comment draft") && html.includes("Dismiss"));
    assert.ok(!html.includes("Apply and save"), "there is no auto-apply");
  });

  it("hides draft actions from viewers and the severity action when it equals the current severity", () => {
    const viewer = render({ settings: settings(), items: [suggestion()] }, { canUse: false });
    assert.ok(!viewer.includes("as draft") && !viewer.includes("Dismiss"));
    const same = suggestion();
    if (same.content?.severity) same.content.severity.value = "sev1";
    assert.ok(!render({ settings: settings(), items: [same] }).includes("Use severity as draft"));
  });

  it("flags a stale suggestion and states that applying saved nothing", () => {
    const html = render({ settings: settings(), items: [suggestion({ incidentVersion: 1, status: "applied", appliedTarget: "comment" })] });
    assert.ok(html.includes("The incident changed after this was generated"));
    assert.ok(html.includes("nothing was saved"));
    assert.ok(!html.includes(">Dismiss<"), "an applied suggestion cannot be dismissed");
  });

  it("keeps older pending suggestions visible when a newer suggestion exists", () => {
    const older = suggestion({ id: "older", content: { ...suggestion().content!, summary: { text: "Older pending summary", citations: [] } } });
    const newer = suggestion({ id: "newer", status: "dismissed", content: { ...suggestion().content!, summary: { text: "Newer dismissed summary", citations: [] } } });
    const html = render({ settings: settings(), items: [newer, older] });
    assert.ok(html.includes("Older pending summary"));
    assert.ok(html.includes("Newer dismissed summary"));
    assert.equal((html.match(/data-testid="ai-suggestion"/g) ?? []).length, 2);
  });

  it("keeps both draft targets available for an applied suggestion so the user can choose another draft", () => {
    const html = render({ settings: settings(), items: [suggestion({ status: "applied", appliedTarget: "comment" })] });
    assert.ok(html.includes("Use next steps as comment draft"));
    assert.ok(html.includes("Use severity as draft"));
  });

  it("shows a safe failure message without any provider detail", () => {
    const html = render({ settings: settings(), items: [suggestion({ status: "failed", content: null, errorCode: "invalid_output" })] });
    assert.ok(html.includes("did not pass the safety checks"));
    assert.ok(html.includes("Nothing was changed"));
    assert.ok(html.includes("Generate a new suggestion"));
  });

  it("surfaces errors in an alert region", () => {
    assert.ok(render({ settings: settings(), items: [] }, { error: "Too many requests" }).includes("Too many requests"));
  });
});

describe("AI settings panel (owner/admin)", () => {
  const view = (s: AiSettingsDto | null) => renderToStaticMarkup(createElement(AiSettingsView, { settings: s, busy: false, error: null, onToggle: noop }));
  it("is off by default and offers to turn on; explains the data flow and draft-only behaviour", () => {
    const html = view(settings({ organizationOptIn: false }));
    assert.ok(html.includes("Off for this organization") && html.includes("Turn on AI suggestions"));
    assert.ok(html.includes("sent to the configured AI provider") && html.includes("drafts only"));
  });
  it("offers to turn off when on, and warns when the server has AI disabled", () => {
    assert.ok(view(settings()).includes("Turn off AI suggestions"));
    assert.ok(view(settings({ serverEnabled: false })).includes("not enabled on this server"));
  });
});
