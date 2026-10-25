import { z } from "zod";
import { uuidSchema } from "./auth";

export const SERVICE_TIERS = ["tier1", "tier2", "tier3"] as const;
export type ServiceTier = (typeof SERVICE_TIERS)[number];

// eslint-disable-next-line no-control-regex -- this validation deliberately rejects control characters
const cleanName = (max: number) => z.string().trim().min(1).max(max).refine((v) => !/[\u0000-\u001f\u007f-\u009f]/.test(v), "control characters are not allowed");
export const createServiceSchema = z.object({
  name: cleanName(100),
  ownerTeam: cleanName(80),
  tier: z.enum(SERVICE_TIERS).default("tier3"),
}).strict();
export const updateServiceSchema = createServiceSchema.partial().refine((v) => Object.keys(v).length > 0, "Provide at least one field to change");
export const linkIncidentServiceSchema = z.object({ serviceId: uuidSchema.nullable() }).strict();

export interface ServiceDto {
  id: string;
  name: string;
  ownerTeam: string;
  tier: ServiceTier;
  createdAt: string;
  updatedAt: string;
}

export interface ChangeEventDto {
  id: string;
  serviceId: string;
  serviceName: string;
  source: string;
  externalId: string;
  version: string;
  actor: string;
  changedAt: string;
  correlationLabel: "correlation, not proven cause";
}

export interface IncidentServiceContextDto {
  service: ServiceDto | null;
  changes: ChangeEventDto[];
  windowHours: 24;
}

export const githubOwnerSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/);
export const githubRepoSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/).refine((v) => v !== "." && v !== "..");
export const githubRepositorySchema = z.object({ owner: githubOwnerSchema, repo: githubRepoSchema }).strict();
export const githubSettingsSchema = z.object({ enabled: z.boolean() }).strict();
export const linkGithubIssueSchema = z.object({ repositoryId: uuidSchema, issueNumber: z.number().int().min(1).max(2147483647) }).strict();

export interface GithubRepositoryDto {
  id: string;
  owner: string;
  repo: string;
  linkedAt: string;
}
export interface GithubIssueLabelDto { name: string; color: string | null }
export interface GithubIssueActivityDto { author: string; body: string; createdAt: string }
export interface GithubIssueSummaryDto {
  title: string;
  state: string;
  isPullRequest: boolean;
  labels: GithubIssueLabelDto[];
  assignee: string | null;
  updatedAt: string;
  bodyExcerpt: string;
  recentActivity: GithubIssueActivityDto[];
}
export type GithubIssueStatus = "disabled" | "unlinked" | "available" | "not_found_or_private" | "rate_limited" | "unavailable" | "invalid_response";
export interface GithubIssueContextDto {
  enabled: boolean;
  status: GithubIssueStatus;
  link: null | { id: string; repository: GithubRepositoryDto; issueNumber: number; url: string };
  issue: GithubIssueSummaryDto | null;
  checkedAt: string | null;
}
export interface GithubSettingsDto {
  enabled: boolean;
  repositories: GithubRepositoryDto[];
}

export const changeEventInputSchema = z.object({
  service: cleanName(100),
  source: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/),
  externalId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  version: cleanName(100),
  actor: cleanName(120),
  timestamp: z.string().datetime({ offset: true }),
}).strict();
export type ChangeEventInput = z.infer<typeof changeEventInputSchema>;
