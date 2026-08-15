// The registry of AI agents and the places they keep session history.
//
// Path templates understand these tokens:
//   ~              the home directory
//   {config}       XDG config   — mac ~/Library/Application Support, win %APPDATA%
//   {data}         XDG data     — mac ~/Library/Application Support, win %LOCALAPPDATA%
//   {appSupport}   mac ~/Library/Application Support, win %APPDATA%, linux ~/.config
//   {cache}        cache root
//   *  and  **     glob segments
//
// A source entry:
//   { path, sqlite?, heavy?, include?, exclude?, note? }
//     sqlite  the file is a live database. Copy it with a real SQLite backup.
//     heavy   the file is large and changes on every run. Upload it on an
//             interval (see heavyIntervalHours) instead of every run.
//
// A path that does not exist is skipped without an error. This is why the
// registry can list tools you have never installed.

// Editors built on VS Code. Each keeps chat state in the same layout.
export const VSCODE_FAMILY = [
  { id: 'vscode', name: 'VS Code', dir: 'Code' },
  { id: 'vscode-insiders', name: 'VS Code Insiders', dir: 'Code - Insiders' },
  { id: 'vscodium', name: 'VSCodium', dir: 'VSCodium' },
  { id: 'cursor', name: 'Cursor', dir: 'Cursor' },
  { id: 'windsurf', name: 'Windsurf', dir: 'Windsurf' },
  { id: 'trae', name: 'Trae', dir: 'Trae' },
  { id: 'kiro', name: 'Kiro', dir: 'Kiro' },
  { id: 'antigravity-editor', name: 'Antigravity (editor)', dir: 'Antigravity' },
  { id: 'positron', name: 'Positron', dir: 'Positron' },
  { id: 'pearai', name: 'PearAI', dir: 'PearAI' },
  { id: 'void', name: 'Void', dir: 'Void' },
  { id: 'firebase-studio', name: 'Firebase Studio', dir: 'FirebaseStudio' },
];

// Agent extensions that store their transcripts inside an editor's
// globalStorage folder. One entry covers every editor in VSCODE_FAMILY.
export const VSCODE_AGENT_EXTENSIONS = [
  { id: 'cline', name: 'Cline', ext: 'saoudrizwan.claude-dev' },
  { id: 'roo-code', name: 'Roo Code', ext: 'rooveterinaryinc.roo-cline' },
  { id: 'kilo-code', name: 'Kilo Code', ext: 'kilocode.kilo-code' },
  { id: 'continue', name: 'Continue', ext: 'continue.continue' },
  { id: 'copilot-chat', name: 'GitHub Copilot Chat', ext: 'github.copilot-chat' },
  { id: 'cody', name: 'Sourcegraph Cody', ext: 'sourcegraph.cody-ai' },
  { id: 'amp-vscode', name: 'Amp (editor)', ext: 'sourcegraph.amp' },
  { id: 'augment', name: 'Augment', ext: 'augment.vscode-augment' },
  { id: 'gemini-code-assist', name: 'Gemini Code Assist', ext: 'google.geminicodeassist' },
  { id: 'codeium', name: 'Codeium', ext: 'codeium.codeium' },
  { id: 'tabnine', name: 'Tabnine', ext: 'tabnine.tabnine-vscode' },
  { id: 'aide', name: 'Aide', ext: 'codestory-ghost.codestoryai' },
  { id: 'claude-code-vscode', name: 'Claude Code for VS Code', ext: 'anthropic.claude-code' },
  { id: 'openai-codex-vscode', name: 'Codex for VS Code', ext: 'openai.chatgpt' },
];

// Files that must never leave the machine, whatever folder they sit in.
// SessionVault archives conversation history, not credentials.
export const GLOBAL_DENY = [
  '**/oauth_creds.json',
  '**/auth.json',
  '**/.credentials.json',
  '**/credentials',
  '**/credentials.json',
  '**/token.json',
  '**/tokens.json',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa*',
  '**/Cookies',
  '**/Cookies-journal',
  '**/Network/**',
  '**/Local Storage/**',
  '**/Session Storage/**',
  '**/IndexedDB/**',
  '**/Service Worker/**',
  '**/Partitions/**',
  '**/node_modules/**',
  '**/.git/**',
  '**/Cache/**',
  '**/CachedData/**',
  '**/Code Cache/**',
  '**/GPUCache/**',
  '**/blob_storage/**',
  '**/*.log.gz',
];

