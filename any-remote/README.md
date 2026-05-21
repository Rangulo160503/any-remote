# Any-Remote MVP

Minimal remote desktop: **PC CASA** (host) streams its screen; **PC AFZ** (browser) views and controls it over **Tailscale**.

## Project structure

```
any-remote/
├── host.py              # Run on PC CASA — HTTP signaling + WebRTC
├── stream_config.py     # Quality presets (low / balanced / high)
├── ice_config.py        # STUN + SDP candidate filtering (srflx only)
├── screen_track.py      # mss capture → aiortc VideoStreamTrack
├── input_handler.py     # DataChannel JSON → pyautogui
├── requirements.txt
├── README.md
└── client/
    ├── index.html       # Controller UI (served by host)
    └── client.js        # WebRTC viewer + input sender
```

## How the libraries work together

| Library | Role |
|---------|------|
| **mss** | Background thread grabs the primary monitor, scales to ≤720p |
| **aiortc** | Encodes frames as WebRTC video; receives input on `RTCDataChannel` |
| **pyautogui** | On PC CASA, moves/clicks the mouse from normalized coordinates |

Flow:

1. `ScreenCapture` (mss) → latest RGB frame in memory  
2. `ScreenStreamTrack.recv()` (aiortc) → `VideoFrame` → browser `<video>`  
3. Browser `client.js` → JSON on DataChannel `"input"`  
4. `input_handler.py` (pyautogui) → `moveTo` / `click` on PC CASA  

## Prerequisites

- Python 3.10+ on **PC CASA**
- [Tailscale](https://tailscale.com/) installed and logged in on **both** PCs (different Wi‑Fi is fine)
- PC CASA must have an **active graphical session** (logged-in desktop; pyautogui needs a real display)
- Windows: allow inbound TCP **8080** on PC CASA (Firewall)

## Install (PC CASA only)

```powershell
cd c:\Users\joel\Documents\TCU\Any\any-remote
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
```

## Run

### 1. Tailscale IP on PC CASA

```powershell
tailscale ip -4
```

Example: `100.64.12.34`

### 2. Start host on PC CASA

```powershell
cd c:\Users\joel\Documents\TCU\Any\any-remote
.\.venv\Scripts\activate
python host.py                    # balanced: 960×540 @ 12 FPS
python host.py --quality high     # 1280×720 @ 15 FPS, higher bitrate
python host.py --quality low     # 854×480, lowest latency
```

In the browser toolbar, pick **Mobile / Balanced / High / Ultra** before **Connect**. On iPhone/iPad, **Balanced** auto-downgrades to **Mobile** (H.264, 640×360).

| Mode | Resolution | FPS | Bitrate (approx) |
|------|------------|-----|------------------|
| Mobile | 640×360 | 10 | 900 kbps |
| Balanced | 960×540 | 12 | 3 Mbps |
| High | 1280×720 | 15 | 5 Mbps |
| Ultra | 1920×1080 | 15 | 7 Mbps |

Changing quality while connected updates bitrate; higher modes may upgrade shared capture for all viewers.

Listens on `0.0.0.0:8080` (all interfaces, including Tailscale).

### 3. Open controller on PC AFZ

In Chrome or Edge:

```
http://100.64.12.34:8080
```

(Use the real Tailscale IP from step 1.)

Click **Connect**. Move the mouse over the video and click to control PC CASA.

### Optional flags

```text
python host.py --port 8080 -v          # debug logs
python host.py --cert-file cert.pem --key-file key.pem   # HTTPS
```

## Public internet (ngrok + STUN)

Use **ngrok only for HTTP signaling** (HTML, `/offer`). WebRTC media uses **UDP** with **Google STUN** — not the ngrok tunnel.

1. On PC CASA: `python host.py`
2. On PC CASA: `ngrok http 8080` → open `https://xxxx.ngrok-free.app` on the remote browser
3. Both peers use `stun:stun.l.google.com:19302` and SDP is filtered to **srflx** candidates (no host/local)

If ICE still fails, symmetric NAT may require TURN (not included yet).

## Phase summary

| Phase | Feature |
|-------|---------|
| **1** | Screen stream to browser (~18 FPS, max 1280×720) |
| **2** | Mouse move + click via WebRTC DataChannel + pyautogui |

## Troubleshooting

| Problem | Check |
|---------|--------|
| Page does not load on AFZ | Tailscale connected on both; correct IP; firewall allows 8080 on CASA |
| Connect fails | Browser console (F12); run host with `-v`; check for `typ srflx` in SDP (F12 → filtered in JS) |
| `Remote candidate could not be resolved` | Ensure STUN + candidate filter deployed; restart host; hard-refresh browser (Ctrl+F5) |
| ngrok works but no video | ngrok is signaling only; WebRTC needs UDP + srflx candidates from STUN |
| Black video (desktop) | Host running; user logged into desktop on CASA |
| iPhone Safari black / DC closed | Hard-refresh; host `-v` should show `negotiated=H264`, keyframe prime, delayed ICE cleanup; tap **Connect** once (user gesture for `play()`); try **Mobile** quality |
| Mouse does not move | Status shows DataChannel open; pyautogui works locally on CASA |
| High latency (20s+) | Restart host; use default `540p` @ 12 FPS; hard-refresh browser; ensure old code not running |
| Video stale | Fixed by latest-frame-only pipeline + `playoutDelayHint=0` in browser |

## Security note

No authentication. Anyone with the URL and Tailscale access can control the host. Use only on trusted networks / tailnets.
