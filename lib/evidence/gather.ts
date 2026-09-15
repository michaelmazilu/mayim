/**
 * Turn live Exa hits into findings: LLM structuring when configured, the
 * deterministic excerpt structurer otherwise (or when the LLM call fails).
 * Shared by the pipeline and `npm run evidence:refresh`.
 */

import type { EvidenceFinding, TownRef } from "@/lib/types";
import type { RawEvidence } from "@/lib/evidence/exa";
import { isLlmConfigured, llmModel, structureFindings } from "@/lib/evidence/llm";
import { structureDeterministically } from "@/lib/evidence/structure";

export async function structureLive(
  town: TownRef,
  raw: RawEvidence[],
): Promise<{ findings: EvidenceFinding[]; structuredBy: string }> {
  if (raw.length === 0) return { findings: [], structuredBy: "none" };
  if (isLlmConfigured()) {
    const findings = await structureFindings(town, raw);
    if (findings && findings.length > 0) return { findings, structuredBy: `llm:${llmModel()}` };
  }
  return { findings: structureDeterministically(raw, town.name), structuredBy: "deterministic" };
}
