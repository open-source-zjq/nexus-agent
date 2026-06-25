import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteFile } from "./atomic-write.js";
import {
  AgentDefinitionSchema,
  SEED_AGENTS,
  type AgentDefinition,
  type AgentCreateInput,
  type AgentUpdateInput,
} from "../../contracts/agents.js";

/**
 * File-backed agent directory (智能体目录). Persists the scenario-agent catalog
 * to `<dataDir>/agents.json`, seeded on first run with the original Nexus
 * preset catalog. CRUD is serialized through a single in-flight promise so
 * concurrent writes never interleave. Never throws on a read; a corrupt file is
 * re-seeded.
 */
export class AgentDirectoryStore {
  private readonly path: string;
  private cache: AgentDefinition[] | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(options: { dataDir: string }) {
    this.path = join(options.dataDir, "agents.json");
  }

  /** All agents, newest-relevant order preserved (seed order, then created order). */
  async list(): Promise<AgentDefinition[]> {
    const agents = await this.load();
    return agents.map((agent) => ({ ...agent }));
  }

  async get(id: string): Promise<AgentDefinition | undefined> {
    const agents = await this.load();
    const found = agents.find((agent) => agent.id === id);
    return found ? { ...found } : undefined;
  }

  /** Create a new agent from a validated request; assigns a stable unique id. */
  async create(input: AgentCreateInput): Promise<AgentDefinition> {
    const agents = await this.load();
    const now = new Date().toISOString();
    const agent: AgentDefinition = AgentDefinitionSchema.parse({
      id: this.uniqueId(input.name, agents),
      name: input.name,
      subtitle: input.subtitle ?? "",
      category: input.category ?? "研发",
      description: input.description ?? "",
      tools: input.tools ?? [],
      triggers: input.triggers ?? [],
      visible: input.visible ?? true,
      createdAt: now,
      updatedAt: now,
    });
    agents.push(agent);
    await this.persist(agents);
    return { ...agent };
  }

  /** Patch an existing agent; throws "agent not found" when the id is unknown. */
  async update(id: string, patch: AgentUpdateInput): Promise<AgentDefinition> {
    const agents = await this.load();
    const index = agents.findIndex((agent) => agent.id === id);
    if (index === -1) throw new Error(`agent not found: ${id}`);
    const current = agents[index];
    const next: AgentDefinition = AgentDefinitionSchema.parse({
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.subtitle !== undefined ? { subtitle: patch.subtitle } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.tools !== undefined ? { tools: patch.tools } : {}),
      ...(patch.triggers !== undefined ? { triggers: patch.triggers } : {}),
      ...(patch.visible !== undefined ? { visible: patch.visible } : {}),
      updatedAt: new Date().toISOString(),
    });
    agents[index] = next;
    await this.persist(agents);
    return { ...next };
  }

  /** Remove an agent; throws "agent not found" when the id is unknown. */
  async delete(id: string): Promise<AgentDefinition> {
    const agents = await this.load();
    const index = agents.findIndex((agent) => agent.id === id);
    if (index === -1) throw new Error(`agent not found: ${id}`);
    const [removed] = agents.splice(index, 1);
    await this.persist(agents);
    return { ...removed };
  }

  /** Load (and lazily seed) the directory, caching the parsed catalog. */
  private async load(): Promise<AgentDefinition[]> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      const list = Array.isArray(parsed) ? parsed : (parsed as { agents?: unknown[] })?.agents;
      const agents = Array.isArray(list)
        ? list.flatMap((entry) => {
            const result = AgentDefinitionSchema.safeParse(entry);
            return result.success ? [result.data] : [];
          })
        : [];
      this.cache = agents;
      return this.cache;
    } catch {
      // Missing or corrupt file → seed the original catalog and persist it.
      const now = new Date().toISOString();
      const seeded = SEED_AGENTS.map((agent) => AgentDefinitionSchema.parse({ ...agent, createdAt: now, updatedAt: now }));
      this.cache = seeded;
      await this.persist(seeded);
      return this.cache;
    }
  }

  /** Atomically write the catalog, serialized behind any in-flight write. */
  private async persist(agents: AgentDefinition[]): Promise<void> {
    this.cache = agents;
    const write = this.writing.then(() => atomicWriteFile(this.path, JSON.stringify(agents, null, 2)));
    // Keep the chain alive even if a write rejects, so later writes still run.
    this.writing = write.catch(() => undefined);
    await write;
  }

  /** Slugify the name into a stable id, disambiguating against existing ids. */
  private uniqueId(name: string, existing: AgentDefinition[]): string {
    const base =
      name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "agent";
    const taken = new Set(existing.map((agent) => agent.id));
    if (!taken.has(base)) return base;
    return `${base}-${randomUUID().slice(0, 8)}`;
  }
}
