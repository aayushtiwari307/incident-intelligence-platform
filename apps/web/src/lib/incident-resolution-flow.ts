import type { ApiClient } from "./api-client";

export type ResolutionFlowResult =
  | { status: "completed"; resolutionSaved: boolean }
  | { status: "invalid"; message: string }
  | {
      status: "failed";
      stage: "resolution" | "transition";
      resolutionSaved: boolean;
      error: unknown;
      resolutionConflict?: boolean;
      outcomeUnknown?: boolean;
    };

type ResolutionFlowApi = Pick<ApiClient, "createIncidentResolution" | "transitionIncident"> &
  Partial<Pick<ApiClient, "getIncidentResolution">>;

export async function resolveIncidentFlow(
  api: ResolutionFlowApi,
  input: {
    incidentId: string;
    expectedVersion: number;
    rootCause: string;
    fixApplied: string;
    resolutionSaved?: boolean;
  },
): Promise<ResolutionFlowResult> {
  const rootCause = input.rootCause.trim();
  const fixApplied = input.fixApplied.trim();
  const hasRootCause = rootCause.length > 0;
  const hasFixApplied = fixApplied.length > 0;

  if (hasRootCause !== hasFixApplied) {
    return { status: "invalid", message: "Enter both root cause and fix applied, or leave both blank." };
  }

  let resolutionSaved = input.resolutionSaved ?? false;
  if (hasRootCause && !resolutionSaved) {
    try {
      await api.createIncidentResolution(input.incidentId, { rootCause, fixApplied });
      resolutionSaved = true;
    } catch (error) {
      if (api.getIncidentResolution) {
        try {
          const saved = await api.getIncidentResolution(input.incidentId);
          if (saved.rootCause === rootCause && saved.fixApplied === fixApplied) {
            resolutionSaved = true;
          } else {
            return {
              status: "failed",
              stage: "resolution",
              resolutionSaved: false,
              resolutionConflict: true,
              error,
            };
          }
        } catch (reconcileError) {
          if (reconcileError instanceof Error && "status" in reconcileError && reconcileError.status === 404) {
            return { status: "failed", stage: "resolution", resolutionSaved: false, error };
          }
          return {
            status: "failed",
            stage: "resolution",
            resolutionSaved: false,
            outcomeUnknown: true,
            error: reconcileError,
          };
        }
      } else {
        return { status: "failed", stage: "resolution", resolutionSaved: false, error };
      }
    }
  }

  try {
    await api.transitionIncident(input.incidentId, { to: "resolved", expectedVersion: input.expectedVersion });
    return { status: "completed", resolutionSaved };
  } catch (error) {
    return { status: "failed", stage: "transition", resolutionSaved, error };
  }
}
