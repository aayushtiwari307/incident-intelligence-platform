import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IncidentDto, IncidentResolutionDto, SimilarIncidentDto } from "@platform/shared";
import { ResolveForm } from "./resolve-form";
import { SimilarIncidentsContent } from "./similar-incidents-panel";
import { resolveIncidentFlow } from "../lib/incident-resolution-flow";

const incident: IncidentDto = {
  id: "incident-1",
  number: 101,
  title: "Checkout unavailable",
  description: "",
  severity: "sev1",
  status: "investigating",
  assignee: null,
  createdBy: null,
  version: 3,
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:00:00.000Z",
  acknowledgedAt: null,
  mitigatedAt: null,
  resolvedAt: null,
};

const resolution: IncidentResolutionDto = {
  incidentId: incident.id,
  rootCause: "Pool saturation",
  fixApplied: "Expanded pool",
  resolvedBy: "user-1",
  version: 1,
  createdAt: incident.createdAt,
  updatedAt: incident.updatedAt,
};

const resolvedIncident: IncidentDto = { ...incident, status: "resolved" };

function similar(number: number): SimilarIncidentDto {
  return {
    id: `incident-${number}`,
    number,
    title: `Related outage ${number}`,
    severity: "sev2",
    resolvedAt: "2026-10-16T00:00:00.000Z",
    rootCause: "Database connection pool exhausted",
    fixApplied: "Increased pool capacity",
    matchedTerms: ["database", "pool"],
  };
}

