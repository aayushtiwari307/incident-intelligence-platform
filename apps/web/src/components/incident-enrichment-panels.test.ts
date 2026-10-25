import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IncidentEnrichmentPanels } from "./incident-enrichment-panels";

jest.mock("next/link", () => ({
  __esModule: true,
  default: (props: { href: string; children?: React.ReactNode }) => React.createElement("a", { href: props.href }, props.children),
}));

describe("incident enrichment panel rendering", () => {
  it("renders the service context and GitHub issue sections with accessible headings", () => {
    // Server rendering doesn't run effects, so this asserts the initial UI without network/database access.
    const html = renderToStaticMarkup(React.createElement(IncidentEnrichmentPanels, { incidentId: "incident-test-id", canUpdate: true }));
    expect(html).toContain("Service and change context");
    expect(html).toContain("Linked service");
    expect(html).toContain("GitHub issue or pull request");
    expect(html).toContain("Choose a service to correlate incident history");
    // Repository-dependent actions remain hidden until the tenant's GitHub settings have loaded.
    expect(html).not.toContain("Link GitHub issue");
  });
});
