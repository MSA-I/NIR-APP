// Diagnostic: run the real interpretation path over an ExtractionContract JSON file and print the
// contract the provider returns. Imports core.ts directly, so the prompt, schema, wire
// normalisation and evidence-id cross-validation are exactly what production does -- nothing is
// duplicated here. Lives outside supabase/functions/ because everything in there gets deployed.
//
//   npx deno run --config supabase/functions/interpret-document/deno.json \
//     --allow-env --allow-read --allow-net=api.openai.com \
//     scripts/fixtures/ocr/probe-interpret.ts <extraction.json>
import {
  buildProviderPayload,
  createOpenAiProvider,
  type ExtractionContract,
  type SupplierCandidate,
} from "../../../supabase/functions/interpret-document/core.ts";

const extractionPath = Deno.args[0];
if (!extractionPath) {
  console.error("usage: probe-interpret.ts <extraction.json>");
  Deno.exit(2);
}
const apiKey = Deno.env.get("OPENAI_API_KEY");
if (!apiKey) {
  console.error("OPENAI_API_KEY is missing");
  Deno.exit(2);
}

const extraction = JSON.parse(
  await Deno.readTextFile(extractionPath),
) as ExtractionContract;

// One candidate, so supplier matching has a legitimate id to point at instead of being forced
// to return null for lack of options.
const suppliers: SupplierCandidate[] = [{
  id: "11111111-1111-4111-8111-111111111111",
  name: Deno.args[1] ?? "ספק בדיקה",
  status: "active",
}];

const payload = buildProviderPayload(extraction, suppliers, []);
const started = performance.now();
const result = await createOpenAiProvider({ apiKey, timeoutMs: 120_000 })
  .interpret(payload);

console.log(
  `model=${result.model} ms=${Math.round(performance.now() - started)} usage=${
    JSON.stringify(result.usage)
  }`,
);
console.log(JSON.stringify(result.interpretation, null, 2));