describe("incident detail UI", () => {
  it("renders accessible loading, empty, and retryable error states for similar incidents", () => {
    const loading = renderToStaticMarkup(
      createElement(SimilarIncidentsContent, { state: { status: "loading" }, onRetry: () => undefined }),
    );
    assert.match(loading, /aria-labelledby="similar-incidents-heading"/);
    assert.match(loading, /role="status"/);
    assert.match(loading, /Finding similar incidents/);

    const empty = renderToStaticMarkup(
      createElement(SimilarIncidentsContent, { state: { status: "loaded", results: [] }, onRetry: () => undefined }),
    );
    assert.match(empty, /No similar resolved incidents found/);

    const failed = renderToStaticMarkup(
      createElement(SimilarIncidentsContent, {
        state: { status: "error", message: "Connection failed" },
        onRetry: () => undefined,
      }),
    );
    assert.match(failed, /role="alert"/);
    assert.match(failed, /Connection failed/);
    assert.match(failed, /Retry loading similar incidents/);
  });

  it("renders no more than five useful resolved matches with accessible identifiers and resolution details", () => {
    const markup = renderToStaticMarkup(
      createElement(SimilarIncidentsContent, {
        state: { status: "loaded", results: Array.from({ length: 7 }, (_, index) => similar(index + 1)) },
        onRetry: () => undefined,
      }),
    );
    assert.equal((markup.match(/Related outage/g) ?? []).length, 5);
    assert.match(markup, /#1/);
    assert.match(markup, /Root cause/);
    assert.match(markup, /Database connection pool exhausted/);
    assert.match(markup, /Fix applied/);
    assert.match(markup, /Matched terms:<\/strong> database, pool/);
    assert.match(markup, /SEV2/);
  });

  it("labels optional resolution inputs and communicates bounds and paired entry", () => {
    const markup = renderToStaticMarkup(
      createElement(ResolveForm, {
        incidentId: incident.id,
        expectedVersion: incident.version,
        onCancel: () => undefined,
        onComplete: () => undefined,
        onTransitionFailure: async () => undefined,
      }),
    );
    assert.match(markup, /aria-label="Resolve incident"/);
    assert.match(markup, /for="resolution-root-cause">Root cause/);
    assert.match(markup, /for="resolution-fix-applied">Fix applied/);
    assert.equal((markup.match(/maxLength="2000"/g) ?? []).length, 2);
    assert.match(markup, /Leave both blank to resolve without them/);
  });

  it("allows an ordinary resolve without resolution text", async () => {
    const calls: string[] = [];
    const client = {
      createIncidentResolution: async () => {
        calls.push("resolution");
        return resolution;
      },
      transitionIncident: async () => {
        calls.push("transition");
        return resolvedIncident;
      },
    };
    const result = await resolveIncidentFlow(client, {
      incidentId: incident.id,
      expectedVersion: incident.version,
      rootCause: " ",
      fixApplied: "",
    });
    assert.deepEqual(result, { status: "completed", resolutionSaved: false });
    assert.deepEqual(calls, ["transition"]);
  });

  it("creates populated resolution text before transitioning and trims both fields", async () => {
    const calls: Array<{ method: string; input?: unknown }> = [];
    const client = {
      createIncidentResolution: async (_id: string, input: { rootCause: string; fixApplied: string }) => {
        calls.push({ method: "resolution", input });
        return resolution;
      },
      transitionIncident: async (_id: string, input: { to: "resolved"; expectedVersion: number }) => {
        calls.push({ method: "transition", input });
        return resolvedIncident;
      },
    };
    const result = await resolveIncidentFlow(client, {
      incidentId: incident.id,
      expectedVersion: incident.version,
      rootCause: "  Pool saturation ",
      fixApplied: " Expanded pool  ",
    });
    assert.deepEqual(result, { status: "completed", resolutionSaved: true });
    assert.deepEqual(calls, [
      { method: "resolution", input: { rootCause: "Pool saturation", fixApplied: "Expanded pool" } },
      { method: "transition", input: { to: "resolved", expectedVersion: incident.version } },
    ]);
  });

  it("does not transition when resolution creation fails and retains the caller's text", async () => {
    let transitions = 0;
    const failure = new Error("Resolution rejected");
    const client = {
      createIncidentResolution: async () => {
        throw failure;
      },
      transitionIncident: async () => {
        transitions += 1;
        return incident;
      },
    };
    const result = await resolveIncidentFlow(client, {
      incidentId: incident.id,
      expectedVersion: incident.version,
      rootCause: "Pool saturation",
      fixApplied: "Expanded pool",
    });
    assert.deepEqual(result, { status: "failed", stage: "resolution", resolutionSaved: false, error: failure });
    assert.equal(transitions, 0);
  });

  it("reconciles a committed resolution after an ambiguous create response before transitioning", async () => {
    const calls: string[] = [];
    const client = {
      createIncidentResolution: async () => {
        calls.push("create");
        throw new Error("connection closed after commit");
      },
      getIncidentResolution: async () => {
        calls.push("read");
        return resolution;
      },
      transitionIncident: async () => {
        calls.push("transition");
        return resolvedIncident;
      },
    };
    const result = await resolveIncidentFlow(client, {
      incidentId: incident.id,
      expectedVersion: incident.version,
      rootCause: resolution.rootCause,
      fixApplied: resolution.fixApplied,
    });
    assert.deepEqual(result, { status: "completed", resolutionSaved: true });
    assert.deepEqual(calls, ["create", "read", "transition"]);
  });

  it("retains submitted text and does not transition when a different resolution already exists", async () => {
    let transitioned = false;
    const client = {
      createIncidentResolution: async () => {
        throw new Error("already exists");
      },
      getIncidentResolution: async () => ({ ...resolution, rootCause: "Different cause" }),
      transitionIncident: async () => {
        transitioned = true;
        return resolvedIncident;
      },
    };
    const result = await resolveIncidentFlow(client, {
      incidentId: incident.id,
      expectedVersion: incident.version,
      rootCause: "Pool saturation",
      fixApplied: "Expanded pool",
    });
    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" && result.resolutionConflict, true);
    assert.equal(transitioned, false);
  });

  it("surfaces unresolved create outcomes without transitioning if reconciliation also fails", async () => {
    const reconcileError = new Error("read unavailable");
    const client = {
      createIncidentResolution: async () => {
        throw new Error("write response lost");
      },
      getIncidentResolution: async () => {
        throw reconcileError;
      },
      transitionIncident: async () => {
        assert.fail("must not transition without knowing whether resolution details were saved");
      },
    };
    const result = await resolveIncidentFlow(client, {
      incidentId: incident.id,
      expectedVersion: incident.version,
      rootCause: "Pool saturation",
      fixApplied: "Expanded pool",
    });
    assert.deepEqual(result, {
      status: "failed",
      stage: "resolution",
      resolutionSaved: false,
      outcomeUnknown: true,
      error: reconcileError,
    });
  });

  it("preserves saved details after a transition failure and skips duplicate creation on retry", async () => {
    let creates = 0;
    const calls: number[] = [];
    const client = {
      createIncidentResolution: async () => {
        creates += 1;
        return resolution;
      },
      transitionIncident: async (_id: string, input: { to: "resolved"; expectedVersion: number }) => {
        calls.push(input.expectedVersion);
        if (calls.length === 1) throw new Error("stale version");
        return resolvedIncident;
      },
    };
    const input = {
      incidentId: incident.id,
      expectedVersion: incident.version,
      rootCause: "Pool saturation",
      fixApplied: "Expanded pool",
    };
    const first = await resolveIncidentFlow(client, input);
    assert.equal(first.status, "failed");
    assert.equal(first.status === "failed" && first.resolutionSaved, true);

    const retry = await resolveIncidentFlow(client, { ...input, expectedVersion: incident.version + 1, resolutionSaved: true });
    assert.deepEqual(retry, { status: "completed", resolutionSaved: true });
    assert.equal(creates, 1);
    assert.deepEqual(calls, [incident.version, incident.version + 1]);
  });

  it("requires both fields together if any resolution text is entered", async () => {
    let calls = 0;
    const client = {
      createIncidentResolution: async () => {
        calls += 1;
        return resolution;
      },
      transitionIncident: async () => {
        calls += 1;
        return incident;
      },
    };
    const result = await resolveIncidentFlow(client, {
      incidentId: incident.id,
      expectedVersion: incident.version,
      rootCause: "Cause",
      fixApplied: "  ",
    });
    assert.deepEqual(result, {
      status: "invalid",
      message: "Enter both root cause and fix applied, or leave both blank.",
    });
    assert.equal(calls, 0);
  });
});
