// @pilotfish/browser — launch and drive Chromium-family browsers over raw CDP. A host plugs its own browser code in
// through the hooks below (setLaunchExtension, setInputDriver, Browser.route, Browser.contextProxy, Browser.inputProfile).
export { launch, connect, findChromium, defaultArgs, launchFailureMessage, chromeVersionOf } from "./launcher.js";
export type { LaunchOptions, LaunchedProcess } from "./launcher.js";
export { setLaunchExtension, launchExtension } from "./extensions.js";
export type { LaunchExtension, LaunchSpawn, LaunchDisplay, PreparedLaunch } from "./extensions.js";
export { setInputDriver, inputDriver } from "./input-driver.js";
export type { InputDriver, InputDriverFactory, InputPause, PathPoint, TypingPace } from "./input-driver.js";
export { Browser } from "./browser.js";
export { proxyHasCredentials } from "./browser.js";
export type { BrowserContextOptions, BrowserEvents, ContextProxy, DownloadEvent, InputProfile, RouteOracle } from "./browser.js";
export { Page, FrameSession, ActionError, sleep, addWorkerInitializer } from "./page.js";
export type { WaitUntil, SettleOptions, SettleResult, WriteSummary, DialogInfo, DialogHandler, Point, Rect, PageEvents } from "./page.js";
export type { InputPhase, NavigateResult, WorkerInitializer } from "./page.js";
export { NetworkTracker, waitForNetworkIdle, isNoiseRequest, isAdFrameUrl, siteOf } from "./network.js";
export type { NetworkStats, WriteRequest } from "./network.js";
export { parseShortcut, describeKey } from "./keys.js";
export { CHROME_SERVICE_HOSTS, isNonPublicAddress } from "./network.js";
export { RequestInterceptor, mergeHeaders } from "./intercept.js";
export { blockPageWrites } from "./write-guard.js";
export { PageTools, pageToolOutputText, describeToolInput } from "./webmcp.js";
export type { PageTool, PageToolAnnotations, PageToolResult } from "./webmcp.js";
export type { Interception, PausedRequest, RequestHandler, HandlerRegistration } from "./intercept.js";
export type { KeyDescriptor, ParsedShortcut } from "./keys.js";
