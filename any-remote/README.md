# Any-Remote MVP

Minimal remote desktop: **PC CASA** (host) streams its screen; **PC AFZ** (browser) views and controls it over **Tailscale**.

## Project structure

```
any-remote/
├── host.py              # Run on PC CASA — HTTP signaling + WebRTC
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
python host.py
```

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

## Phase summary

| Phase | Feature |
|-------|---------|
| **1** | Screen stream to browser (~18 FPS, max 1280×720) |
| **2** | Mouse move + click via WebRTC DataChannel + pyautogui |

## Troubleshooting

| Problem | Check |
|---------|--------|
| Page does not load on AFZ | Tailscale connected on both; correct IP; firewall allows 8080 on CASA |
| Connect fails | Browser console (F12); run host with `-v`; both machines online in Tailscale admin |
| Black video | Host running; user logged into desktop on CASA |
| Mouse does not move | Status shows DataChannel open; pyautogui works locally on CASA |
| High latency | Normal for MVP; lower capture resolution in `screen_track.py` if needed |

## Security note

No authentication. Anyone with the URL and Tailscale access can control the host. Use only on trusted networks / tailnets.
