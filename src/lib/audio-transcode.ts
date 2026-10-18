const CLOUDCONVERT_API_URL = "https://api.cloudconvert.com/v2";
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 30; // ~60s ceiling

export class TranscodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscodeError";
  }
}

interface CloudConvertTask {
  id: string;
  name: string;
  status: string;
  result?: {
    form?: { url: string; parameters: Record<string, string> };
    files?: { url: string }[];
  };
  message?: string;
  code?: string;
}

interface CloudConvertJob {
  id: string;
  status: string;
  tasks: CloudConvertTask[];
}

async function cloudConvertRequest(path: string, init?: RequestInit): Promise<CloudConvertJob> {
  const apiKey = process.env.CLOUDCONVERT_API_KEY;
  if (!apiKey) {
    throw new TranscodeError("CLOUDCONVERT_API_KEY is not configured");
  }

  const res = await fetch(`${CLOUDCONVERT_API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const json = (await res.json()) as { data?: CloudConvertJob; message?: string };
  if (!res.ok || !json.data) {
    throw new TranscodeError(`CloudConvert API error: ${json.message ?? res.statusText}`);
  }
  return json.data;
}

/**
 * Transcodes an arbitrary audio buffer to MP3 via the CloudConvert API.
 *
 * Why: Meta's Cloud API only documents support for aac/amr/mp3/mp4/ogg-opus.
 * Browser MediaRecorder output (webm/opus) and assorted phone recordings
 * (m4a, wav, ...) aren't guaranteed to be accepted as-is — sends were
 * observed failing silently (status: "failed" via the delivery webhook)
 * with no conversion step. Normalizing everything removes that guesswork.
 *
 * NOTE: WhatsApp only renders the native voice-note waveform bubble (mic
 * icon, play/pause, timer) for OGG/Opus — the exact format its own recorder
 * produces. OGG/Opus was tried and verified correct at every layer, but
 * Meta's Cloud API still rejected every send with a generic "Media upload
 * error" (code 131053) for this app/WABA at the time (that WABA was later
 * found to be an unverified test account). MP3 is the format confirmed to
 * actually deliver; it shows up on the recipient's side as a plain
 * audio-file attachment instead of a voice-note bubble.
 *
 * Runs via a hosted conversion API (not a local ffmpeg binary) so it works
 * on serverless/edge runtimes with no filesystem or subprocess support
 * (e.g. Cloudflare Workers), in addition to the VPS.
 */
export async function transcodeToMp3(input: Buffer): Promise<Buffer> {
  const job = await cloudConvertRequest("/jobs", {
    method: "POST",
    body: JSON.stringify({
      tasks: {
        "import-audio": { operation: "import/upload" },
        "convert-audio": {
          operation: "convert",
          input: "import-audio",
          output_format: "mp3",
          engine: "ffmpeg",
          audio_codec: "mp3",
          audio_bitrate: 128,
        },
        "export-audio": { operation: "export/url", input: "convert-audio" },
      },
    }),
  });

  const uploadTask = job.tasks.find((t) => t.name === "import-audio");
  const uploadForm = uploadTask?.result?.form;
  if (!uploadForm) {
    throw new TranscodeError("CloudConvert did not return an upload target");
  }

  const formData = new FormData();
  for (const [key, value] of Object.entries(uploadForm.parameters)) {
    formData.append(key, value);
  }
  formData.append("file", new Blob([new Uint8Array(input)]), "input-audio");
  const uploadRes = await fetch(uploadForm.url, { method: "POST", body: formData });
  if (!uploadRes.ok) {
    const body = await uploadRes.text().catch(() => "");
    throw new TranscodeError(
      `CloudConvert upload failed: ${uploadRes.status} ${uploadRes.statusText} — ${body.slice(0, 300)}`
    );
  }

  let finishedJob: CloudConvertJob | null = null;
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const polled = await cloudConvertRequest(`/jobs/${job.id}`);
    if (polled.status === "finished") {
      finishedJob = polled;
      break;
    }
    if (polled.status === "error") {
      // Report the ROOT failing task (e.g. the upload itself), not just
      // whichever task happens to be first — a downstream "convert" task
      // failing because its input failed just says "Input task has failed",
      // which hides the actual reason.
      const importTask = polled.tasks.find((t) => t.name === "import-audio");
      const errorTasks = polled.tasks.filter((t) => t.status === "error");
      const root = importTask?.status === "error" ? importTask : errorTasks[0];
      const detail = errorTasks
        .map((t) => `${t.name}: ${t.message ?? "no message"}${t.code ? ` (${t.code})` : ""}`)
        .join(" | ");
      throw new TranscodeError(
        `CloudConvert job failed — root: ${root?.name ?? "unknown"}: ${root?.message ?? "unknown"}. All failed tasks: ${detail}`
      );
    }
  }
  if (!finishedJob) {
    throw new TranscodeError("CloudConvert job timed out");
  }

  const exportTask = finishedJob.tasks.find((t) => t.name === "export-audio");
  const fileUrl = exportTask?.result?.files?.[0]?.url;
  if (!fileUrl) {
    throw new TranscodeError("CloudConvert did not return a download URL");
  }

  const downloadRes = await fetch(fileUrl);
  if (!downloadRes.ok) {
    throw new TranscodeError(`Failed to download converted file: ${downloadRes.statusText}`);
  }
  return Buffer.from(await downloadRes.arrayBuffer());
}
