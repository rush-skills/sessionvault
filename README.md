# SessionVault

[![CI](https://github.com/rush-skills/sessionvault/actions/workflows/ci.yml/badge.svg)](https://github.com/rush-skills/sessionvault/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%E2%89%A518.17-brightgreen)](https://nodejs.org)
[![licence](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)
[![dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)](package.json)

Back up the session history of every AI coding agent on your machine to Cloudflare R2.

Claude Code, Codex, Cursor, Gemini CLI, Copilot, Cline, Windsurf and 30 more tools keep
your transcripts on local disk. Each one prunes that history on its own schedule. When a
client purges a folder, the record of how you built something goes with it.

SessionVault copies that history to a bucket you own, adds only what changed, and never
deletes. Every machine writes into the same bucket under its own name, so you can gather
years of work from every laptop in one place.

```
$ sessionvault backup

SessionVault backup  run 20260815T011121Z-838f37
machine macbook-air-3d62bb   backend wrangler   bucket ai-sessions

› Scanning for agent history…
  • Claude Code                     4122 files     930MB
  • Cursor                           179 files     282MB
  • Codex CLI                         50 files     155MB
  • VS Code                          124 files      82MB
  • Antigravity                      201 files      71MB
  … 9 more
  14 agents, 5903 files, 1.5GB on disk

› 25 new or changed, 5878 unchanged, 0 gone from disk
✓ Packed 25 files into 1 part: 17MB → 9.7MB
✓ Uploaded 9.7MB in 1 object.
✓ Backup finished in 20s.
```

## Install

One command. It needs Node 18 or later, and nothing else.

```bash
npm install -g github:rush-skills/sessionvault
```

Or run it without an install:

```bash
npx github:rush-skills/sessionvault init
```

The package is not on the npm registry yet. When it is, `npm install -g sessionvault`
will work as well, and the installer scripts will use it:

```bash
# macOS and Linux
curl -fsSL https://raw.githubusercontent.com/rush-skills/sessionvault/main/install.sh | sh

# Windows
irm https://raw.githubusercontent.com/rush-skills/sessionvault/main/install.ps1 | iex
```

## Set it up

```bash
wrangler login        # once per machine, if you do not have a Cloudflare login yet
sessionvault init
```

`init` finds your agents, creates the bucket, writes the config, runs the first backup and
offers to repeat it every two hours. It asks nothing that it can work out on its own.

To set up a second machine, run three commands:

```bash
npm install -g github:rush-skills/sessionvault
wrangler login
sessionvault init --bucket ai-sessions --yes
```

The second machine picks its own name from its hostname. The two archives sit side by side
and never overwrite each other.

## Commands

| Command | What it does |
| --- | --- |
| `sessionvault init` | Guided setup: bucket, config, first backup, schedule |
| `sessionvault backup` | Send new and changed history |
| `sessionvault status` | Show the local state and what the bucket holds |
| `sessionvault agents` | List the agents found on this machine |
| `sessionvault known` | List all 37 agents SessionVault can find |
| `sessionvault machines` | List every machine that writes to this bucket |
| `sessionvault restore --to DIR` | Rebuild an archive into a folder |
| `sessionvault schedule install` | Repeat the backup automatically |
| `sessionvault doctor` | Check that the setup works |
| `sessionvault config` | Show or change the config |

Useful flags:

```bash
sessionvault backup --dry-run             # show what would go, send nothing
sessionvault backup --only claude-code    # one agent
sessionvault backup --full                # ignore the local state, send everything
sessionvault restore --machine desktop-a1b2c3 --to ./from-desktop
sessionvault schedule install --every 60  # minutes
```

## What it backs up

SessionVault knows 37 agents. It skips any that you do not have.

**Command line agents**
Claude Code · Codex CLI · Gemini CLI · GitHub Copilot CLI · Cursor CLI · Aider · OpenCode ·
Goose · Amp · Droid (Factory) · Crush · Amazon Q Developer · Qwen Code · OpenHands ·
Codebuff · ShellGPT · Open Interpreter

**Editors and desktop apps**
Cursor · VS Code · VS Code Insiders · VSCodium · Windsurf · Trae · Kiro · Antigravity ·
Positron · PearAI · Void · Firebase Studio · Zed · Warp · Claude Desktop · JetBrains AI
Assistant and Junie

**Editor extensions** (in any of the editors above)
Cline · Roo Code · Kilo Code · Continue · Copilot Chat · Cody · Amp · Augment ·
Gemini Code Assist · Codeium · Tabnine · Aide · Claude Code for VS Code · Codex for VS Code

Run `sessionvault agents` to see what is on your machine, and `sessionvault known` for the
full list.

### It does not back up credentials

SessionVault archives conversations, not secrets. A deny list blocks `auth.json`,
`oauth_creds.json`, `credentials*`, `*.pem`, `*.key`, browser cookies and local storage,
wherever they sit. A test proves that no credential file reaches the archive.

Transcripts are a different matter. If you pasted a password into a chat, that password is
in a transcript. Turn on encryption when you set up:

```bash
export SESSIONVAULT_PASSPHRASE='…'
sessionvault config set encrypt true
```

Each bundle then gets AES-256-GCM with a scrypt key before it leaves the machine. Keep the
passphrase. Without it the archive cannot be read.

## How it works

1. **Scan.** Each agent has a list of paths. Missing paths are skipped.
2. **Compare.** A local state file records the size and the modified time of every archived
   file. Only new and changed files go.
3. **Pack.** The chosen files go into `tar.gz` parts, each under 240 MB. Any standard `tar`
   can open them.
4. **Upload.** Each part becomes one object. A manifest and an index object go with it.

A live SQLite database — Cursor, Zed, Warp and the VS Code family keep chat in one — is
never copied byte for byte while it is open. SessionVault runs `VACUUM INTO` through
`node:sqlite` to get a consistent file. On Node 18 and 20, which have no `node:sqlite`, it
copies the database with its `-wal` and `-shm` sidecars instead, which stays restorable.

A large database that changes on every run is uploaded once a day, not every run. Change
that with `heavyIntervalHours`.

### Layout in the bucket

```
sessionvault/v1/
  machines.json                       every machine that writes here
  machines/<machine-id>/
    machine.json                      hostname, platform, architecture
    index.json                        every run, and the parts it produced
    manifests/<run-id>.json           every file in that run, with its hash
    bundles/<run-id>.part001.tar.gz   the data
```

Nothing is ever deleted. A file that an agent purges stays in the bucket.

## Restore

```bash
sessionvault restore --to ./archive
```

Runs are applied oldest first, so the newest copy of each file wins. Nothing is written
back into a live agent folder: the target is a plain directory that you name.

To read one bundle without the tool:

```bash
wrangler r2 object get ai-sessions/sessionvault/v1/machines/<id>/bundles/<run>.part001.tar.gz \
  --file part1.tar.gz --remote
tar -xzf part1.tar.gz
```

## Backends

| Backend | Setup | Notes |
| --- | --- | --- |
| `wrangler` (default) | `wrangler login` | No keys to manage. Reuses your Cloudflare login. |
| `s3` | An R2 access key pair | Faster, can list a bucket, handles larger objects. |
| `local` | A folder path | An external disk, a network share, or a test. |

The `s3` backend reads `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` from the environment,
or from the config file.

## Cost

R2 charges for storage and for operations, not for reading data out.

SessionVault uploads a few large objects, not thousands of small ones. A first backup of
1.5 GB compresses to about 635 MB and costs 7 write operations. A later run usually costs
one or two. At the R2 price of $0.015 per GB per month, a 1 GB archive costs about 18 cents
a year. The R2 free tier covers 10 GB.

## Configuration

`sessionvault config` prints the file. It sits at `~/.config/sessionvault/config.json`.

| Key | Default | Meaning |
| --- | --- | --- |
| `backend` | `wrangler` | `wrangler`, `s3` or `local` |
| `bucket` | `ai-sessions` | The R2 bucket |
| `prefix` | `sessionvault/v1` | The prefix inside the bucket |
| `machine` | from the hostname | This machine's name in the bucket |
| `encrypt` | `false` | Encrypt each bundle before upload |
| `maxBundleMB` | `240` | The size at which a new part starts |
| `heavyIntervalHours` | `24` | How often a large, always-changing file goes |
| `skipAgents` | `[]` | Agent ids to leave out |
| `includeConfig` | `true` | Also archive settings, rules and skills |

Environment variables override the file: `SESSIONVAULT_BUCKET`, `SESSIONVAULT_PREFIX`,
`SESSIONVAULT_BACKEND`, `SESSIONVAULT_MACHINE`, `SESSIONVAULT_PASSPHRASE`.

## Add an agent

Every agent is a small entry in [`src/registry.js`](src/registry.js):

```js
{
  id: 'my-agent',
  name: 'My Agent',
  vendor: 'Example',
  kind: 'cli',
  sources: [
    { path: '~/.myagent/sessions' },
    { path: '{data}/myagent/history.db', sqlite: true },
    { path: '~/.myagent/config.json', config: true },
  ],
}
```

`{config}`, `{data}`, `{appSupport}` and `{cache}` resolve per platform. A `*` in a path is
a glob. A path that does not exist is skipped. Send a pull request — a new agent is a
three-line change.

## Roadmap

Backup is the first job, and it works today. Next:

- `sessionvault search` — full text search across every machine and every agent
- `sessionvault review` — summarise what an agent did in a period
- `sessionvault preview` — read a transcript in a browser

## Requirements

- Node 18.17 or later. Node 22.5 or later gives the better SQLite path.
- For the `wrangler` backend: a Cloudflare account and `wrangler login`.
- No runtime dependencies. The package installs nothing else.

## Licence

MIT
