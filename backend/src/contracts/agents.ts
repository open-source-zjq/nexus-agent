import { z } from "zod";

/**
 * Agent directory (智能体目录) contracts.
 *
 * Faithful to the original Nexus AgentMatrixView: an agent is a "场景编排"
 * (scenario orchestration) preset that combines connector + plugin tool access
 * under a named, categorized card with a tool whitelist, trigger methods, and a
 * per-agent visibility flag controlling whether it appears in a session's agent
 * selector. The original shipped a fixed seed catalog; this contract makes the
 * directory a real, persisted, editable store so agents can also be created.
 */

export const AGENT_CATEGORIES = ["研发", "办公", "数据"] as const;

export const AgentTriggerSchema = z.object({
  kind: z.enum(["command", "event", "schedule"]),
  /** Command name (/mr-review), event key (mr_opened), or schedule text (每周五 17:00). */
  value: z.string().min(1).max(200),
});
export type AgentTrigger = z.infer<typeof AgentTriggerSchema>;

export const AgentDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  subtitle: z.string().max(120).default(""),
  category: z.string().min(1).max(40).default("研发"),
  description: z.string().max(2000).default(""),
  /** Tool whitelist (工具白名单) — tool names this agent is allowed to call. */
  tools: z.array(z.string().min(1).max(80)).default([]),
  /** Trigger methods (触发方式). */
  triggers: z.array(AgentTriggerSchema).default([]),
  /** 会话可选 (true) / 已隐藏 (false): visible in a session's agent selector. */
  visible: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/** Request body for POST /v1/agents (create). */
export const AgentCreateRequest = z.object({
  name: z.string().min(1).max(80),
  subtitle: z.string().max(120).optional(),
  category: z.string().min(1).max(40).optional(),
  description: z.string().max(2000).optional(),
  tools: z.array(z.string().min(1).max(80)).optional(),
  triggers: z.array(AgentTriggerSchema).optional(),
  visible: z.boolean().optional(),
});
export type AgentCreateInput = z.infer<typeof AgentCreateRequest>;

/** Request body for PATCH /v1/agents/:id (partial update). */
export const AgentUpdateRequest = AgentCreateRequest.partial();
export type AgentUpdateInput = z.infer<typeof AgentUpdateRequest>;

/**
 * The original seed catalog (10 scenario agents) recovered from
 * AgentMatrixView-C1N-Z2Ny.js / reconstruction/fragments/agentmatrix.html. The
 * store seeds these on first run so the directory is populated out of the box.
 */
