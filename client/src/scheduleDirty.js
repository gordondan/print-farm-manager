// Cross-page signal that the Print Queue's inputs just changed.
//
// The Print Queue also polls a server-side fingerprint, so it will notice any change on
// its own within a few seconds. This event makes the common case immediate: when an
// operator edits a part on the Projects page and switches to Fleet, the queue should
// already be recalculating rather than showing a list built from the old inputs.
//
// Window CustomEvent rather than shared state, following the farmNameChanged pattern in
// App.jsx: this client has no providers, no context, and no state library.

export const SCHEDULE_DIRTY_EVENT = 'scheduleDirty';

export function signalScheduleDirty() {
  window.dispatchEvent(new CustomEvent(SCHEDULE_DIRTY_EVENT));
}