const cliAgents = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    vendor: 'Anthropic',
    kind: 'cli',
    sources: [
      { path: '~/.claude/projects', exclude: ['**/image-cache/**', '**/downloads/**'] },
      { path: '~/.claude/history.jsonl' },
      { path: '~/.claude/todos' },
      { path: '~/.claude/tasks' },
      { path: '~/.claude/sessions' },
      { path: '~/.claude/settings.json', config: true },
      { path: '~/.claude/CLAUDE.md', config: true },
      { path: '~/.claude/agents', config: true },
      { path: '~/.claude/commands', config: true },
      { path: '~/.claude/rules', config: true },
      { path: '~/.claude/skills', config: true },
      { path: '~/.claude.json', config: true },
    ],
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    vendor: 'OpenAI',
    kind: 'cli',
    sources: [
      { path: '~/.codex/sessions' },
      { path: '~/.codex/history.jsonl' },
      { path: '~/.codex/memories' },
      { path: '~/.codex/archived_sessions' },
      { path: '~/.codex/memories_1.sqlite', sqlite: true },
      { path: '~/.codex/state_5.sqlite', sqlite: true },
      { path: '~/.codex/goals_1.sqlite', sqlite: true },
      { path: '~/.codex/queue_1.sqlite', sqlite: true },
      { path: '~/.codex/config.toml', config: true },
      { path: '~/.codex/AGENTS.md', config: true },
      { path: '~/.codex/rules', config: true },
      { path: '~/.codex/prompts', config: true },
    ],
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    vendor: 'Google',
    kind: 'cli',
    sources: [
      { path: '~/.gemini/tmp', include: ['**/*.json', '**/*.jsonl', '**/*.md'] },
      { path: '~/.gemini/history' },
      { path: '~/.gemini/chats' },
      { path: '~/.gemini/sessions' },
      { path: '~/.gemini/projects.json' },
      { path: '~/.gemini/settings.json', config: true },
      { path: '~/.gemini/GEMINI.md', config: true },
      { path: '~/.gemini/commands', config: true },
    ],
  },
  {
    id: 'antigravity',
    name: 'Antigravity (agent data)',
    vendor: 'Google',
    kind: 'ide',
    sources: [
      { path: '~/.gemini/antigravity/conversations' },
      { path: '~/.gemini/antigravity/brain' },
      { path: '~/.gemini/antigravity/context_state' },
      { path: '~/.gemini/antigravity/implicit' },
      { path: '~/.gemini/antigravity/code_tracker' },
      { path: '~/.gemini/antigravity/mcp_config.json', config: true },
    ],
  },
  {
    id: 'cursor-cli',
    name: 'Cursor CLI / agents',
    vendor: 'Anysphere',
    kind: 'cli',
    sources: [
      { path: '~/.cursor/projects' },
      { path: '~/.cursor/agents' },
      { path: '~/.cursor/chats' },
      { path: '~/.cursor/ai-tracking' },
      { path: '~/.cursor/cli-history' },
      { path: '~/.cursor/rules', config: true },
      { path: '~/.cursor/mcp.json', config: true },
    ],
  },
  {
    id: 'copilot-cli',
    name: 'GitHub Copilot CLI',
    vendor: 'GitHub',
    kind: 'cli',
    sources: [
      { path: '~/.copilot/history-session-state' },
      { path: '~/.copilot/session-state' },
      { path: '~/.copilot/logs' },
      { path: '~/.copilot/skills', config: true },
      { path: '{config}/github-copilot', exclude: ['**/apps.json', '**/hosts.json'] },
    ],
  },
  {
    id: 'aider',
    name: 'Aider',
    vendor: 'Aider',
    kind: 'cli',
    sources: [
      { path: '~/.aider' },
      { path: '~/.aider.chat.history.md' },
      { path: '~/.aider.input.history' },
      { path: '{cache}/aider' },
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    vendor: 'SST',
    kind: 'cli',
    sources: [
      { path: '{data}/opencode/storage' },
      { path: '{data}/opencode/project' },
      { path: '{data}/opencode/log', optional: true },
      { path: '~/.opencode' },
      { path: '{config}/opencode', config: true },
    ],
  },
  {
    id: 'goose',
    name: 'Goose',
    vendor: 'Block',
    kind: 'cli',
    sources: [
      { path: '{data}/goose/sessions' },
      { path: '{config}/goose/sessions' },
      { path: '{config}/goose/memory' },
      { path: '{config}/goose/config.yaml', config: true },
    ],
  },
  {
    id: 'amp',
    name: 'Amp',
    vendor: 'Sourcegraph',
    kind: 'cli',
    sources: [
      { path: '~/.amp' },
      { path: '{config}/amp' },
      { path: '{data}/amp' },
      { path: '{cache}/amp/threads' },
    ],
  },
  {
    id: 'droid',
    name: 'Droid',
    vendor: 'Factory',
    kind: 'cli',
    sources: [
      { path: '~/.factory/sessions' },
      { path: '~/.factory/history' },
      { path: '~/.factory/logs' },
      { path: '~/.factory/settings.json', config: true },
      { path: '~/.droid' },
    ],
  },
  {
    id: 'crush',
    name: 'Crush',
    vendor: 'Charm',
    kind: 'cli',
    sources: [
      { path: '{data}/crush' },
      { path: '~/.crush' },
      { path: '{config}/crush', config: true },
    ],
  },
  {
    id: 'amazon-q',
    name: 'Amazon Q Developer',
    vendor: 'AWS',
    kind: 'cli',
    sources: [
      { path: '{data}/amazon-q' },
      { path: '~/.aws/amazonq/history', sqlite: true },
      { path: '~/.aws/amazonq/cli-agents' },
      { path: '~/.aws/amazonq/profiles' },
      { path: '~/.aws/amazonq/data.sqlite3', sqlite: true },
    ],
  },
  {
    id: 'qwen-code',
    name: 'Qwen Code',
    vendor: 'Alibaba',
    kind: 'cli',
    sources: [
      { path: '~/.qwen/tmp', include: ['**/*.json', '**/*.jsonl', '**/*.md'] },
      { path: '~/.qwen/history' },
      { path: '~/.qwen/chats' },
      { path: '~/.qwen/settings.json', config: true },
    ],
  },
  {
    id: 'openhands',
    name: 'OpenHands',
    vendor: 'All Hands AI',
    kind: 'cli',
    sources: [
      { path: '~/.openhands/sessions' },
      { path: '~/.openhands/conversations' },
      { path: '{data}/openhands' },
    ],
  },
  {
    id: 'codebuff',
    name: 'Codebuff',
    vendor: 'Codebuff',
    kind: 'cli',
    sources: [{ path: '~/.codebuff' }, { path: '{config}/manicode' }],
  },
  {
    id: 'shell-gpt',
    name: 'ShellGPT',
    vendor: 'Community',
    kind: 'cli',
    sources: [{ path: '{cache}/shell_gpt' }, { path: '{config}/shell_gpt', config: true }],
  },
  {
    id: 'open-interpreter',
    name: 'Open Interpreter',
    vendor: 'Open Interpreter',
    kind: 'cli',
    sources: [
      { path: '{config}/Open Interpreter/conversations' },
      { path: '{config}/Open Interpreter Terminal/conversations' },
    ],
  },
  {
    id: 'warp',
    name: 'Warp',
    vendor: 'Warp',
    kind: 'terminal',
    sources: [
      { path: '{appSupport}/dev.warp.Warp-Stable/warp.sqlite', sqlite: true, heavy: true },
      { path: '{data}/warp-terminal/warp.sqlite', sqlite: true, heavy: true },
      { path: '{appSupport}/dev.warp.Warp-Stable/mcp', config: true },
    ],
  },
  {
    id: 'zed',
    name: 'Zed',
    vendor: 'Zed Industries',
    kind: 'ide',
    sources: [
      { path: '{appSupport}/Zed/db/*/db.sqlite', sqlite: true, heavy: true },
      { path: '{appSupport}/Zed/threads', optional: true },
      { path: '{appSupport}/Zed/conversations', optional: true },
      { path: '{data}/zed/db/*/db.sqlite', sqlite: true, heavy: true },
      { path: '{data}/zed/threads', optional: true },
      { path: '{config}/zed/settings.json', config: true },
    ],
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    vendor: 'Anthropic',
    kind: 'desktop',
    note: 'Conversations live on the server. Only local config and logs are archived.',
    sources: [
      { path: '{appSupport}/Claude/claude_desktop_config.json', config: true },
      { path: '{appSupport}/Claude/logs', optional: true },
    ],
  },
  {
    id: 'jetbrains-ai',
    name: 'JetBrains AI Assistant / Junie',
    vendor: 'JetBrains',
    kind: 'ide',
    sources: [
      { path: '{appSupport}/JetBrains/*/options/aiAssistant*.xml' },
      { path: '{appSupport}/JetBrains/*/llm' },
      { path: '{appSupport}/JetBrains/*/junie' },
      { path: '{config}/JetBrains/*/llm' },
      { path: '{config}/JetBrains/*/junie' },
    ],
  },
  {
    id: 'windsurf-plugin',
    name: 'Windsurf / Codeium plugin',
    vendor: 'Codeium',
    kind: 'plugin',
    sources: [
      { path: '~/.codeium/windsurf/cascade' },
      { path: '~/.codeium/windsurf/memories' },
      { path: '~/.codeium/database', optional: true },
    ],
  },
];

