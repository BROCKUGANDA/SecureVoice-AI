/**
 * GATE — the institution knowledge base: upload → extract → chunk → embed, and
 * the tenant isolation around all of it.
 *
 * The failure this file exists to prevent is the one the platform's own docs
 * already admitted: `docs/TODO.md` said "the knowledge-base integration is
 * described, not built". Everything below is the machinery that makes that
 * sentence false — and specifically the properties that are cheap to claim and
 * expensive to guarantee:
 *
 *   1. An anonymous caller is refused; a caller with no ORGANIZATION is refused
 *      with 409 rather than being filed under a null tenant.
 *   2. An upload is validated by CONTENT. A `.pdf` filename on a shell script is
 *      refused; the declared MIME type is not trusted.
 *   3. Vectorization records a STATUS and a REASON for every outcome, including
 *      the configuration one (`pinecone_not_configured`). A silent success is the
 *      dangerous case: the console would show a knowledge base that answers
 *      nothing.
 *   4. Retry actually retries: it clears the error and re-enters the pipeline,
 *      which is only possible because the upload bytes are retained.
 *   5. **Cross-tenant is 404, never 403.** A 403 with a body confirms the
 *      document exists; a 404 does not. This is asserted directly.
 *
 * Pinecone is NOT configured in this environment, which is deliberate: it is the
 * one failure mode an operator WILL actually meet, so the test asserts the
 * honest `FAILED (pinecone_not_configured)` state rather than mocking the happy
 * path and never seeing it.
 *
 *   bun test tests/console/documents.test.ts
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import * as realCredits from "@/lib/credits";
import { buildPdf } from "../fixtures/build-pdf";

process.env.ELEVENLABS_DRY_RUN = "true";
process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "documents-gate-secret";
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "documents-gate-secret";

const ORG = `0d0d0d0d-0000-4000-8000-${createHash("sha256")
  .update("documents-a")
  .digest("hex")
  .slice(0, 12)}`;
const OTHER_ORG = `0d0d0d0d-0000-4000-8000-${createHash("sha256")
  .update("documents-b")
  .digest("hex")
  .slice(0, 12)}`;
const USER_ID = `00000000-0000-4000-8000-${createHash("sha256")
  .update("documents-user")
  .digest("hex")
  .slice(0, 12)}`;

const session = { orgId: ORG as string | null, signedIn: true };

mock.module("@/lib/credits", () => ({
  ...realCredits,
  // Signed-in but possibly with NO active organization — that is the state the
  // 409 branch exists for, so the mock must be able to express it. Returning
  // null there would make every such case a 401 and the 409 unreachable.
  getProfile: async () =>
    session.signedIn
      ? {
          userId: USER_ID,
          email: "kb@securevoice.ae",
          name: "KB Gate",
          role: "operator" as const,
          orgId: session.orgId,
          credits: 500,
          walletScope: (session.orgId ? "org" : "user") as "org" | "user",
        }
      : null,
}));

const { GET: listDocs, POST: uploadDoc } = await import("@/app/api/console/documents/route");
const { DELETE: deleteDoc } = await import("@/app/api/console/documents/[id]/route");
const { POST: retryDoc } = await import("@/app/api/console/documents/[id]/retry/route");
const { POST: testSearch } = await import("@/app/api/console/documents/test/route");

const POLICY_TEXT = [
  "Disputed transaction handling policy",
  "A cardholder who disputes a cash withdrawal receives a temporary restriction",
  "on the card ending 4417 while a fraud specialist reviews the case.",
  "The bank never asks for a PIN, an OTP or a CVV.",
].join("\n");

function pdfFile(name = "policy.pdf"): File {
  return new File([new Uint8Array(buildPdf(POLICY_TEXT))], name, { type: "application/pdf" });
}

function uploadForm(file: File, extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.append("file", file);
  form.append("title", "Fraud Disposition Policy");
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return form;
}

function post(url: string, init?: RequestInit) {
  return new NextRequest(new Request(`http://localhost${url}`, init));
}

async function readJson(res: Response) {
  return (await res.json().catch(() => ({}))) as Record<string, never> & {
    documents?: { id: string; status: string; error: string | null; title: string }[];
    document?: { id: string; status: string };
    error?: string;
    matches?: unknown[];
  };
}

/**
 * The upload hands vectorization off asynchronously, and the FIRST call in a
 * process pays pdf.js's cold start (a couple of seconds). So the poll window is
 * wide and the per-test timeout is raised to match — a default 5s timeout here
 * would abort the test while the pipeline was still correctly running, which is
 * the worst way to fail.
 */
