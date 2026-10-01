export {}

type LakeDesktopAPI = {
  ListLakes(): Promise<string>
  CurrentLake(): Promise<string>
  ListModels(): Promise<string>
  Settings(payload: string): Promise<string>
  ExtensionStatus(projectPath: string): Promise<string>
  SetPluginEnabled(name: string, enabled: boolean): Promise<string>
  SetWorkspaceHookEnabled(projectPath: string, enabled: boolean): Promise<string>
  GetPermissions(): Promise<string>
  SetPermission(key: string, enabled: boolean): Promise<string>
  UseModel(model: string): Promise<void>
  ListResources(lake: string): Promise<string>
  ListAllResources(): Promise<string>
  PickKubeconfigFile(): Promise<string>
  ListKubeContexts(path: string): Promise<string>
  AddK8sResource(lake: string, name: string, path: string, contextName: string, namespace: string): Promise<string>
  AddDatabaseResource(lake: string, name: string, kind: string, host: string, port: number, username: string, database: string, tlsMode: string, password: string): Promise<string>
  ListCodeProjects(): Promise<string>
  ListProjectFiles(projectID: string): Promise<string>
  ReadProjectFile(projectID: string, relative: string): Promise<string>
  GitOverview(projectID: string): Promise<string>
  GitDiff(projectID: string, relative: string): Promise<string>
  TaskTerminalStatus(conversationID: string): Promise<string>
  CloseTaskTerminal(conversationID: string): Promise<void>
  RunTaskCommand(conversationID: string, command: string): Promise<string>
  RunProposedCommand(proposalID: string): Promise<string>
  DeclineProposedCommand(proposalID: string): Promise<void>
  TakeCommandControl(proposalID: string): Promise<void>
  ReturnCommandControl(proposalID: string, sequence: number): Promise<void>
  AskWithExecutions(id: string, prompt: string, sequences: number[], images: { name?: string; mime_type: string; data: string }[]): Promise<void>
  OpenTerminal(projectID: string): Promise<string>
  RunTerminal(sessionID: string, command: string): Promise<string>
  CloseTerminal(sessionID: string): Promise<void>
  WorkflowV2Manage(payload: string): Promise<string>
  WorkflowLibrary(payload: string): Promise<string>
  ListSpecialistTasks(): Promise<string>
  RunWorkflowV2(id: string, prompt: string, request: { definition_id?: string; run_id?: string; project_id?: string; retry_writes: boolean }): Promise<void>
  ResumeSpecialist(id: string, prompt: string, taskID: string, retryWrites: boolean): Promise<void>
  ListWorkflows(): Promise<string>
  ListWorkflowRuns(lake: string): Promise<string>
  GetWorkflowRun(id: string): Promise<string>
  PickCodeProjectDirectory(): Promise<string>
  PickVideoFrames(count: number): Promise<string>
  PickPDFPreview(): Promise<string>
  AddCodeProject(lake: string, path: string): Promise<string>
  BindConversationProject(conversationID: string, projectID: string): Promise<string>
  ListRemoteCodeWorkspaces(): Promise<string>
  AddRemoteCodeWorkspace(lake: string, name: string, resource: string, root: string): Promise<string>
  AuthorizeRemoteCodeWorkspace(id: string, enabled: boolean): Promise<string>
  BindConversationRemoteCodeWorkspace(conversationID: string, workspaceID: string): Promise<string>
  ListRemoteCodeFiles(id: string): Promise<string>
  ReadRemoteCodeFile(id: string, relative: string): Promise<string>
  WriteRemoteCodeFile(id: string, relative: string, expectedSHA: string, content: string): Promise<string>
  RunRemoteCodeCommand(id: string, command: string): Promise<string>
  ListConversations(): Promise<string>
  ListArchivedConversations(): Promise<string>
  CreateConversation(lake: string): Promise<string>
  GetConversation(id: string): Promise<string>
  GetMemory(): Promise<string>
  SetMemoryEnabled(enabled: boolean): Promise<string>
  DeleteMemory(id: string): Promise<string>
  RenameConversation(id: string, title: string): Promise<string>
  ArchiveConversation(id: string): Promise<void>
  RestoreConversation(id: string): Promise<void>
  UseLake(lake: string): Promise<void>
  AuthorizeResource(path: string, allow: boolean): Promise<void>
  StartConversation(id: string): Promise<void>
  StopConversation(): Promise<void>
  Ask(id: string, prompt: string): Promise<void>
  ReformatResult(id: string, prompt: string): Promise<void>
  UIAction(id: string, action: { surfaceId: string; sourceComponentId: string; name: string; context: Record<string, unknown>; revision: number }): Promise<void>
  RunWorkflow(id: string, prompt: string, request: { name: string; resource?: string; targets?: string[]; bindings?: Record<string, string> }): Promise<void>
  AskWithImages(id: string, prompt: string, images: { name?: string; mime_type: string; data: string }[]): Promise<void>
  Approve(id: string, approved: boolean): Promise<void>
  AnswerQuestion(id: string, questionID: string, answers: Record<string, string>): Promise<void>
  SaveDownload(filename: string, mimeType: string, base64Data: string): Promise<string>
}

declare global {
  interface Window {
    go?: { main?: { App?: LakeDesktopAPI } }
    runtime?: { EventsOn(name: string, listener: (value: any) => void): () => void }
  }
}