/** Build the source list for the editors in VSCODE_FAMILY. */
function editorAgents() {
  const roots = ['{appSupport}/%DIR%', '{config}/%DIR%'];
  return VSCODE_FAMILY.map((editor) => {
    const sources = [];
    for (const root of roots) {
      const base = root.replace('%DIR%', editor.dir);
      // The editor's own chat and agent state.
      sources.push({ path: `${base}/User/globalStorage/state.vscdb`, sqlite: true, heavy: true });
      sources.push({ path: `${base}/User/workspaceStorage/*/state.vscdb`, sqlite: true });
      sources.push({ path: `${base}/User/workspaceStorage/*/workspace.json` });
      sources.push({ path: `${base}/User/workspaceStorage/*/chatSessions` });
      sources.push({ path: `${base}/User/workspaceStorage/*/chatEditingSessions` });
      sources.push({ path: `${base}/User/globalStorage/chatSessions` });
      // Every known agent extension inside this editor.
      for (const extension of VSCODE_AGENT_EXTENSIONS) {
        sources.push({
          path: `${base}/User/globalStorage/${extension.ext}`,
          exclude: ['**/cache/**', '**/checkpoints/**'],
        });
      }
    }
    return {
      id: editor.id,
      name: editor.name,
      vendor: 'editor',
      kind: 'ide',
      sources,
    };
  });
}

const standaloneExtensionAgents = [
  {
    id: 'continue-cli',
    name: 'Continue (home folder)',
    vendor: 'Continue',
    kind: 'plugin',
    sources: [
      { path: '~/.continue/sessions' },
      { path: '~/.continue/dev_data' },
      { path: '~/.continue/config.json', config: true },
      { path: '~/.continue/config.yaml', config: true },
    ],
  },
  {
    id: 'cline-home',
    name: 'Cline (home folder)',
    vendor: 'Cline',
    kind: 'plugin',
    sources: [{ path: '~/.cline' }, { path: '~/Documents/Cline/Rules', config: true }],
  },
];

export const AGENTS = [...cliAgents, ...editorAgents(), ...standaloneExtensionAgents];

const duplicateIds = AGENTS.map((agent) => agent.id).filter(
  (id, index, all) => all.indexOf(id) !== index,
);
if (duplicateIds.length > 0) {
  throw new Error(`the registry has duplicate agent ids: ${[...new Set(duplicateIds)].join(', ')}`);
}

export function getAgent(id) {
  return AGENTS.find((agent) => agent.id === id);
}

export function agentIds() {
  return AGENTS.map((agent) => agent.id);
}
