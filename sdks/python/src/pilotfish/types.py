"""The shapes the REST API takes and gives (https://pilotfish.gai.ventures/docs/api).

Field names are the API's own (camelCase). These are ``TypedDict``s for editor help only: the client returns the
API's JSON as plain dicts, extra fields included, and never checks them against these shapes.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, TypedDict, Union

TaskStatus = Literal["queued", "running", "needs_input", "done", "failed", "cancelled"]
BatchStatus = Literal["running", "done", "cancelled", "stopped"]


class PreApproved(TypedDict, total=False):
    """What a task may do without asking: only with the person's explicit say-so."""

    kinds: List[Literal["pay", "delete", "send", "transfer", "cancel"]]
    maxAmount: float
    currency: str
    hosts: List[str]


class UploadFile(TypedDict, total=False):
    """A file for the task to upload or read: its bytes in base64 (up to 10 files, 25 MB in all)."""

    name: str
    type: str
    data: str


class TaskRequest(TypedDict, total=False):
    """POST /jobs: a task and its settings. Only ``task`` is needed; any other field the API takes may be added."""

    task: str
    startUrl: str
    model: str
    maxSteps: int
    timeoutMs: int
    region: str
    sites: List[str]
    login: str
    accounts: Dict[str, str]
    identity: str
    credentials: List[str]
    preApproved: PreApproved
    allowedHosts: List[str]
    stealth: bool
    solve: bool
    askMode: Literal["auto", "manual", "accept_all"]
    proxy: str
    webhookUrl: str
    outputSchema: Dict[str, Any]
    trial: bool
    files: List[UploadFile]


#: The ways a sign-in page can offer, as ``Question["signIn"]["ways"]`` lists them (the API's own list, kept equal to it
#: by the API's tests). ``password``: an email, phone or username and a password. ``phone_code``: a phone number and a
#: code sent by text. ``email_code``: an email address and a code or link sent there. ``identifier_first``: the email,
#: phone or username first, the rest on the site's next page. ``passkey``: a passkey, in the browser.
SIGN_IN_WAYS = ("password", "phone_code", "email_code", "identifier_first", "passkey")
SignInWay = Literal["password", "phone_code", "email_code", "identifier_first", "passkey"]


class SignInAsk(TypedDict, total=False):
    """A sign-in question's ways (``Question["signIn"]``, category ``login``), read from the live page when it was asked.

    Show the person these and no others; the details themselves are typed on ``answerUrl``. Read it with
    ``pilotfish.sign_in_of``, which checks it.
    """

    #: In the page's order, the way its own form shows first leading. Empty with no ``providers``: it could not be read.
    ways: List[SignInWay]
    #: Providers it offers by name ("Google", "Apple"), done in the browser.
    providers: List[str]
    #: The way the form opens on: the person's when the page offers it, else the page's first. One of ``ways``.
    opensOn: SignInWay
    #: The way the person asked for that the page does not offer (never one of ``ways``).
    asked: SignInWay
    #: The page's own words for its sign-in.
    pageWords: str


class Question(TypedDict, total=False):
    """A question a task is waiting on (status ``needs_input``). Codes and passwords are answered on ``answerUrl``."""

    id: str
    kind: str
    #: For a hand-off: what the page shows (``login``, ``captcha``, ``otp``...).
    category: str
    message: str
    text: str
    question: str
    options: List[str]
    #: A sign-in (category ``login``): the ways its page offers.
    signIn: SignInAsk
    askedAt: int
    expiresAt: int


class TaskResult(TypedDict, total=False):
    """What a finished task found."""

    success: bool
    result: str
    outcome: str
    stopReason: str
    steps: int
    data: Dict[str, Any]
    dataError: Dict[str, Any]
    error: str
    report: Dict[str, Any]
    blocked: Dict[str, Any]
    paused: bool
    next: str
    costUsd: float


class Cost(TypedDict, total=False):
    modelUsd: float
    proxyUsd: float
    browserUsd: float
    captchaUsd: float
    totalUsd: float


class Task(TypedDict, total=False):
    """A task (a job) as the API shows it."""

    id: str
    threadId: str
    status: TaskStatus
    task: str
    question: Optional[Question]
    result: Optional[TaskResult]
    createdAt: int
    updatedAt: int
    finishedAt: Optional[int]
    project: str
    identity: str
    paused: bool
    next: Literal["continue", "answer", "sign_in", "retry_region"]
    url: str
    appUrl: str
    answerUrl: str
    settings: Dict[str, Any]
    cost: Cost
    control: Optional[str]
    live: Optional[Dict[str, Any]]


class TaskEvent(TypedDict, total=False):
    """One of a task's events (steps, questions, files...)."""

    seq: int
    at: int
    type: str
    data: Dict[str, Any]


