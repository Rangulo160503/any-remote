/**
 * Fast startup — first frame gates recovery; 8s connect budget.
 */

import { stopAutoplayRetryLoop } from "./video-singleton.js";

export const CONNECT_BUDGET_MS = 8000;
export const ICE_DISCONNECT_MS = 10000;

export class FastConnect {
    constructor(hooks = {}) {
        this.hooks = hooks;
        this.firstFrameReceived = false;
        this.connectStartedAt = 0;
        this.stableSince = 0;
    }

    markConnectStart() {
        this.connectStartedAt = performance.now();
        this.firstFrameReceived = false;
        this.stableSince = 0;
    }

    get inStartup() {
        return !this.firstFrameReceived;
    }

    connectElapsed() {
        return performance.now() - this.connectStartedAt;
    }

    timedOut() {
        return this.connectElapsed() > CONNECT_BUDGET_MS;
    }

    notifyFirstFrame() {
        if (this.firstFrameReceived) return;
        this.firstFrameReceived = true;
        this.stableSince = performance.now();
        stopAutoplayRetryLoop();
        console.log(
            "[any-remote] first frame",
            Math.round(this.connectElapsed()),
            "ms",
        );
        this.hooks.onFirstFrame?.();
    }

    markStablePlayback() {
        if (!this.firstFrameReceived) return false;
        return performance.now() - this.stableSince > 12000;
    }
}
