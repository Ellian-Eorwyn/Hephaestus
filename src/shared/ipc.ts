// Centralized IPC channel names shared by main + preload.

export const IPC = {
  listHarnesses: 'harness:list',
  addHarness: 'harness:add',
  removeHarness: 'harness:remove',
  getHarnessPresets: 'harness:presets',
  installHarness: 'harness:install',

  listProjects: 'session:listProjects',
  loadSession: 'session:load',
  getModels: 'harness:models',

  listFiles: 'file:list',
  listDir: 'file:listDir',
  indexPaths: 'file:indexPaths',
  readFile: 'file:read',
  watchProject: 'file:watch',

  openExternal: 'shell:openExternal',

  browseFolder: 'dialog:browseFolder',
  addProject: 'session:addProject',
  removeProject: 'session:removeProject',

  checkBackend: 'backend:check',

  getStackConfig: 'stack:getConfig',
  setStackConfig: 'stack:setConfig',
  probeStack: 'stack:probe',

  agentOpen: 'agent:open',
  agentSend: 'agent:send',
  agentRespond: 'agent:respond',
  agentAbort: 'agent:abort',
  agentAbortRetry: 'agent:abortRetry',
  agentClose: 'agent:close',
  agentListRuns: 'agent:listRuns',

  // main -> renderer events
  evtSessionUpdated: 'evt:sessionUpdated',
  evtAgentBatch: 'evt:agentBatch',
  evtProjectChanged: 'evt:projectChanged',
  evtInstallProgress: 'evt:installProgress',
  evtStackStatus: 'evt:stackStatus'
} as const
