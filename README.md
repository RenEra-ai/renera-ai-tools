# Renera AI Tools

Claude Code plugin marketplace by Renera.

## Installation

Add the marketplace in Claude Code:

```bash
/plugin marketplace add RenEra-ai/renera-ai-tools
```

Or via the UI: Settings > Plugins > Add Marketplace, enter `RenEra-ai/renera-ai-tools`.

Then browse and install plugins:

```bash
/plugin
```

## Available Plugins

| Plugin | Description | Version |
|--------|-------------|---------|
| `immigration-guide` | DIY U.S. immigration guidance — visas, green cards, asylum, naturalization, work permits | 1.0.3 |
| `sound-studio` | Music production with Python audio processing — mixing, mastering, stem separation, voice synthesis, composition | 1.0.0 |
| `codex-claude` | Use Codex (GPT-5.x) as an architect & reviewer in the Claude Code dev loop; `/codex-issue` wraps the repo's own workflow in a fully autonomous architect → implement → review → PR loop, composing with a Claude Code Workflow when present (`/codex-compose-setup` makes any repo composition-ready) | 1.8.3 |

## Structure

```
renera-ai-tools/
├── .claude-plugin/
│   └── marketplace.json        # Marketplace catalog
├── immigration-guide/          # Immigration guidance plugin
│   ├── .claude-plugin/
│   │   └── plugin.json
│   ├── skills/
│   │   └── immigration-guide/
│   │       ├── SKILL.md
│   │       └── references/
│   ├── agents/
│   ├── commands/
│   ├── hooks/
│   ├── scripts/
│   └── data/
├── sound-studio/               # Python audio production plugin (no DAW required)
│   ├── .claude-plugin/
│   │   └── plugin.json
│   ├── skills/
│   │   ├── audio-engine/       # Core audio processing (pedalboard, pydub, librosa)
│   │   ├── mix-engineer/       # Per-stem polishing and remixing
│   │   ├── mastering-engineer/ # Loudness optimization for streaming
│   │   ├── stem-separator/     # AI stem separation (Demucs)
│   │   ├── voice-synthesis/    # TTS and voice cloning
│   │   ├── generative-music-composer/
│   │   └── genre-creator/
│   ├── commands/
│   │   └── play.md             # /play command for audio playback
│   └── README.md
├── codex-claude/               # Codex as architect & reviewer (codex-drive over JSON-RPC)
│   ├── .claude-plugin/
│   │   └── plugin.json
│   ├── skills/codex-claude/    # Daemon lifecycle + the codex-drive verb contract
│   ├── commands/               # /codex-architect, /codex-review, /codex-issue
│   ├── agents/                 # codex-architect, codex-planner, codex-impl-reviewer
│   ├── bin/ + lib/             # codex-drive CLI + session daemon (zero deps)
│   ├── scripts/ + test/ + docs/
│   └── README.md
├── docs/                       # Research and planning docs
├── LICENSE
└── README.md
```

## Adding a New Plugin

1. Create a directory at the repo root: `your-plugin-name/`
2. Add `.claude-plugin/plugin.json` manifest
3. Add your skills, agents, hooks, or MCP servers
4. Register it in `.claude-plugin/marketplace.json`
5. Validate with `claude plugin validate ./your-plugin-name`

## License

[MIT](LICENSE)
