// Every text the mod shows, in English. `{name}` marks a value filled in by
// `t(key, params)`. A translation is a file like this one with the same keys
// (see README, "Adding a language").
export const en = {
    // Button next to the tabs, floating pill over the tab.
    "toggle.label": "Sessions · {count}",
    "pill.sleep": "Sleep · {agent}",
    // Asking before putting a working agent to sleep.
    "confirm.title": "{agent} is still answering",
    "confirm.sleepWhenDone": "Sleep when done",
    "confirm.interruptAndSleep": "Interrupt and sleep",
    "confirm.cancel": "Cancel",
    "confirm.unsentInput": "Unsent input will be lost",
    // The strip of a sleeping tab.
    "strip.resume": "Resume",
    "strip.retry": "Retry",
    "strip.forget": "Forget",
    "strip.startNew": "Start new session",
    "strip.asleep": "Asleep since {time}",
    "strip.interrupted": "Interrupted by restart · {time}",
    "strip.stoppedForcefully": "Stopped forcefully, conversation kept",
    "strip.elsewhere": "This session is open elsewhere — close it there to resume here",
    "strip.missing": "Conversation no longer exists on disk",
    "strip.updatedAfterSleep": "Updated after sleep · {time} · +{count} messages",
    "strip.waking.found": "Found session",
    "strip.waking.starting": "Starting",
    "strip.waking.ready": "Ready",
    // The Sessions panel.
    "panel.title": "Sessions",
    "panel.empty": "No agent sessions yet — start Claude Code or Codex in any tab",
    "panel.memoryFreed": "{amount} memory freed",
    "panel.resumeAll": "Resume all in project",
    "panel.skippedElsewhere": "Skipped: open elsewhere",
    // Errors and notices (session `error` fields hold these keys).
    "error.startFailed": "Couldn't start {agent}: {reason}",
    "error.startTimeout": "{agent} didn't start within 30 seconds",
    "notice.skippedElsewhere": "Some sessions are open elsewhere and were skipped",
    "notice.layoutOutdated": "Suspender couldn't update its layout for Herdr {version}",
};
