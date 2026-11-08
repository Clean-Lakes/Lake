/** Pinned third-party public API boundary. Lake owns the host, not these APIs. */
export { builtInTools, AgentRuntime, ManualPermissionBroker, createToolRegistry,
  createExploreSubagentPort, InMemoryRuntimeTaskRegistry, createBuiltInGeneralPurposeAgentProfile,
  createBuiltInExploreAgentProfile, resolveProjectMemoryRoot,
  type ExploreSubagentRuntimeRequest, type ToolEntry, type ToolExecutionContext } from '@zcode/core';
export { InMemorySessionEventStore, modelDescriptorOf, getCurrentModelInvocationContext,
  type SessionStorePort, type Model, type SessionEvent as NativeSessionEvent, type SessionId, type ProjectId,
  type ExecutionPort, type ExecutionRequest, type ExecutionResult, type ExecutionRunOptions,
  type BackgroundExecutionSnapshot, type FileSystemPort, type HttpClientPort, type PermissionRuleset } from '@zcode/contracts';
export { AiSdkModelAdapter } from '@zcode/adapters/model';
// Public dependency pinned by the adapter manifest; used only through its
// runtime injection port to prevent the library's raw default error logging.
export {generateText as aiGenerateText, streamText as aiStreamText} from 'ai';
export { createNodeExecutionAdapter } from '@zcode/adapters/exec';
export { createNodeFileSystemAdapter } from '@zcode/adapters/fs';
export { createJimpImageProcessorAdapter } from '@zcode/adapters/image';
export { createPopplerPdfDocumentAdapter } from '@zcode/adapters/pdf';
export { createNodeWebFetchHttpClientAdapter } from '@zcode/adapters/http';
export { createSqliteSessionStore, createNodeToolArtifactStore } from '@zcode/adapters/storage';
export { ProviderConfig, ApiKeyAccessConfig, ProviderApiConfig, ModelConfig,
  type RegistryProviderConfig, type RegistryModelConfig } from '@zcode/provider';
