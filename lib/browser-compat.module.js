import './browser-compat.js';

const compat = globalThis.__OVD_BROWSER_COMPAT__ || {};

export const browserInfo = compat.browserInfo;
export const detectBrowser = compat.detectBrowser;
export const pauseDownloadAsync = compat.pauseDownloadAsync;
export const resumeDownloadAsync = compat.resumeDownloadAsync;
export const safeRuntimeMessage = compat.safeRuntimeMessage;
export const safeTabMessage = compat.safeTabMessage;
export const sendRuntimeMessageAsync = compat.sendRuntimeMessageAsync;
export const sendTabMessageAsync = compat.sendTabMessageAsync;
export const supportsDownloadPause = compat.supportsDownloadPause;
export const supportsDownloadResume = compat.supportsDownloadResume;
