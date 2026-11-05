# Device tools over the bridge: what the Peeps server must add

The runner half of plan piece G2 (Peeps `docs/plans/2026-10-23-appium-mobile/plan.md`,
"Live device exploration") is in this repository: `src/device-tools.ts`, wired into
`agent` mode by `src/agent.ts`. This note lists exactly what the Peeps server needs
for an agent to use it. Nothing here exists on the server yet; until it does, the
runner offers the tools and nothing calls them.

The model is the browser tools over the bridge (Peeps `docs/REPO_BACKED_PROJECTS.md`,
"Browser tools over the bridge (PQA-2313 phase 2b)"): the agent runs on Peeps, its
`device_*` calls are relayed through `agent_bridge_call` rows, and the runner answers
each with an MCP `CallToolResult`. Two differences: the runner is a CI job
(`runner_kind = 'ci'`, OIDC), not a local runner, and the tools drive an Appium
session instead of `@playwright/mcp`.

## 1. Asking for the tools: a dispatch input

The runner offers device tools only when the job says so, because starting them
costs minutes (Appium, then a session that installs and launches the app) and
reads the live app:

| Platform | How | Values |
| --- | --- | --- |
| GitHub | action input `device-tools`, from a new `workflow_dispatch` input | `true` / anything else is off |
| GitLab | pipeline variable `PEEPS_DEVICE_TOOLS` | same |

Server changes:

- `appiumWorkflowTemplate` (`src/lib/repo-backed/appium-workflow.ts`): add the input
  and pass it through.

  ```yaml
  on:
    workflow_dispatch:
      inputs:
        mode:        { type: string, required: true }
        sessionId:   { type: string, required: false }
        ref:         { type: string, required: false }
        deviceTools: { type: string, required: false }   # "true" when Peeps' agent drives the device
  # …
        with:
          framework: appium
          mode: ${{ inputs.mode }}
          session-id: ${{ inputs.sessionId }}
          device-tools: ${{ inputs.deviceTools }}
  ```

  The device steps already run for every mode but `inventory`, so the emulator or
  simulator and the app build are there in `agent` mode.
- The dispatch (`repo-heal-service.ts`, `repo-generate-service.ts`, where they call
  `workflow_dispatch` with `{ mode: "agent", sessionId }`): add `deviceTools: "true"`
  only for a session whose agent will use device tools. 🚨 **A workflow installed
  before the template gained the input refuses the dispatch**: GitHub answers 422
  "Unexpected inputs provided" for an input the file does not declare, and Peeps never
  edits workflow files. So read the workflow file on the target branch first (as
  `dispatchRepoGenerate` already does for `workflow_missing`) and send `deviceTools`
  only when it declares it; otherwise dispatch without it and run the agent without
  device tools (or refuse with a "reinstall the workflow" outcome; a product decision).
- GitLab: send `PEEPS_DEVICE_TOOLS=true` with `PEEPS_MODE=agent`.

## 2. Attach: what the runner reports

`POST …/bridge/sessions/<id>/attach` is unchanged in shape. With device tools on, an
Appium runner sends 22 tools (the 9 repository tools plus the 13 below; the route
allows 64) and two new `runnerInfo` keys:

```json
{
  "runnerInfo": {
    "workingDirectory": "/home/runner/work/app/app/mobile",
    "configPath": "wdio.android.conf.ts",
    "framework": "appium",
    "node": "v22.20.0",
    "sha": "…",
    "ref": "refs/heads/main",
    "deviceTools": { "tools": ["device_page_source", "device_screenshot", "…"] }
  }
}
```

- `runnerInfo.framework` is sent by every runner now (`playwright`, `pytest`,
  `appium`, or `unknown (…)` for an unknown `framework` input).
- `runnerInfo.deviceTools` is present only when the tools are offered. An agent should
  register the device proxy only when the attached session's `runnerInfo.deviceTools`
  lists them (`attachBridgeSession` stores `runnerInfo`; expose it to the owner the
  way `kind`/`baseSha` are). Without it, the job ran an older action, `device-tools`
  was not passed, or the suite is not Appium.

No version handshake is needed for v1: the catalogue is this file's, and a runner that
does not offer a tool answers "unknown tool". If the catalogue changes, add
`deviceTools.version` and refuse an off-pin runner the way `playwright_mcp_version`
does for local discovery.

