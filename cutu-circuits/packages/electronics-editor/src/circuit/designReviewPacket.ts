import { buildBomProjection } from './bomProjection.ts';
import {
  canonicalJson,
  checkArtifactFreshnessSnapshot,
  sha256Text,
  writeTrackedExport,
  type ArtifactFreshnessResult,
  type TextFileSystem,
} from './artifactFreshness.ts';
import { lintCircuit, listComponents, listNets } from './circuitJson.ts';
import { buildReadinessReport } from './readiness.ts';
import { summarizeProjectGuidance } from './projectGuidance.ts';
import { buildPcbRuleLens, type PcbRuleLensResult } from './pcbRuleLens.ts';
import type { DesignReviewSnapshot, ElectronicsEditorAPI } from '../editorApi.ts';
import { parseSimulationReportSummary, type SimulationReportSummary } from '../sim/simulationReport.ts';
import { parseSimulationMatrixReportSummary, type SimulationMatrixReportSummary } from '../sim/simulationMatrixReport.ts';
import {
  reviewPartEvidenceContributionDraft,
  type PartEvidenceContributionReviewResult,
} from './partEvidenceContribution.ts';

export const DESIGN_REVIEW_PACKET_SCHEMA = 'cutucircuits-electronics/design-review-packet@1' as const;
export const DESIGN_REVIEW_GENERATOR = 'electronics-design-review@1' as const;

export type DesignReviewResult = {
  status: 'created' | 'refused' | 'incomplete';
  output_path: string;
  manifest_path: string;
  packet_sha256?: string;
  source_sha256?: string;
  circuit_json_sha256?: string;
  sourceStableBeforeWrite: boolean;
  sourceStableBeforeManifest: boolean;
  freshAtReturn: 'not-guaranteed';
  nonAtomicNoClobber: true;
  symlinkConfinement: 'unproven';
  cleanup?: { automatic: false; pathsThatMayExist: string[] };
  refusal?: { code: string; message: string };
};

interface FreshnessObservation extends ArtifactFreshnessResult {
  recordedArtifactPaths?: string[];
}

interface PacketBuild {
  markdown: string;
  packetSha256: string;
  sourceSha256: string;
  circuitJsonSha256: string;
  observations: FreshnessObservation[];
}

function pathError(label: string, message: string): never {
  throw new Error(`${label} ${message}`);
}

export function validateCanonicalWorkspaceRelativePath(path: unknown, label: string, suffix: string): string {
  if (typeof path !== 'string' || !path || path.trim() !== path) pathError(label, 'must be an explicit non-empty canonical workspace-relative path.');
  if (path.includes('\\')) pathError(label, 'must use forward slashes; backslashes are rejected.');
  if (path.includes('\0')) pathError(label, 'must not contain NUL.');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) pathError(label, 'must be workspace-relative, not absolute.');
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) pathError(label, 'must not contain empty, dot, or dot-dot segments.');
  if (!path.endsWith(suffix)) pathError(label, `must end with ${suffix}.`);
  return path;
}

function joinWorkspace(workspacePath: string, relativePath: string): string {
  return `${workspacePath.replace(/\/$/, '')}/${relativePath}`;
}

