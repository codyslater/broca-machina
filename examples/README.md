# examples

Copy-paste starting points for wiring broca-machina to a brain of your own.
Each folder is self-contained: a `config.json` you edit, a script (where
relevant), and a short README.

| Example | Transport | What it does | Start here if… |
|---------|-----------|--------------|----------------|
| [`echo/`](echo/) | command | Repeats your words back | …you just want to verify the audio loop works |
| [`ollama/`](ollama/) | command | Talks to a local Ollama (or any OpenAI-compatible) model | …you want a fully local LLM |
| [`claude-cli/`](claude-cli/) | command | Runs `claude -p` per turn | …you have Claude Code installed |
| [`file-transport/`](file-transport/) | file | Filesystem hand-off for your own long-running process | …your brain is a persistent agent/session |

New here? Run **`echo/`** first — if it echoes back, everything else just works.

Full guide: [`../docs/INTEGRATIONS.md`](../docs/INTEGRATIONS.md).
