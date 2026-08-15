// The public API, for anyone who wants to build on SessionVault.
export { AGENTS, getAgent, agentIds } from './registry.js';
export { scanAll, scanAgent } from './scan.js';
export { loadConfig, saveConfig, machineInfo, remoteKeys } from './config.js';
export { createBackend, BACKENDS } from './backends/index.js';
export { backup } from './commands/backup.js';
export { restore } from './commands/restore.js';
export { TarPack, tarEntries } from './tar.js';
