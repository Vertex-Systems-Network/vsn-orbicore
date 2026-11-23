// Temporary CI-only test extension. Playwright invokes the native tabs zoom API.
// No page injection, no network activity, no access to credentials.
chrome.runtime.onInstalled.addListener(() => {});
