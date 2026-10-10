"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The institution knowledge base — upload, watch it embed, and test retrieval.
 *
 * Shared by the Settings "Knowledge" tab and by step 4 of the onboarding wizard,
 * so the operator learns the same surface in whichever order they arrive.
 *
 * Three things this component is careful about:
 *
 *  - **The status ladder is shown, not summarised away.** Pending → Chunking →
 *    Embedding → Ready is the pipeline actually running; a spinner that hides it
 *    would make a working upload look identical to a stalled one. FAILED shows
 *    the machine-readable reason (`pinecone_not_configured`) plus a Retry,
 *    because that reason is an instruction — "set the index keys and retry".
 *  - **The file input is keyboard-reachable.** The dropzone is a <button> that
 *    opens a hidden <input type="file">; a drag-only uploader is unusable
 *    without a pointer.
 *  - **Polling stops when nothing is moving.** A 2s poll that runs forever on a
 *    finished list is a battery drain with no purpose.
 */

type DocStatus = "PENDING" | "CHUNKING" | "EMBEDDING" | "READY" | "FAILED";

type KnowledgeDoc = {
  id: string;
  title: string;
  fileName: string;
  sizeBytes: number;
  lang: string;
  status: DocStatus | string;
  chunkCount: number;
  error: string | null;
  createdAt: string;
};

type Hit = {
  documentId: string;
  title: string;
  chunkIndex: number;
  text: string;
  score: number;
};

const STATUS_STYLE: Record<string, string> = {
  PENDING: "bg-paper text-ink-2 border-line",
  CHUNKING: "bg-paper text-ink-2 border-line",
  EMBEDDING: "bg-amber-tint text-amber-soft border-amber-soft/30",
  READY: "bg-green-tint text-green-deep border-[#c4e5d6]",
  FAILED: "bg-red-tint text-red-soft border-red-soft/30",
};

