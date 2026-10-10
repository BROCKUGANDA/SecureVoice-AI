"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
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
import { t, useApp } from "@/lib/store";
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

/** Display labels for the pipeline states. The enum values on `d.status` stay
    untouched — STATUS_STYLE and every comparison key off them; only the label
    the operator reads is translated. */
const STATUS_AR: Record<string, string> = {
  PENDING: "قيد الانتظار",
  CHUNKING: "قيد التقطيع",
  EMBEDDING: "قيد التضمين",
  READY: "جاهز",
  FAILED: "فشل",
};

/** The pipeline in the order the machine actually runs it. A row draws four
    segments and fills up to the step `d.status` sits on; terminal states draw
    no ladder, because a finished job has no step left to show. */
const LADDER: DocStatus[] = ["PENDING", "CHUNKING", "EMBEDDING", "READY"];

/** Where `status` sits on the ladder. An unrecognised status shows as PENDING —
    the same fallback STATUS_STYLE gives the pill: an unknown state is "still
    queued", not "stuck past the last segment". */
function ladderIndex(status: string): number {
  return Math.max(0, LADDER.indexOf(status as DocStatus));
}

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

/** Escape a literal for a RegExp: question words arrive as typed, and
    "withdrawal?" is a quantifier when it wants to be a word. */
function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wrap the question's own words inside a hit's chunk text. Splitting the text
    and interleaving <mark> elements — never innerHTML — keeps a chunk that
    quotes code or markup as plain text. `split` with a capture group puts the
    matched words at the odd indexes, which is what this maps over. */
