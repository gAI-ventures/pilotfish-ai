"""pilotfish SDK for Python (https://pilotfish.gai.ventures/docs/sdk).

    Pilotfish, AsyncPilotfish   the hosted client: tasks in pilotfish's cloud browser over the REST API, with an API key.
    LocalBrowser                Chrome on your own machine, driven through the open MCP's browser tools: no key, no model calls.
"""

from . import types
from ._core import CONTINUE_TEXT, DEFAULT_BASE_URL, DownloadedFile, Page, sign_in_of
from .types import SIGN_IN_WAYS
from ._version import __version__
from .client import (
    AsyncBatches,
    AsyncIdentities,
    AsyncPilotfish,
    AsyncSavedTasks,
    AsyncSchedules,
    AsyncTasks,
    AsyncUsageApi,
    Batches,
    Identities,
    Pilotfish,
    SavedTasks,
    Schedules,
    Tasks,
    UsageApi,
)
from .errors import (
    AuthenticationError,
    BadRequestError,
    ConflictError,
    ConnectionError,
    NotFoundError,
    PaymentRequiredError,
    PermissionDeniedError,
    PilotfishError,
    RateLimitError,
    ServerError,
    WaitTimeoutError,
    error_for,
)
from .local import LocalBrowser, LocalQuestion, LocalToolError, ToolResult
from .webhooks import parse_webhook, sign_webhook, verify_webhook

VERSION = __version__

__all__ = [
    "__version__",
    "VERSION",
    "types",
    "Pilotfish",
    "AsyncPilotfish",
    "Tasks",
    "Batches",
    "Identities",
    "SavedTasks",
    "Schedules",
    "UsageApi",
    "AsyncTasks",
    "AsyncBatches",
    "AsyncIdentities",
    "AsyncSavedTasks",
    "AsyncSchedules",
    "AsyncUsageApi",
    "Page",
    "DownloadedFile",
    "DEFAULT_BASE_URL",
    "CONTINUE_TEXT",
    "SIGN_IN_WAYS",
    "sign_in_of",
    "LocalBrowser",
    "LocalQuestion",
    "LocalToolError",
    "ToolResult",
    "verify_webhook",
    "parse_webhook",
    "sign_webhook",
    "PilotfishError",
    "BadRequestError",
    "AuthenticationError",
    "PaymentRequiredError",
    "PermissionDeniedError",
    "NotFoundError",
    "ConflictError",
    "RateLimitError",
    "ServerError",
    "ConnectionError",
    "WaitTimeoutError",
    "error_for",
]
