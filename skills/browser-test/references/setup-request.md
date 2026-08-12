---
skill-selector: setup-request
selector-summary: Request or prepare browser validation setup.
selector-aliases: check-waypost-messages/action:browser_setup_requested
---

# Browser Setup Request

## Setup Request Receive

On `browser_setup_requested`, reply `browser_setup_provided` to the tester with the same Task, Round, and Browser Check. Include setup details or `Unavailable: <reason>`, then acknowledge the claim. Never send secrets through Waypost.
