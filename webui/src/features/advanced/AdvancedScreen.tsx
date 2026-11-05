import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { ApiError, api } from "@/api/client";
import {
  useDevices,
  useGroups,
  useHome,
  useNames,
  useReady,
  useRules,
  useSaveRule,
  useSystemActions,
  useTestRule,
  useTime,
} from "@/api/queries";
import { type Device, deviceSchema, type Group, groupSchema, ruleSchema } from "@/api/types";
import { ClimatePatch, climateCapable } from "@/components/ClimatePatch";
import { Control } from "@/components/Control";
import {
  Badge,
  Button,
  Card,
  Dialog,
  Empty,
  Muted,
  Row,
  Select,
  Stack,
  TextField,
  Toggle,
} from "@/components/primitives";
import { StatusHeader } from "@/components/StatusHeader";
import { describeTestReport } from "@/lib/schedule";
import { useUnsavedChanges } from "@/lib/use-unsaved";

type Tab = "readings" | "configuration" | "system";

export function AdvancedScreen() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab") ?? "readings";
  const tab = (["documents", "schedules"].includes(requested) ? "configuration" : requested) as Tab;
  const documentType = params.get("type") ?? (requested === "documents" ? "devices" : "schedules");
  const setTab = (next: Tab) =>
    setParams((p) => {
      p.set("tab", next);
      return p;
    });
  return (
    <div>
      <StatusHeader />
      <Stack gap={20}>
        <Select
          label="Advanced section"
          value={tab}
          onChange={(value) => setTab(value as Tab)}
          options={[
            { value: "readings", label: "Readings" },
            { value: "configuration", label: "Configuration" },
            { value: "system", label: "System" },
          ]}
        />
        {tab === "configuration" && (
          <Select
            label="Configuration type"
            value={documentType}
            onChange={(value) =>
              setParams((p) => {
                p.set("type", value);
                return p;
              })
            }
            options={[
              { value: "schedules", label: "Schedule JSON" },
              { value: "devices", label: "Device and group JSON" },
            ]}
          />
        )}
        {tab === "readings" ? <ReadingsTable /> : null}
        {tab === "configuration" && documentType === "devices" ? <Documents /> : null}
        {tab === "configuration" && documentType === "schedules" ? <RawSchedules /> : null}
        {tab === "system" ? <SystemPanel /> : null}
      </Stack>
    </div>
  );
}

