# pilotfish MCP (managed)

[![npm](https://img.shields.io/npm/v/@gaiventures/pilotfish-mcp-managed)](https://www.npmjs.com/package/@gaiventures/pilotfish-mcp-managed)

An MCP server that does whole browser tasks for your AI agent. Your agent says what it wants done ("download last
month's invoices from our AWS billing console", "pull the risk factors from Apple's latest 10-K on SEC EDGAR").
[pilotfish](https://pilotfish.gai.ventures) does it in its cloud browser, signed in with your saved logins, and
returns the answer and any files.

For people and teams using Claude Code, Claude.ai, Claude Desktop, Codex CLI, Cursor, VS Code or another
[MCP](https://modelcontextprotocol.io) client, and for products that run browser tasks for their own users. It is a
paid service: you need a pilotfish account ([sign up with Google](https://pilotfish.gai.ventures/signup)), and tasks
are paid from your organization's credits.

> **Launch offer: new accounts start with $1 free**, no card needed.

```sh
claude mcp add --transport http pilotfish https://pilotfish-be.gai.ventures/mcp
```

Then run `/mcp` in Claude Code and sign in. Any client that takes a URL connects to
`https://pilotfish-be.gai.ventures/mcp`, by signing in or with an API key. This npm package is a small relay for clients that can only
start a local (stdio) server: `npx -y @gaiventures/pilotfish-mcp-managed` (setup under "Connect" below).

Want a browser on your own computer for free, driven by your agent's own model, with no account? Use the open
[`@gaiventures/pilotfish-mcp`](https://www.npmjs.com/package/@gaiventures/pilotfish-mcp) instead.

[![pilotfish (managed) MCP server](https://mcprush.com/badge/pilotfish-managed-mcp/card.svg)](https://mcprush.com/to/pilotfish-managed-mcp?ref=badge)

## Why managed

- **One call per task.** pilotfish plans and runs the task on its own models and checks the answer. Your agent spends
  a tool call or two, not a context full of web pages.
- **Signed in as you.** Save a login once in the app and every task can use it, several accounts a site if you have
  them. Sessions are kept between runs, and two-factor codes, emailed codes and phone sign-in by code are handled.
- **Or as each of your own users.** Building a product? Run tasks for your end users in a shared project, each as an
  identity with their own logins, sessions, residential IP and device, and see what each one's tasks cost.
- **Gets through where plain browsers stop.** Residential IPs in your country, stealth browsing and CAPTCHA solving
  are on by default, with per-site settings. When something truly needs you, you get a link.
- **Always on.** Tasks run in the cloud, so they carry on while your laptop sleeps. A follow-up picks up the same
  session where it left off.
- **You can see everything.** Watch any task live or take control, replay it afterwards, and see what each one cost.
- **Safe with money and messages.** Payments, orders and messages wait for a person's yes unless the task's own words
  allow them, and codes and passwords never pass through the agent.

## Get started

1. **Have an account.** [Sign up with Google](https://pilotfish.gai.ventures/signup) and name your organization (you
   become its primary admin), or accept an emailed invitation to join an existing one as a member or an admin.
2. **Make sure the organization has credits.** Admins add them under **Org settings → Credits** in the app (pay as you go,
   from $5, with optional auto reload; launch offer: new accounts start with $1 of free credit). Members run tasks on the organization's credits within any allowance an
   admin sets for them.
3. **Connect your agent** (below). The simplest way is to sign in from your client, which then acts as you. Scripts,
   servers and shared agents use an API key instead (Org settings → API keys). The app's **MCP** page
   (`https://pilotfish.gai.ventures/connect`) has the endpoint and every client's setup.

## Connect

The endpoint is `https://pilotfish-be.gai.ventures/mcp` (Streamable HTTP).

### Claude Code

```sh
claude mcp add --transport http pilotfish https://pilotfish-be.gai.ventures/mcp
```

Then run `/mcp` in Claude Code, choose pilotfish and sign in with your pilotfish account. To use an API key instead,
add `--header "Authorization: Bearer pf_YOUR_KEY"` to the command.

### Claude.ai and Claude Desktop

**Settings → Connectors → Add custom connector**, paste `https://pilotfish-be.gai.ventures/mcp`, connect, and sign in.
No key is needed.

### Cursor, Windsurf and other clients that take a URL

```json
{
  "mcpServers": {
    "pilotfish": {
      "url": "https://pilotfish-be.gai.ventures/mcp",
      "headers": { "Authorization": "Bearer pf_YOUR_KEY" }
    }
  }
}
```

A client that supports MCP sign-in (OAuth) can leave out `headers` and sign in instead.

### VS Code

In `.vscode/mcp.json`:

```json
{
  "servers": {
    "pilotfish": {
      "type": "http",
      "url": "https://pilotfish-be.gai.ventures/mcp",
      "headers": { "Authorization": "Bearer pf_YOUR_KEY" }
    }
  }
}
```

### Sign in a terminal (no key needed)

Clients that start a local server (Codex CLI, any `command`/`args` client), on a laptop or over SSH, can use your own
sign-in instead of a key. Run this once on that machine:

```sh
npx -y @gaiventures/pilotfish-mcp-managed login
```

It prints a link and a code such as `BCDF-GHJK`. Open the link on any device (your phone works), check that the page
shows the same code, sign in and choose **Allow**. The relay then keeps the sign-in in `~/.pilotfish/mcp-managed.json`
(readable only by you) and renews it by itself, so the client configs below need no `env` at all. It acts as you, in
your Personal project, like signing in from Claude Code. `logout` signs that machine out (the sign-in is revoked at
pilotfish too). If `PILOTFISH_KEY` is set, the key is used instead.

### Codex CLI

In `~/.codex/config.toml`, through this package (leave out `env` once you've run `login`):

```toml
[mcp_servers.pilotfish]
command = "npx"
args = ["-y", "@gaiventures/pilotfish-mcp-managed"]
env = { PILOTFISH_KEY = "pf_YOUR_KEY" }
# A call returns within 50 s, or 120 s when the client asks for progress updates; the task carries on either way.
# Codex stops a call after 60 s by default.
tool_timeout_sec = 180
```

### Any client that starts a local server

```json
{
  "mcpServers": {
    "pilotfish": {
      "command": "npx",
      "args": ["-y", "@gaiventures/pilotfish-mcp-managed"],
      "env": { "PILOTFISH_KEY": "pf_YOUR_KEY" }
    }
  }
}
```

The relay needs Node.js 22 or newer. It only forwards messages to the endpoint with your key; the browser runs in
pilotfish's cloud. On native Windows, if your client cannot start `npx`, use `"command": "cmd"` with
`"args": ["/c", "npx", "-y", "@gaiventures/pilotfish-mcp-managed"]`.

### Check a key or a sign-in

Prints the endpoint and the tools, or why the key or sign-in was refused (with no key set, it checks the sign-in):

```sh
PILOTFISH_KEY=pf_YOUR_KEY npx -y @gaiventures/pilotfish-mcp-managed --check
```

In Windows PowerShell:

```powershell
$env:PILOTFISH_KEY = "pf_YOUR_KEY"; npx -y @gaiventures/pilotfish-mcp-managed --check
```

`--version` prints the relay's version.

## Signing in or an API key

|  | **Signing in** (OAuth) | **An organization API key** (`pf_…`) |
| --- | --- | --- |
| Who it acts as | You | The organization, as no particular person |
| Who can use it | Only you | Anyone who has the key: keep it secret |
| Project | Personal, until you `switch_project` | The one shared project it belongs to |
| Saved logins, site profiles, saved tasks | Yours (in Personal) | No one's: each end user's logins belong to an identity |
| Tasks it sees | Your own; an admin can also open any of the organization's tasks by id | Only the tasks started with that key |
| Paid from | The organization's credits, within your allowance if you have one | The organization's credits, within the key's allowance if it has one |
| Who sets it up | You, from your client (or `login` once, for a client that starts this package) | The organization's admins, under **Org settings → API keys** |

**About keys.** Admins create, show again, copy, rotate and revoke keys under **Org settings → API keys**
(`https://pilotfish.gai.ventures/org?view=keys`). Each key belongs to one shared project, picked when it is made
(Default unless chosen) and movable later. Rotating gives a new value under the same name, and the old one stops
working at once; rotate a key when someone who had it leaves. Each key has its own page with what it spent, its tasks
through the MCP and the API, and its sessions. An admin can give a key an allowance: a spending limit on the
organization's credits, with an optional automatic top-up.

**Personal API keys.** An API key always belongs to a project. For your own scripts and tools that can't sign in,
make one in the app's **Org settings → API keys** and pick the project **Personal (you)**: it acts as you, in your
Personal project, with your own saved logins, and only you can see or manage it. Admins (the primary admin included)
can always do this; a member can once an admin turns on **Allow personal API keys** on the member's page (turning it
off revokes their keys at once), and then finds their keys on their Org settings page. Admins see each person's key
usage, never the keys. Every key, personal ones included, can have a spending limit of its own: admins set it on the
key's page (a member sees the limit and how much of it is used, and asks an admin to change it). At the limit, new
tasks with that key are refused and running ones pause until it is raised; `get_usage` with a personal key says what
is left of it. Most people need no key at all: Claude Code, the Claude app, Cursor and VS Code sign in, and
a client that starts this package signs in once with `login` (see **Sign in a terminal**).

## Projects

Every task runs in a project.

- **Personal** is your own: your saved logins (several accounts a site, one of them the default), saved and scheduled
  tasks, connected inbox and site settings. It is where you are when you sign in, in the app or from an AI tool.
- **Default** is the shared project every organization starts with, for product companies running tasks for their
  own end users. It holds no one's personal logins and no saved or scheduled tasks: each end user is an **identity**
  there. A task with no identity gets a fresh browser of its own, and nothing of it is kept for other sessions.
- **Projects of your own** (made by your organization's admins) are shared projects like Default, one per further
  product or customer, so each keeps its own identities, API keys and spend.

Switch in the app's project switcher, or with `switch_project` (no argument lists your projects). Signed in from your
client (OAuth), the MCP remembers your choice for your next connections. With a personal API key the switch lasts for
that connection only, and the key starts in Personal again next time. An organization API key always works in its own
project.

## Identities: tasks for your own users

An identity (`idn_…`) is one of your end users. pilotfish keeps, on its servers, everything that makes them look like
the same person to a site: their logins for any number of sites (several accounts a site), their signed-in sessions,
a residential IP in their country (the same region every time, kept sticky) and their device fingerprint. None of it
is ever handed back. You only see its id, label, your own user id for it (`external_user_id`), its country and device
OS, which sites it has logins for (usernames masked), its credential ids, and what its tasks cost.

- **Manage them** with the `identities` tool (`list`, `create`, `get`, `update`, `delete`) or the REST API
  (`/identities`). Creating one with an `external_user_id` you already used gives the existing one back, also when
  two requests arrive at once; changing one to an id another identity has is refused (409 `external_user_id_taken`).
- **Page through them** over REST: `GET /identities?limit=` (1 to 200, default 50) returns `nextCursor`; pass it as
  `cursor` for the next page (`null` on the last). `GET /jobs` pages the same way.
- **Run a task as one** with `browser_task {identity: "idn_…"}`. A `follow_up` keeps the session's identity. Each
  identity runs one task at a time.
- **Delete** wipes its logins, sessions and device for good. Its tasks and their costs stay, for your billing.
- **One place and one machine.** All of an identity's sites see the same residential IP, from the same city, and the
  same device, as one person's browsing would. A residential provider holds an IP for a day at most, so pilotfish
  renews it between tasks, never during one: a task that starts near the end of the day gets the new IP from its
  first page, in the same city, on the same device. A sign-in made on the old IP stays signed in.

### Getting a user's logins in, without an AI seeing them

Each saved login gets a credential id (`cred_…`). A password never passes through the MCP. There are three ways in:

1. **A login link.** `identities {action: "login_link", id, sites: ["linkedin.com"]}` (or `POST /identities/:id/link`)
   returns a one-time page, valid for 30 minutes (over REST, `ttlMinutes` sets 5 to 1440). Send it to your end user; they type their own login
   there, and it is saved sealed to their identity. Add `webhook_url` (REST: `webhookUrl`, https) to be told as each
   site's login is saved: an `identity.login_saved` event, signed like job webhooks, with the identity, your
   `externalUserId`, the site, the account, the new `credential` id, `linkDone` and the sites `remaining`. Never the
   username or password. Without one, `identities get` shows when it is saved.
2. **Your own server.** `POST /identities/:id/credentials {site, username, password?, totp?, account?, default?}`
   with your API key, from your backend. The MCP refuses this route.
3. **Sign-ins during a task.** With `save_logins: true` on the identity, a sign-in typed during one of its tasks is
   kept once it works. Off by default; the signed-in session is kept either way. The task's own webhook gets the same
   `identity.login_saved` event (`via: "task"`).

Use them in a task with `credentials: ["cred_…"]`, or name the account per site with
`accounts: {"linkedin.com": "work"}`.

### Which account a task uses

When a site has several saved accounts (yours in Personal, or an identity's), a task takes, in order: the one the
request names (`accounts`, `credentials` or `login`), the one the session already chose, the one the person's own
words name (its name, or its username or email), the site's default, or the only one saved. Otherwise it asks once, at
the start: each saved account, **Use another login**, **Create a new account** or **Go without signing in**. A
scheduled run never asks: it takes the default, else the main account. Set a default with `manage_login {action: "set_default"}` (Personal)
or `identities {action: "set_default", credential}`.

### Codes and sign-ins for your end users

When a site asks an identity's task for something only its end user has, the task waits on them, never on you:

- **An authenticator app code:** save the identity's authenticator key with its login (the login link's
  "Two-step sign-in" field, or `totp` in `POST /identities/:id/credentials`) and pilotfish types the code itself.
- **A code sent by text or email, a sign-in, a security check:** the task pauses with a question. The reply from
  `browser_task` or `get_job` reads `Waiting for the end user of identity idn_…` with an `Answer here:` link; the
  `job.needs_input` webhook carries the `identity` and the question. Send that link to the end user: they type the
  code or their sign-in on pilotfish's page (no account needed, the link is the capability) and the task carries on.
  A sign-in typed there is kept as the identity's credential when it keeps sign-ins (`saveLogins`).
- Codes and passwords never pass through your agent, your servers' task calls, events or webhooks.

### Updating a login

When an end user changes a password, send them a new login link for that site (and account, if it has a name):
`identities {action: "login_link", id, sites: ["linkedin.com"], account: "work"}`. What they type replaces the saved
login, and its credential id stays the same. Your own server can do the same with
`POST /identities/:id/credentials` (same site and account). A signed-in session the site keeps is used as long as it
lasts; the saved login signs in again when it ends.

### Usage per project

Admins see every shared project's API keys, identities and this month's spend in Org settings → Projects, or with
`projects {action: "list"}`; `projects {action: "usage", id, days}` gives one project's spend by kind and per key
(`GET /org/projects`, `GET /org/projects/:id/usage?days=`).

### What each task cost

Every result has the same layout: the outcome first (`SUCCESS`, `PARTLY DONE`, `NOT DONE`…), the answer, then
the job, its cost by kind (kinds that cost nothing left out) and where it ran:

```text
SUCCESS
Result: Applied to 3 roles: …
Job: job_Ab12… · 14 steps
Cost: $0.0213 (model $0.0081, residential IP $0.0104, browser $0.0020, CAPTCHA $0.0008)
Project: Acme HR app (prj_acme)
Identity: idn_7Hq2…
Open in pilotfish: https://…/tasks/job_Ab12…
```

`identities {action: "get"}` and `GET /identities/:id/usage?since=` give an identity's totals (tasks; model,
residential IP, browser and CAPTCHA cost) and each task's cost, so you can bill your own users.

### An example: Acme HR

Acme HR runs LinkedIn tasks for its users Priya (in India) and Rahul (in the US). An admin creates the shared project
"Acme HR" and an API key in it, and Acme's server connects with that key.

1. One identity per user:
   `identities {action: "create", external_user_id: "u_1042", label: "Priya", country: "in"}` and
   `identities {action: "create", external_user_id: "u_2077", label: "Rahul", country: "us"}`.
2. A login link for each: `identities {action: "login_link", id: "idn_priya…", sites: ["linkedin.com"]}`. Acme shows
   the link in its own app; Priya signs in to LinkedIn there. Rahul does the same with his.
3. Tasks by identity: `browser_task {identity: "idn_priya…", task: "Read my new LinkedIn messages and list who wrote"}`.
   It runs on Priya's LinkedIn session, from an Indian residential IP on her own device; Rahul's runs from the US on his.
4. The cost: each result ends with `Cost: …`, `Project: …` and `Identity: idn_priya…`; at month end Acme reads
   `GET /identities/idn_priya…/usage?since=…` for each user and bills them.
5. Priya leaves: `identities {action: "delete", id: "idn_priya…"}` wipes her LinkedIn login, session and device. Her
   past tasks and their costs stay in Acme's usage.

## Organizations, members and money

Everyone is in one organization, and its credits pay for every task its people and its keys run.

| | **Primary admin** | **Admins** | **Members** |
| --- | --- | --- | --- |
| Run tasks, connect agents, save logins | Yes | Yes | Yes |
| Add credits, card, auto reload | Yes | Yes | No |
| Monthly limit and overage | Yes | Yes | No |
| Invite people, change roles, set allowances | Yes | Yes | No |
| Create and manage API keys, and shared projects | Yes | Yes | No |
| A personal API key | Yes | Yes | When an admin turns it on (else they sign in from their client) |
| See everyone's tasks and spending | Yes | Yes | No: their own, and their allowance |
| Hand the primary admin role to someone else | Yes | No | No |

- **Allowances.** An admin may give a member (or a key) a spending limit on the organization's credits. No limit is
  the default. When it is used up, new tasks are refused and running ones pause until an admin raises it.
- **The monthly limit.** An admin may set one for the whole organization. The primary admin is emailed at 80% and at
  100%; at the limit, tasks pause and new ones are refused until an admin turns on overage or raises the limit.
- **One task at a time** per person, per key and per identity. Another task started meanwhile is refused until the
  first finishes or is stopped.
- **Check-ins on long tasks.** A task that has spent a set amount ($1 by default) pauses and says what it found so
  far; carry on with a follow-up, and it checks in again at the next step of that amount.
- **What your agent sees.** A refused task comes back with the reason and whom to ask:

| Reason | What it says | What to do |
| --- | --- | --- |
| `no_credits` | You're out of credits, or the balance is too low to start a task | An admin adds credits under **Org settings → Credits**, or turns on auto reload |
| `allocation_used` | You've used your (or this key's) allowance, naming the admins to ask | An admin raises the allowance |
| `org_limit` | The organization has reached its monthly limit | An admin turns on overage or raises the limit |
| `one_session` | You already have a task running | Wait for it to finish, or stop it with `cancel_job` |
| `queue_full` | Your organization has 50 tasks waiting to start already | Wait for some to start, or stop some with `cancel_job` |
| `start_rate` | Your organization is starting tasks faster than 60 a minute | Try again after the seconds it gives |

`get_usage` shows where you stand: for an admin, the organization's balance and auto reload; for a member, their
allowance and whether the organization's credits are fine, low or out; for everyone, this month's spending against
the monthly limit and spending by category and by model.

## Tools

| Tool | What it does |
| --- | --- |
| `browser_task` `{task, start_url?, region?, sites?, login?, accounts?, identity?, credentials?, stealth?, solve?, model?, max_steps?, pre_approved?, files?, output_schema?, wait?, wait_seconds?}` | Run a whole web task, however many sites and steps. Waits up to `wait_seconds` (default 120 when your client asks for progress updates, else 50) and returns the result with its cost by kind and its project and identity, or the job id if it is still running (it carries on; `get_job` waits again). A call that is cancelled or times out stops waiting and leaves the task running. `wait: false` returns the id at once. `model`: the OpenAI model every step runs on, `gpt-6-luna` (the default), `gpt-5-mini` or `gpt-5-nano`. `region`: the country to browse from (`"us"`, `"in"`). `start_url`: the page to open first. `sites`: further sites whose saved logins the task may use. `login`: which of your accounts on those sites; `accounts` (`{"linkedin.com": "work"}`, `""` the main one): which account on each site. `identity` (`idn_…`, in a shared project): run as that end user; `credentials` (`["cred_…"]`): which of its saved logins. `stealth` and `solve`: on by default; `false` turns them off for this run. `max_steps`: browser actions across the run. `pre_approved` (`{actions: [pay, delete, send, transfer, cancel], max_amount?, currency?}`): only with the person's say-so, final steps that run without asking. `files`: up to 10 attachments (`{name, type?, data}` in base64, 25 MB each). `output_schema`: a JSON Schema (root `type: "object"`) for the answer; the reply then gives `Data: {…}` in place of `Result:`, with the JSON as structured content (see [Structured output](#structured-output)). |
| `get_job` `{id, wait_seconds?}` | A job's status, its open question with the link to answer it, the result, the cost so far, the live-view link while it runs, and the session's files. `wait_seconds` waits for it to finish or need you first, with progress updates while it waits. |
| `get_file` `{id, file_id}` | One of the session's files: attached, downloaded, or a PDF the run read in the browser's viewer. Up to 5 MB comes back in the result (an image as an image, text as text); larger files are linked in the app. |
| `list_jobs` `{status?, limit?}` | Your recent jobs, newest first, with their cost; `[replay]` marks recorded ones. `status`: `queued`, `running`, `needs_input`, `done`, `failed` or `cancelled`. |
| `follow_up` `{id, text, model?, region?, files?, output_schema?, wait?, wait_seconds?}` | Carry on in the same session: the same browser while it is kept, the same sign-ins, what earlier turns found ("now also…", "open the second one", "try again with…"). `model` changes this turn's model (`auto` routes again). `region` runs the turn from another country, in a new browser session there. `output_schema`: this turn's answer schema (omitted keeps the session's). The session keeps its project and identity. |
| `rerun_job` `{id, wait?, wait_seconds?}` | Run the same task again with the same settings, as a new job in a new session. To change the instructions or carry on, use `follow_up`. |
| `answer_job` `{id, question_id, answer}` | Answer a job's question: `yes`, `no`, `done` (handled in the browser), `cancel`, or text. The id is in the job's `Question …` line, which also says what answer it takes. Codes and passwords go on the answer page, never here. |
| `message_job` `{id, text}` | Pass on what the person says while a job runs ("take the cheaper one", a detail it asked for), in their words. It reads the message before its next step, and the person's newest words win over the task; sent while the job waits on a question, it answers it. |
| `take_control` `{id}` / `hand_back` `{id}` | Pause a running job and get a link to drive its browser yourself, then let it carry on from where you left it. |
| `cancel_job` `{id}` | Stop a queued, running or waiting job for good: it can't be resumed, and what it spent stays charged. It is the only way to stop one: a tool call that is cancelled or times out stops waiting, and the job carries on. |
| `get_replay` `{id}` | The job's steps with timings and what got in the way, and a link to its replay video (valid for an hour) when one was recorded. Replay videos are kept 7 days by default (your org's admins can choose 1–30); after that it says the video expired, and the steps are still there. |
| `list_saved_tasks` | Your saved tasks: id, name, settings, how often and when they last ran, and what their last run needed. |
| `run_saved_task` `{id, extra_instructions?, start_url?, region?, sites?, stealth?, solve?, output_schema?, wait?, wait_seconds?}` | Run a saved task with its saved settings, with optional changes for this run only. |
| `save_task` `{name, task? \| from_job?, start_url?, region?, sites?, login?, accounts?, stealth?, solve?, model?, output_schema?}` | Save a task to run again here or in the app: give the task and settings, or `from_job` to save a job's task with the settings it ran with. |
| `update_saved_task` `{id, name?, task?, …settings}` | Rename a saved task, change its task, or change only the settings given. |
| `delete_saved_task` `{id}` | Delete a saved task. Its past runs stay in your history. |
| `delete_session` `{id}` | Delete a session from your history: it no longer shows or opens anywhere; its record and cost are kept for billing. Logins, saved tasks and spending stay. Only with the person's say-so. |
| `list_logins` | Sites with saved logins in your Personal project: which accounts, whether a password and authenticator key are stored, what recent runs met there. Never a password or code. |
| `manage_login` `{action, site, account?}` | Your Personal logins. `add`: a link to the app where you type the login yourself (never in the chat). `set_default`: the account tasks use on a site with several when they don't say. `delete`: forget one. `save_offered` / `discard_offered`: a sign-in a run offered for saving. |
| `projects` `{action, id?, name?, days?}` | Admins: your organization's shared projects. `list` (each with its API keys, identities and this month's spend), `create`, `rename`, `delete` (wipes its identities, revokes its keys; its tasks' cost stays), `usage` (one project's spend by kind and per key over `days`), `keys` (its keys and what each spent). New API keys are made in the app (Org settings → API keys): a key's value never passes through a chat. |
| `switch_project` `{project?}` | Which project your tasks run in: `personal`, `default` or a project's id or name. No argument lists them. Signed in (OAuth), remembered for your next connections; with a personal API key, for that connection only. An organization API key stays in its own. |
| `identities` `{action, id?, external_user_id?, label?, query?, country?, device_os?, email?, save_logins?, sites?, account?, credential?, webhook_url?}` | Your end users in a shared project. `list` (by `external_user_id` or `query`), `create`, `get` (logins by credential id, masked; signed-in sites; cost so far), `update`, `delete` (wipes logins, sessions and device; costs stay), `login_link` (`sites`: a one-time page for the user to type their own login; `webhook_url` to be told when it is saved), `set_default` and `delete_login` (by `credential`). |
| `get_settings` / `update_site_settings` `{site, residential?, stealth?, solve?}` | Your sites and their settings, and change one site's: residential IP (`auto`, `always` or `never`), stealth browsing, CAPTCHA solving. A change applies to every later task on that site. |
| `get_usage` `{days?}` | Your organization's credits as your role sees them (an admin: its balance and auto reload; a member: whether it is fine, low, out or at its limit), what is left of your allowance (or the key's), this month's spending against the organization's monthly limit, and the last `days` (default 30) of spending by category (model, residential IP, browser, CAPTCHA) and by model. |

## What a job returns

Every job reply starts with one status word on its own line:

| First line | Meaning |
| --- | --- |
| `SUCCESS` | Done, and the final check confirmed the result. |
| `PARTLY DONE` | Not fully done, but there is an answer: it lists what is done, what is not (each with its evidence) and why it stopped. |
| `NOT DONE` | Nothing usable; `Why it stopped:` says why when that is known. |
| `PAUSED (<reason>)` | Stopped resumably: a spend check-in (`cost_cap`), a question nobody answered (`no_answer`), the residential IP down (`residential_down`), or the machine running it stopped or was replaced (`machine_lost`, `machine_reclaimed`). |
| `NEEDS YOU` | Waiting for a person: the question, a `Question <id>` line saying how to answer it, and the answer link. |
| `RUNNING` / `QUEUED` | Still going, or waiting for a free browser. |
| `ERROR <code>` | The call was refused: `ERROR <code>: <message>`, the figures that matter, and a `Docs:` link when a person has to act (add credits, ask an admin, switch project). |

Labelled lines follow (`Result:`, `Done:`, `Not done:`, `Why it stopped:`, `Job: <id> · N steps`). A finished job then
has a `Cost:` line (only the kinds it spent on: model, residential IP, browser, CAPTCHA), a `Project:` line, and an
`Identity:` line when it ran as one. The last line is `Next:` only when your agent has something to do, for example
`Next: follow_up {"id":"job_…","text":"Continue"} picks it up from where it left off.` for a paused job, or
`Next: get_job {"id":"job_…"} to wait for it.` for one still running.

### Structured output

Give `output_schema` (a JSON Schema whose root has `type: "object"`, at most 16 KB, local `$ref`s only) to `browser_task`,
`follow_up`, `run_saved_task` or `save_task`, and a finished job's reply has `Data: {…}` (compact JSON that matches it,
cut at 20,000 characters on that line) where `Result:` would be, and the whole JSON as the tool result's
`structuredContent`. When the answer does not fit the schema even after one retry, the reply keeps `Result:` and adds
`ERROR schema_mismatch: the answer did not match output_schema` with up to 5 `- path: problem` lines (`ERROR no_answer`
when the run gave no answer to make JSON from). A schema that cannot be used is refused before the task starts:
`ERROR invalid_schema: output_schema: <why>`. A schema adds one small model call to a task whose browser agent did not
already return matching JSON, and one more when that JSON does not fit.

A call returns within 120 s (50 s for a client that takes no progress updates) with `Still running after 120 s; the job
carries on`, and your agent waits again with `get_job`. A tool call that is cancelled or times out leaves the job running
too: `get_job` (or `list_jobs`, for its id) gets it, and only `cancel_job` stops it.

When every browser is busy, a job says `QUEUED`: it starts by itself as one frees up, each organization taking its turn
(at most 5 tasks running at once per organization while others wait). One that cannot start within 15 minutes ends
`NOT DONE` with `Next: rerun_job …`: nothing ran and nothing was charged, so send it again. A paused job picks up from
where it left off with `follow_up` and the text "Continue" (in a new browser when its machine was lost). A job whose
machine stopped before it did anything on a site starts again by itself, once.

## Writing tasks

Send the whole web task in one `browser_task`, however many sites and steps it has: "find the cheapest return flight
on MakeMyTrip, then book a hotel near the beach for those dates on Booking.com". pilotfish splits it into parts, asks
for every sign-in it needs at the start, carries what each site gives to the next and checks the end result. Say in
the task what may be completed without asking ("pay with my saved card", "go ahead and submit"); anything else that
is final waits for a yes.

A site that offers its own tools to agents through [WebMCP](https://webmachinelearning.github.io/webmcp/) (the
origin trial's sites in Chrome) has them used where they fit, under the same rules: a tool that pays, sends or deletes,
or that the site marks as consequential, waits for a yes like the same button would.

A task that names no site ("research Postgres vs MySQL for a startup") may be answered from a web search, every fact
linked to its page, with no browser. A price or availability for particular dates is always read on the site itself.

Your agent gets the rest from the tools' own descriptions: when to split a task itself, and how to pass on what the
person says while a task runs (`message_job`).

## When a job needs a person

A one-time code with no saved source, a CAPTCHA it could not clear, a sign-in or a payment to approve: clients that
support it open pilotfish's answer page, and other clients get the link in the tool result. The answer page shows the
browser live and lets the person take over, so they can type a code or sign in right there. Codes and passwords never
pass through the agent.

## Pricing

Pay as you go from the organization's prepaid credit: browser time at $0.05 per browser-hour (billed in whole minutes),
residential traffic at $4 per GB, models at their token price plus 20%, and CAPTCHAs per solve. Each task shows its
cost as it runs. Full prices: [pilotfish.gai.ventures/pricing](https://pilotfish.gai.ventures/pricing). For volume
pricing or your own proxies, [talk to us](https://pilotfish.gai.ventures/contact).

## Settings

Only for this package (the relay). Clients that connect to the URL need none.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PILOTFISH_KEY` | | An API key (`pf_…`): one of your organization's, or a personal key (admins, and members an admin allowed). Leave it out after `login` to use your own sign-in. |
| `PILOTFISH_URL` | `https://pilotfish-be.gai.ventures` | The pilotfish API, or its `/mcp` URL. |
| `PILOTFISH_TOKEN_FILE` | `~/.pilotfish/mcp-managed.json` | Where `login` keeps this machine's sign-in. |

## Troubleshooting

- **401 Unauthorized:** the key was revoked or rotated, or your organization was deleted. Ask an admin for a current
  key (**Org settings → API keys**), or sign in from your client instead. Signed in with `login`: run `login` again
  (a sign-in unused for 30 days ends).
- **Not signed in:** run `npx -y @gaiventures/pilotfish-mcp-managed login` on that machine, or set `PILOTFISH_KEY`.
- **Codex stops the call after a minute:** keep `tool_timeout_sec = 180` as above; the task itself carries on.
- **A call timed out or was cancelled:** the task carries on. `get_job {id}` gets its result (`list_jobs` lists the id);
  `cancel_job` stops it.
- **Session not found (404):** pilotfish was updated, or the connection sat unused for 30 minutes. This relay opens a
  new session by itself; a client connected by URL reconnects (restart it if it does not).
- **`npx` fails, or the relay won't start:** check `node --version` is 22 or newer; on Windows, start it through
  `cmd /c` as above.
- **`shared_project` or `personal_project`:** saved logins and saved tasks are in Personal, identities in a shared
  project: `switch_project` to the right one (an organization API key stays in its own).
- **`identity_busy`:** that identity already has a task running; wait for it or stop it.
- **A task is refused (`ERROR no_credits`, `allocation_used`, `org_limit`):** the reason and whom to ask are in the
  result, with the page to fix it; the table under "Organizations, members and money" above lists each one.
- **`ERROR not_found: no job … of yours`:** the id is wrong, the session was deleted, or the job is another person's
  (an organization key reaches only the tasks it started). `list_jobs` lists yours.
- **`ERROR not_running` from `cancel_job`:** the job has already ended; nothing to stop.
- **`ERROR start_rate`, `queue_full` or `rate_limited`:** too many tasks or requests at once; the `Next:` line says when
  to try again.

## Source and issues

- Source: [gAI-ventures/pilotfish-mcp](https://github.com/gAI-ventures/pilotfish-mcp/tree/main/packages/mcp-managed) on GitHub.
  The relay is published from there, with npm provenance.
- Issues: [github.com/gAI-ventures/pilotfish-mcp/issues](https://github.com/gAI-ventures/pilotfish-mcp/issues).

## License

This relay is MIT licensed. The pilotfish service is covered by its
[terms](https://pilotfish.gai.ventures/terms).
