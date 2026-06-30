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

  checkBackend: 'backend:check',

  agentOpen: 'agent:open',
  agentSend: 'agent:send',
  agentAbort: 'agent:abort',
  agentClose: 'agent:close',

  // main -> renderer events
  evtSessionUpdated: 'evt:sessionUpdated',
  evtAgentEvent: 'evt:agentEvent'
} as const