export const SEED_AGENTS: ReadonlyArray<Omit<AgentDefinition, "createdAt" | "updatedAt">> = [
  {
    id: "mr-review",
    name: "MR 评审官",
    subtitle: "GitLab + 本地仓库",
    category: "研发",
    description: "拉取 GitLab MR 的 diff 与本地仓库全量上下文，做结构化评审，并可回写行级评论与审批。",
    tools: ["gitlab_get_mr", "gitlab_get_mr_changes", "gitlab_post_mr_discussion", "gitlab_approve_mr", "gitlab_merge_mr", "read", "bash"],
    triggers: [
      { kind: "command", value: "/mr-review" },
      { kind: "event", value: "mr_opened" },
      { kind: "event", value: "mr_updated" },
    ],
    visible: true,
  },
  {
    id: "release",
    name: "发布管家",
    subtitle: "GitLab + K8s + 飞书群",
    category: "研发",
    description: "从项目空间读取流水线/环境参数，触发 KubeSphere 发布，轮询进度，完成后在飞书群通报。",
    tools: ["gitlab_get_mr", "ks_trigger_pipeline", "ks_pipeline_status", "k8s_list_pods", "k8s_logs", "k8s_rollback"],
    triggers: [
      { kind: "command", value: "/release" },
      { kind: "event", value: "mr_merged" },
      { kind: "event", value: "pipeline_succeeded" },
      { kind: "event", value: "pipeline_failed" },
    ],
    visible: true,
  },
  {
    id: "oncall",
    name: "值班诊断",
    subtitle: "K8s + GitLab + 飞书群",
    category: "研发",
    description: "聚合 logs / events / top 与最近合入 MR 的 diff，给出根因假设与建议动作，必要时在群里 @提交人。",
    tools: ["k8s_logs", "k8s_events", "k8s_describe", "k8s_top", "k8s_rollout_restart", "k8s_rollback", "gitlab_list_commits", "gitlab_get_commit_diff"],
    triggers: [
      { kind: "command", value: "/oncall" },
      { kind: "event", value: "pod_crashloop" },
      { kind: "event", value: "pod_oomkilled" },
    ],
    visible: false,
  },
  {
    id: "meeting",
    name: "会议助理",
    subtitle: "飞书日历/会议/文档 + @成员",
    category: "办公",
    description: "起草会议议题与参会人，一键创建飞书日历会议与视频会议链接，并挂载会前材料云文档。",
    tools: ["read"],
    triggers: [
      { kind: "command", value: "/meeting" },
      { kind: "event", value: "alignment_needed" },
    ],
    visible: true,
  },
  {
    id: "weekly-report",
    name: "周报秘书",
    subtitle: "全部只读 + docx",
    category: "办公",
    description: "每周五 17:00 聚合本周该空间的 MR / 发布 / 事件，生成研发周报草稿，确认后写入云文档并发群。",
    tools: ["gitlab_list_mrs", "gitlab_list_pipelines", "read"],
    triggers: [
      { kind: "command", value: "/weekly-report" },
      { kind: "schedule", value: "每周五 17:00" },
    ],
    visible: true,
  },
  {
    id: "knowledge",
    name: "知识管家",
    subtitle: "云文档/wiki + insight",
    category: "办公",
    description: "把收敛的调研/讨论整理成纪要，沉淀到飞书云文档或知识库，可同步到群。",
    tools: ["read"],
    triggers: [
      { kind: "command", value: "/knowledge" },
      { kind: "event", value: "research_converged" },
    ],
    visible: true,
  },
  {
    id: "data",
    name: "数据助手",
    subtitle: "sheets/bitable + 本地文件",
    category: "数据",
    description: "把回答中的结构化数据或本地文件清洗结果，生成飞书电子表格 / 多维表格。",
    tools: ["read", "bash"],
    triggers: [
      { kind: "command", value: "/data" },
      { kind: "event", value: "data_detected" },
    ],
    visible: true,
  },
  {
    id: "polish",
    name: "邮件/公告润色",
    subtitle: "飞书消息/邮件草稿 + 本地文件",
    category: "办公",
    description: "把口语化草稿润色成正式邮件或全员公告，按收件对象调语气，可读取本地附件素材，确认后由桌面端发送。",
    tools: ["read", "bash"],
    triggers: [
      { kind: "command", value: "/polish" },
      { kind: "event", value: "draft_detected" },
    ],
    visible: false,
  },
  {
    id: "trip",
    name: "行程规划助理",
    subtitle: "飞书日历 + 本地文件",
    category: "办公",
    description: "根据出差/活动需求整理行程安排表（时间 / 地点 / 事项 / 提醒），确认后由桌面端写入飞书日历并同步相关人。",
    tools: ["read", "bash"],
    triggers: [
      { kind: "command", value: "/trip" },
      { kind: "event", value: "trip_requested" },
    ],
    visible: true,
  },
  {
    id: "minutes",
    name: "会议纪要速记",
    subtitle: "云文档 + 飞书群 + 本地转写文件",
    category: "办公",
    description: "把粘贴的讨论记录 / 本地转写文件整理成结构化会议纪要（结论 / 待办 / 负责人），确认后由桌面端归档到云文档并发群。",
    tools: ["read", "bash"],
    triggers: [
      { kind: "command", value: "/minutes" },
      { kind: "event", value: "meeting_ended" },
    ],
    visible: true,
  },
];