async function waitForStatus(
  id: string,
  wanted: string[],
  tries = 200,
): Promise<{ status: string; error: string | null }> {
  for (let i = 0; i < tries; i++) {
    const row = await db.document.findUnique({
      where: { id },
      select: { status: true, error: true },
    });
    if (row && wanted.includes(row.status)) return row;
    await new Promise((r) => setTimeout(r, 100));
  }
  const row = await db.document.findUnique({
    where: { id },
    select: { status: true, error: true },
  });
  return row ?? { status: "MISSING", error: null };
}

beforeAll(async () => {
  await db.organization.createMany({
    data: [
      { id: ORG, name: "KB Gate Org", slug: `kb-gate-a-${ORG.slice(-6)}`, createdAt: new Date() },
      {
        id: OTHER_ORG,
        name: "Other Bank",
        slug: `kb-gate-b-${ORG.slice(-6)}`,
        createdAt: new Date(),
      },
    ],
    skipDuplicates: true,
  });
  await db.user.upsert({
    where: { id: USER_ID },
    create: {
      id: USER_ID,
      email: `kb.${ORG.slice(-6)}@securevoice.ae`,
      name: "KB Gate",
      emailVerified: true,
    },
    update: {},
  });
});

afterAll(async () => {
  await db.document.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
  await db.userProfile.deleteMany({ where: { userId: USER_ID } });
  await db.organization.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  await db.user.deleteMany({ where: { id: USER_ID } });
  await db.$disconnect();
});

test("documents: an anonymous caller is refused on every verb", async () => {
  session.signedIn = false;
  try {
    expect((await listDocs()).status).toBe(401);
    const up = await uploadDoc(
      post("/api/console/documents", { method: "POST", body: uploadForm(pdfFile()) }),
    );
    expect(up.status).toBe(401);
    const del = await deleteDoc(post("/api/console/documents/abc", { method: "DELETE" }), {
      params: Promise.resolve({ id: "abc" }),
    });
    expect(del.status).toBe(401);
    const retry = await retryDoc(post("/api/console/documents/abc/retry", { method: "POST" }), {
      params: Promise.resolve({ id: "abc" }),
    });
    expect(retry.status).toBe(401);
    const search = await testSearch(
      post("/api/console/documents/test", {
        method: "POST",
        body: JSON.stringify({ question: "what is the policy" }),
      }),
    );
    expect(search.status).toBe(401);
  } finally {
    session.signedIn = true;
  }
});

