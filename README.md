# Renera AI Tools

Claude Code plugin marketplace by Renera.

## Installation

Add the marketplace:

```bash
/plugin marketplace add renera/marketplace
```

Browse and install plugins:

```bash
/plugin
```

Or install directly:

```bash
/plugin install immigration-guide@renera-ai-tools
```

## Available Plugins

| Plugin | Description | Version |
|--------|-------------|---------|
| `immigration-guide` | DIY U.S. immigration guidance — visas, green cards, asylum, naturalization, work permits | 1.0.0 |

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