function parentPath(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

function displayPath(path: string, workspacePath: string): string {
  const prefix = `${workspacePath.replace(/\/$/, '')}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export const MAX_PRESENTED_FIELD_BYTES = 256;
const PRESENTATION_LIMITS = {
  boards: 32,
  components: 256,
  nets: 256,
  netEndpoints: 64,
  readinessChecks: 64,
  readinessActions: 16,
  lintFindings: 256,
  findingRefs: 64,
  bomGroups: 256,
  bomRefs: 128,
  evidenceRefs: 128,
  freshnessObservations: 64,
  freshnessDetails: 16,
  artifactPointers: 256,
  simulationReports: 32,
  simulationResults: 32,
  simulationMatrixReports: 16,
  simulationMatrixCases: 8,
  simulationMatrixResults: 16,
  partContributionDrafts: 16,
  pcbRuleFindings: 64,
} as const;

type PcbRuleLensPacketObservation =
  | { state: 'not-loaded' }
  | { state: 'minimums-not-declared' }
  | { state: 'observed'; result: PcbRuleLensResult }
  | { state: 'unavailable'; error: string };

function observeLoadedGuidancePcbRules(snapshot: DesignReviewSnapshot): PcbRuleLensPacketObservation {
  if (!snapshot.loadedProjectGuidance) return { state: 'not-loaded' };
  const minimums = snapshot.loadedProjectGuidance.rules.pcbScalarMinimums;
  if (!minimums) return { state: 'minimums-not-declared' };
  try {
    return { state: 'observed', result: buildPcbRuleLens(snapshot.circuitJson, { kind: 'loaded-project-guidance', minimums }).result };
  } catch (error) {
    return { state: 'unavailable', error: error instanceof Error ? error.message : String(error) };
  }
}

function normalizePresentationText(value: unknown): string {
  const normalized = String(value)
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\p{Cf}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized || '(empty)';
}

export function boundUtf8Presentation(value: unknown, maxBytes = MAX_PRESENTED_FIELD_BYTES): string {
  const normalized = normalizePresentationText(value);
  const encoder = new TextEncoder();
  const totalBytes = encoder.encode(normalized).length;
  if (totalBytes <= maxBytes) return normalized;
  let prefix = '';
  let prefixBytes = 0;
  for (const character of normalized) {
    const bytes = encoder.encode(character).length;
    const candidateBytes = prefixBytes + bytes;
    const candidateSuffix = ` … [${totalBytes - candidateBytes} UTF-8 bytes omitted]`;
    if (candidateBytes + encoder.encode(candidateSuffix).length > maxBytes) break;
    prefix += character;
    prefixBytes = candidateBytes;
  }
  const suffix = ` … [${totalBytes - prefixBytes} UTF-8 bytes omitted]`;
  return `${prefix}${suffix}`;
}

/** One inert, single-line, byte-bounded Markdown code span. */
function scalar(value: unknown): string {
  const text = boundUtf8Presentation(value);
  const longestBacktickRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(longestBacktickRun + 1);
  const padding = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${text}${padding}${fence}`;
}

function presented<T>(values: T[], limit: number): { visible: T[]; omitted: number } {
  return { visible: values.slice(0, limit), omitted: Math.max(0, values.length - limit) };
}

function omissionLine(label: string, omitted: number): string[] {
  return omitted ? [`- ${label} omitted from presentation: ${scalar(omitted)}.`] : [];
}

function sortedStrings(values: string[]): string[] {
  return [...values].sort(compareStrings);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface ReviewBomGroup {
  comment: string;
  footprint: string;
  lcsc: string;
  mpn: string;
  designators: string[];
}

function reviewText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Valid designs use the shared assembly-backed projection. The packet's older
 * adversarial-input contract still requires a bounded report when those strict
 * identities are malformed, so its fallback groups presentation fields only
 * and must never be used as assembly-readiness evidence.
 */
function projectReviewBom(circuitJson: DesignReviewSnapshot['circuitJson']): ReviewBomGroup[] {
  try {
    return buildBomProjection(circuitJson).lines.map((line) => ({
      comment: line.comment,
      footprint: line.footprint,
      lcsc: line.lcscPartNumber,
      mpn: line.manufacturerPartNumber,
      designators: line.refs.map((ref) => ref.ref),
    }));
  } catch {
    const groups = new Map<string, ReviewBomGroup>();
    for (const element of circuitJson) {
      if (element.type !== 'source_component') continue;
      const designator = reviewText(element.name);
      if (!designator) continue;
      const mpn = reviewText(element.manufacturer_part_number) || reviewText(element.manufacturerPartNumber);
      const comment = reviewText(element.display_value)
        || reviewText(element.resistance)
        || reviewText(element.capacitance)
        || reviewText(element.inductance)
        || mpn
        || reviewText(element.ftype).replace(/^simple_/, '').replace(/_/g, ' ');
      const footprint = reviewText(element.footprint);
      const suppliers = element.supplier_part_numbers;
      const supplierMap = suppliers && typeof suppliers === 'object' && !Array.isArray(suppliers)
        ? suppliers as Record<string, unknown>
        : {};
      const lcsc = ['jlcpcb', 'lcsc', 'JLCPCB', 'LCSC'].flatMap((provider) => {
        const candidate = supplierMap[provider];
        return Array.isArray(candidate) && typeof candidate[0] === 'string' ? [candidate[0]] : [];
      })[0] ?? '';
      const key = JSON.stringify([comment, footprint, lcsc, mpn]);
      const current = groups.get(key);
      if (current) current.designators.push(designator);
      else groups.set(key, { comment, footprint, lcsc, mpn, designators: [designator] });
    }
    return [...groups.values()].sort((a, b) => a.designators[0].localeCompare(b.designators[0]));
  }
}

async function buildPacket(
  snapshot: DesignReviewSnapshot,
  fs: Pick<TextFileSystem, 'readFile' | 'fileExists'>,
  workspacePath: string,
  artifactManifestPaths: string[],
): Promise<PacketBuild> {
  const [sourceSha256, circuitJsonSha256] = await Promise.all([
    sha256Text(snapshot.source),
    sha256Text(canonicalJson(snapshot.circuitJson)),
  ]);
  const observations: FreshnessObservation[] = [];
  const pcbRuleLens = observeLoadedGuidancePcbRules(snapshot);
  for (const path of artifactManifestPaths) {
    observations.push(await checkArtifactFreshnessSnapshot({
      fs,
      manifestPath: path,
      source: snapshot.source,
      circuitJson: snapshot.circuitJson,
    }));
  }
  observations.sort((a, b) => compareStrings(a.manifestPath, b.manifestPath));
  const partContributionReviews: Array<{
    manifestPath: string;
    review: PartEvidenceContributionReviewResult;
  }> = [];
  for (const observation of observations) {
    if (!observation.fresh || observation.kind !== 'part-contribution-draft') continue;
    const review = await reviewPartEvidenceContributionDraft({
      fs,
      workspacePath,
      manifestPath: displayPath(observation.manifestPath, workspacePath),
    });
    if (review.state === 'consistent_current_observations') {
      partContributionReviews.push({ manifestPath: observation.manifestPath, review });
    }
  }
  partContributionReviews.sort((a, b) => compareStrings(a.manifestPath, b.manifestPath));
  const simulationReports: Array<{
    manifestPath: string;
    artifactPath: string;
    summary?: SimulationReportSummary;
    error?: string;
  }> = [];
  for (const observation of observations) {
    if (!observation.fresh || observation.kind !== 'simulation-report' || observation.recordedArtifactPaths?.length !== 1) continue;
    const artifactPath = observation.recordedArtifactPaths[0];
    try {
      simulationReports.push({ manifestPath: observation.manifestPath, artifactPath, summary: parseSimulationReportSummary(await fs.readFile(artifactPath)) });
    } catch (error) {
      simulationReports.push({ manifestPath: observation.manifestPath, artifactPath, error: error instanceof Error ? error.message : String(error) });
    }
  }
  simulationReports.sort((a, b) => compareStrings(a.manifestPath, b.manifestPath));
  const simulationMatrixReports: Array<{
    manifestPath: string;
    artifactPath: string;
    summary?: SimulationMatrixReportSummary;
    error?: string;
  }> = [];
  for (const observation of observations) {
    if (!observation.fresh || observation.kind !== 'simulation-matrix-report' || observation.recordedArtifactPaths?.length !== 1) continue;
    const artifactPath = observation.recordedArtifactPaths[0];
    try {
      simulationMatrixReports.push({
        manifestPath: observation.manifestPath,
        artifactPath,
        summary: parseSimulationMatrixReportSummary(await fs.readFile(artifactPath)),
      });
    } catch (error) {
      simulationMatrixReports.push({
        manifestPath: observation.manifestPath,
        artifactPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  simulationMatrixReports.sort((a, b) => compareStrings(a.manifestPath, b.manifestPath));

  const components = listComponents(snapshot.circuitJson)
    .sort((a, b) => compareStrings(a.name, b.name) || compareStrings(a.id, b.id));
  const boards = snapshot.circuitJson
    .filter((item) => item.type === 'pcb_board')
    .map((item, index) => ({
      id: typeof item.pcb_board_id === 'string' ? item.pcb_board_id : `board-${index + 1}`,
      width: typeof item.width === 'number' ? item.width : 'unresolved',
      height: typeof item.height === 'number' ? item.height : 'unresolved',
    }))
    .sort((a, b) => compareStrings(a.id, b.id));
  const nets = listNets(snapshot.circuitJson)
    .map((net) => ({ name: net.name, endpoints: sortedStrings(net.endpoints) }))
    .sort((a, b) => compareStrings(a.name, b.name) || compareStrings(a.endpoints.join('\0'), b.endpoints.join('\0')));
  const readiness = buildReadinessReport(
    snapshot.circuitJson,
    snapshot.loadedProjectGuidance,
    snapshot.source,
    snapshot.loadedPartEvidence,
  );
  const findings = lintCircuit(snapshot.circuitJson)
    .map((finding) => ({ ...finding, relatedRefs: sortedStrings(finding.relatedRefs ?? []) }))
    .sort((a, b) => compareStrings(a.rule, b.rule) || compareStrings(a.severity, b.severity) || compareStrings(a.message, b.message) || compareStrings(a.relatedRefs.join('\0'), b.relatedRefs.join('\0')));
  const bom = projectReviewBom(snapshot.circuitJson)
    .map((group) => ({ ...group, designators: sortedStrings(group.designators) }))
    .sort((a, b) => compareStrings(`${a.comment}|${a.footprint}|${a.lcsc}|${a.mpn}`, `${b.comment}|${b.footprint}|${b.lcsc}|${b.mpn}`));
  const presentedBoards = presented(boards, PRESENTATION_LIMITS.boards);
  const presentedComponents = presented(components, PRESENTATION_LIMITS.components);
  const presentedNets = presented(nets, PRESENTATION_LIMITS.nets);
  const readinessChecks = presented([...readiness.checks].sort((a, b) => compareStrings(a.id, b.id)), PRESENTATION_LIMITS.readinessChecks);
  const readinessActions = presented(readiness.nextActions, PRESENTATION_LIMITS.readinessActions);
  const presentedFindings = presented(findings, PRESENTATION_LIMITS.lintFindings);
  const presentedBom = presented(bom, PRESENTATION_LIMITS.bomGroups);
  const presentedObservations = presented(observations, PRESENTATION_LIMITS.freshnessObservations);
  const artifactPointers = presented(
    sortedStrings(observations.flatMap((observation) => observation.recordedArtifactPaths ?? [])),
    PRESENTATION_LIMITS.artifactPointers,
  );
  const presentedSimulationReports = presented(simulationReports, PRESENTATION_LIMITS.simulationReports);
  const presentedSimulationMatrixReports = presented(simulationMatrixReports, PRESENTATION_LIMITS.simulationMatrixReports);
  const presentedPartContributionReviews = presented(partContributionReviews, PRESENTATION_LIMITS.partContributionDrafts);

  const lines: string[] = [
    '# Electronics design review packet',
    '',
    '## 1. Scope and prohibited interpretations',
    '',
    '- This is a deterministic local preflight dossier over one immutable editor-buffer source copy and its one evaluated Circuit JSON snapshot.',
    '- It is not ERC, DRC, DFM, fabrication or fab acceptance, manufacturing correctness or acceptance, KiCad-application validation, physical/hardware validation, or offline validation.',
    '- It does not save, mutate, approve, synchronize, auto-run, scan the workspace, or prove that the editor buffer matches disk.',
    '- Freshness manifests are unsigned and unauthenticated; neither manifest authenticity nor resistance to coordinated edits is proven.',
    '- Any fresh artifact state was observed during generation only. Freshness after observation or at tool return is not guaranteed.',
    '',
    '## 2. Snapshot provenance',
    '',
    `- Packet schema: ${scalar(DESIGN_REVIEW_PACKET_SCHEMA)}`,
    `- Generator: ${scalar(DESIGN_REVIEW_GENERATOR)}`,
    `- Source origin: ${scalar(snapshot.sourceOrigin)}`,
    `- Persistence state: ${scalar(snapshot.persistenceState)} (saved/unsaved state and disk match are unknown)`,
    `- Source SHA-256: ${scalar(sourceSha256)}`,
    `- Canonical Circuit JSON SHA-256: ${scalar(circuitJsonSha256)}`,
    '- Snapshot evaluation count: `1`',
    '- Artifact freshness scope: `observed-during-generation`',
    '- Fresh at return: `not-guaranteed`',
    '',
    '## 3. Exact evaluated inventory',
    '',
    `- Board count: ${scalar(boards.length)}. Definition: evaluated elements whose exact type is ${scalar('pcb_board')}.`,
    `- Placed-part count: ${scalar(components.length)}. Definition: evaluated ${scalar('source_component')} elements exposed by the existing component inventory; this does not prove placement, footprint correctness, or assembly readiness.`,
    `- Logical-net count: ${scalar(nets.length)}. Definition: one existing logical-net inventory entry per evaluated ${scalar('source_trace')}; this is not PCB copper or routing proof.`,
    '',
    '### Boards',
    '',
    ...(boards.length ? presentedBoards.visible.map((board) => `- ${scalar(board.id)} — width ${scalar(board.width)}, height ${scalar(board.height)}`) : ['- None.']),
    ...omissionLine('Boards', presentedBoards.omitted),
    '',
    '### Placed parts',
    '',
    ...(components.length ? presentedComponents.visible.map((part) => `- ${scalar(part.name)} — id ${scalar(part.id || 'unresolved')}; value ${scalar(part.value ?? 'unresolved')}; footprint ${scalar(part.footprint ?? 'unresolved')}; MPN ${scalar(part.manufacturerPartNumber ?? 'unresolved')}`) : ['- None.']),
    ...omissionLine('Placed parts', presentedComponents.omitted),
    '',
    '### Logical nets',
    '',
    ...(nets.length ? presentedNets.visible.flatMap((net) => {
      const endpoints = presented(net.endpoints, PRESENTATION_LIMITS.netEndpoints);
      return [
        `- ${scalar(net.name)} — endpoints ${endpoints.visible.length ? endpoints.visible.map(scalar).join(', ') : scalar('none')}`,
        ...(endpoints.omitted ? [`  - Endpoints omitted from presentation: ${scalar(endpoints.omitted)}.`] : []),
      ];
    }) : ['- None.']),
    ...omissionLine('Logical nets', presentedNets.omitted),
    '',
    '## 4. Existing readiness preflight guidance',
    '',
    `- Existing readiness score: ${scalar(readiness.score)} (${scalar(readiness.label)}). This is preflight guidance, not a second design-review score or a validation result.`,
    ...readinessChecks.visible.map((check) => `- ${scalar(check.id)} [${check.status}] ${scalar(check.title)}: ${scalar(check.detail)}${check.action ? ` Action: ${scalar(check.action)}` : ''}`),
    ...omissionLine('Readiness checks', readinessChecks.omitted),
    ...(readiness.nextActions.length ? ['- Prioritized actions:', ...readinessActions.visible.map((action) => `  - ${scalar(action)}`), ...(readinessActions.omitted ? [`  - Actions omitted from presentation: ${scalar(readinessActions.omitted)}.`] : [])] : ['- Prioritized actions: none from the existing preflight.']),
    '',
    '## 5. Heuristic lint findings',
    '',
    '- These are heuristic lint findings, not ERC results.',
    ...(findings.length ? presentedFindings.visible.flatMap((finding, index) => {
      const refs = presented(finding.relatedRefs, PRESENTATION_LIMITS.findingRefs);
      return [
        `- ${scalar(finding.id ?? `heuristic-${index + 1}`)} [${finding.severity}] ${scalar(finding.rule)}: ${scalar(finding.message)} Refs: ${refs.visible.length ? refs.visible.map(scalar).join(', ') : scalar('none')}.`,
        ...(refs.omitted ? [`  - Related refs omitted from presentation: ${scalar(refs.omitted)}.`] : []),
      ];
    }) : ['- None observed by the heuristic linter.']),
    ...omissionLine('Lint findings', presentedFindings.omitted),
    '',
    '## 6. BOM summary',
    '',
    `- Group count: ${scalar(bom.length)}; grouped placed-part quantity: ${scalar(bom.reduce((sum, group) => sum + group.designators.length, 0))}. Grouping reuses the existing value + footprint + supplier/manufacturer part-number contract.`,
    ...(bom.length ? presentedBom.visible.flatMap((group) => {
      const refs = presented(group.designators, PRESENTATION_LIMITS.bomRefs);
      return [
        `- Qty ${scalar(group.designators.length)}; refs ${refs.visible.map(scalar).join(', ')}; value ${scalar(group.comment || 'unresolved')}; footprint ${scalar(group.footprint || 'unresolved')}; MPN ${scalar(group.mpn || group.lcsc || 'unresolved')}.`,
        ...(refs.omitted ? [`  - BOM refs omitted from presentation: ${scalar(refs.omitted)}.`] : []),
      ];
    }) : ['- No named source-component BOM groups.']),
    ...omissionLine('BOM groups', presentedBom.omitted),
    '',
    '## 7. Loaded project guidance state',
    '',
    snapshot.loadedProjectGuidance
      ? '- State: `loaded-provenance-unknown`. The editor session had guidance loaded, but this snapshot does not prove its path, bytes, hash, freshness, authenticity, or an implicit reload.'
      : '- State: `not-loaded`. No project guidance was loaded into the editor session; no implicit reload was attempted.',
    ...(snapshot.loadedProjectGuidance
      ? Object.entries(summarizeProjectGuidance(snapshot.loadedProjectGuidance)).sort(([a], [b]) => compareStrings(a, b)).map(([key, value]) => `- ${scalar(key)}: ${scalar(value)}`)
      : []),
    '',
    '## 8. Loaded part-evidence state',
    '',
    snapshot.loadedPartEvidence
      ? '- State: `loaded-provenance-unknown`. The report was copied from current editor-session state without reloading or synchronizing it.'
      : '- State: `not-loaded`. No part-evidence report was loaded into the editor session; no implicit reload was attempted.',
    ...(snapshot.loadedPartEvidence ? [
      `- Counts: total ${scalar(snapshot.loadedPartEvidence.summary.total)}, incomplete ${scalar(snapshot.loadedPartEvidence.summary.incomplete)}, declared ${scalar(snapshot.loadedPartEvidence.summary.declared)}, evidenced ${scalar(snapshot.loadedPartEvidence.summary.evidenced)}, conflict ${scalar(snapshot.loadedPartEvidence.summary.conflict)}.`,
      ...(['incomplete', 'declared', 'evidenced', 'conflict'] as const).flatMap((state) => {
        const allRefs = snapshot.loadedPartEvidence!.parts
          .filter((part) => part.status === state)
          .map((part) => part.ref)
          .sort(compareStrings);
        const refs = presented(allRefs, PRESENTATION_LIMITS.evidenceRefs);
        return [
          `- ${state} refs: ${refs.visible.length ? refs.visible.map(scalar).join(', ') : scalar('none')}.`,
          ...(refs.omitted ? [`  - ${state} refs omitted from presentation: ${scalar(refs.omitted)}.`] : []),
        ];
      }),
      '- Evidence disclaimer: referenced evidence paths were presence-checked only. Their contents were not opened, read, content-hashed, validated, authenticated, or verified; presence is not authenticity or correctness.',
    ] : ['- No evidence contents or paths were read by packet generation.']),
    '',
    '## 9. Explicit artifact freshness observations',
    '',
    '- Freshness means observed-during-generation only; `freshAtReturn` is always `not-guaranteed`. Manifest authenticity is not proven.',
    ...(observations.length ? presentedObservations.visible.flatMap((observation) => {
      const details = presented(observation.details, PRESENTATION_LIMITS.freshnessDetails);
      return [
        `- Manifest ${scalar(displayPath(observation.manifestPath, workspacePath))}: state ${scalar(observation.state)}; fresh ${scalar(observation.fresh)}.`,
        ...details.visible.map((detail) => `  - ${scalar(detail)}`),
        ...(details.omitted ? [`  - Freshness details omitted from presentation: ${scalar(details.omitted)}.`] : []),
      ];
    }) : ['- No explicit artifact manifests were supplied; freshness was not assessed.']),
    ...omissionLine('Freshness observations', presentedObservations.omitted),
    '',
    '### Loaded-guidance PCB Rule Lens observation',
    '',
    '- This is one bounded scalar observation from the same immutable Circuit JSON and copied loaded-guidance session state as this packet. It does not re-evaluate source, reload guidance, scan files, or prove comprehensive clearance, ERC, DRC, DFM, fabrication acceptance, manufacturing, or physical hardware.',
    ...(pcbRuleLens.state === 'not-loaded'
      ? ['- State: `not-loaded`; no PCB Rule Lens observation was attempted and no guidance file was implicitly loaded.']
      : pcbRuleLens.state === 'minimums-not-declared'
        ? ['- State: `minimums-not-declared`; loaded guidance had no `rules.pcbScalarMinimums`, so no scalar comparison was attempted.']
        : pcbRuleLens.state === 'unavailable'
          ? [`- State: \`unavailable\`; the bounded comparison refused: ${scalar(pcbRuleLens.error)}.`]
          : (() => {
              const result = pcbRuleLens.result;
              const findings = presented(result.findings, PRESENTATION_LIMITS.pcbRuleFindings);
              return [
                `- State: \`observed\`; status ${scalar(result.status)} against ${scalar(result.reference.label)} using units ${scalar(result.units)}.`,
                `- Counts: violations ${scalar(result.counts.violations)}, indeterminate ${scalar(result.counts.indeterminate)}, exact markers ${scalar(result.counts.markers)}, findings omitted by Rule Lens ${scalar(result.counts.omittedFindings)}, markers omitted ${scalar(result.counts.omittedMarkers)}.`,
                `- Inspected: traces ${scalar(result.observed.traceCount)}, wire route entries ${scalar(result.observed.wireRouteEntryCount)}, vias ${scalar(result.observed.viaCount)}${result.observed.platedHoleCount == null ? '' : `, plated holes ${scalar(result.observed.platedHoleCount)}, inspectable circular plated holes ${scalar(result.observed.inspectableCircularPlatedHoleCount ?? 0)}`}.`,
                ...(result.observed.minimumTraceWidthMm == null ? [] : [`- Minimum observed trace width: ${scalar(result.observed.minimumTraceWidthMm)} mm.`]),
                ...(result.observed.minimumViaHoleDiameterMm == null ? [] : [`- Minimum observed via-hole diameter: ${scalar(result.observed.minimumViaHoleDiameterMm)} mm.`]),
                ...(result.observed.minimumViaPadDiameterMm == null ? [] : [`- Minimum observed via-pad diameter: ${scalar(result.observed.minimumViaPadDiameterMm)} mm.`]),
                ...(result.observed.minimumTraceRoutePointEdgeGapMm == null ? [] : [`- Minimum observed trace route-point edge envelope: ${scalar(result.observed.minimumTraceRoutePointEdgeGapMm)} mm.`]),
                ...(result.observed.minimumViaPadEdgeGapMm == null ? [] : [`- Minimum observed via-pad edge envelope: ${scalar(result.observed.minimumViaPadEdgeGapMm)} mm.`]),
                ...(result.observed.minimumPadToPadEdgeGapMm == null ? [] : [`- Minimum observed supported SMT-pad edge gap: ${scalar(result.observed.minimumPadToPadEdgeGapMm)} mm.`]),
                ...(result.observed.minimumPlatedHoleAnnularRingMm == null ? [] : [`- Minimum observed nominal circular plated-hole radial annular width: ${scalar(result.observed.minimumPlatedHoleAnnularRingMm)} mm; drill/plating tolerance is not modeled.`]),
                ...(findings.visible.length
                  ? findings.visible.map((finding) => `- [${finding.status}] ${scalar(finding.kind)}: ${scalar(finding.message)}`)
                  : ['- No bounded Rule Lens findings were emitted.']),
                ...omissionLine('PCB Rule Lens findings', findings.omitted),
                `- Limitation: ${scalar(result.limitation)}`,
              ];
            })()),
    '',
    '### Accepted explicit part-contribution drafts',
    '',
    '- Only explicitly supplied `part-contribution-draft` manifests that are fresh for this exact editor snapshot and internally consistent with current root collision/path-presence observations are summarized. This is not verification, acceptance, publication, licensing, or content review.',
    ...(partContributionReviews.length ? presentedPartContributionReviews.visible.map(({ manifestPath, review }) => {
      const draft = review.draft!;
      return `- Manifest ${scalar(displayPath(manifestPath, workspacePath))}; draft ${scalar(review.draft_path)}; selected ${scalar(draft.selected.ref)} / ${scalar(draft.selected.sourceComponentId)}; MPN ${scalar(draft.selected.mpn)}; footprint ${scalar(draft.selected.footprint)}; root collision ${scalar(review.current?.collision ?? draft.localObservations.collisionTarget.collision)}; evidence paths present ${scalar(review.current?.pathPresence.present ?? 0)}, missing ${scalar(review.current?.pathPresence.missing ?? 0)}.`;
    }) : ['- No fresh, consistent explicit part-contribution draft was supplied.']),
    ...omissionLine('Part-contribution drafts', presentedPartContributionReviews.omitted),
    '',
    '## 10. Explicit simulation regression results and matrices',
    '',
    '- Only fresh, explicitly supplied `simulation-report` manifests are summarized. A passing emulator report is not hardware validation.',
    ...(simulationReports.length ? presentedSimulationReports.visible.flatMap((entry) => {
      if (!entry.summary) return [
        `- Report ${scalar(displayPath(entry.artifactPath, workspacePath))}: fresh emitted text, but its simulation-report content is unsupported or malformed: ${scalar(entry.error ?? 'unknown parse failure')}.`,
      ];
      const results = presented(entry.summary.results, PRESENTATION_LIMITS.simulationResults);
      return [
        `- ${scalar(entry.summary.name)}: ${scalar(entry.summary.status)}; ${scalar(entry.summary.passed)} passed, ${scalar(entry.summary.failed)} failed on ${scalar(entry.summary.engine)} / ${scalar(entry.summary.fixture)}; requested ${scalar(entry.summary.durationMs)} ms${entry.summary.simulatedMs == null ? '' : `, observed ${scalar(entry.summary.simulatedMs)} simulated ms`}.`,
        `  - Circuit: ${scalar(entry.summary.circuitPath)}; test: ${scalar(entry.summary.testPath)}; report: ${scalar(displayPath(entry.artifactPath, workspacePath))}.`,
        ...results.visible.map((result) => `  - [${result.pass ? 'pass' : 'fail'}] ${scalar(result.type)}${result.target ? ` ${scalar(result.target)}` : ''}: ${scalar(result.detail)}`),
        ...(results.omitted ? [`  - Assertion results omitted from presentation: ${scalar(results.omitted)}.`] : []),
      ];
    }) : ['- No fresh explicit simulation-report manifest was supplied.']),
    ...omissionLine('Simulation reports', presentedSimulationReports.omitted),
    '',
    '- Only fresh, explicitly supplied `simulation-matrix-report` manifests are summarized. Every case is isolated in a fresh emulator; passing cases are not hardware validation.',
    ...(simulationMatrixReports.length ? presentedSimulationMatrixReports.visible.flatMap((entry) => {
      if (!entry.summary) return [
        `- Matrix report ${scalar(displayPath(entry.artifactPath, workspacePath))}: fresh emitted text, but its simulation-matrix-report content is unsupported or malformed: ${scalar(entry.error ?? 'unknown parse failure')}.`,
      ];
      const cases = presented(entry.summary.caseResults, PRESENTATION_LIMITS.simulationMatrixCases);
      return [
        `- Matrix ${scalar(entry.summary.name)}: ${scalar(entry.summary.status)}; cases ${scalar(entry.summary.cases.passed)}/${scalar(entry.summary.cases.total)} passed; assertions ${scalar(entry.summary.assertions.passed)}/${scalar(entry.summary.assertions.total)} passed on ${scalar(entry.summary.engine)} / ${scalar(entry.summary.fixture)}; requested ${scalar(entry.summary.durationMs)} ms per case.`,
        `  - Circuit: ${scalar(entry.summary.circuitPath)}; matrix: ${scalar(entry.summary.matrixPath)}; report: ${scalar(displayPath(entry.artifactPath, workspacePath))}.`,
        ...cases.visible.flatMap((matrixCase) => {
          const results = presented(matrixCase.results, PRESENTATION_LIMITS.simulationMatrixResults);
          return [
            `  - Case ${scalar(matrixCase.id)} / ${scalar(matrixCase.name)}: ${scalar(matrixCase.status)}; ${scalar(matrixCase.passed)} passed, ${scalar(matrixCase.failed)} failed.`,
            ...results.visible.map((result) => `    - [${result.pass ? 'pass' : 'fail'}] ${scalar(result.type)}${result.target ? ` ${scalar(result.target)}` : ''}: ${scalar(result.detail)}`),
            ...(results.omitted ? [`    - Assertion results omitted from presentation: ${scalar(results.omitted)}.`] : []),
          ];
        }),
        ...(cases.omitted ? [`  - Matrix cases omitted from presentation: ${scalar(cases.omitted)}.`] : []),
      ];
    }) : ['- No fresh explicit simulation-matrix-report manifest was supplied.']),
    ...omissionLine('Simulation Matrix reports', presentedSimulationMatrixReports.omitted),
    '',
    '## 11. Unresolved limitations',
    '',
    '- Full ERC, DRC, DFM, fabrication/fab acceptance, manufacturing correctness/acceptance, KiCad-application behavior, physical/hardware behavior, and offline operation remain unresolved and unvalidated.',
    '- Source persistence is unknown: the editor-buffer snapshot is not claimed saved, unsaved, or equal to disk.',
    '- Workspace confinement is lexical only. The SDK exposes no realpath, lstat, no-follow open, exclusive create, atomic rename, transaction, rollback, or deletion primitive; symlink confinement and atomic no-clobber are unproven.',
    '- Destination existence was checked immediately before writing and the tool never knowingly overwrites, but fileExists followed by writeFile has a race.',
    '- A completed manifest is only a completion marker and emitted-text provenance record, not a transaction, rollback proof, correctness proof, or design acceptance.',
    '- Loaded guidance and evidence have session-state provenance only; their file bytes, freshness, and authenticity are not established by this packet.',
    '- Refer to the readiness check IDs, heuristic lint finding IDs, evidence classifications, and explicit freshness states above; no broader claim is inferred.',
    '',
    '## 12. Recorded artifact pointers',
    '',
    ...(() => {
      return artifactPointers.visible.length
        ? artifactPointers.visible.map((path) => `- ${scalar(displayPath(path, workspacePath))} (recorded by an accepted explicit manifest; not discovered by scanning)`)
        : ['- None from accepted explicit manifests.'];
    })(),
    ...omissionLine('Recorded artifact pointers', artifactPointers.omitted),
    '',
  ];
  const markdown = lines.join('\n');
  return {
    markdown,
    packetSha256: await sha256Text(markdown),
    sourceSha256,
    circuitJsonSha256,
    observations,
  };
}

function baseResult(outputPath: string, manifestPath: string): Omit<DesignReviewResult, 'status'> {
  return {
    output_path: outputPath,
    manifest_path: manifestPath,
    sourceStableBeforeWrite: false,
    sourceStableBeforeManifest: false,
    freshAtReturn: 'not-guaranteed',
    nonAtomicNoClobber: true,
    symlinkConfinement: 'unproven',
  };
}

export async function createDesignReviewPacket(input: {
  api: Pick<ElectronicsEditorAPI, 'getCode' | 'captureDesignReviewSnapshot'>;
  fs: TextFileSystem;
  workspacePath: string;
  outputPath: unknown;
  manifestPath: unknown;
  artifactManifestPaths?: unknown;
}): Promise<DesignReviewResult> {
  let outputRelative = typeof input.outputPath === 'string' ? input.outputPath : '';
  let manifestRelative = typeof input.manifestPath === 'string' ? input.manifestPath : '';
  if (typeof input.workspacePath !== 'string' || !input.workspacePath.trim()) {
    return {
      ...baseResult(outputRelative, manifestRelative),
      status: 'refused',
      refusal: {
        code: 'workspace-unavailable',
        message: 'A workspace must be open before creating a workspace-local design-review packet.',
      },
    };
  }
  try {
    outputRelative = validateCanonicalWorkspaceRelativePath(input.outputPath, 'output_path', '.md');
    manifestRelative = validateCanonicalWorkspaceRelativePath(input.manifestPath, 'manifest_path', '.freshness.json');
    if (input.artifactManifestPaths != null && !Array.isArray(input.artifactManifestPaths)) {
      throw new Error('artifact_manifest_paths must be an explicit array when provided.');
    }
    const artifactRelative = (input.artifactManifestPaths as unknown[] | undefined ?? []).map((path, index) =>
      validateCanonicalWorkspaceRelativePath(path, `artifact_manifest_paths[${index}]`, '.freshness.json'));
    const allRelative = [outputRelative, manifestRelative, ...artifactRelative];
    if (new Set(allRelative).size !== allRelative.length) throw new Error('Packet, completed manifest, and input manifest paths must be distinct and non-colliding.');
    const outputAbsolute = joinWorkspace(input.workspacePath, outputRelative);
    const manifestAbsolute = joinWorkspace(input.workspacePath, manifestRelative);
    const artifactAbsolute = artifactRelative.map((path) => joinWorkspace(input.workspacePath, path));
    const base = baseResult(outputRelative, manifestRelative);

    const snapshot = await input.api.captureDesignReviewSnapshot();
    if (snapshot.evalError) return { ...base, status: 'refused', refusal: { code: 'snapshot-failed', message: `The copied editor source failed evaluation: ${snapshot.evalError}` } };
    if (input.api.getCode() !== snapshot.source) return { ...base, status: 'refused', refusal: { code: 'source-changed-before-write', message: 'The editor-buffer source changed before any intentional write.' } };
    const built = await buildPacket(snapshot, input.fs, input.workspacePath, artifactAbsolute);

    const collisionKeys = new Set([outputAbsolute, manifestAbsolute, ...artifactAbsolute]);
    for (const observation of built.observations) {
      for (const path of observation.recordedArtifactPaths ?? []) {
        if (collisionKeys.has(path)) throw new Error(`Accepted manifest recorded a path that collides with another packet input or destination: ${displayPath(path, input.workspacePath)}`);
        collisionKeys.add(path);
      }
    }
    if (input.api.getCode() !== snapshot.source) return {
      ...base, status: 'refused', packet_sha256: built.packetSha256, source_sha256: built.sourceSha256,
      circuit_json_sha256: built.circuitJsonSha256,
      refusal: { code: 'source-changed-before-write', message: 'The editor-buffer source changed while the packet was being assembled; no intentional write was attempted.' },
    };
    const parentPaths = [...new Set([parentPath(outputAbsolute), parentPath(manifestAbsolute)])];
    for (const parent of parentPaths) {
      if (!(await input.fs.fileExists(parent))) return {
        ...base, status: 'refused', packet_sha256: built.packetSha256, source_sha256: built.sourceSha256,
        circuit_json_sha256: built.circuitJsonSha256,
        refusal: { code: 'parent-missing-or-unevidenced', message: `A destination parent directory must already exist as far as fileExists can evidence: ${displayPath(parent, input.workspacePath)}` },
      };
    }
    if (await input.fs.fileExists(outputAbsolute) || await input.fs.fileExists(manifestAbsolute)) return {
      ...base, status: 'refused', packet_sha256: built.packetSha256, source_sha256: built.sourceSha256,
      circuit_json_sha256: built.circuitJsonSha256,
      refusal: { code: 'path-exists', message: 'The packet or completed-manifest destination already exists. The non-atomic preflight never offers overwrite-anyway.' },
    };

    let writeStage: 'none' | 'packet' | 'manifest' = 'none';
    let sourceStableBeforeWrite = false;
    let sourceStableBeforeManifest = false;
    const trackedFs = {
      writeFile: async (path: string, text: string) => {
        if (path === outputAbsolute) {
          if (await input.fs.fileExists(outputAbsolute) || await input.fs.fileExists(manifestAbsolute)) {
            throw new Error('A destination appeared after the non-atomic preflight; no intentional packet write was attempted.');
          }
          sourceStableBeforeWrite = input.api.getCode() === snapshot.source;
          if (!sourceStableBeforeWrite) throw new Error('The editor-buffer source changed immediately before packet write.');
        } else {
          if (await input.fs.fileExists(manifestAbsolute)) {
            throw new Error('The completed-manifest destination appeared after the non-atomic preflight; it was not knowingly overwritten.');
          }
          sourceStableBeforeManifest = input.api.getCode() === snapshot.source;
          if (!sourceStableBeforeManifest) throw new Error('The editor-buffer source changed immediately before completed-manifest write.');
        }
        writeStage = path === outputAbsolute ? 'packet' : 'manifest';
        await input.fs.writeFile(path, text);
      },
    };
    let assertionCount = 0;
    try {
      const tracked = await writeTrackedExport({
        fs: trackedFs,
        manifestPath: manifestAbsolute,
        source: snapshot.source,
        circuitJson: snapshot.circuitJson,
        kind: 'design-review',
        options: {
          packetSchema: DESIGN_REVIEW_PACKET_SCHEMA,
          generator: DESIGN_REVIEW_GENERATOR,
          sourceOrigin: snapshot.sourceOrigin,
          persistenceState: snapshot.persistenceState,
          artifactManifestPaths: artifactRelative,
        },
        artifacts: [{ path: outputAbsolute, text: built.markdown }],
        assertSourceCurrent: () => {
          assertionCount += 1;
          const stable = input.api.getCode() === snapshot.source;
          if (assertionCount === 1) sourceStableBeforeWrite = stable;
          else sourceStableBeforeManifest = stable;
          if (!stable) throw new Error('The editor-buffer source changed during packet emission.');
        },
      });
      return {
        ...base, status: 'created', packet_sha256: built.packetSha256,
        source_sha256: tracked.manifest.source.sha256,
        circuit_json_sha256: tracked.manifest.circuitJson.sha256,
        sourceStableBeforeWrite, sourceStableBeforeManifest,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (writeStage === 'none') return {
        ...base, status: 'refused', packet_sha256: built.packetSha256, source_sha256: built.sourceSha256,
        circuit_json_sha256: built.circuitJsonSha256, sourceStableBeforeWrite, sourceStableBeforeManifest,
        refusal: { code: sourceStableBeforeWrite ? 'write-failed' : 'source-changed-before-write', message },
      };
      const pathsThatMayExist = writeStage === 'packet' ? [outputRelative] : [outputRelative, manifestRelative];
      return {
        ...base, status: 'incomplete', packet_sha256: built.packetSha256, source_sha256: built.sourceSha256,
        circuit_json_sha256: built.circuitJsonSha256, sourceStableBeforeWrite, sourceStableBeforeManifest,
        cleanup: { automatic: false, pathsThatMayExist },
        refusal: { code: sourceStableBeforeManifest ? 'write-failed' : 'source-changed-before-manifest', message },
      };
    }
  } catch (error) {
    return {
      ...baseResult(outputRelative, manifestRelative),
      status: 'refused',
      refusal: { code: 'path-invalid', message: error instanceof Error ? error.message : String(error) },
    };
  }
}