## 3. The catalogue: `bridge-device-catalogue.ts`

Declare the schemas on the Peeps side, as `bridge-browser-catalogue.ts` does: a tool
Peeps does not know is not exposed, whatever the runner announces. These are the
runner's exact names and schemas (`DEVICE_TOOL_[
  {
    "name": "device_page_source",
    "description": "The current screen's page source: the native view hierarchy as XML, or the page's HTML in a WEBVIEW context. Truncated to maxChars.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "maxChars": {
          "type": "integer",
          "minimum": 1000,
          "maximum": 150000,
          "description": "Default 60000"
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "device_screenshot",
    "description": "A PNG screenshot of the device screen, returned as an image when it is small enough; always saved on the runner.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "device_find",
    "description": "Find elements on the current screen. Returns each element's id (for device_tap / device_type), text, rect and whether it is displayed.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "strategy": {
          "type": "string",
          "enum": [
            "accessibility id",
            "id",
            "xpath",
            "class name",
            "-android uiautomator",
            "-ios predicate string",
            "-ios class chain",
            "css selector"
          ],
          "description": "Locator strategy. Prefer accessibility id; css selector only in a WEBVIEW context"
        },
        "selector": {
          "type": "string",
          "description": "The selector for that strategy, e.g. `signIn` for accessibility id"
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 50,
          "description": "Most elements described; default 10"
        }
      },
      "required": [
        "strategy",
        "selector"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "device_tap",
    "description": "Tap an element (elementId from device_find), or a point on the screen (x, y in screen pixels).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "elementId": {
          "type": "string",
          "description": "An element id from device_find"
        },
        "x": {
          "type": "number",
          "minimum": 0
        },
        "y": {
          "type": "number",
          "minimum": 0
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "device_type",
    "description": "Type text into an element (elementId from device_find), optionally clearing it first. The text is never echoed; a value typed into a secure field is masked in later results.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "elementId": {
          "type": "string",
          "description": "An element id from device_find"
        },
        "text": {
          "type": "string",
          "description": "The text to type"
        },
        "clear": {
          "type": "boolean",
          "description": "Clear the field first"
        }
      },
      "required": [
        "elementId",
        "text"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "device_swipe",
    "description": "Swipe a finger across the screen, or across one element, in a direction (the direction the finger moves).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "direction": {
          "type": "string",
          "enum": [
            "up",
            "down",
            "left",
            "right"
          ],
          "description": "The way the finger moves"
        },
        "elementId": {
          "type": "string",
          "description": "Swipe within this element instead of the whole screen"
        },
        "distance": {
          "type": "number",
          "minimum": 0.1,
          "maximum": 0.95,
          "description": "Fraction of the area to travel; default 0.6"
        }
      },
      "required": [
        "direction"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "device_scroll",
    "description": "Scroll the screen to reveal content in a direction (down reveals what is below), optionally until an element is displayed.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "direction": {
          "type": "string",
          "enum": [
            "up",
            "down",
            "left",
            "right"
          ],
          "description": "The content to reveal: down scrolls toward the end"
        },
        "strategy": {
          "type": "string",
          "enum": [
            "accessibility id",
            "id",
            "xpath",
            "class name",
            "-android uiautomator",
            "-ios predicate string",
            "-ios class chain",
            "css selector"
          ],
          "description": "Locator strategy. Prefer accessibility id; css selector only in a WEBVIEW context"
        },
        "selector": {
          "type": "string",
          "description": "Stop when an element matching this is displayed"
        },
        "maxSwipes": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10,
          "description": "Default 5"
        }
      },
      "required": [
        "direction"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "device_back",
    "description": "Press the system back button (Android), or navigate back.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "device_contexts",
    "description": "The available contexts (NATIVE_APP, WEBVIEW_…) and the current one.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "device_switch_context",
    "description": "Switch to a context from device_contexts: a WEBVIEW_… one to use css selectors and read the page's HTML, NATIVE_APP to return.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "The context name"
        }
      },
      "required": [
        "name"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "device_launch_app",
    "description": "Bring an app to the foreground, launching it if needed. Defaults to the app under test (appium:appPackage / appium:bundleId).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "appId": {
          "type": "string",
          "description": "Android package or iOS bundle id; default the app under test"
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "device_terminate_app",
    "description": "Stop an app. Defaults to the app under test (appium:appPackage / appium:bundleId).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "appId": {
          "type": "string",
          "description": "Android package or iOS bundle id; default the app under test"
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "device_logs",
    "description": "The device log since the last read: logcat on Android, syslog on iOS, by default. The last maxLines entries.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "description": "Log type, e.g. logcat, syslog, crashlog, server"
        },
        "maxLines": {
          "type": "integer",
          "minimum": 1,
          "maximum": 1000,
          "description": "Default 200"
        }
      },
      "required": [],
      "additionalProperties": false
    }
  }
]` in `src/device-tools.ts`); a
drift test can compare against a copy of that list checked into Peeps.

| Tool | Arguments | Answer (text part unless noted) |
| --- | --- | --- |
| `device_page_source` | `maxChars?` integer 1000–150000 (default 60000) | `Page source (xml\|html, context <ctx>, <n> characters[; the first <max> follow]):\n<source>` |
| `device_screenshot` | — | an **image part** (`image/png`, base64) when the base64 is ≤ 180000 characters, then a JSON text part `{ width, height, bytes, savedOnRunner, returned, note? }` |
| `device_find` | `strategy` (enum below), `selector`, `limit?` 1–50 (default 10) | JSON `{ strategy, selector, count, truncated, elements: [{ elementId, text, rect: {x,y,width,height}, displayed }] }` |
| `device_tap` | `elementId` **or** `x` and `y` (screen pixels) | `Tapped element <id>.` / `Tapped at (x, y).` |
| `device_type` | `elementId`, `text`, `clear?` | `Typed <n> characters into element <id>[ (a secure field: …)].` The text is never echoed |
| `device_swipe` | `direction` up/down/left/right (the finger's), `elementId?`, `distance?` 0.1–0.95 (default 0.6) | `Swiped <dir> … from (x, y) to (x, y).` |
| `device_scroll` | `direction` (the content to reveal: `down` scrolls toward the end), `strategy?` + `selector?` (together), `maxSwipes?` 1–10 (default 5) | JSON `{ found, swipes, elements? }`, or `{ scrolled, swipes }` without a target |
| `device_back` | — | `Pressed back.` |
| `device_contexts` | — | JSON `{ current, contexts: ["NATIVE_APP", "WEBVIEW_…"] }` |
| `device_switch_context` | `name` | `Switched to context <name>.` |
| `device_launch_app` | `appId?` (default `appium:appPackage` / `appium:bundleId`) | `Brought <id> to the foreground.` |
| `device_terminate_app` | `appId?` (same default) | `Stopped <id>.` / `<id> was not running.` |
| `device_logs` | `type?` (default `logcat` on Android, `syslog` on iOS), `maxLines?` 1–1000 (default 200) | `<type>: <n> entries since the last read[, the last <m> follow]:\n<ISO time> <LEVEL> <message>…` |

Strategies: `accessibility id`, `id`, `xpath`, `class name`, `-android uiautomator`,
`-ios predicate string`, `-ios class chain`, `css selector` (WebView contexts only).

Every failure (bad arguments, an Appium error such as `no such element: …`, a timeout,
a session that could not start or is still starting) is a normal answer with
`isError: true` and one text part saying why; the runner posts it as
`{ ok: true, result: { content, isError: true } }`. Only an unknown tool is
`{ ok: false, error }`.

<details>
<summary>The full JSON schemas</summary>

```json
[
  {
    "name": "device_page_source",
    "description": "The current screen's page source: the native view hierarchy as XML, or the page's HTML in a WEBVIEW context. Truncated to maxChars.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "maxChars": {
          "type": "integer",
          "minimum": 1000,
          "maximum": 150000,
          "description": "Default 60000"
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "device_screenshot",
    "description": "A PNG screenshot of the device screen, returned as an image when it is small enough; always saved on the runner.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "device_find",
    "description": "Find elements on the current screen. Returns each element's id (for device_tap / device_type), text, rect and whether it is displayed.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "strategy": {
          "type": "string",
          "enum": [
            "accessibility id",
            "id",
            "xpath",
            "class name",
            "-android uiautomator",
            "-ios predicate string",
            "-ios class chain",
            "css selector"
          ],
          "description": "Locator strategy. Prefer accessibility id; css selector only in a WEBVIEW context"
        },
        "selector": {
          "type": "string",
          "description": "The selector for that strategy, e.g. `signIn` for accessibility id"
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 50,
          "description": "Most elements described; default 10"
        }
      },
      "required": [
        "strategy",
        "selector"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "device_tap",
    "description": "Tap an element (elementId from device_find), or a point on the screen (x, y in screen pixels).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "elementId": {
          "type": "string",
          "description": "An element id from device_find"
        },
        "x": {
          "type": "number",
          "minimum": 0
        },
        "y": {
          "type": "number",
          "minimum": 0
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "device_type",
    "description": "Type text into an element (elementId from device_find), optionally clearing it first. The text is never echoed; a value typed into a secure field is masked in later results.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "elementId": {
          "type": "string",
          "description": "An element id from device_find"
        },
        "text": {
          "type": "string",
          "description": "The text to type"
        },
        "clear": {
          "type": "boolean",
          "description": "Clear the field first"
        }
      },
      "required": [
        "elementId",
        "text"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "device_swipe",
    "description": "Swipe a finger across the screen, or across one element, in a direction (the direction the finger moves).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "direction": {
          "type": "string",
          "enum": [
            "up",
            "down",
            "left",
            "right"
          ],
          "description": "The way the finger moves"
        },
        "elementId": {
          "type": "string",
          "description": "Swipe within this element instead of the whole screen"
        },
        "distance": {
          "type": "number",
          "minimum": 0.1,
          "maximum": 0.95,
          "description": "Fraction of the area to travel; default 0.6"
        }
      },
      "required": [
        "direction"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "device_scroll",
    "description": "Scroll the screen to reveal content in a direction (down reveals what is below), optionally until an element is displayed.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "direction": {
          "type": "string",
          "enum": [
            "up",
            "down",
            "left",
            "right"
          ],
          "description": "The content to reveal: down scrolls toward the end"
        },
        "strategy": {
          "type": "string",
          "enum": [
            "accessibility id",
            "id",
            "xpath",
            "class name",
            "-android uiautomator",
            "-ios predicate string",
            "-ios class chain",
            "css selector"
          ],
          "description": "Locator strategy. Prefer accessibility id; css selector only in a WEBVIEW context"
        },
        "selector": {
          "type": "string",
          "description": "Stop when an element matching this is displayed"
        },
        "maxSwipes": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10,
          "description": "Default 5"
        }
      },
      "required": [
        "direction"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "device_back",
    "description": "Press the system back button (Android), or navigate back.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "device_contexts",
    "description": "The available contexts (NATIVE_APP, WEBVIEW_…) and the current one.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "device_switch_context",
    "description": "Switch to a context from device_contexts: a WEBVIEW_… one to use css selectors and read the page's HTML, NATIVE_APP to return.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "The context name"
        }
      },
      "required": [
        "name"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "device_launch_app",
    "description": "Bring an app to the foreground, launching it if needed. Defaults to the app under test (appium:appPackage / appium:bundleId).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "appId": {
          "type": "string",
          "description": "Android package or iOS bundle id; default the app under test"
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "device_terminate_app",
    "description": "Stop an app. Defaults to the app under test (appium:appPackage / appium:bundleId).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "appId": {
          "type": "string",
          "description": "Android package or iOS bundle id; default the app under test"
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "device_logs",
    "description": "The device log since the last read: logcat on Android, syslog on iOS, by default. The last maxLines entries.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "description": "Log type, e.g. logcat, syslog, crashlog, server"
        },
        "maxLines": {
          "type": "integer",
          "minimum": 1,
          "maximum": 1000,
          "description": "Default 200"
        }
      },
      "required": [],
      "additionalProperties": false
    }
  }
]
```

</details>

## 4. The proxy: `bridge-device-proxy.ts`

A low-level MCP server, like `bridge-browser-proxy.ts` (reuse its structure, or
generalise it over a catalogue):

- Registered under a name of its own, e.g. `appium`, so the agent sees
  `mcp__appium__device_*`; list only the catalogue; refuse undeclared arguments and
  schema failures (Ajv) before a row is written.
- Relay with `call(sessionId, tool, args, { timeoutMs })`. **Timeout: 120 s is enough.**
  The runner answers every device call within about 110 s: at most 60 s waiting for
  the session to become ready (it answers "still starting; call again shortly" after
  that, rather than holding the call) plus at most 50 s for the call. As in the browser
  proxy, a call unanswered past the timeout should end the session.
- Return the runner's `CallToolResult` text parts and `isError`. **Decision needed on
  image parts:** the browser proxy drops them ("pixels stay on the machine", design
  §7.3, for a developer's own machine). Here the device is the customer's CI emulator
  or simulator, and a failed Appium test's screenshot is already uploaded by
  `report`/`run`, so forwarding `device_screenshot`'s image to the model is defensible
  and is most of that tool's value. Either forward image parts for device tools only,
  or drop them like the browser proxy (the JSON text part still says the size and
  where it was saved, and `device_page_source` is the accessible equivalent of a
  snapshot). The runner sends the image either way; the proxy decides.
- Mask before the model: the runner masks only values in the job's environment and
  values typed into secure fields. Run device text results through the same
  project-secret masker `run_tests` output gets (`loadHealerModelMasker`, `values`
  mode) before they reach the model, and withhold them when it cannot load, as for
  `run_tests`.
- `device_type`'s `text` is an argument, so it is stored in `agent_bridge_call.args`
  and shown by `call-args-summary.ts`. Add `text` to the summary's elided keys (the
  runner's job log already elides it), and consider treating it like `token` (the
  `secret` column) when the agent types a credential.

## 5. Which agents get it

- The Appium script agent (plan piece G) in **generate** mode: `RepoGeneratorAgent`
  for an Appium project gets the device proxy in place of the cloud `playwright-test`
  browser it uses for web (there is no cloud device), plus the repository bridge as
  today. Dispatch with `deviceTools: "true"`.
- The **healer** for Appium (piece H) optionally: it works from the failure's page
  source and screenshot (already in `run_tests`' result, below); give it device tools
  only if a live look is wanted, at the cost of the startup minutes.
- Prompts (piece F, `platform:mobile`): the bridge-mode variant must say which tools
  exist (no evaluate, no file upload), that element ids from `device_find` are what
  `device_tap`/`device_type` take, to prefer accessibility ids, and to switch to the
  `WEBVIEW_…` context for DOM selectors.

## 6. `run_tests` for an Appium suite (no server change needed)

`run_tests` keeps its arguments and result shape, so `runTestOnRunner` and
`verifyOnRunner` work unchanged:

- `grep`: the server's `titleGrep` (`(?:^| )Describe test(?: @[^ ]+)*$`) matches
  mocha's full title as it matches Playwright's; the runner passes it to mocha as a
  regular expression (line terminators escaped).
- `project`: ignored for Appium (send none; `pwProject` is empty for Appium tests).
- `results[].title` is the title path joined with ` › `, exactly the inventory's
  `titlePath`, so the target is matched as it is for Playwright. `status` is `passed`,
  `failed` or `skipped`.
- New optional fields on a failed test: `errorStack`, `evidence` (`[{ name, path,
  size }]`, absolute paths on the runner; informational, the agent cannot read them
  with `read_file`), `pageSource` (redacted, ≤ 20,000 characters, for at most three
  failed tests) and `pageSourceTruncated`. They pass through the existing `run_tests`
  masker like the rest of the result.

## 7. Session lifetime and storage

- The runner deletes the WebDriver session and stops Appium's process group when the
  session ends (410 on a poll), when its cap passes, on SIGTERM (a cancelled run), and
  when the loop fails. The owner keeps ending the session in its `finally`, as today.
- A screenshot can make a result up to about 180 KB, under `MAX_INLINE_RESULT_BYTES`
  (256 KB) and the route's 512 KB. Device results hold page source and screenshots of
  the customer's app in `agent_bridge_call.result`; CI sessions' calls are not scrubbed
  today (local sessions are, after 7 days). Decide whether device calls get the same
  retention.
- `ATTACH_WAIT_MS` (10 min) is unaffected: the device session starts after attach, in
  the background.
