/**
 * Remote pointer state machine — true down/move/up semantics (Citrix-grade).
 */

export class PointerController {
    constructor(sendInput, coordsAt) {
        this.send = sendInput;
        this.coordsAt = coordsAt;
        this.buttons = { leftDown: false, rightDown: false, middleDown: false };
        this.dragLock = false;
        this.lastSent = { x: 0.5, y: 0.5 };
        this.lastSendMs = 0;
    }

    get anyDown() {
        return this.buttons.leftDown || this.buttons.rightDown || this.buttons.middleDown;
    }

    activeButton() {
        if (this.buttons.leftDown) return "left";
        if (this.buttons.rightDown) return "right";
        if (this.buttons.middleDown) return "middle";
        return null;
    }

    _coords(clientX, clientY) {
        if (clientX != null && clientY != null) {
            const c = this.coordsAt(clientX, clientY);
            if (c) return c;
        }
        return { ...this.lastSent };
    }

    _throttle(ms) {
        const now = Date.now();
        if (now - this.lastSendMs < ms) return true;
        this.lastSendMs = now;
        return false;
    }

    pointerDown(clientX, clientY, button = "left") {
        const c = this._coords(clientX, clientY);
        if (button === "left") this.buttons.leftDown = true;
        if (button === "right") this.buttons.rightDown = true;
        if (button === "middle") this.buttons.middleDown = true;
        this.lastSent = c;
        this.send({ t: "down", button, x: c.x, y: c.y });
        document.body.classList.add("remote-drag");
    }

    pointerMove(clientX, clientY, force = false) {
        const c = this._coords(clientX, clientY);
        const ms = this.anyDown ? 12 : 28;
        if (!force && this._throttle(ms)) return;
        this.lastSent = c;
        this.send({ t: "move", x: c.x, y: c.y });
    }

    pointerUp(clientX, clientY, button) {
        const btn = button || this.activeButton() || "left";
        const c = this._coords(clientX, clientY);
        if (btn === "left") this.buttons.leftDown = false;
        if (btn === "right") this.buttons.rightDown = false;
        if (btn === "middle") this.buttons.middleDown = false;
        this.lastSent = c;
        this.send({ t: "up", button: btn, x: c.x, y: c.y });
        if (!this.anyDown && !this.dragLock) {
            document.body.classList.remove("remote-drag");
        }
    }

    releaseAll(clientX, clientY) {
        if (this.buttons.leftDown) this.pointerUp(clientX, clientY, "left");
        if (this.buttons.rightDown) this.pointerUp(clientX, clientY, "right");
        if (this.buttons.middleDown) this.pointerUp(clientX, clientY, "middle");
        this.dragLock = false;
        document.body.classList.remove("remote-drag");
    }

    click(clientX, clientY, button = "left") {
        this.pointerDown(clientX, clientY, button);
        this.pointerUp(clientX, clientY, button);
    }

    doubleClickAt(x, y) {
        this.click(null, null, "left");
        setTimeout(() => this.click(null, null, "left"), 70);
    }

    rightClick(clientX, clientY) {
        this.click(clientX, clientY, "right");
    }

    enableDragLock() {
        this.dragLock = true;
        if (!this.buttons.leftDown) {
            this.pointerDown(null, null, "left");
        }
    }

    disableDragLock() {
        this.dragLock = false;
        if (this.buttons.leftDown) {
            this.pointerUp(null, null, "left");
        }
    }
}
