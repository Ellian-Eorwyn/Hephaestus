// Centralized IPC channel names shared by main + preload.

export const IPC = {
  listHarnesses: 'harness:list',
  addHarness: 'harness:add',
  removeHarness: 'harness:remove',

  listProjects: 'session:listProjects',
  loadSession: 'session:load',
  getModels: 'harness:models',

  listFiles: 'file:list',
  readFile: 'file:read',
  watchProject: 'file:watch',

  browseFolder: 'dialog:browseFolder',
  addProject: 'session:addProject',
  removeProject: 'session:removeProject',

  checkBackend: 'backend:check',

  agentOpen: 'agent:open',
  agentSend: 'agent:send',
  agentAbort: 'agent:abort',
  agentClose: 'agent:close',
  agentListRuns: 'agent:listRuns',

  // main -> renderer events
  evtSessionUpdated: 'evt:sessionUpdated',
  evtAgentEvent: 'evt:agentEvent',
  evtProjectChanged: 'evt:projectChanged'
} as const
