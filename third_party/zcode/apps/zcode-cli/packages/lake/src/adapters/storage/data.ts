import type { JsonValue } from "../../domain/json.js";
import type { Params } from "../../domain/validation.js";
import type { DataPort } from "../../app/ports.js";
import { LakeDatabase } from "./database.js";
import { CatalogRepository } from "./catalog.js";
import { HistoryRepository } from "./history.js";
import { ProjectsRepository } from "./projects.js";
import { MemoryRepository } from "./memory.js";
import { WorkflowRepository } from "./workflows.js";
import { WorkflowLibraryRepository } from "./workflow-library.js";

export class LakeData implements DataPort {
  private readonly catalog: CatalogRepository;
  private readonly history: HistoryRepository;
  private readonly projects: ProjectsRepository;
  private readonly memory: MemoryRepository;
  private readonly workflows: WorkflowRepository;
  private readonly library: WorkflowLibraryRepository;
  constructor(private readonly db: LakeDatabase) {
    this.catalog = new CatalogRepository(db);
    this.history = new HistoryRepository(db, this.catalog);
    this.projects = new ProjectsRepository(db, this.catalog);
    this.memory = new MemoryRepository(db, this.catalog);
    this.workflows = new WorkflowRepository(db, this.catalog);
    this.library = new WorkflowLibraryRepository(db, this.catalog);
  }
  async request(method: string, params: Params): Promise<JsonValue> {
    if (method.startsWith("conversation.") || method.startsWith("journal.")) return this.history.request(method, params);
    if (method.startsWith("code.")) return this.projects.request(method, params);
    if (method.startsWith("memory.")) return this.memory.request(method, params);
    if (method === "workflow.library") return this.library.request(params);
    if (method.startsWith("workflow.")) return this.workflows.request(method, params);
    return this.catalog.request(method, params);
  }
  close(): void { this.db.close(); }
}