class Answer(TypedDict, total=False):
    """An answer to a task's question: ``{"type": "yes"|"no"|"done"|"skip"|"cancel"|"text"|"code", ...}``."""

    type: Literal["yes", "no", "done", "skip", "cancel", "text", "code"]
    text: str
    code: str
    reason: str


class SessionFile(TypedDict, total=False):
    """A file of a task's session (attached, or downloaded by the run)."""

    id: str
    name: str
    mime: str
    size: int
    origin: str
    url: str
    createdAt: int


class FollowUpRequest(TypedDict, total=False):
    """A follow-up: the next instruction in the same session (same browser while it is kept, same sign-ins)."""

    text: str
    model: str
    region: str
    outputSchema: Optional[Dict[str, Any]]
    files: List[UploadFile]
    login: Dict[str, Any]


class BatchRequest(TypedDict, total=False):
    """POST /batches: up to 100 tasks, run one after another."""

    tasks: List[Union[str, TaskRequest]]
    defaults: Dict[str, Any]
    name: str
    webhookUrl: str


class BatchItem(TypedDict, total=False):
    index: int
    task: str
    status: str
    jobId: Optional[str]
    error: str
    costUsd: float
    result: Optional[TaskResult]
    startedAt: Optional[int]
    endedAt: Optional[int]
    appUrl: str
    #: Where a person answers the task's questions (the batch's maker only; never in a webhook).
    answerUrl: str


class BatchCounts(TypedDict, total=False):
    total: int
    pending: int
    running: int
    done: int
    failed: int
    cancelled: int
    skipped: int


class Batch(TypedDict, total=False):
    id: str
    name: Optional[str]
    status: BatchStatus
    reason: str
    counts: BatchCounts
    costUsd: float
    project: str
    createdAt: int
    updatedAt: int
    finishedAt: Optional[int]
    url: str
    items: List[BatchItem]


class IdentityLogin(TypedDict, total=False):
    credential: str
    site: str
    account: str
    username: str
    hasPassword: bool
    hasTotp: bool
    default: bool


class Identity(TypedDict, total=False):
    """One of your product's end users, in a shared project: their own logins, sessions, IP address and device."""

    id: str
    label: str
    externalUserId: Optional[str]
    project: str
    country: Optional[str]
    deviceOs: Optional[Literal["windows", "macos"]]
    email: Optional[str]
    saveLogins: bool
    createdAt: int
    lastUsedAt: Optional[int]
    logins: List[IdentityLogin]
    signedIn: List[Dict[str, str]]
    existed: bool


class IdentityCreate(TypedDict, total=False):
    label: str
    externalUserId: str
    country: Optional[str]
    deviceOs: Optional[Literal["windows", "macos"]]
    email: Optional[str]
    saveLogins: bool


class CredentialCreate(TypedDict, total=False):
    site: str
    username: str
    password: str
    totp: str
    otp: Literal["email", "sms"]
    account: str
    default: bool


class LoginLink(TypedDict, total=False):
    url: str
    expiresAt: int
    sites: List[str]
    webhookUrl: str


class SavedTaskOptions(TypedDict, total=False):
    """The settings a saved task keeps."""

    startUrl: str
    region: str
    sites: List[str]
    login: str
    preApproved: PreApproved
    model: str
    allowedHosts: List[str]
    stealth: bool
    solve: bool
    askMode: Literal["auto", "manual", "accept_all"]
    outputSchema: Dict[str, Any]


class SavedTask(TypedDict, total=False):
    id: str
    name: str
    task: str
    options: SavedTaskOptions
    runs: int
    lastRunAt: Optional[int]


class ScheduleRule(TypedDict, total=False):
    """When a schedule runs: ``repeat`` once (with ``date``), daily, weekdays, weekly (with ``days``, 1 = Monday) or
    monthly (with ``day``, 1-28), at ``time`` (HH:MM) in ``tz``."""

    repeat: Literal["once", "daily", "weekdays", "weekly", "monthly"]
    time: str
    tz: str
    date: str
    days: List[int]
    day: int


class Schedule(TypedDict, total=False):
    savedTaskId: str
    rule: ScheduleRule
    paused: bool
    nextRunAt: Optional[int]
    lastRunAt: Optional[int]
    lastStatus: Optional[str]
    describe: str
    task: Optional[SavedTask]


class Frame(TypedDict, total=False):
    seq: int
    at: int
    step: int
    label: str
    url: str


class WebhookEvent(TypedDict, total=False):
    """What a webhook delivery's body holds."""

    type: str
    jobId: str
    batchId: str
    at: int
    data: Dict[str, Any]


Usage = Dict[str, Any]
"""GET /me/usage: spending by kind, day, model and task, and what is left of an allowance."""
