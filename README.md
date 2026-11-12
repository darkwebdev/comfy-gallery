# comfy-gallery

A phone-first gallery for ComfyUI renders. It reads the generation graph ComfyUI embeds in each PNG and shows what made the image: model, LoRAs with strengths, prompt and negative, seed, steps, CFG, sampler, size and date.

It exists because general image browsers miss LoRAs and show no model for graphs that load it with `UNETLoader`, and are cramped on phones.

## Features

- Grid of every image under your ComfyUI output folder, newest first, with folder, model, LoRA and text filters.
- Swipe carousel with a resizable details sheet (arrows, ←/→ keys, tap or drag on touch).
- Render time per image, taken from ComfyUI's job history and kept across ComfyUI restarts.
- Move an image to the system Trash from the viewer.
- Optional ComfyUI sidebar tab ("Renders") that embeds the gallery and opens an image's workflow in a new workflow tab.
- Thumbnails cached on disk (480 px).

## Install

Needs Python 3.11+ and a ComfyUI install.

```bash
git clone https://github.com/darkwebdev/comfy-gallery.git
cd comfy-gallery
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env   # set GALLERY_ROOT to your ComfyUI output folder
./run.sh
```

Open http://127.0.0.1:8189, or `http://<your-computer>.local:8189` from a phone on the same network.

### Settings

Set these in `.env` or the environment.

| Variable | Default | What it does |
| --- | --- | --- |
| `GALLERY_ROOT` | `~/ComfyUI/output` | Folder of images to show (searched recursively) |
| `COMFY_URL` | `http://127.0.0.1:8188` | ComfyUI server, used for render times and workflow lookups |
| `GALLERY_CACHE` | `./cache` | Thumbnails and saved render times |
| `GALLERY_HOST` | `0.0.0.0` | Address to listen on; use `127.0.0.1` to keep it local |
| `GALLERY_PORT` | `8189` | Port |

## ComfyUI sidebar tab

Copy or symlink `comfyui-extension/comfy-gallery-tab` into `ComfyUI/custom_nodes/` and restart ComfyUI. A "Renders" tab appears in the left sidebar. On phones it covers the whole screen. It expects the gallery on port 8189 of the same host.

## Start at login (macOS)

Edit the paths in `launchd/local.comfy-gallery.plist`, then:

```bash
cp launchd/local.comfy-gallery.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.comfy-gallery.plist
```

launchd starts it at login and restarts it within 30 seconds if it stops. Useful commands:

```bash
launchctl kickstart -k gui/$(id -u)/local.comfy-gallery   # restart
launchctl bootout gui/$(id -u)/local.comfy-gallery        # stop and disable
```

The log goes to `launchd.log` in the project folder.

## Security

There is no login. Anyone who can reach the port can view your images and move them to the Trash. By default it listens on all interfaces, which is meant for a trusted home network only. Set `GALLERY_HOST=127.0.0.1` if you don't need phone access, and never expose the port to the internet.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/images` | Paged, filtered image list (`folder`, `q`, `model`, `lora`, `offset`, `limit`) |
| `GET /api/meta` | Parsed generation details for one image |
| `GET /api/siblings` | Images written by the same run, per Save Image node |
| `POST /api/delete` | Move an image to the Trash |
| `GET /thumb`, `GET /full` | Thumbnail and full image |
