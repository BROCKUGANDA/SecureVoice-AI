/**
 * Shared fixture: a REAL, minimal PDF, built byte by byte.
 *
 * Why not a checked-in binary: the documents pipeline's first real step is
 * `extractPdfText` (unpdf/pdf.js), and a fixture that is not a genuine PDF tests
 * nothing — the extractor would reject it and the test would "pass" by asserting
 * a failure. Building the file here keeps the bytes honest and the assertion
 * about the pipeline.
 *
 * The xref table is computed from the actual byte offsets, because pdf.js
 * validates it: a hand-written wrong offset makes the file unopenable, and a test
 * that then asserts `FAILED` would pass for exactly the wrong reason.
 */
export function buildPdf(text: string): Uint8Array {
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>",
    `<</Length ${contentLength(text)}>>stream\n${contentStream(text)}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return new TextEncoder().encode(body);
}

function contentStream(text: string): string {
  // Each source line becomes its own Tj so the extractor sees line breaks, which
  // is what the chunker's paragraph-boundary path depends on.
  const lines = text.split("\n");
  const ops = [
    "BT",
    "/F1 12 Tf",
    "14 TL",
    "20 160 Td",
    ...lines.map((l) => `(${escapePdf(l)}) Tj T*`),
  ];
  return ops.join("\n");
}

function contentLength(text: string): number {
  return Buffer.byteLength(contentStream(text), "latin1");
}

function escapePdf(s: string): string {
  return s.replace(/([\\()])/g, "\\$1");
}
