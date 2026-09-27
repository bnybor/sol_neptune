# Sol Neptune Graph plugin

This is the installable ChatGPT/Codex plugin package for the OAuth-protected Sol
Neptune MCP service. It is more than the remote MCP endpoint: it supplies the
portable plugin identity, install-surface metadata, MCP connection, guarded
typed-semantic workflow, and bounded Gremlin operating instructions.

## Package contents

- `plugin.json`: portable Agent Plugins manifest.
- `mcp.json`: portable Streamable HTTP connection.
- `.codex-plugin/plugin.json`: OpenAI compatibility manifest.
- `.mcp.json`: compatibility MCP connection with the exact OAuth resource.
- `skills/sol-neptune-graph/SKILL.md`: safe read and mutation workflow.

The canonical MCP and OAuth resource URL is:

```text
https://e5ihe7vc7nrzmzu2rfezzaraja0dzwfv.lambda-url.us-east-1.on.aws/mcp
```

## Register the ChatGPT connection

In ChatGPT Developer mode, open ChatGPT Plugins and create a connection with:

- Name: `Sol Neptune Graph`
- Description: `OAuth-protected Gremlin access to Sol's private Neptune graph.`
- Connection: public MCP endpoint
- URL: the canonical `/mcp` URL above
- Authentication: Mixed (anonymous MCP discovery with OAuth-protected tools)

Complete Auth0 login with Robyn's approved Google account. ChatGPT displays a
non-secret technical connection ID in the resulting browser URL. Add that ID to
`.app.json` and reference the file as `apps` in the compatibility manifest so
the packaged plugin points to the registered ChatGPT connection.

## Local marketplace

The repo marketplace is named `sol-neptune-local`. Register and install it with:

```bash
codex plugin marketplace add /home/robyn/sol/mcp
codex plugin add sol-neptune-graph@sol-neptune-local
```

After installing or refreshing the plugin, start a new chat so its skill and
MCP tools are loaded for that chat.

The server endpoint and connection identity do not change when the typed tools
are added. An already configured connection should discover
`get_graph_state`, `commit_semantic_delta`, and `reconcile_operation` after a
supported reconnect or tool-manifest rescan; recreating the plugin connection
is not an implementation requirement.

## Validation

From the bundled plugin-creator skill directory:

```bash
python3 scripts/validate_plugin.py \
  /home/robyn/sol/mcp/plugins/sol-neptune-graph
```

Both portable manifests also validate against Agent Plugins schema version
`1.0.0`.
