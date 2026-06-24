import { uploadFiles, createRepo, type RepoDesignation } from "@huggingface/hub";

const DS_SERVER = "https://datasets-server.huggingface.co";

function buildHfHeaders(token?: string): Record<string, string> | undefined {
  if (!token) return undefined;
  return {
    Authorization: `Bearer ${token}`,
    "X-HF-Token": token,
  };
}

export interface HfRow {
  index: number;
  imageUrl: string; // remote URL or blob URL
  label: string;
}

export interface DatasetInfo {
  numRows: number;
  config: string;
  split: string;
  imageColumn: string;
  labelColumn: string;
}

interface RawRow {
  row_idx: number;
  row: Record<string, unknown>;
}

interface RowsResponse {
  features: { name: string; type: { _type: string; dtype?: string } }[];
  rows: RawRow[];
  num_rows_total: number;
}

export async function fetchDatasetInfo(
  dataset: string,
  token?: string,
): Promise<DatasetInfo> {
  const headers = buildHfHeaders(token);

  const splitsRes = await fetch(`${DS_SERVER}/splits?dataset=${encodeURIComponent(dataset)}`, { headers });
  if (!splitsRes.ok) throw new Error(`Failed to fetch splits: ${splitsRes.status} ${await splitsRes.text()}`);
  const splitsJson = (await splitsRes.json()) as { splits: { config: string; split: string }[] };
  const preferred =
    splitsJson.splits.find((s) => s.split === "train") ?? splitsJson.splits[0];
  if (!preferred) throw new Error("No splits found");

  // Probe first row to discover schema
  const probe = await fetchRowsRaw(dataset, preferred.config, preferred.split, 0, 1, token);
  const imgFeat =
    probe.features.find((f) => ["image", "img"].includes(f.name)) ??
    probe.features.find((f) => f.type._type === "Image") ??
    probe.features.find(
      (f) =>
        f.type._type === "Value" &&
        f.type.dtype === "string" &&
        !["label", "text", "file_name"].includes(f.name),
    );
  const strFeat =
    probe.features.find((f) => ["label", "text"].includes(f.name)) ??
    probe.features.find(
      (f) =>
        f.type._type === "Value" &&
        f.type.dtype === "string" &&
        !["image", "img", "file_name"].includes(f.name),
    );
  if (!imgFeat) throw new Error("Dataset has no image column");
  if (!strFeat) throw new Error("Dataset has no string label column");

  return {
    numRows: probe.num_rows_total,
    config: preferred.config,
    split: preferred.split,
    imageColumn: imgFeat.name,
    labelColumn: strFeat.name,
  };
}

async function fetchRowsRaw(
  dataset: string,
  config: string,
  split: string,
  offset: number,
  length: number,
  token?: string,
): Promise<RowsResponse> {
  const headers = buildHfHeaders(token);
  const url = `${DS_SERVER}/rows?dataset=${encodeURIComponent(dataset)}&config=${encodeURIComponent(
    config,
  )}&split=${encodeURIComponent(split)}&offset=${offset}&length=${length}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Rows fetch failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as RowsResponse;
}

export async function fetchRows(
  dataset: string,
  info: DatasetInfo,
  offset: number,
  length: number,
  token?: string,
): Promise<HfRow[]> {
  const data = await fetchRowsRaw(dataset, info.config, info.split, offset, length, token);
  return data.rows.map((r) => {
    const img = r.row[info.imageColumn] as { src?: string } | string;
    const imageUrl = typeof img === "string" ? img : (img?.src ?? "");
    const label = String(r.row[info.labelColumn] ?? "");
    return { index: r.row_idx, imageUrl, label };
  });
}

export async function loadDataset(
  dataset: string,
  token?: string,
  start = 0,
  length = 100,
): Promise<{ info: DatasetInfo; rows: HfRow[] }> {
  const info = await fetchDatasetInfo(dataset, token);
  const rows = await fetchRows(dataset, info, start, length, token);
  return { info, rows };
}

export async function fetchImageBlob(url: string, token?: string): Promise<Blob> {
  // Pre-signed HF CDN URLs (cached-assets) already carry auth in the query string.
  // Adding an Authorization header triggers a CORS preflight the CDN rejects,
  // causing a "Failed to fetch". Only attach the bearer for raw HF asset URLs.
  const isPresigned =
    /[?&](Signature|X-Amz-Signature|sig)=/.test(url) ||
    url.includes("cached-assets") ||
    url.includes("cdn-lfs");
  const headers: Record<string, string> = {};
  if (token && (url.includes("huggingface.co") || url.includes("hf.co")) && !isPresigned) {
    headers.Authorization = `Bearer ${token}`;
    headers["X-HF-Token"] = token;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);
  return await res.blob();
}

export interface TransformedItem {
  filename: string;
  blob: Blob;
  label: string;
}

export async function pushDataset(
  repoId: string,
  token: string,
  items: TransformedItem[],
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  const repo: RepoDesignation = { type: "dataset", name: repoId };

  // Ensure repo exists (ignore "already exists" error)
  try {
    await createRepo({ repo, accessToken: token, license: "mit" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/exist|409/i.test(msg)) {
      // continue anyway; upload will surface real auth/perm errors
      console.warn("createRepo:", msg);
    }
  }

  // Build metadata.jsonl (HF "imagefolder" with metadata convention)
  const lines = items.map((it) =>
    JSON.stringify({ file_name: `images/${it.filename}`, text: it.label }),
  );
  const metadata = new Blob([lines.join("\n")], { type: "application/jsonl" });

  const readme = new Blob(
    [
      `---\nlicense: mit\ntask_categories:\n- image-to-text\n---\n\n# ${repoId}\n\nCleaned OCR dataset generated with OCR Dataset Verification Tool.\n\n- ${items.length} samples\n- columns: \`image\`, \`text\`\n`,
    ],
    { type: "text/markdown" },
  );

  // Upload in chunks to keep memory under control
  const CHUNK = 100;
  let done = 0;
  const total = items.length + 2;

  // metadata + readme first
  await uploadFiles({
    repo,
    accessToken: token,
    files: [
      { path: "README.md", content: readme },
      { path: "metadata.jsonl", content: metadata },
    ],
    commitTitle: "Add metadata",
  });
  done += 2;
  onProgress(done, total);

  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    await uploadFiles({
      repo,
      accessToken: token,
      files: chunk.map((it) => ({
        path: `images/${it.filename}`,
        content: it.blob,
      })),
      commitTitle: `Upload images ${i + 1}-${i + chunk.length}`,
    });
    done += chunk.length;
    onProgress(done, total);
  }
}
