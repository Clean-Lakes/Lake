import type { JsonValue } from "../../domain/json.js";
import { text, type Params } from "../../domain/validation.js";
import type { DataPort } from "../../app/ports.js";
import { LakeDatabase, newID } from "./database.js";
import { CatalogRepository } from "./catalog.js";
import { HistoryRepository } from "./history.js";
import { ProjectsRepository } from "./projects.js";
import { MemoryRepository } from "./memory.js";
import { WorkflowRepository } from "./workflows.js";
import { WorkflowLibraryRepository } from "./workflow-library.js";
import { SummaryRepository } from "./summaries.js";
import { TasksRepository } from "./tasks.js";
import { ExtensionsRepository } from "./extensions.js";
import { ScriptsRepository } from "./scripts.js";
import { SchedulesRepository } from "./schedules.js";

export class LakeData implements DataPort {
  private readonly catalog: CatalogRepository;
  private readonly history: HistoryRepository;
  private readonly projects: ProjectsRepository;
  private readonly memory: MemoryRepository;
  private readonly workflows: WorkflowRepository;
  private readonly library: WorkflowLibraryRepository;
  private readonly summaries: SummaryRepository;
  private readonly tasks: TasksRepository;
  private readonly extensions: ExtensionsRepository;
  private readonly scripts: ScriptsRepository;
  private readonly schedules: SchedulesRepository;
  constructor(private readonly db: LakeDatabase) {
    this.catalog = new CatalogRepository(db);
    this.history = new HistoryRepository(db, this.catalog);
    this.projects = new ProjectsRepository(db, this.catalog);
    this.memory = new MemoryRepository(db, this.catalog);
    this.workflows = new WorkflowRepository(db, this.catalog);
    this.library = new WorkflowLibraryRepository(db, this.catalog);
    this.summaries = new SummaryRepository(db);
    this.tasks = new TasksRepository(db, this.catalog);
    this.extensions = new ExtensionsRepository(db);
    this.scripts = new ScriptsRepository(db, this.catalog);
    this.schedules = new SchedulesRepository(db, this.catalog);
  }
  async request(method: string, params: Params): Promise<JsonValue> {
    if (method.startsWith("script.")) return this.scripts.request(method, params);
    if (method.startsWith("code.")) return this.projects.request(method, params);
    const mutate = /\.(?:add|use|authorize|identity|set_credential|set|create|rename|archive|restore|edit|delete|save|amend|enable)$/u.test(method) && method !== "journal.append";
    if (!mutate) return this.route(method, params);
    return this.db.transaction(() => {
      const result = this.route(method, params), action = newID();
      this.db.run("INSERT INTO journal(ts,action_id,actor,target_path,tool,risk,event,detail) VALUES(?,?,'cli',?,?,'write','completed','metadata_change')", Date.now(), action, text(params, "resource", text(params, "lake", text(params, "id", method))), method);
      return result;
    });
  }
  private route(method: string, params: Params): JsonValue {
    if (method.startsWith("schedule.")) return this.schedules.request(method, params);
    if (["specialist.", "patrol.", "link."].some(prefix => method.startsWith(prefix))) return this.tasks.request(method, params);
    if (method.startsWith("plugin.") || method.startsWith("hook.")) return this.extensions.request(method, params);
    if (method === "conversation.summary" || method === "conversation.save_summary") return this.summaries.request(method, params);
    if (method.startsWith("conversation.") || method.startsWith("journal.")) return this.history.request(method, params);
    if (method.startsWith("memory.")) return this.memory.request(method, params);
    if (method === "workflow.library") return this.library.request(params);
    if (method.startsWith("workflow.")) return this.workflows.request(method, params);
    return this.catalog.request(method, params);
  }
  close(): void { this.db.close(); }
}