function ReadingsTable() {
  const devicesQuery = useDevices();
  const devices = devicesQuery.data ?? [];
  const [editing, setEditing] = useState<{ device: string; attr: string } | null>(null);
  const home = useHome();
  const names = useNames();
  const time = useTime();
  const [params, setParams] = useSearchParams();
  const filter = params.get("readings") ?? "";
  const setFilter = (v: string) =>
    setParams(
      (p) => {
        if (v) p.set("readings", v);
        else p.delete("readings");
        return p;
      },
      { replace: true },
    );

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return devices
      .flatMap((device) =>
        Object.keys(device.attributes).map((attr) => ({
          device: device.id,
          attr,
          spec: device.attributes[attr],
          state: device.state[attr],
        })),
      )
      .filter(
        (row) =>
          !needle ||
          `${row.device} ${row.attr} ${home.byDevice.get(row.device)?.name ?? ""}`
            .toLowerCase()
            .includes(needle),
      );
  }, [devices, filter, home]);

  const thing = editing ? home.byDevice.get(editing.device) : undefined;
  const reading = thing?.readings.find((r) => r.attr === editing?.attr);
  const climate = thing && climateCapable(thing) && ["mode", "setpoint"].includes(editing?.attr ?? "");
  return (
    <Card variant="elevated">
      <Stack gap={14}>
        {devicesQuery.isPending && <Empty>Loading readings…</Empty>}
        {devicesQuery.isError && (
          <p role="alert" className="form-error">
            Readings could not be refreshed. Last known values are shown when available.{" "}
            <Button onClick={() => devicesQuery.refetch()}>Retry</Button>
          </p>
        )}
        <Row gap={12}>
          <div style={{ flex: 1 }}>
            <TextField
              value={filter}
              onChange={setFilter}
              label="Search readings"
              placeholder="Device or reading name"
              leadingIcon="filter_list"
            />
          </div>
          <Muted>{rows.length} readings</Muted>
        </Row>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to scroll this table region. */}
        <div className="table-region" role="region" aria-label="All readings" tabIndex={0}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr
                style={{ borderBottom: "1px solid var(--md-sys-color-outline-variant)", textAlign: "left" }}
              >
                <th style={{ padding: "10px 8px" }}>Device</th>
                <th style={{ padding: "10px 8px" }}>Reading</th>
                <th style={{ padding: "10px 8px" }}>Current value</th>
                <th style={{ padding: "10px 8px" }}>Last update</th>
                <th style={{ padding: "10px 8px" }}>Control</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.device}-${row.attr}`}
                  style={{ borderBottom: "1px solid var(--md-sys-color-surface-container-high)" }}
                >
                  <td style={{ padding: "8px", fontWeight: 600 }}>{names.device(row.device)}</td>
                  <td style={{ padding: "8px" }}>
                    {names.attr(row.device, row.attr)} <Muted>{row.attr}</Muted>
                  </td>
                  <td style={{ padding: "8px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                    {row.state ? names.value(row.device, row.attr, row.state.value) : "—"}
                  </td>
                  <td style={{ padding: "8px" }}>
                    {row.state ? (
                      <Row gap={6}>
                        <Badge tone="muted">{row.state.source}</Badge>
                        <Muted>{time.rel(row.state.ts)}</Muted>
                      </Row>
                    ) : (
                      <Muted>Never reported</Muted>
                    )}
                  </td>
                  <td style={{ padding: "8px" }}>
                    {row.spec.write && !home.byDevice.get(row.device)?.locked ? (
                      <Button
                        variant="text"
                        onClick={() => setEditing({ device: row.device, attr: row.attr })}
                      >
                        Edit control
                      </Button>
                    ) : (
                      <Muted>Sensor reading</Muted>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {editing && thing && reading && (
          <Dialog
            title={thing.name}
            onClose={() => setEditing(null)}
            footer={
              <Button variant="text" onClick={() => setEditing(null)}>
                Close
              </Button>
            }
          >
            {climate ? <ClimatePatch thing={thing} /> : <Control reading={reading} heading={thing.name} />}
          </Dialog>
        )}
      </Stack>
    </Card>
  );
}

function Documents() {
  const devices = useDevices().data ?? [];
  const groups = useGroups().data ?? [];
  const [params, setParams] = useSearchParams();
  const which = params.get("item") ?? "";
  const setWhich = (value: string) =>
    setParams((p) => {
      p.set("item", value);
      return p;
    });
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState("");
  const [documents, setDocuments] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<string[]>([]);
  const key = which;
  const current: Device | Group | undefined = which.startsWith("device:")
    ? devices.find((device) => device.id === which.slice(7))
    : groups.find((group) => group.id === which.slice(6));
  const text = documents[key] ?? (current ? JSON.stringify(stripLive(current), null, 2) : "");

  const original = current ? JSON.stringify(stripLive(current), null, 2) : "";
  const dirty = text !== original;
  useUnsavedChanges(dirty && !success);
  const devicesQuery = useDevices();
  const groupsQuery = useGroups();
  const save = async () => {
    if (saving || !current) return;
    setSaving(true);
    setSuccess("");
    setProblems([]);
    try {
      const body = (which.startsWith("device:") ? deviceSchema : groupSchema).parse(JSON.parse(text));
      if (body.id !== current.id) throw new Error("The saved ID must stay unchanged.");
      if (which.startsWith("device:")) await api.putDevice(which.slice(7), body);
      else await api.putGroup(which.slice(6), body);
      await Promise.all([devicesQuery.refetch(), groupsQuery.refetch()]);
      setSuccess("Configuration saved.");
    } catch (error) {
      if (error instanceof ApiError) setProblems(error.problems);
      else setProblems([(error as Error).message]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card variant="elevated">
      <Stack gap={14}>
        <Select
          label="Document to edit"
          value={which}
          disabled={saving}
          onChange={(v) => {
            setProblems([]);
            setSuccess("");
            setWhich(v);
          }}
          options={[
            { value: "", label: "Choose a device or group" },
            ...devices.map((device) => ({ value: `device:${device.id}`, label: `Device: ${device.id}` })),
            ...groups.map((group) => ({ value: `group:${group.id}`, label: `Group: ${group.id}` })),
          ]}
        />
        <textarea
          aria-label="Device or group configuration"
          style={{
            fontFamily: "Roboto Mono, monospace",
            fontSize: "13px",
            width: "100%",
            minHeight: "320px",
            backgroundColor: "var(--md-sys-color-surface-container-lowest)",
            color: "var(--md-sys-color-on-surface)",
            border: "1px solid var(--md-sys-color-outline-variant)",
            borderRadius: "8px",
            padding: "12px",
          }}
          disabled={saving || !current}
          value={text}
          onChange={(event) => {
            setSuccess("");
            setDocuments({ ...documents, [key]: event.target.value });
          }}
        />
        {problems.map((problem) => (
          <div key={problem} role="alert" style={{ color: "var(--md-sys-color-error)", fontSize: "13px" }}>
            {problem}
          </div>
        ))}
        <Row gap={8}>
          <Button variant="filled" disabled={saving || !dirty || !current} onClick={save}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
          <Button
            variant="tonal"
            disabled={saving || !dirty}
            onClick={() =>
              setDocuments({
                ...documents,
                [key]: current ? JSON.stringify(stripLive(current), null, 2) : "",
              })
            }
          >
            Discard changes
          </Button>
          {success && <span role="status">{success}</span>}
        </Row>
      </Stack>
    </Card>
  );
}

function stripLive(document: Device | Group): unknown {
  const { referenced_by: _referencedBy, ...rest } = document as Device & { state?: unknown };
  if ("state" in rest) delete (rest as { state?: unknown }).state;
  return rest;
}

function RawSchedules() {
  const rulesQuery = useRules();
  const rules = rulesQuery.data ?? [];
  const names = useNames();
  const save = useSaveRule();
  const test = useTestRule();
  const [params, setParams] = useSearchParams();
  const selected = params.get("rule") ?? rules[0]?.id ?? "";
  const rule = rules.find((r) => r.id === selected);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState("");
  const [success, setSuccess] = useState("");
  const original = rule ? JSON.stringify(rule, null, 2) : "";
  const text = drafts[selected] ?? original;
  const dirty = text !== original;
  useUnsavedChanges(dirty && !save.isSuccess);
  const saveOne = () => {
    setProblem("");
    setSuccess("");
    try {
      const document = ruleSchema.parse(JSON.parse(text));
      if (document.id !== selected) throw new Error("The saved schedule ID must stay unchanged.");
      save.mutate(document, {
        onSuccess: (saved) => {
          setDrafts((d) => ({ ...d, [selected]: JSON.stringify(saved, null, 2) }));
          setSuccess("Configuration saved.");
        },
        onError: (error) => setProblem(error.message),
      });
    } catch (error) {
      setProblem((error as Error).message);
    }
  };
  return (
    <Card>
      <Stack>
        <Select
          label="Schedule configuration"
          value={selected}
          disabled={save.isPending}
          onChange={(id) => {
            setProblem("");
            setSuccess("");
            save.reset();
            test.reset();
            setParams((p) => {
              p.set("rule", id);
              return p;
            });
          }}
          options={rules.map((r) => ({ value: r.id, label: r.name ?? r.id }))}
        />
        {rulesQuery.isPending ? (
          <Empty>Loading configuration…</Empty>
        ) : rulesQuery.isError ? (
          <Empty>
            Configuration could not be refreshed. <Button onClick={() => rulesQuery.refetch()}>Retry</Button>
          </Empty>
        ) : !rule ? (
          <Empty>No schedule selected.</Empty>
        ) : (
          <>
            <label htmlFor="schedule-json">Configuration (JSON)</label>
            <textarea
              id="schedule-json"
              rows={20}
              spellCheck={false}
              value={text}
              disabled={save.isPending}
              onChange={(e) => {
                setDrafts({ ...drafts, [selected]: e.target.value });
                setSuccess("");
                save.reset();
              }}
              style={{
                fontFamily: "monospace",
                background: "var(--md-sys-color-surface)",
                padding: 12,
                borderRadius: 8,
              }}
            />
            {problem && (
              <p role="alert" className="form-error">
                {problem}
              </p>
            )}
            {success && <p role="status">{success}</p>}
            <Row wrap>
              <Button disabled={save.isPending || !dirty} onClick={saveOne}>
                {save.isPending ? "Saving…" : "Save configuration"}
              </Button>
              <Button
                variant="text"
                disabled={save.isPending || !dirty}
                onClick={() => {
                  setDrafts({ ...drafts, [selected]: original });
                  setProblem("");
                  setSuccess("");
                }}
              >
                Discard changes
              </Button>
            </Row>
            <details>
              <summary>Simulation</summary>
              <Stack>
                <Muted>Simulation evaluates the saved schedule. Save changes first to include them.</Muted>
                <Button
                  variant="tonal"
                  disabled={test.isPending || save.isPending}
                  onClick={() => test.mutate(selected)}
                >
                  {test.isPending ? "Simulating…" : "Simulate saved schedule"}
                </Button>
                {test.data && <p role="status">{describeTestReport(test.data, names)}</p>}
                {test.error && (
                  <p role="alert" className="form-error">
                    {test.error.message}
                  </p>
                )}
              </Stack>
            </details>
          </>
        )}
      </Stack>
    </Card>
  );
}

function SystemPanel() {
  const ready = useReady();
  const actions = useSystemActions();
  return (
    <Card variant="elevated">
      <Stack gap={16}>
        <section className="form-section">
          <h2>Simulation mode</h2>
          <Toggle
            checked={Boolean(ready.data?.dry_run)}
            label="Dry run"
            disabled={ready.isPending || ready.isError || actions.dryRun.isPending}
            onChange={(next) => {
              if (!ready.isPending && !ready.isError && !actions.dryRun.isPending)
                actions.dryRun.mutate(next);
            }}
          />
          <Muted>When enabled, automation plans actions without sending device commands.</Muted>
          {actions.dryRun.isPending && <span role="status">Changing simulation mode…</span>}
          {actions.dryRun.error && (
            <p role="alert" className="form-error">
              {actions.dryRun.error.message}
            </p>
          )}
        </section>
        <section className="form-section">
          <h2>System health</h2>
          <Button
            variant="tonal"
            icon="refresh"
            disabled={actions.reload.isPending}
            onClick={() => actions.reload.mutate()}
          >
            {actions.reload.isPending ? "Reloading…" : "Reload configuration"}
          </Button>
          {actions.reload.error && (
            <p role="alert" className="form-error">
              {actions.reload.error.message}
            </p>
          )}
        </section>
        {ready.data?.warnings.length ? (
          <Stack gap={6}>
            <strong style={{ color: "var(--md-sys-color-warning)" }}>Active Warnings</strong>
            {ready.data.warnings.map((warning) => (
              <div key={warning} style={{ fontSize: "13px" }}>
                • {warning}
              </div>
            ))}
          </Stack>
        ) : null}
        <details>
          <summary>Developer tools</summary>
          <Row wrap>
            <a className="text-link" href={`${api.base}/metrics`} target="_blank" rel="noreferrer">
              Metrics
            </a>
            <a className="text-link" href={`${api.base}/docs`} target="_blank" rel="noreferrer">
              API documentation
            </a>
          </Row>
          <pre
            style={{
              fontFamily: "Roboto Mono, monospace",
              fontSize: "12px",
              padding: "12px",
              borderRadius: "8px",
              backgroundColor: "var(--md-sys-color-surface-container-lowest)",
            }}
          >
            {JSON.stringify(ready.data, null, 2)}
          </pre>
        </details>
      </Stack>
    </Card>
  );
}
