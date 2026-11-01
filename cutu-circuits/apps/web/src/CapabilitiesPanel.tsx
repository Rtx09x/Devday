import { Button, Input, SettingsSelect, Switch } from "@cutucircuits/ui";
import type { Capability, Operation } from "@cutucircuits/core";
import { OperationControls } from "./OperationControls";
import { Glyph } from "./Glyph";
interface Props {
  capabilities: Capability[];
  capability?: Capability;
  inputs: Record<string, unknown>;
  onChoose: (capability: Capability) => void;
  onInputs: (inputs: Record<string, unknown>) => void;
  onRun: () => void;
  busy: boolean;
  operations: Operation[];
  onCancel: (operation: Operation) => void;
  onSend: (
    operation: Operation,
    message: Record<string, unknown>,
  ) => Promise<void>;
}
const humanize = (value: string) =>
  value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/^./, (s) => s.toUpperCase());
export function CapabilitiesPanel({
  capabilities,
  capability,
  inputs,
  onChoose,
  onInputs,
  onRun,
  busy,
  operations,
  onCancel,
  onSend,
}: Props) {
  return (
    <div className="capabilities">
      {capabilities.length ? (
        <>
          <div className="form-field">
            <span>Action</span>
            <SettingsSelect
              aria-label="Capability"
              value={capability?.id ?? ""}
              options={[
                { value: "", label: "Choose an action", disabled: true },
                ...capabilities.map((c) => ({ value: c.id, label: c.label })),
              ]}
              onValueChange={(id) => {
                const c = capabilities.find((c) => c.id === id);
                if (c) onChoose(c);
              }}
            />
          </div>
          {capability && (
            <>
              <p className="capability-description">{capability.description}</p>
              <div className="capability-fields">
                {Object.entries(
                  (capability.inputSchema.properties as Record<
                    string,
                    Record<string, unknown>
                  >) || {},
                ).map(([key, schema]) => {
                  const title = String(schema.title ?? humanize(key));
                  return (
                    <div
                      className={`form-field ${schema.type === "boolean" ? "switch-field" : ""}`}
                      key={key}
                    >
                      <label htmlFor={`cap-${key}`}>{title}</label>
                      {Array.isArray(schema.enum) ? (
                        <SettingsSelect
                          aria-label={title}
                          value={String(inputs[key] ?? "")}
                          options={[
                            { value: "", label: "Select…", disabled: true },
                            ...schema.enum.map((v) => ({
                              value: String(v),
                              label: humanize(String(v)),
                            })),
                          ]}
                          onValueChange={(value) =>
                            onInputs({
                              ...inputs,
                              [key]: (schema.enum as unknown[]).find(
                                (v) => String(v) === value,
                              ),
                            })
                          }
                        />
                      ) : schema.type === "boolean" ? (
                        <Switch
                          id={`cap-${key}`}
                          aria-label={title}
                          checked={!!inputs[key]}
                          onCheckedChange={(checked) =>
                            onInputs({ ...inputs, [key]: checked })
                          }
                        />
                      ) : (
                        <Input
                          id={`cap-${key}`}
                          type={
                            schema.type === "number" ||
                            schema.type === "integer"
                              ? "number"
                              : "text"
                          }
                          value={String(inputs[key] ?? "")}
                          min={
                            typeof schema.minimum === "number"
                              ? schema.minimum
                              : undefined
                          }
                          max={
                            typeof schema.maximum === "number"
                              ? schema.maximum
                              : undefined
                          }
                          step={schema.type === "integer" ? 1 : "any"}
                          onChange={(e) =>
                            onInputs({
                              ...inputs,
                              [key]:
                                schema.type === "number" ||
                                schema.type === "integer"
                                  ? Number(e.target.value)
                                  : e.target.value,
                            })
                          }
                        />
                      )}
                      {!!schema.description && (
                        <small>{String(schema.description)}</small>
                      )}
                    </div>
                  );
                })}
              </div>
              <Button
                variant="filled"
                className="control-button accent run-capability"
                disabled={busy}
                onClick={onRun}
              >
                <Glyph name="play" />
                {busy ? "Starting…" : `Run ${capability.label}`}
              </Button>
            </>
          )}
        </>
      ) : (
        <div className="panel-empty">
          <span className="empty-icon">
            <Glyph name="bolt" />
          </span>
          <h3>No project actions yet</h3>
          <p>This project has no hardware capabilities configured.</p>
        </div>
      )}
      {!!operations.length && (
        <div className="operation-list">
          <h3>Recent activity</h3>
          {operations
            .slice()
            .reverse()
            .map((op) => (
              <section key={op.id}>
                <div className="operation-heading">
                  <strong>{op.label}</strong>
                  <span className={`op-status ${op.status}`}>
                    <span className={`status-dot ${op.status}`} />
                    {humanize(op.status)}
                  </span>
                </div>
                {op.error && <p className="error-text">{op.error}</p>}
                {op.status === "running" && (
                  <Button
                    variant="filled"
                    className="control-button"
                    onClick={() => onCancel(op)}
                  >
                    <Glyph name="stop" />
                    Cancel operation
                  </Button>
                )}
                {op.status === "running" &&
                  capabilities.find((c) => c.id === op.capabilityId)
                    ?.persistent && (
                    <details className="technical-details">
                      <summary>Send a program message</summary>
                      <OperationControls
                        onSend={(message) => onSend(op, message)}
                      />
                    </details>
                  )}
                <details className="technical-details">
                  <summary>View output</summary>
                  <pre>
                    {op.output ||
                      (op.status === "running"
                        ? "Waiting for output…"
                        : "No output recorded.")}
                  </pre>
                </details>
              </section>
            ))}
        </div>
      )}
    </div>
  );
}
