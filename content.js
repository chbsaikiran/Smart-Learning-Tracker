/**
 * Smart Learning Tracker — content script
 * Sends periodic heartbeats while the page is visible so the service worker can
 * attribute time accurately (MV3 alarms cannot fire faster than ~1 minute).
 * Reports whether likely media playback is active for passive vs active learning.
 */
(function () {
  function mediaLikelyPlaying() {
    const nodes = document.querySelectorAll("video, audio");
    for (const el of nodes) {
      if (el.paused || el.muted) continue;
      // currentTime > 0 avoids counting uninitialized players
      if (el.readyState >= 2 && el.currentTime > 0) return true;
    }
    return false;
  }

  function sendHeartbeat() {
    if (document.visibilityState !== "visible") return;
    chrome.runtime.sendMessage({
      type: "heartbeat",
      mediaPlaying: mediaLikelyPlaying(),
    }).catch(() => {});
  }

  // Visible-tab updates ~5s (background dedupes to active tab only)
  setInterval(sendHeartbeat, 5000);
  document.addEventListener("visibilitychange", sendHeartbeat);
  // Initial ping when script loads on an already-visible tab
  sendHeartbeat();
})();
