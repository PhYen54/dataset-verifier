import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  RotateCw,
  FlipHorizontal2,
  FlipVertical2,
  Trash2,
  Undo2,
  Upload,
  Database,
  Loader2,
  CheckCircle2,
  ImageIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  fetchDatasetInfo,
  fetchRows,
  fetchImageBlob,
  pushDataset,
  type DatasetInfo,
  type HfRow,
} from "@/lib/hf";
import { transformImage, inferExtension } from "@/lib/image-transform";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "OCR Dataset Verification Tool" },
      {
        name: "description",
        content:
          "Load, review, edit, and push OCR datasets to Hugging Face. Verify labels, rotate, flip and clean images at scale.",
      },
      { property: "og:title", content: "OCR Dataset Verification Tool" },
      {
        property: "og:description",
        content:
          "Review and clean Hugging Face OCR datasets with keyboard-first workflow.",
      },
    ],
  }),
  component: OcrVerifier,
});

interface ItemState {
  index: number;
  imageUrl: string;
  label: string;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  deleted: boolean;
  reviewed: boolean;
}

const INITIAL_BATCH = 100;
const BG_BATCH = 200;

function OcrVerifier() {
  const [datasetId, setDatasetId] = useState("");
  const [readToken, setReadToken] = useState("");
  const [writeToken, setWriteToken] = useState("");
  const [targetRepo, setTargetRepo] = useState("");

  const [info, setInfo] = useState<DatasetInfo | null>(null);
  const [items, setItems] = useState<ItemState[]>([]);
  const [current, setCurrent] = useState(0);

  const [loading, setLoading] = useState(false);
  const [bgLoading, setBgLoading] = useState(false);
  const [loadedCount, setLoadedCount] = useState(0);

  const [pushing, setPushing] = useState(false);
  const [pushProgress, setPushProgress] = useState({ done: 0, total: 0 });

  const cancelBgRef = useRef(false);

  const total = info?.numRows ?? 0;
  const item = items[current];

  // ---------- Loaders ----------
  const ingest = useCallback((rows: HfRow[]) => {
    setItems((prev) => {
      const next = [...prev];
      for (const r of rows) {
        next.push({
          index: r.index,
          imageUrl: r.imageUrl,
          label: r.label,
          rotation: 0,
          flipH: false,
          flipV: false,
          deleted: false,
          reviewed: false,
        });
      }
      return next;
    });
    setLoadedCount((c) => c + rows.length);
  }, []);

  const loadInBackground = useCallback(
    async (dsInfo: DatasetInfo, startOffset: number) => {
      setBgLoading(true);
      try {
        for (let offset = startOffset; offset < dsInfo.numRows; offset += BG_BATCH) {
          if (cancelBgRef.current) break;
          const length = Math.min(BG_BATCH, dsInfo.numRows - offset);
          try {
            const rows = await fetchRows(datasetId, dsInfo, offset, length, readToken || undefined);
            ingest(rows);
          } catch (err) {
            console.error("Background batch failed", err);
            // brief backoff
            await new Promise((r) => setTimeout(r, 1500));
          }
        }
      } finally {
        setBgLoading(false);
      }
    },
    [datasetId, readToken, ingest],
  );

  const handleLoad = useCallback(async () => {
    if (!datasetId.trim()) {
      toast.error("Enter a Hugging Face dataset ID");
      return;
    }
    cancelBgRef.current = true;
    await new Promise((r) => setTimeout(r, 50));
    cancelBgRef.current = false;

    setLoading(true);
    setItems([]);
    setLoadedCount(0);
    setCurrent(0);
    try {
      const dsInfo = await fetchDatasetInfo(datasetId.trim(), readToken || undefined);
      setInfo(dsInfo);
      const firstLen = Math.min(INITIAL_BATCH, dsInfo.numRows);
      const firstRows = await fetchRows(datasetId.trim(), dsInfo, 0, firstLen, readToken || undefined);
      ingest(firstRows);
      toast.success(`Loaded first ${firstRows.length} of ${dsInfo.numRows} rows`);
      setLoading(false);
      // background fetch the rest
      if (dsInfo.numRows > firstLen) {
        void loadInBackground(dsInfo, firstLen);
      }
    } catch (err) {
      setLoading(false);
      toast.error(err instanceof Error ? err.message : "Failed to load dataset");
    }
  }, [datasetId, readToken, ingest, loadInBackground]);

  // ---------- Mutations ----------
  const update = useCallback((idx: number, patch: Partial<ItemState>) => {
    setItems((prev) => {
      const next = [...prev];
      if (next[idx]) next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }, []);

  const goPrev = useCallback(() => {
    setCurrent((c) => Math.max(0, c - 1));
  }, []);
  const goNext = useCallback(() => {
    setCurrent((c) => Math.min(items.length - 1, c + 1));
  }, [items.length]);

  const saveAndNext = useCallback(() => {
    if (!item) return;
    update(current, { reviewed: true });
    goNext();
  }, [item, current, update, goNext]);

  const toggleDelete = useCallback(() => {
    if (!item) return;
    update(current, { deleted: !item.deleted });
    toast(item.deleted ? "Restored" : "Marked for deletion");
  }, [item, current, update]);

  // ---------- Keyboard shortcuts ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const inTextarea = tag === "TEXTAREA";
      const inInput = tag === "INPUT";
      if (e.key === "Enter" && inTextarea && !e.shiftKey) {
        e.preventDefault();
        saveAndNext();
        return;
      }
      if (inInput) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "Enter" && !inTextarea) {
        e.preventDefault();
        saveAndNext();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goNext, goPrev, saveAndNext]);

  // ---------- Push ----------
  const handlePush = useCallback(async () => {
    if (!writeToken.trim()) return toast.error("Write token required");
    if (!targetRepo.trim()) return toast.error("Enter target dataset name");
    const kept = items.filter((i) => !i.deleted);
    if (!kept.length) return toast.error("No items to push");

    setPushing(true);
    setPushProgress({ done: 0, total: kept.length });

    // Pause background loading to free up connections during push
    const wasBgLoading = bgLoading;
    cancelBgRef.current = true;

    try {
      const transformed: { filename: string; blob: Blob; label: string }[] = [];
      // Transform images sequentially to keep memory bounded (one bitmap at a time).
      for (let i = 0; i < kept.length; i++) {
        const it = kept[i];
        let orig: Blob;
        try {
          orig = await fetchImageBlob(it.imageUrl, readToken || undefined);
        } catch (e) {
          // Retry once without auth header in case of CORS issues on signed URLs
          console.warn(`Image fetch failed for row ${it.index}, retrying without auth`, e);
          orig = await fetchImageBlob(it.imageUrl);
        }
        const needTx = it.rotation !== 0 || it.flipH || it.flipV;
        const blob = needTx
          ? await transformImage(orig, it.rotation, it.flipH, it.flipV, orig.type || "image/png")
          : orig;
        const ext = inferExtension(blob.type || orig.type || "image/png");
        transformed.push({
          filename: `${String(it.index).padStart(7, "0")}.${ext}`,
          blob,
          label: it.label,
        });
        setPushProgress({ done: i + 1, total: kept.length + kept.length });
      }

      setPushProgress({ done: 0, total: kept.length + 2 });
      await pushDataset(targetRepo.trim(), writeToken.trim(), transformed, (done, t) => {
        setPushProgress({ done, total: t });
      });
      toast.success(`Pushed ${kept.length} samples to ${targetRepo}`);
    } catch (err) {
      console.error("Push failed", err);
      toast.error(err instanceof Error ? err.message : "Push failed");
    } finally {
      setPushing(false);
      // Resume background loading if it was running and dataset isn't fully loaded
      if (wasBgLoading && info && loadedCount < info.numRows) {
        cancelBgRef.current = false;
        void loadInBackground(info, loadedCount);
      }
    }
  }, [items, writeToken, targetRepo, readToken, bgLoading, info, loadedCount, loadInBackground]);

  // ---------- Derived ----------
  const stats = useMemo(() => {
    let reviewed = 0;
    let deleted = 0;
    for (const i of items) {
      if (i.reviewed) reviewed++;
      if (i.deleted) deleted++;
    }
    return { reviewed, deleted, kept: items.length - deleted };
  }, [items]);

  const imgTransform = item
    ? `rotate(${item.rotation}deg) scale(${item.flipH ? -1 : 1}, ${item.flipV ? -1 : 1})`
    : "none";

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b bg-card/50 backdrop-blur supports-[backdrop-filter]:bg-card/40 sticky top-0 z-20">
        <div className="mx-auto max-w-[1600px] px-6 py-4 space-y-4">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
              <Database className="size-5" />
            </div>
            <div className="flex-1">
              <h1 className="text-lg font-semibold leading-tight">
                OCR Dataset Verification Tool
              </h1>
              <p className="text-xs text-muted-foreground">
                Load · Review · Clean · Push to Hugging Face
              </p>
            </div>
            <div className="hidden md:flex items-center gap-2 text-xs text-muted-foreground">
              <kbd className="rounded border bg-muted px-1.5 py-0.5">←</kbd>
              <kbd className="rounded border bg-muted px-1.5 py-0.5">→</kbd>
              navigate
              <kbd className="rounded border bg-muted px-1.5 py-0.5 ml-2">Enter</kbd>
              save & next
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-12">
            <div className="md:col-span-4">
              <Label htmlFor="ds" className="text-xs">Dataset ID</Label>
              <Input
                id="ds"
                placeholder="username/dataset-name"
                value={datasetId}
                onChange={(e) => setDatasetId(e.target.value)}
              />
            </div>
            <div className="md:col-span-3">
              <Label htmlFor="rtok" className="text-xs">Read Token (optional)</Label>
              <Input
                id="rtok"
                type="password"
                placeholder="hf_..."
                value={readToken}
                onChange={(e) => setReadToken(e.target.value)}
              />
            </div>
            <div className="md:col-span-2 flex items-end">
              <Button onClick={handleLoad} disabled={loading} className="w-full">
                {loading ? (
                  <><Loader2 className="size-4 animate-spin" /> Loading</>
                ) : (
                  <>Load Dataset</>
                )}
              </Button>
            </div>
            <div className="md:col-span-3 flex items-end gap-2">
              {info && (
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="secondary">{info.split}</Badge>
                  <Badge variant="outline">
                    {loadedCount.toLocaleString()} / {total.toLocaleString()} loaded
                  </Badge>
                  {bgLoading && (
                    <Badge className="bg-primary/15 text-primary border-primary/20">
                      <Loader2 className="size-3 animate-spin mr-1" /> background
                    </Badge>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-6 py-6">
        {!items.length ? (
          <EmptyState />
        ) : (
          <div className="grid gap-6 lg:grid-cols-10 items-stretch">
            {/* Left pane: image (60%) */}
            <Card className="lg:col-span-6 p-0 overflow-hidden flex flex-col">
              <div className="flex items-center justify-between border-b px-4 py-2.5">
                <div className="flex items-center gap-2 text-sm">
                  <ImageIcon className="size-4 text-muted-foreground" />
                  <span className="font-medium">
                    Image {current + 1} <span className="text-muted-foreground">of {items.length}</span>
                  </span>
                  {item?.deleted && (
                    <Badge variant="destructive" className="ml-2">deleted</Badge>
                  )}
                  {item?.reviewed && !item.deleted && (
                    <Badge className="ml-2 bg-success text-success-foreground">
                      <CheckCircle2 className="size-3 mr-1" /> reviewed
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground tabular-nums">
                  row #{item?.index}
                </div>
              </div>

              <div className="relative flex-1 min-h-[60vh] bg-[radial-gradient(circle_at_1px_1px,_var(--color-border)_1px,_transparent_0)] [background-size:18px_18px] grid place-items-center p-6 overflow-hidden">
                {item && (
                  <img
                    key={item.index}
                    src={item.imageUrl}
                    alt={item.label}
                    className="max-h-[70vh] max-w-full object-contain transition-transform duration-300 ease-out shadow-lg rounded-md bg-white"
                    style={{ transform: imgTransform }}
                    draggable={false}
                  />
                )}
                {item?.deleted && (
                  <div className="absolute inset-0 bg-destructive/10 pointer-events-none" />
                )}
              </div>
            </Card>

            {/* Right pane: controls + label + nav (40%) */}
            <div className="lg:col-span-4 flex flex-col gap-4">
              {/* Controls */}
              <Card className="p-4">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                  Image controls
                </div>
                <div className="grid grid-cols-4 gap-2">
                  <IconBtn
                    label="Rotate left"
                    onClick={() => item && update(current, { rotation: (item.rotation + 270) % 360 })}
                  >
                    <RotateCcw className="size-4" />
                  </IconBtn>
                  <IconBtn
                    label="Rotate right"
                    onClick={() => item && update(current, { rotation: (item.rotation + 90) % 360 })}
                  >
                    <RotateCw className="size-4" />
                  </IconBtn>
                  <IconBtn
                    label="Flip horizontal"
                    active={item?.flipH}
                    onClick={() => item && update(current, { flipH: !item.flipH })}
                  >
                    <FlipHorizontal2 className="size-4" />
                  </IconBtn>
                  <IconBtn
                    label="Flip vertical"
                    active={item?.flipV}
                    onClick={() => item && update(current, { flipV: !item.flipV })}
                  >
                    <FlipVertical2 className="size-4" />
                  </IconBtn>
                </div>
              </Card>

              {/* Label editor */}
              <Card className="p-4 flex-1 flex flex-col">
                <div className="flex items-center justify-between mb-2">
                  <Label htmlFor="lbl" className="text-xs uppercase tracking-wide text-muted-foreground">
                    Label
                  </Label>
                  <span className="text-[10px] text-muted-foreground">
                    Enter = save & next · Shift+Enter = newline
                  </span>
                </div>
                <Textarea
                  id="lbl"
                  value={item?.label ?? ""}
                  onChange={(e) => update(current, { label: e.target.value })}
                  className="flex-1 min-h-[160px] font-mono text-sm resize-none"
                  placeholder="OCR transcription..."
                />
              </Card>

              {/* Navigation */}
              <Card className="p-4 space-y-3">
                <div className="flex gap-2">
                  <Button variant="outline" onClick={goPrev} disabled={current === 0} className="flex-1">
                    <ChevronLeft className="size-4" /> Previous
                  </Button>
                  <Button onClick={saveAndNext} disabled={current >= items.length - 1} className="flex-1">
                    Save & Next <ChevronRight className="size-4" />
                  </Button>
                </div>
                <Button
                  variant={item?.deleted ? "outline" : "destructive"}
                  onClick={toggleDelete}
                  className="w-full"
                >
                  {item?.deleted ? (
                    <><Undo2 className="size-4" /> Restore</>
                  ) : (
                    <><Trash2 className="size-4" /> Delete from new dataset</>
                  )}
                </Button>

                <Separator />

                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <Stat label="Reviewed" value={stats.reviewed} tone="primary" />
                  <Stat label="Kept" value={stats.kept} tone="success" />
                  <Stat label="Deleted" value={stats.deleted} tone="destructive" />
                </div>
              </Card>
            </div>
          </div>
        )}

        {/* Push section */}
        {items.length > 0 && (
          <Card className="mt-6 p-5">
            <div className="flex items-center gap-2 mb-3">
              <Upload className="size-4 text-primary" />
              <h2 className="font-semibold">Push to Hugging Face</h2>
            </div>
            <div className="grid gap-3 md:grid-cols-12">
              <div className="md:col-span-5">
                <Label htmlFor="target" className="text-xs">New dataset name</Label>
                <Input
                  id="target"
                  placeholder="username/cleaned-dataset"
                  value={targetRepo}
                  onChange={(e) => setTargetRepo(e.target.value)}
                  disabled={pushing}
                />
              </div>
              <div className="md:col-span-5">
                <Label htmlFor="wtok" className="text-xs">Write Token</Label>
                <Input
                  id="wtok"
                  type="password"
                  placeholder="hf_..."
                  value={writeToken}
                  onChange={(e) => setWriteToken(e.target.value)}
                  disabled={pushing}
                />
              </div>
              <div className="md:col-span-2 flex items-end">
                <Button onClick={handlePush} disabled={pushing} className="w-full">
                  {pushing ? (
                    <><Loader2 className="size-4 animate-spin" /> Pushing</>
                  ) : (
                    <><Upload className="size-4" /> Push</>
                  )}
                </Button>
              </div>
            </div>

            {pushing && (
              <div className="mt-4 space-y-1.5">
                <Progress
                  value={pushProgress.total ? (pushProgress.done / pushProgress.total) * 100 : 0}
                />
                <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
                  <span>Transforming & uploading…</span>
                  <span>
                    {pushProgress.done} / {pushProgress.total}
                  </span>
                </div>
              </div>
            )}
          </Card>
        )}
      </main>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="grid place-items-center py-24 text-center">
      <div className="size-16 rounded-2xl bg-accent grid place-items-center mb-4">
        <Database className="size-8 text-primary" />
      </div>
      <h2 className="text-xl font-semibold">Load a Hugging Face dataset to begin</h2>
      <p className="text-sm text-muted-foreground mt-2 max-w-md">
        Enter a dataset ID with <code className="font-mono">image</code> and a string
        label column. The first 100 rows load instantly, the rest stream in the
        background.
      </p>
    </div>
  );
}

function IconBtn({
  children,
  label,
  onClick,
  active,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <Button
      type="button"
      variant={active ? "default" : "outline"}
      size="sm"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="h-10"
    >
      {children}
    </Button>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "primary" | "success" | "destructive";
}) {
  const toneClass =
    tone === "primary"
      ? "text-primary"
      : tone === "success"
        ? "text-[color:var(--color-success)]"
        : "text-destructive";
  return (
    <div className="rounded-md border bg-card px-2 py-2">
      <div className={`text-base font-semibold tabular-nums ${toneClass}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}
