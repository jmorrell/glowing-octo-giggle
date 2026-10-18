import { WorkerEntrypoint } from "cloudflare:workers";
import type { HostCapabilities, ProcessRequest, ProcessResult, ProcessorEntrypoint, SearchSegment } from "../../contract";

declare const TRANSCRIBE_MODEL: string; // set per release by scripts/build-plugins.mjs

const FRAME_TIMES = [0, 5, 10];
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

function title(request: ProcessRequest): string {
  let input = request.item.input;
  return input.kind === "upload" ? input.filename.replace(/\.[^.]+$/, "") : "Video";
}

export default class VideoProcessor extends WorkerEntrypoint implements ProcessorEntrypoint {
  async process(request: ProcessRequest, host: HostCapabilities): Promise<ProcessResult> {
    switch (request.processor) {
      case "media":
        return this.media(request, host);
      case "transcript":
        return this.transcript(host);
      case "frames":
        return this.frames(host);
      default:
        throw new Error(`Unknown processor ${request.processor}`);
    }
  }

  // Cheap and first, so the item is presentable before paid derivatives finish.
  private async media(request: ProcessRequest, host: HostCapabilities): Promise<ProcessResult> {
    let head = await host.readOriginal({ offset: 0, length: 4 });
    if (!EBML_MAGIC.every((byte, index) => head[index] === byte)) throw new Error("Not a WebM/Matroska file");
    let name = title(request);
    return {
      metadata: { title: name },
      search: [{ text: name }],
      views: {
        card: { title: name, subtitle: "Video", image: { processor: "frames", name: "poster.bmp" }, badges: ["video"] },
        detail: {
          template: "media",
          media: "original",
          cues: { processor: "transcript", name: "cues.json" },
          thumbnails: { processor: "frames", name: "thumbnails.json" },
        },
      },
    };
  }

  private async transcript(host: HostCapabilities): Promise<ProcessResult> {
    let cues = await host.transcribe({ model: TRANSCRIBE_MODEL });
    await host.putArtifact("cues.json", JSON.stringify({ cues }), "application/json");
    let search: SearchSegment[] = cues.map((cue) => ({ text: cue.text, target: { type: "time", start: cue.start, end: cue.end } }));
    return { search };
  }

  private async frames(host: HostCapabilities): Promise<ProcessResult> {
    let frames = await host.extractFrames({ at: FRAME_TIMES });
    let search: SearchSegment[] = [];
    let thumbnails = [];
    for (let [index, frame] of frames.entries()) {
      let name = `frame-${frame.at}.bmp`;
      await host.putArtifact(name, frame.image, frame.mediaType);
      if (index === 0) await host.putArtifact("poster.bmp", frame.image, frame.mediaType);
      thumbnails.push({ at: frame.at, image: { processor: "frames", name } });
      let description = await host.describeImage({ image: frame.image, mediaType: frame.mediaType });
      let end = FRAME_TIMES[index + 1] ?? frame.at + 5;
      search.push({ text: description.text, target: { type: "time", start: frame.at, end } });
    }
    await host.putArtifact("thumbnails.json", JSON.stringify({ frames: thumbnails }), "application/json");
    return { search };
  }
}
