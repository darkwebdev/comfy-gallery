// Left-sidebar tab that embeds the comfy-gallery app. Like the built-in Assets tab,
// clicking the icon again (or another tab) collapses it, and the gallery keeps its state.
// The gallery can also ask this page to open an image's workflow in a new workflow tab.
import { app } from "../../scripts/app.js";

const GALLERY_PORT = 8189;
const TAB_ID = "renders-gallery";
// phones and tablets: the side panel is too cramped, so the gallery covers the whole screen instead
const fullscreen = () => matchMedia("(max-width: 768px), (pointer: coarse)").matches;
// read at load time: the frontend rewrites the address before extensions run setup()
const PENDING_WF = new URLSearchParams(location.search).get("gallery_wf");

// path is relative to the output folder; ComfyUI serves it from /view, same origin.
async function openWorkflow(path) {
  const i = path.lastIndexOf("/");
  const q = new URLSearchParams({ filename: path.slice(i + 1), subfolder: i < 0 ? "" : path.slice(0, i), type: "output" });
  const res = await fetch(`/view?${q}`);
  if (!res.ok) return app.extensionManager.toast?.add({ severity: "error", summary: "Could not load image", detail: path, life: 4000 });
  const blob = await res.blob();
  const name = path.slice(i + 1);
  // Images saved through the API carry only the "prompt" graph. ComfyUI loads those into the
  // current tab, so open a blank tab first; images with a full workflow open their own tab anyway.
  const head = new TextDecoder("latin1").decode(await blob.slice(0, 4 << 20).arrayBuffer());
  if (!head.includes("workflow\0")) await app.extensionManager.command.execute("Comfy.NewBlankWorkflow");
  await app.handleFile(new File([blob], name, { type: blob.type }));
  await showResult(name, q.get("subfolder"));
}

// A workflow loaded from a PNG has empty Save Image nodes. Put the run's images back: each Save Image
// node gets the file it wrote in that run (the gallery looks it up from ComfyUI's job history, or by
// filename_prefix and time). If nothing is found, the opened image goes into every Save Image node.
async function showResult(filename, subfolder) {
  const saves = (app.graph?.nodes || []).filter((n) => n.type === "SaveImage");
  if (!saves.length) return;
  const prefix = (n) => String(n.widgets?.find((w) => w.name === "filename_prefix")?.value || "");
  const path = subfolder ? `${subfolder}/${filename}` : filename;
  let found = {};
  try {
    const q = new URLSearchParams({ path, nodes: JSON.stringify(Object.fromEntries(saves.map((n) => [String(n.id), prefix(n)]))) });
    found = await (await fetch(`${location.protocol}//${location.hostname}:${GALLERY_PORT}/api/siblings?${q}`)).json();
  } catch (e) {}
  const outputs = { ...(app.nodeOutputs || {}) };
  let any = false;
  for (const n of saves) {
    const f = found[String(n.id)] || (filename.startsWith(prefix(n).split("/").pop()) && prefix(n) ? { filename, subfolder } : null);
    if (f) { outputs[String(n.id)] = { images: [{ ...f, type: "output" }] }; any = true; }
  }
  if (!any) for (const n of saves) outputs[String(n.id)] = { images: [{ filename, subfolder, type: "output" }] };
  app.nodeOutputs = outputs;
  app.graph.setDirtyCanvas(true, true);
}

app.registerExtension({
  name: "comfyGallery.rendersTab",
  setup() {
    let frame, overlay;
    const closeOverlay = () => {
      if (!overlay || overlay.hidden) return;
      overlay.hidden = true;
      const sb = app.extensionManager.sidebarTab;
      if (sb.activeSidebarTabId === TAB_ID) sb.toggleSidebarTab(TAB_ID);
    };
    app.extensionManager.registerSidebarTab({
      id: TAB_ID,
      icon: "pi pi-images",
      title: "Renders",
      tooltip: "Renders gallery",
      type: "custom",
      render: (el) => {
        // keep one iframe for the whole session so scroll position and open image survive collapsing
        if (!frame) {
          frame = document.createElement("iframe");
          frame.src = `${location.protocol}//${location.hostname}:${GALLERY_PORT}/`;
          frame.style.cssText = "width:100%;height:100%;border:0;display:block;background:transparent";
          frame.allow = "clipboard-write";
        }
        if (fullscreen()) {
          if (!overlay) {
            overlay = document.createElement("div");
            overlay.style.cssText = "position:fixed;inset:0;z-index:10000;background:#111;" +
              "padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
            document.body.appendChild(overlay);
          }
          overlay.hidden = false;
          overlay.appendChild(frame);
          return;
        }
        el.style.height = "100%";
        el.appendChild(frame);
      },
    });

    window.addEventListener("message", (e) => {
      if (!frame || e.source !== frame.contentWindow) return;
      if (e.data?.type === "gallery-close") {
        if (overlay && !overlay.hidden) closeOverlay();
        else if (app.extensionManager.sidebarTab.activeSidebarTabId === TAB_ID) app.extensionManager.sidebarTab.toggleSidebarTab(TAB_ID);
      } else if (e.data?.type === "gallery-open-workflow") {
        closeOverlay();  // show the workflow that just opened
        openWorkflow(String(e.data.path));
      }
    });

    // opened from the standalone gallery as /?gallery_wf=<path>
    // ComfyUI restores its saved tabs after startup, which would swallow an early load:
    // wait until a workflow is active, then load once.
    if (PENDING_WF) {
      const ready = () => app.graph && app.extensionManager.workflow?.activeWorkflow;
      const wait = (n) => (ready() ? setTimeout(() => openWorkflow(PENDING_WF), 1000) : n > 0 && setTimeout(() => wait(n - 1), 500));
      wait(120);
    }
  },
});
