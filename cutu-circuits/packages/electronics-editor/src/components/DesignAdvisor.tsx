import { Fragment, useState, type CSSProperties, type ReactNode } from 'react';
import type { ComponentSummary, LintFinding, NetSummary } from '../circuit/circuitJson';
import type { ReadinessCategory, ReadinessReport, ReadinessStatus } from '../circuit/readiness';
import { evidenceFindingByComponentId, type PartEvidenceReport } from '../circuit/partEvidence';
import {
  advisorAgentTargetKey,
  createLintAgentTarget,
  createNetAgentTarget,
  createReadinessAgentTarget,
} from '../circuit/selectionContext';
import type { EvaluatorDiagnosticBeaconStory, NetDetectiveStory } from '../circuit/advisorAffectedGeometry';
import { formatElectricalValue } from '../circuit/valueFormatting';

type AdvisorTab = 'overview' | 'issues' | 'components' | 'nets';

const CATEGORY_LABELS: Record<ReadinessCategory, string> = {
  requirements: 'Requirements', design: 'Design', electrical: 'Electrical', layout: 'Layout', sourcing: 'Sourcing',
};

const STATUS_GLYPHS: Record<ReadinessStatus, string> = {
  pass: '✓', warning: '!', blocked: '×', info: '·',
};

export function DesignAdvisor({
  report,
  partEvidence,
  findings,
  components,
  nets,
  activeContextLabel,
  activeAdvisorTargetKey,
  netDetectiveStory,
  evaluatorDiagnosticBeaconStory,
  agentRequestCard,
  pairComponentIds = [],
  onSelectCheck,
  onSelectFinding,
  onSelectComponent,
  onSelectNet,
  onClose,
}: {
  report: ReadinessReport;
  partEvidence?: PartEvidenceReport;
  findings: LintFinding[];
  components: ComponentSummary[];
  nets: NetSummary[];
  activeContextLabel?: string;
  activeAdvisorTargetKey?: string;
  netDetectiveStory?: NetDetectiveStory;
  evaluatorDiagnosticBeaconStory?: EvaluatorDiagnosticBeaconStory;
  agentRequestCard?: ReactNode;
  pairComponentIds?: string[];
  onSelectCheck: (check: ReadinessReport['checks'][number]) => void;
  onSelectFinding: (finding: LintFinding) => void;
  onSelectComponent: (component: ComponentSummary) => void;
  onSelectNet: (net: NetSummary) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<AdvisorTab>('overview');
  const issueCount = findings.filter((finding) => finding.severity !== 'info').length;
  const ringStyle = { '--es-score': `${report.score * 3.6}deg` } as CSSProperties;
  const evidenceById = evidenceFindingByComponentId(partEvidence);

  return (
    <aside className="es-advisor" aria-label="Design advisor">
      <div className="es-advisor-header">
        <div>
          <div className="es-eyebrow">Preflight</div>
          <div className="es-advisor-title">Design advisor</div>
        </div>
        <button className="es-icon-button" onClick={onClose} title="Close advisor">×</button>
      </div>

      <div className="es-score-card">
        <div className="es-score-ring" style={ringStyle}>
          <div><strong>{report.score}</strong><span>/100</span></div>
        </div>
        <div className="es-score-copy">
          <span className={`es-readiness-dot es-readiness-${scoreTone(report.score)}`} />
          <strong>{report.label}</strong>
          <small>{report.nextActions[0] ?? 'Review the design, then run final ERC/DRC checks.'}</small>
        </div>
      </div>

      <div className="es-stat-grid">
        <div><strong>{report.summary.components}</strong><span>Parts</span></div>
        <div><strong>{report.summary.nets}</strong><span>Nets</span></div>
        <div><strong>{report.summary.connectedPins}/{report.summary.totalPins}</strong><span>Pins</span></div>
        <div><strong>{report.summary.supplierCoverage}%</strong><span>{partEvidence ? 'Present-backed' : 'Identified'}</span></div>
      </div>

      <div className="es-advisor-tabs" role="tablist">
        <AdvisorButton tab="overview" current={tab} onClick={setTab}>Overview</AdvisorButton>
        <AdvisorButton tab="issues" current={tab} onClick={setTab}>Issues {issueCount > 0 && <b>{issueCount}</b>}</AdvisorButton>
        <AdvisorButton tab="components" current={tab} onClick={setTab}>Parts</AdvisorButton>
        <AdvisorButton tab="nets" current={tab} onClick={setTab}>Nets</AdvisorButton>
      </div>

      <div className="es-advisor-content">
        {tab === 'overview' && (
          <div className="es-check-list">
            {(['requirements', 'design', 'electrical', 'layout', 'sourcing'] as ReadinessCategory[]).map((category) => {
              const checks = report.checks.filter((check) => check.category === category);
              if (checks.length === 0) return null;
              return (
                <section key={category}>
                  <div className="es-check-section">{CATEGORY_LABELS[category]}</div>
                  {checks.map((check) => (
                    <button
                      className={activeAdvisorTargetKey === advisorAgentTargetKey(createReadinessAgentTarget(check)) ? 'es-check es-agent-context-active' : 'es-check'}
                      key={check.id}
                      onClick={() => onSelectCheck(check)}
                    >
                      <span className={`es-check-icon es-check-${check.status}`}>{STATUS_GLYPHS[check.status]}</span>
                      <div><strong>{check.title}</strong><small>{check.detail}</small></div>
                      <span className="es-context-spark" aria-hidden="true">✦</span>
                    </button>
                  ))}
                </section>
              );
            })}
          </div>
        )}

        {tab === 'issues' && (
          <div className="es-issue-list">
            {findings.map((finding, index) => (
              <button
                className={`${activeAdvisorTargetKey === advisorAgentTargetKey(createLintAgentTarget(finding, findings)) ? 'es-issue es-agent-context-active' : 'es-issue'} es-issue-${finding.severity}`}
                key={`${finding.rule}-${index}`}
                onClick={() => onSelectFinding(finding)}
              >
                <span>{finding.severity === 'warning' ? '!' : finding.severity === 'error' ? '×' : 'i'}</span>
                <div><strong>{humanRule(finding.rule)}</strong><small>{finding.message}</small></div>
                <span className="es-context-spark" aria-hidden="true">✦</span>
              </button>
            ))}
          </div>
        )}

        {tab === 'components' && (
          <div className="es-inspector-list">
            {components.length === 0 && <EmptyInspector text="No evaluated components yet." />}
            {components.map((component) => (
              <button
                className={pairComponentIds.includes(component.id) ? 'es-inspector-row es-pair-member' : 'es-inspector-row'}
                key={component.id || component.name}
                onClick={() => onSelectComponent(component)}
                aria-pressed={pairComponentIds.includes(component.id)}
              >
                <span className="es-ref">{component.name}</span>
                <div>
                  <strong>{prettyType(component.ftype)}</strong>
                  <small>{[
                    component.value != null ? formatElectricalValue(component.numericValue ?? component.value, component.valueUnit) : undefined,
                    component.footprint,
                  ].filter(Boolean).join(' · ') || 'No value metadata'}</small>
                  {evidenceById.get(component.id) && <small data-evidence-status={evidenceById.get(component.id)!.status}>Local evidence: {evidenceById.get(component.id)!.status}</small>}
                </div>
                {pairComponentIds.includes(component.id) && (
                  <span className="es-pair-badge" aria-label={`Pair member ${pairComponentIds.indexOf(component.id) + 1} of 2: ${component.name}`}>
                    {pairComponentIds.indexOf(component.id) + 1}/2
                  </span>
                )}
                <span className="es-context-spark" aria-hidden="true">✦</span>
              </button>
            ))}
          </div>
        )}

        {tab === 'nets' && (
          <div className="es-inspector-list">
            {nets.length === 0 && <EmptyInspector text="Wire parts to inspect signal paths." />}
            {nets.map((net, index) => {
              const targetKey = advisorAgentTargetKey(createNetAgentTarget(net));
              const active = activeAdvisorTargetKey === targetKey;
              return (
                <Fragment key={`${net.name}-${index}`}>
                  <button
                    className={active ? 'es-net-row es-agent-context-active' : 'es-net-row'}
                    onClick={() => onSelectNet(net)}
                  >
                    <div><span className="es-net-dot" /><strong>{net.name}</strong></div>
                    <small>{net.endpoints.join(' → ') || 'Named net'}</small>
                    <span className="es-context-spark" aria-hidden="true">✦</span>
                  </button>
                  {active && netDetectiveStory?.targetKey === targetKey && (
                    <section className="es-net-detective" aria-label="Net Detective evidence">
                      <div className="es-net-detective-title"><span>⌁</span><strong>Net Detective</strong></div>
                      <p><b>{netDetectiveStory.label}</b> · {netDetectiveStory.endpointCount} endpoint{netDetectiveStory.endpointCount === 1 ? '' : 's'}</p>
                      <p>{netDetectiveStory.endpoints.join(' ↔ ') || 'No exact endpoints'}{netDetectiveStory.endpointsOmitted ? ` · ${netDetectiveStory.endpointsOmitted} omitted` : ''}</p>
                      <p>Parts: {netDetectiveStory.componentRefs.join(', ') || 'none'}{netDetectiveStory.componentRefsOmitted ? ` · ${netDetectiveStory.componentRefsOmitted} omitted` : ''}</p>
                      <p>Unique PCB endpoint coordinates: {netDetectiveStory.uniquePcbEndpointCount}/{netDetectiveStory.endpointCount} ({netDetectiveStory.pcbEndpointCoverage})</p>
                      <small>{netDetectiveStory.disclaimer}</small>
                    </section>
                  )}
                </Fragment>
              );
            })}
          </div>
        )}
      </div>

      {evaluatorDiagnosticBeaconStory && (
        <section className="es-diagnostic-beacon" aria-label="Diagnostic Beacon evidence">
          <div className="es-diagnostic-beacon-title"><span>⌖</span><strong>Diagnostic Beacon</strong></div>
          <p><b>{evaluatorDiagnosticBeaconStory.total}</b> native diagnostic{evaluatorDiagnosticBeaconStory.total === 1 ? '' : 's'} · {evaluatorDiagnosticBeaconStory.types.length + evaluatorDiagnosticBeaconStory.typesOmitted} type{evaluatorDiagnosticBeaconStory.types.length + evaluatorDiagnosticBeaconStory.typesOmitted === 1 ? '' : 's'}</p>
          <p>{evaluatorDiagnosticBeaconStory.types.map((entry) => `${entry.type} (${entry.count})`).join(' · ') || 'No presented types'}{evaluatorDiagnosticBeaconStory.typesOmitted ? ` · ${evaluatorDiagnosticBeaconStory.typesOmitted} types omitted` : ''}</p>
          <p>Linked parts: {evaluatorDiagnosticBeaconStory.refs.join(', ') || 'none'}{evaluatorDiagnosticBeaconStory.refsOmitted ? ` · ${evaluatorDiagnosticBeaconStory.refsOmitted} omitted` : ''}</p>
          <p>PCB links {evaluatorDiagnosticBeaconStory.linkedPcbComponentCount} · finite markers {evaluatorDiagnosticBeaconStory.finiteLocationCount}{evaluatorDiagnosticBeaconStory.finiteLocationsOmitted ? ` + ${evaluatorDiagnosticBeaconStory.finiteLocationsOmitted} omitted` : ''}</p>
          {(evaluatorDiagnosticBeaconStory.omitted > 0 || evaluatorDiagnosticBeaconStory.unresolvedIdentityLinks > 0) && (
            <p>Report omissions {evaluatorDiagnosticBeaconStory.omitted} · unresolved/capped links {evaluatorDiagnosticBeaconStory.unresolvedIdentityLinks}</p>
          )}
          <small>{evaluatorDiagnosticBeaconStory.disclaimer}</small>
        </section>
      )}

      <div className={agentRequestCard ? 'es-advisor-footer es-advisor-agent-footer' : 'es-advisor-footer'}>
        {agentRequestCard ?? (activeContextLabel
          ? <><span className="es-context-spark">✦</span><strong>{activeContextLabel}</strong> published to host context</>
          : <><span>ⓘ</span>{report.disclaimer}</>)}
      </div>
    </aside>
  );
}

function AdvisorButton({
  tab, current, onClick, children,
}: {
  tab: AdvisorTab;
  current: AdvisorTab;
  onClick: (tab: AdvisorTab) => void;
  children: React.ReactNode;
}) {
  return <button className={tab === current ? 'active' : ''} onClick={() => onClick(tab)}>{children}</button>;
}

function EmptyInspector({ text }: { text: string }) {
  return <div className="es-inspector-empty"><span>◇</span><small>{text}</small></div>;
}

function scoreTone(score: number): 'good' | 'warn' | 'bad' {
  return score >= 82 ? 'good' : score >= 55 ? 'warn' : 'bad';
}

function humanRule(rule: string): string {
  return rule.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function prettyType(ftype?: string): string {
  return ftype ? ftype.replace(/^simple_/, '').replace(/_/g, ' ') : 'Component';
}
