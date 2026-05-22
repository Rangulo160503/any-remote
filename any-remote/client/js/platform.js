/** Device / browser / network detection. */

const UA = navigator.userAgent || "";

export function detectPlatform() {
    const ios = /iPhone|iPad|iPod/i.test(UA);
    const android = /Android/i.test(UA);
    const safari =
        ios || (/Safari/i.test(UA) && !/Chrome|CriOS|FxiOS|EdgiOS/i.test(UA));
    const mobile =
        ios ||
        android ||
        (navigator.maxTouchPoints > 0 &&
            window.matchMedia("(max-width: 900px)").matches);

    let safariVersion = "";
    const m = UA.match(/Version\/(\d+(?:\.\d+)?)/);
    if (m) safariVersion = m[1];

    const device = ios
        ? /iPad/i.test(UA)
            ? "iPad"
            : "iPhone"
        : android
          ? "Android"
          : "desktop";

    return {
        mobile,
        safari,
        ios,
        android,
        device,
        os: ios ? "iOS" : android ? "Android" : "desktop",
        safariVersion,
        isSafariMobile: mobile && safari,
    };
}

export function getNetworkType() {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!c) return "unknown";
    return c.effectiveType || c.type || "unknown";
}

export function getClientId() {
    const key = "any-remote-client-id";
    let id = localStorage.getItem(key);
    if (!id) {
        id = crypto.randomUUID?.() || `c${Date.now().toString(36)}`;
        localStorage.setItem(key, id);
    }
    return id;
}

export function clientMeta(platform) {
    return {
        device: platform.device,
        os: platform.os,
        safariVersion: platform.safariVersion || "—",
        networkType: getNetworkType(),
        screen: `${screen.width}x${screen.height}`,
        dpr: window.devicePixelRatio || 1,
    };
}
