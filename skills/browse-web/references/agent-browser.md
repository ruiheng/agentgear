---
runtime-command: agent-browser
append-to-selector: start
---

## Runtime guidance: agent-browser

Before using `agent-browser` for browser work, load its complete, version-matched guidance:

```bash
agent-browser skills get core --full
```

### Reuse an existing Chrome session

After the user enables **Allow remote debugging for this browser instance** at `chrome://inspect/#remote-debugging`, attach and inspect the tabs:

```bash
agent-browser --auto-connect tab list --json
```

Confirm that the result contains the user's expected tabs before interacting. Keep `--auto-connect` on subsequent commands for that attached session; omitting it can select or launch a different browser.

Do not use `agent-browser get cdp-url` to discover a user's Chrome. It reports the CDP endpoint associated with the current agent-browser session.