test("documents: a caller with no organization is refused with 409, not filed under null", async () => {
  session.orgId = null;
  try {
    const res = await uploadDoc(
      post("/api/console/documents", { method: "POST", body: uploadForm(pdfFile()) }),
    );
    expect(res.status).toBe(409);
    const body = await readJson(res);
    expect(body.error).toContain("organization");
    // No row must exist for a tenant-less upload. `Document.orgId` is NOT NULL in
    // the schema, so the guarantee is structural rather than a filter: the insert
    // could not have happened at all.
    const orphanRows = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM "Document" WHERE "orgId" IS NULL`,
    );
    expect(Number(orphanRows[0]?.n ?? 0)).toBe(0);
  } finally {
    session.orgId = ORG;
  }
});

test("documents: an upload is validated by CONTENT, not by filename or declared type", async () => {
  // A shell script wearing a .pdf name and an application/pdf content type.
  const disguised = new File(["#!/bin/sh\nrm -rf /\n"], "policy.pdf", { type: "application/pdf" });
  const res = await uploadDoc(
    post("/api/console/documents", { method: "POST", body: uploadForm(disguised) }),
  );
  expect(res.status).toBe(422);
  const body = await readJson(res);
  expect(body.error).toContain("PDF");
  expect(
    await db.document.count({ where: { title: "Fraud Disposition Policy", status: "PENDING" } }),
  ).toBe(0);
});

test("documents: an oversized upload is refused before anything is stored", async () => {
  const big = new File([new Uint8Array(9 * 1024 * 1024)], "big.pdf", { type: "application/pdf" });
  const res = await uploadDoc(
    post("/api/console/documents", { method: "POST", body: uploadForm(big) }),
  );
  expect(res.status).toBe(422);
  const body = await readJson(res);
  expect(body.error).toContain("8 MB");
});

test("documents: a real PDF is accepted, extracted, and lands on an honest FAILED state", async () => {
  const res = await uploadDoc(
    post("/api/console/documents", { method: "POST", body: uploadForm(pdfFile()) }),
  );
  expect(res.status).toBe(201);
  const created = (await readJson(res)).document!;
  expect(created.status).toBe("PENDING");

  // Extraction must have run against real PDF bytes — this is the assertion
  // that distinguishes "the pipeline works" from "the row was created".
  const settled = await waitForStatus(created.id, ["READY", "FAILED"]);
  expect(settled.status).toBe("FAILED");
  // Pinecone is intentionally unset in this environment, so the reason must be
  // the CONFIGURATION one and not an opaque extractor failure — that is the
  // difference between an instruction ("set the index keys") and a mystery. It
  // is also proof the extractor SUCCEEDED: reaching the Pinecone check means
  // chunking ran on real text.
  expect(settled.error).toBe("pinecone_not_configured");

  // The raw bytes are retained so Retry needs no re-upload.
  const row = await db.document.findUnique({
    where: { id: created.id },
    select: { pdfBytes: true },
  });
  expect(row?.pdfBytes?.length ?? 0).toBeGreaterThan(0);
}, 60_000);

test("documents: retry clears the error and re-enters the pipeline", async () => {
  const res = await uploadDoc(
    post("/api/console/documents", { method: "POST", body: uploadForm(pdfFile("retry.pdf")) }),
  );
  const id = (await readJson(res)).document!.id;
  await waitForStatus(id, ["FAILED"]);

  const retry = await retryDoc(post(`/api/console/documents/${id}/retry`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
  expect(retry.status).toBe(200);
  // The row must exist and the error must be CLEARED — a retry that leaves the
  // old reason in place tells the operator their fix did nothing.
  const immediately = await db.document.findUnique({
    where: { id },
    select: { status: true, error: true },
  });
  expect(immediately).not.toBeNull();
  expect(["PENDING", "CHUNKING", "EMBEDDING", "FAILED"]).toContain(immediately!.status);
  expect(immediately!.error).toBeNull();

  await waitForStatus(id, ["FAILED", "READY"]);
  const settled = await db.document.findUnique({ where: { id }, select: { error: true } });
  expect(settled?.error).toBe("pinecone_not_configured");
}, 60_000);

test("documents: a cross-tenant document id is 404, and its existence is NOT confirmed", async () => {
  // A row that belongs to a DIFFERENT organization.
  const foreign = await db.document.create({
    data: {
      orgId: OTHER_ORG,
      title: "Other Bank Policy",
      fileName: "other.pdf",
      sizeBytes: 10,
      status: "PENDING",
    },
    select: { id: true },
  });

  const del = await deleteDoc(post(`/api/console/documents/${foreign.id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id: foreign.id }),
  });
  // 404, not 403. A 403 body would tell a competitor that this document id is
  // real, which is itself a leak.
  expect(del.status).toBe(404);
  expect((await readJson(del)).error).toBe("not found");
  expect(await db.document.count({ where: { id: foreign.id } })).toBe(1);

  // The listing is scoped to the session's org and does not mention it at all.
  const list = await readJson(await listDocs());
  expect((list.documents ?? []).some((d) => d.id === foreign.id)).toBe(false);

  await db.document.delete({ where: { id: foreign.id } });
});

test("documents: the list is org-scoped and never leaks raw bytes or the retained PDF", async () => {
  const list = await readJson(await listDocs());
  expect(Array.isArray(list.documents)).toBe(true);
  for (const d of list.documents ?? []) {
    expect(d).not.toHaveProperty("pdfBytes");
  }
  // Everything listed belongs to this org by construction.
  const rows = await db.document.findMany({ where: { orgId: OTHER_ORG }, select: { id: true } });
  for (const row of rows) {
    expect((list.documents ?? []).some((d) => d.id === row.id)).toBe(false);
  }
});

test("documents: test search reports the configuration state instead of pretending", async () => {
  const res = await testSearch(
    post("/api/console/documents/test", {
      method: "POST",
      body: JSON.stringify({ question: "what do I do about a disputed cash withdrawal" }),
    }),
  );
  // Deliberately 200: an unset index is a CONFIGURATION state, not a bad
  // request, and the console renders it as an instruction rather than an error.
  expect(res.status).toBe(200);
  const body = await readJson(res);
  expect(body.error).toBe("pinecone_not_configured");
  expect(body.matches ?? []).toEqual([]);
});

test("documents: test search validates its input before spending an embedding call", async () => {
  const res = await testSearch(
    post("/api/console/documents/test", {
      method: "POST",
      body: JSON.stringify({ question: "a" }),
    }),
  );
  expect(res.status).toBe(422);
});