/** 2s while something is moving, 5s when the list is settled. */
function pollMs(docs: KnowledgeDoc[]): number | null {
  if (docs.length === 0) return null;
  const moving = docs.some((d) => d.status !== "READY" && d.status !== "FAILED");
  return moving ? 2000 : 5000;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function DocumentsSection({ compact = false }: { compact?: boolean }) {
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [question, setQuestion] = useState("");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /**
   * Read the list. Returns the rows instead of setting state, so the mount effect
   * below has no synchronous `setState` — a callback that both fetches and sets
   * state is the shape that makes "cascading renders" impossible to rule out.
   */
  const fetchDocs = useCallback(async (): Promise<KnowledgeDoc[]> => {
    try {
      const r = await fetch("/api/console/documents");
      const d = (await r.json().catch(() => ({ documents: [] }))) as {
        documents?: KnowledgeDoc[];
        error?: string;
      };
      return d.documents ?? [];
    } catch {
      return [];
    }
  }, []);

  /** Re-read and repaint. Used after an upload, retry or delete. */
  const refresh = useCallback(async () => {
    setDocs(await fetchDocs());
    setLoading(false);
  }, [fetchDocs]);

  useEffect(() => {
    let alive = true;
    void fetchDocs().then((next) => {
      if (!alive) return;
      setDocs(next);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [fetchDocs]);

  // Poll only while the ladder is moving. A terminal state (READY / FAILED) is a
  // resting state, not a pending one; the poll is the only thing watching, so it
  // stops rather than polling forever behind a static table.
  useEffect(() => {
    const every = pollMs(docs);
    if (!every) return;
    const t = setInterval(() => void refresh(), every);
    return () => clearInterval(t);
  }, [docs, refresh]);

  const upload = async (file: File) => {
    setUploading(true);
    setMsg(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("title", file.name.replace(/\.pdf$/i, ""));
      const r = await fetch("/api/console/documents", { method: "POST", body: form });
      const d = (await r.json().catch(() => ({ error: "Unreadable response" }))) as {
        error?: string;
      };
      if (!r.ok) throw new Error(d.error || "Upload failed");
      setMsg({ ok: true, text: `Uploaded ${file.name} — embedding now.` });
      await refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Upload failed" });
    } finally {
      setUploading(false);
    }
  };

  const retry = async (id: string) => {
    setMsg(null);
    await fetch(`/api/console/documents/${encodeURIComponent(id)}/retry`, { method: "POST" });
    await refresh();
  };

  const remove = async (id: string) => {
    setMsg(null);
    const r = await fetch(`/api/console/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
    const d = (await r.json().catch(() => ({ error: "Unreadable response" }))) as {
      error?: string;
    };
    if (!r.ok) setMsg({ ok: false, text: d.error || "Delete failed" });
    await refresh();
  };

  const testSearch = async () => {
    if (question.trim().length < 3) return;
    setSearching(true);
    setSearchNote(null);
    try {
      const r = await fetch("/api/console/documents/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: question.trim() }),
      });
      const d = (await r.json().catch(() => ({ error: "Unreadable response" }))) as {
        matches?: Hit[];
        error?: string;
      };
      // A missing index comes back as 200 with an error field on purpose: it is a
      // configuration state, and rendering it as a red failure would imply the
      // upload was wrong when it was the deployment.
      if (d.error && d.error !== "") {
        setSearchNote(d.error);
        setHits([]);
        return;
      }
      setHits(d.matches ?? []);
    } catch {
      setSearchNote("search_failed");
      setHits([]);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <p className="flex items-center gap-2 text-[13px] font-semibold">
          <BookOpen className="h-4 w-4 text-primary" />
          Knowledge base
        </p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
          Upload your institution&apos;s own policy documents. They are chunked and embedded into a
          tenant-scoped index so the agent answers from your rules instead of a model&apos;s memory
          — and retrieval is answered only for your organization.
        </p>
      </div>

      {/* Dropzone. A real <button> so it is reachable by keyboard; the file input
          is hidden but stays in the DOM for the click to target. */}
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void upload(file);
        }}
        aria-label="Upload a policy PDF"
        className={cn(
          "flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-6 py-8 text-center transition",
          dragging
            ? "border-primary bg-green-tint"
            : "border-line bg-paper hover:border-primary/40",
        )}
      >
        {uploading ? (
          <Loader2 className="h-5 w-5 animate-spin text-ink-3" />
        ) : (
          <Upload className="h-5 w-5 text-ink-3" />
        )}
        <span className="text-[12.5px] font-semibold">
          {uploading ? "Uploading…" : "Drop a policy PDF, or click to choose"}
        </span>
        <span className="text-[11px] text-ink-3">
          PDF only · up to 8 MB · scanned PDFs have no text to index
        </span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
          e.target.value = "";
        }}
      />

      {msg && (
        <div
          role="status"
          className={cn(
            "flex items-center gap-2 rounded-xl px-4 py-3 text-[12.5px] font-medium",
            msg.ok ? "bg-green-tint text-green-deep" : "bg-red-tint text-red-soft",
          )}
        >
          {msg.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
          {msg.text}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-ink-3" />
        </div>
      ) : docs.length === 0 ? (
        <p className="rounded-xl bg-paper px-4 py-4 text-[12px] leading-relaxed text-ink-3">
          No documents yet. The agent still answers from its configured knowledge base — uploading a
          policy document is what makes it answer from <em>your</em> rules.
        </p>
      ) : (
        <ul className="space-y-2">
          {docs.map((d) => (
            <li
              key={d.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-paper px-3.5 py-3"
            >
              <div className="flex min-w-0 items-start gap-2.5">
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" />
                <div className="min-w-0">
                  <p className="truncate text-[12.5px] font-semibold">{d.title}</p>
                  <p className="num text-[10.5px] text-ink-3">
                    {d.lang.toUpperCase()} · {fmtSize(d.sizeBytes)} ·{" "}
                    {d.status === "READY"
                      ? `${d.chunkCount} chunks`
                      : new Date(d.createdAt).toLocaleDateString()}
                  </p>
                  {d.status === "FAILED" && d.error && (
                    <p className="num mt-1 flex items-center gap-1 text-[11px] text-red-soft">
                      <AlertTriangle className="h-3 w-3 shrink-0" />
                      {d.error}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[10.5px] font-semibold",
                    STATUS_STYLE[d.status] ?? STATUS_STYLE.PENDING,
                  )}
                >
                  {d.status.toLowerCase()}
                </span>
                {d.status === "FAILED" && (
                  <button
                    type="button"
                    onClick={() => void retry(d.id)}
                    aria-label={`Retry indexing ${d.title}`}
                    className="rounded-full border border-line bg-white px-2.5 py-1 text-[10.5px] font-semibold text-ink-2 hover:text-primary"
                  >
                    <RefreshCw className="h-3 w-3" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void remove(d.id)}
                  aria-label={`Delete ${d.title}`}
                  className="rounded-full border border-line bg-white px-2.5 py-1 text-[10.5px] font-semibold text-ink-2 hover:text-red-soft"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {!compact && (
        <div className="border-t border-line pt-5">
          <p className="flex items-center gap-2 text-[13px] font-semibold">
            <Search className="h-4 w-4 text-primary" />
            Test knowledge base
          </p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
            Ask a question the agent should answer from these documents. You get the exact chunk and
            its score — so you can see retrieval working before a live customer call depends on it.
          </p>
          <div className="mt-3 flex gap-2">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void testSearch();
              }}
              placeholder="What do I do about a disputed cash withdrawal?"
              aria-label="Test question"
              className="h-10 flex-1 rounded-xl border border-line bg-paper px-3.5 text-[12.5px]"
            />
            <button
              type="button"
              onClick={() => void testSearch()}
              disabled={searching || question.trim().length < 3}
              className="flex shrink-0 items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-[12.5px] font-semibold text-white transition hover:bg-green-deep disabled:opacity-40"
            >
              {searching ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Search className="h-3.5 w-3.5" />
              )}
              Search
            </button>
          </div>
          {searchNote && <p className="num mt-2 text-[11.5px] text-amber-soft">{searchNote}</p>}
          {hits && hits.length === 0 && !searchNote && (
            <p className="mt-2 text-[11.5px] text-ink-3">No chunk matched that question.</p>
          )}
          {hits && hits.length > 0 && (
            <ul className="mt-3 space-y-2">
              {hits.map((h) => (
                <li
                  key={`${h.documentId}-${h.chunkIndex}`}
                  className="rounded-xl border border-line bg-paper px-3.5 py-3"
                >
                  <p className="flex items-center justify-between gap-2 text-[11px] font-semibold">
                    <span className="truncate">{h.title}</span>
                    <span className="num shrink-0 text-ink-3">score {h.score.toFixed(3)}</span>
                  </p>
                  <p className="mt-1 line-clamp-4 text-[11.5px] leading-relaxed text-ink-2">
                    {h.text}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