function highlightMatches(text: string, words: string[]): ReactNode[] {
  if (words.length === 0) return [text];
  const rx = new RegExp(`(${words.map(escapeRx).join("|")})`, "gi");
  return text.split(rx).map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="bg-green-tint text-primary">
        {part}
      </mark>
    ) : (
      part
    ),
  );
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
  const { lang } = useApp();

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
      const d = (await r.json().catch(() => ({
        error: t("Unreadable response", "استجابة غير مقروءة", lang),
      }))) as {
        error?: string;
      };
      if (!r.ok) throw new Error(d.error || t("Upload failed", "فشل الرفع", lang));
      setMsg({
        ok: true,
        text: t(
          `Uploaded ${file.name} — embedding now.`,
          `تم رفع ${file.name} — جارٍ التضمين الآن.`,
          lang,
        ),
      });
      await refresh();
    } catch (e) {
      setMsg({
        ok: false,
        text: e instanceof Error ? e.message : t("Upload failed", "فشل الرفع", lang),
      });
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
    const d = (await r.json().catch(() => ({
      error: t("Unreadable response", "استجابة غير مقروءة", lang),
    }))) as {
      error?: string;
    };
    if (!r.ok) setMsg({ ok: false, text: d.error || t("Delete failed", "فشل الحذف", lang) });
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
      const d = (await r.json().catch(() => ({
        error: t("Unreadable response", "استجابة غير مقروءة", lang),
      }))) as {
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

  // The words worth marking in a hit: the question itself, minus noise. Below
  // three characters the match rate is stop-words — "do", "a", "to" — which
  // would paint the whole chunk instead of pointing at the answer.
  const markWords = useMemo(
    () =>
      Array.from(
        new Set(
          question
            .toLowerCase()
            .split(/\s+/)
            .map((w) => w.replace(/[^\p{L}\p{N}-]+/gu, ""))
            .filter((w) => w.length >= 3),
        ),
      ),
    [question],
  );

  // Only READY rows own chunks. A PENDING upload has none until the ladder
  // climbs, and counting it would promise an index that does not exist yet.
  const readyDocs = docs.filter((d) => d.status === "READY");
  const readyChunks = readyDocs.reduce((sum, d) => sum + d.chunkCount, 0);

  return (
    <div className="space-y-5">
      <div>
        <p className="flex items-center gap-2 text-[13px] font-semibold">
          <BookOpen className="h-4 w-4 text-primary" />
          {t("Knowledge base", "قاعدة المعرفة", lang)}
        </p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
          {t(
            "Upload your institution's own policy documents. They are chunked and embedded into a tenant-scoped index so the agent answers from your rules instead of a model's memory — and retrieval is answered only for your organization.",
            "ارفع مستندات سياسات مؤسستك الخاصة. تُقسَّم وتُضمَّن في فهرس خاص بمستأجرك، ليجيب الوكيل استناداً إلى قواعدك بدلاً من ذاكرة النموذج — والاسترجاع يقتصر على مؤسستك وحدها.",
            lang,
          )}
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
        aria-label={t("Upload a policy PDF", "ارفع مستند سياسات بصيغة PDF", lang)}
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
          {uploading
            ? t("Uploading…", "جارٍ الرفع…", lang)
            : t(
                "Drop a policy PDF, or click to choose",
                "أفلت مستند PDF للسياسات، أو انقر للاختيار",
                lang,
              )}
        </span>
        <span className="text-[11px] text-ink-3">
          {t(
            "PDF only · up to 8 MB · scanned PDFs have no text to index",
            "PDF فقط · حتى 8 ميجابايت · ملفات PDF الممسوحة ضوئياً لا تحتوي على نص للفهرسة",
            lang,
          )}
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
        // Three skeleton rows, not a spinner: the audit checklist bans
        // spinner-for-data, and a pulse shaped like the rows being fetched
        // tells the operator "working" the moment the section mounts.
        <ul className="space-y-2" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <li
              key={i}
              className="flex h-16 animate-pulse items-center gap-3 rounded-xl border border-line bg-paper px-3.5 py-3"
            >
              <div className="h-4 w-4 shrink-0 rounded bg-line" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-3 w-2/5 rounded bg-line" />
                <div className="h-2.5 w-1/4 rounded bg-line" />
              </div>
              <div className="h-6 w-16 shrink-0 rounded-full bg-line" />
            </li>
          ))}
        </ul>
      ) : docs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-paper px-6 py-10 text-center">
          <p className="text-[12px] leading-relaxed text-ink-3">
            {t(
              "No documents yet. The agent still answers from its configured knowledge base — uploading a policy document is what makes it answer from ",
              "لا توجد مستندات بعد. لا يزال الوكيل يجيب من قاعدة المعرفة المُعدَّة له — ورفع مستند سياسات هو ما يجعله يجيب من ",
              lang,
            )}
            <em>{t("your", "قواعدك", lang)}</em>
            {t(" rules.", " أنت.", lang)}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="num text-[11.5px] text-ink-3">
            {t(
              `${readyDocs.length} documents · ${readyChunks} chunks indexed`,
              `${readyDocs.length} مستندات · ${readyChunks} مقطع مفهرس`,
              lang,
            )}
          </p>
          <ul className="space-y-2">
            {docs.map((d) => {
              // Step this row is on in LADDER; unknown statuses clamp to the
              // first step, matching how STATUS_STYLE styles the pill.
              const step = ladderIndex(d.status);
              return (
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
                          ? t(`${d.chunkCount} chunks`, `${d.chunkCount} مقطع`, lang)
                          : new Date(d.createdAt).toLocaleDateString()}
                      </p>
                      {/* Four segments, one per pipeline step: filled where this row
                      is, half-filled behind it, line-colored ahead of it. It is
                      the ladder the header comment promises — the wait made
                      legible instead of collapsing into a single spinner.
                      Terminal states skip it; there is nothing left to climb. */}
                      {d.status !== "READY" && d.status !== "FAILED" && (
                        <div
                          className="mt-2 flex items-center gap-1"
                          role="img"
                          aria-label={t(
                            `Indexing: ${d.status.toLowerCase()}`,
                            `الفهرسة: ${STATUS_AR[d.status] ?? d.status.toLowerCase()}`,
                            lang,
                          )}
                        >
                          {LADDER.map((s, i) => (
                            <span
                              key={s}
                              className={cn(
                                "h-1 w-6 rounded-full",
                                i < step ? "bg-primary/40" : i === step ? "bg-primary" : "bg-line",
                              )}
                            />
                          ))}
                        </div>
                      )}
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
                      {t(
                        d.status.toLowerCase(),
                        STATUS_AR[d.status] ?? d.status.toLowerCase(),
                        lang,
                      )}
                    </span>
                    {d.status === "FAILED" && (
                      <button
                        type="button"
                        onClick={() => void retry(d.id)}
                        aria-label={t(
                          `Retry indexing ${d.title}`,
                          `إعادة محاولة فهرسة ${d.title}`,
                          lang,
                        )}
                        className="rounded-full border border-line bg-white px-2.5 py-1 text-[10.5px] font-semibold text-ink-2 hover:text-primary"
                      >
                        <RefreshCw className="h-3 w-3" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void remove(d.id)}
                      aria-label={t(`Delete ${d.title}`, `حذف ${d.title}`, lang)}
                      className="rounded-full border border-line bg-white px-2.5 py-1 text-[10.5px] font-semibold text-ink-2 hover:text-red-soft"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {!compact && (
        <div className="border-t border-line pt-5">
          <p className="flex items-center gap-2 text-[13px] font-semibold">
            <Search className="h-4 w-4 text-primary" />
            {t("Test knowledge base", "اختبر قاعدة المعرفة", lang)}
          </p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
            {t(
              "Ask a question the agent should answer from these documents. You get the exact chunk and its score — so you can see retrieval working before a live customer call depends on it.",
              "اطرح سؤالاً يجب أن يجيب عنه الوكيل من هذه المستندات. تحصل على المقطع الدقيق ودرجة تشابهه — لترى الاسترجاع يعمل قبل أن تعتمد عليه مكالمة عميل حقيقية.",
              lang,
            )}
          </p>
          <div className="mt-3 flex gap-2">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void testSearch();
              }}
              placeholder={t(
                "What do I do about a disputed cash withdrawal?",
                "ماذا أفعل بشأن سحب نقدي متنازع عليه؟",
                lang,
              )}
              aria-label={t("Test question", "سؤال الاختبار", lang)}
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
              {t("Search", "بحث", lang)}
            </button>
          </div>
          {searchNote && <p className="num mt-2 text-[11.5px] text-amber-soft">{searchNote}</p>}
          {hits && hits.length === 0 && !searchNote && (
            <p className="mt-2 text-[11.5px] text-ink-3">
              {t("No chunk matched that question.", "لم يطابق أي مقطع هذا السؤال.", lang)}
            </p>
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
                    <span className="num shrink-0 text-ink-3">
                      {t(`score ${h.score.toFixed(3)}`, `درجة التشابه ${h.score.toFixed(3)}`, lang)}
                    </span>
                  </p>
                  <p className="mt-1 line-clamp-4 text-[11.5px] leading-relaxed text-ink-2">
                    {highlightMatches(h.text, markWords)}
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
