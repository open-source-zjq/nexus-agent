import { z } from "zod";
import { ApprovalPolicySchema, SandboxModeSchema } from "./policy.js";
import { ModelEndpointFormat } from "../config/config.js";
import { RuntimeCapabilityManifest } from "./capabilities.js";

/**
 * Response for `GET /v1/runtime-info`: describes the live serving process — its
 * bind address, data dir, active model/policy, and the full capability
 * manifest. Ported faithfully from the original Nexus `contracts/runtime-info`.
 */
export const RuntimeInfoResponse = z
  .object({
    host: z.string(),
    port: z.number().int().min(0).max(65535),
    dataDir: z.string().min(1),
    configPath: z.string().optional(),
    model: z.string().optional(),
    endpointFormat: ModelEndpointFormat.optional(),
    approvalPolicy: ApprovalPolicySchema.optional(),
    sandboxMode: SandboxModeSchema.optional(),
    tokenEconomyMode: z.boolean().optional(),
    insecure: z.boolean().optional(),
    startedAt: z.string(),
    pid: z.number().int().positive().optional(),
    capabilities: RuntimeCapabilityManifest,
  })
  .strict();
export type RuntimeInfoResponse = z.infer<typeof RuntimeInfoResponse>;
