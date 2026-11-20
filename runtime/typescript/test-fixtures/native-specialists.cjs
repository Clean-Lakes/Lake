const {createHash} = require('node:crypto');

// Existing SDK and ledger tests exercise native Workers against a local fake
// model. Keep this fixture out of production and opt out in Codex-policy tests.
exports.enableNativeSpecialistFixture = host => {
  const currentExecution = host.roleExecution.bind(host);
  host.roleExecution = (role, freezeModel) => role.execution?.kind === 'native'
    ? structuredClone(role.execution) : currentExecution(role, freezeModel);

  const requireExecution = host.requireSpecialistExecution.bind(host);
  host.requireSpecialistExecution = (execution, status) => {
    if (execution?.kind !== 'native') requireExecution(execution, status);
  };

  const backend = host.roleBackend.bind(host);
  host.roleBackend = (project, value, allowRevision) => {
    if (value?.kind !== 'native' || Object.keys(value).some(key => !['kind', 'model'].includes(key)))
      return backend(project, value, allowRevision);
    return structuredClone(value);
  };

  const freeze = host.freezeRoleExecution.bind(host);
  host.freezeRoleExecution = role => role.execution?.kind === 'native'
    ? {...role, execution: structuredClone(role.execution)} : freeze(role);

  const options = host.executionOptions.bind(host);
  host.executionOptions = (project, kind) => {
    const native = kind === 'acp' ? [] : host.store.modelProviders().filter(provider => provider.enabled).flatMap(provider =>
      provider.models.filter(model => model.enabled && !model.supportsImageOutput).map(model => {
        const execution = {kind: 'native', model: {providerId: provider.id, modelId: model.id}};
        const id = createHash('sha256').update(JSON.stringify(execution)).digest('hex');
        return {id, agentName: 'Lake 原生', modelName: model.name, execution};
      }));
    return [...native, ...(kind === 'native' ? [] : options(project, kind))].sort((a, b) => a.id.localeCompare(b.id));
  };
};
