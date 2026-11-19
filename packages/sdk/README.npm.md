# pilotfish SDK for TypeScript and JavaScript

Browser tasks from code, two ways, with the same names in TypeScript and [Python](https://pypi.org/project/pilotfish-ai/) (`pip install pilotfish-ai`):

- **Hosted** (`Pilotfish`): send a whole web task to pilotfish's cloud browser and get the answer back. pilotfish
  plans it, signs in with your saved logins, clears bot checks, and checks the result before it says done. Paid from
  your organization's credits.
- **Local** (`LocalBrowser`): drive Chrome on your own machine from your code, through the open MCP's browser tools.
  No account, no API key, no model calls: your code decides each step.

Both send pages as compact outlines and, after the first look, only what changed, so an agent reading them spends far
fewer tokens and each step comes back sooner.

```sh
npm install @gaiventures/pilotfish
```

Node.js 20.3 or later. Docs: <https://pilotfish.gai.ventures/docs/sdk> · REST API: <https://pilotfish.gai.ventures/docs/api>

## Hosted: tasks in pilotfish's cloud

Make an API key in the app (Org settings → API keys) and set `PILOTFISH_API_KEY`, or pass `apiKey`.

```ts
import { Pilotfish } from "@gaiventures/pilotfish";

const pf = new Pilotfish(); // reads PILOTFISH_API_KEY

const task = await pf.tasks.run({
  task: "Find the cheapest non-stop flight from Delhi to Mumbai on 12 December and report the airline, times and fare",
  startUrl: "https://www.google.com/travel/flights",
});
console.log(task.status, task.result?.result);
```

`tasks.run` starts the task and waits until it ends, or until it waits on a question for the person
(`status: "needs_input"`; pass `returnOnQuestion: false` to wait through questions). `tasks.create` returns at once with
the task's `id`, `url`, `appUrl` (watch it in the app) and `answerUrl` (where a person answers what it asks).

### Steer, answer, follow up

```ts
const t = await pf.tasks.create("Book a table for two at 8 pm tomorrow at Olive, Bandra");
for await (const event of pf.tasks.stream(t.id)) console.log(event.type);   // each event once, until it ends

await pf.tasks.message(t.id, "make it 8:30 instead");     // read before its next step
const waiting = await pf.tasks.wait(t.id);
if (waiting.question) await pf.tasks.answer(t.id, waiting.question.id, "yes");
// Codes and passwords are never sent through the API: the person enters them on waiting.answerUrl.

const next = await pf.tasks.followUp(t.id, "now add a note: window seat");  // same browser, same sign-ins
const paused = await pf.tasks.get(next.id);
if (paused.paused && paused.next === "continue") await pf.tasks.continue(next.id);
await pf.tasks.cancel(next.id);
```

How much a task asks the person: `askMode: "auto"` (the default, only what it can't do without them),
`"manual"` (also every choice the task leaves open) or `"accept_all"` (decides every choice itself from the task, the
session and the site). Sign-ins, codes and final steps the person hasn't approved stay theirs in every mode.

Also: `get`, `list` (one page) and `iterate` (all pages), `events`, `pause` / `resume` (take the browser and hand it
back), `rerun`, `thread` (the whole session), `files` and `downloadFile`, `frames`, `replayMp4`, `deleteSession`.

### Structured output

```ts
const t = await pf.tasks.run({
  task: "Price and stock of the Logitech MX Master 3S on amazon.in",
  outputSchema: { type: "object", properties: { price: { type: "number" }, inStock: { type: "boolean" } }, required: ["price", "inStock"] },
});
t.result?.data;      // { price: 8995, inStock: true } when it validates
t.result?.dataError; // else why not: { code: "schema_mismatch" | "no_answer", errors }
```

### Batches: many tasks, one request

```ts
const batch = await pf.batches.run({
  name: "Prices",
  tasks: ["Price of the MX Master 3S on amazon.in", "Price of the MX Master 3S on flipkart.com", { task: "Price on croma.com", region: "in" }],
  defaults: { maxSteps: 40 },
  webhookUrl: "https://example.com/hooks/pilotfish", // batch.finished, signed
});
for (const item of batch.items ?? []) console.log(item.status, item.result?.result, item.costUsd);
```

Up to 100 tasks run one after another under the one-task-at-a-time rule, and their results are collected together.
Each task is charged when it runs; if credits run out, the rest are skipped, never run or charged. `batches.create`,
`get`, `wait`, `list` and `cancel` (the running task is cancelled, the rest skipped).

### Identities: tasks for your own users

With an org API key (it works in a shared project), each of your end users is an identity with their own logins,
sessions, IP address and device:

```ts
const user = await pf.identities.create({ externalUserId: "user-42", label: "Ada" });
const link = await pf.identities.loginLink(user.id, { sites: ["linkedin.com"] }); // they type their own login there
await pf.tasks.run({ task: "List my 5 newest LinkedIn messages", identity: user.id });
```

Also `get`, `list`, `update`, `delete`, `usage`, `addCredential` (from your own server), `credentials`,
`setDefaultCredential`, `deleteCredential`.

### Saved tasks, schedules, usage

```ts
const saved = await pf.savedTasks.create({ name: "Daily fares", task: "Cheapest DEL-BOM fare tomorrow", options: { model: "gpt-6-luna" } });
await pf.schedules.create({ savedTaskId: saved.id, rule: { repeat: "daily", time: "08:00", tz: "Asia/Kolkata" } });
await pf.savedTasks.run(saved.id, { extraInstructions: "only non-stop" });
const usage = await pf.usage.get({ days: 30 });
```

Saved tasks and schedules live in your Personal project (a person's own key); an org key's shared project answers
`409 shared_project`.

### Errors and retries

Every error is the API's `{error, code, hint, docs, fields, retryAfterS}` as an exception: `BadRequestError` (400,
with `fields`), `AuthenticationError` (401), `PaymentRequiredError` (402: `no_credits`, `allocation_used`,
`org_limit`), `PermissionDeniedError` (403), `NotFoundError` (404), `ConflictError` (409: `one_session`,
`identity_busy`), `RateLimitError` (429, with `retryAfterS`), `ServerError` (5xx), `ConnectionError`, and
`WaitTimeoutError` from `wait` (the task carries on). All extend `PilotfishError`.

A 429 is retried after its `retryAfterS` (it refused before anything was made, so a POST is safe to send again); a 5xx
or a network failure is retried for reads only. `maxRetries` (default 2), `timeoutMs` (default 60 s per request).

### Webhooks

`job.needs_input`, `job.finished`, `job.question_withdrawn`, `identity.login_saved` and `batch.finished` are signed
with your org's webhook secret (Org settings):

```ts
import { parseWebhook } from "@gaiventures/pilotfish";

const event = await parseWebhook(process.env.PILOTFISH_WEBHOOK_SECRET!, req.headers["pilotfish-signature"], rawBody);
```

`verifyWebhook` returns true or false instead; both refuse a signature over 5 minutes old. Pass the raw body as
received, before any JSON parsing.

## Local: Chrome on your machine

```ts
import { LocalBrowser } from "@gaiventures/pilotfish";

const browser = await LocalBrowser.start({ headless: false });
await browser.navigate("https://news.ycombinator.com");
const titles = await browser.query<string[]>("[...document.querySelectorAll('.titleline > a')].slice(0, 5).map((a) => a.textContent)");
console.log(titles.value);
const page = await browser.snapshot();            // the page as an outline with refs: [e12]<a>new
await browser.click("e12");
await browser.close();
```

It starts the open MCP ([`@gaiventures/pilotfish-mcp`](https://www.npmjs.com/package/@gaiventures/pilotfish-mcp))
and talks to it over stdio: the installed package when there is one (`npm install @gaiventures/pilotfish-mcp` to pin
it), else `npx -y @gaiventures/pilotfish-mcp`. Every browser tool is a method: `navigate`, `snapshot`, `click`,
`type`, `select`, `press`, `scroll`, `actions` (up to 10 steps in one call), `query`, `find`, `getText`,
`screenshot`, `wait`, `resume`, `tabs`, `pageTool`, plus `call(name, args)` for any tool by name and `close`. Each
returns `{text, images, structured, isError}`; a tool's error is thrown as `LocalToolError` (`throwOnError: false`
returns it instead).

Options: `headless`, `allowedHosts`, `allowPrivate` (localhost, for testing your own app), `secrets` (typed as
`{{name}}`, never in any result), `chrome`, `env` (any of the MCP's settings), `command`, `timeoutMs`.

A step that looks irreversible (pay, place an order, send, delete) needs a yes, and a page that needs a person (a
sign-in, a code, a CAPTCHA) is theirs to handle in the window. Pass `onQuestion` to answer:

```ts
const browser = await LocalBrowser.start({
  onQuestion: async ({ kind, message }) => (kind === "confirm" ? await askTheUser(message) : await waitUntilDone(message)),
});
```

Without it, an irreversible step is refused, and a page that needs a person says `NEEDS A PERSON` in the result (call
`resume()` once it is handled).

## Links

- Docs: <https://pilotfish.gai.ventures/docs/sdk> · REST API reference: <https://pilotfish.gai.ventures/docs/api>
- Source: [gAI-ventures/pilotfish-ai](https://github.com/gAI-ventures/pilotfish-ai/tree/main/packages/sdk) on GitHub.
  Issues: <https://github.com/gAI-ventures/pilotfish-ai/issues>.

## License

MIT
