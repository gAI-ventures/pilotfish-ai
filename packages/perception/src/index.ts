// @pilotfish/perception — structure-first page perception for agents.
export { captureSnapshot, withCaptureStats, currentCaptureStats, markSensitiveField, nodeKey, groupKey, textOf, pageAttrs, isCaptureMeta } from "./snapshot.js";
export type { Snapshot, SnapNode, SnapshotOptions, SnapshotTimings } from "./snapshot.js";
export { serializeSnapshot, pageText, openPanels, pageLinks, findInSnapshot, findScored, describeNode, clip, controlStates, urlParams, choiceOf } from "./serialize.js";
export type { FindHit } from "./serialize.js";
export type { SerializeOptions } from "./serialize.js";
export { handleFor, resolveHandle } from "./handles.js";
export type { ElementHandle, ResolveResult } from "./handles.js";
export { diffSnapshots, formatEvidence, headingOf, breadcrumbOf } from "./evidence.js";
export { applyInOrder, diffObservation } from "./observation.js";
export type { ObservationDiff } from "./observation.js";
export type { ActionEvidence, ValueChange } from "./evidence.js";
export * from "./interrupts.js";
export type { PageTextOptions } from "./serialize.js";
