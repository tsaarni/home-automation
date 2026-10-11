import { useMemo, useState } from "react";
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
import type { Device, Group, Rule } from "@/api/types";
import { Control } from "@/components/Control";
import {
  Badge,
  Button,
  Card,
  Chip,
  Empty,
  Muted,
  Row,
  Select,
  Stack,
  Switch,
  TextField,
} from "@/components/primitives";
import { StatusHeader } from "@/components/StatusHeader";
import { describeTestReport, parseRule } from "@/lib/schedule";

type Tab = "readings" | "documents" | "schedules" | "system";

export function AdvancedScreen() {
  const [tab, setTab] = useState<Tab>("readings");
  return (
    <div>
      <StatusHeader />
      <Stack gap={20}>
        <Row gap={8} wrap>
          {(
            [
              ["readings", "All readings", "table_rows"],
              ["documents", "Things & groups", "description"],
              ["schedules", "Schedules (raw)", "code"],
              ["system", "System", "settings"],
            ] as const
          ).map(([key, label, icon]) => (
            <Chip key={key} active={tab === key} onClick={() => setTab(key)} icon={icon}>
              {label}
            </Chip>
          ))}
        </Row>
        {tab === "readings" ? <ReadingsTable /> : null}
        {tab === "documents" ? <Documents /> : null}
        {tab === "schedules" ? <RawSchedules /> : null}
        {tab === "system" ? <SystemPanel /> : null}
      </Stack>
    </div>
  );
}

function ReadingsTable() {
  const devices = useDevices().data ?? [];
  const home = useHome();
  const names = useNames();
  const time = useTime();
  const [filter, setFilter] = useState("");

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

  return (
    <Card variant="elevated">
      <Stack gap={14}>
        <Row gap={12}>
          <div style={{ flex: 1 }}>
            <TextField
              value={filter}
              onChange={setFilter}
              placeholder="Filter readings by thing or attribute name…"
              leadingIcon="filter_list"
            />
          </div>
          <Muted>{rows.length} readings</Muted>
        </Row>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--md-sys-color-outline-variant)", textAlign: "left" }}>
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
                      <Control
                        reading={
                          home.byDevice
                            .get(row.device)
                            ?.readings.find((reading) => reading.attr === row.attr) ?? {
                            device: row.device,
                            attr: row.attr,
                            label: names.attr(row.device, row.attr),
                            value: row.state?.value,
                            unit: row.spec.unit ?? null,
                            ts: row.state?.ts ?? null,
                            source: row.state?.source ?? null,
                            known: Boolean(row.state),
                            on: 1,
                            off: 0,
                            schedules: [],
                            isControl: true,
                          }
                        }
                      />
                    ) : (
                      <Muted>Sensor reading</Muted>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Stack>
    </Card>
  );
}

function Documents() {
  const devices = useDevices().data ?? [];
  const groups = useGroups().data ?? [];
  const [which, setWhich] = useState("device:powerplug-terrace");
  const [documents, setDocuments] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<string[]>([]);
  const key = which;
  const current: Device | Group | undefined = which.startsWith("device:")
    ? devices.find((device) => device.id === which.slice(7))
    : groups.find((group) => group.id === which.slice(6));
  const text = documents[key] ?? (current ? JSON.stringify(stripLive(current), null, 2) : "");

  const save = async () => {
    setProblems([]);
    try {
      const body = JSON.parse(text);
      if (which.startsWith("device:")) await api.putDevice(which.slice(7), body);
      else await api.putGroup(which.slice(6), body);
    } catch (error) {
      if (error instanceof ApiError) setProblems(error.problems);
      else setProblems([(error as Error).message]);
    }
  };

  return (
    <Card variant="elevated">
      <Stack gap={14}>
        <Select
          label="Document to edit"
          value={which}
          onChange={setWhich}
          options={[
            ...devices.map((device) => ({ value: `device:${device.id}`, label: `Device: ${device.id}` })),
            ...groups.map((group) => ({ value: `group:${group.id}`, label: `Group: ${group.id}` })),
          ]}
        />
        <textarea
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
          value={text}
          onChange={(event) => setDocuments({ ...documents, [key]: event.target.value })}
        />
        {problems.map((problem) => (
          <div key={problem} style={{ color: "var(--md-sys-color-error)", fontSize: "13px" }}>
            {problem}
          </div>
        ))}
        <Row gap={8}>
          <Button variant="filled" onClick={save}>
            Save Document
          </Button>
          <Button
            variant="tonal"
            onClick={() =>
              setDocuments({
                ...documents,
                [key]: current ? JSON.stringify(stripLive(current), null, 2) : "",
              })
            }
          >
            Reset
          </Button>
          <Muted>PUT replaces document in persistent storage</Muted>
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
  const rules = useRules().data ?? [];
  const names = useNames();
  const save = useSaveRule();
  const test = useTestRule();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<Record<string, string[]>>({});

  const saveOne = (rule: Rule) => {
    setProblems({ ...problems, [rule.id]: [] });
    try {
      save.mutate(JSON.parse(drafts[rule.id] ?? JSON.stringify(rule)));
    } catch (error) {
      setProblems({ ...problems, [rule.id]: [(error as Error).message] });
    }
  };

  return (
    <Stack gap={14}>
      {rules.map((rule) => {
        const parsed = parseRule(rule);
        return (
          <Card key={rule.id} variant="elevated">
            <Stack gap={12}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px" }}>
                <Row gap={8}>
                  <strong>{names.rule(rule.id)}</strong>
                  <Badge tone="muted">{rule.id}</Badge>
                  {!parsed.ok ? <Badge tone="warn">raw</Badge> : null}
                </Row>
                <Button size="small" variant="tonal" icon="play_arrow" onClick={() => test.mutate(rule.id)}>
                  Test
                </Button>
              </div>
              {test.data?.rule === rule.id ? <Muted>{describeTestReport(test.data, names)}</Muted> : null}
              <textarea
                style={{
                  fontFamily: "Roboto Mono, monospace",
                  fontSize: "12px",
                  minHeight: "180px",
                  backgroundColor: "var(--md-sys-color-surface-container-lowest)",
                  color: "var(--md-sys-color-on-surface)",
                  border: "1px solid var(--md-sys-color-outline-variant)",
                  borderRadius: "8px",
                  padding: "10px",
                }}
                value={drafts[rule.id] ?? JSON.stringify(rule, null, 2)}
                onChange={(event) => setDrafts({ ...drafts, [rule.id]: event.target.value })}
              />
              {problems[rule.id]?.map((problem) => (
                <div key={problem} style={{ color: "var(--md-sys-color-error)", fontSize: "13px" }}>
                  {problem}
                </div>
              ))}
              <Row gap={8}>
                <Button variant="filled" onClick={() => saveOne(rule)}>
                  Save
                </Button>
                <Button
                  variant="tonal"
                  onClick={() => setDrafts({ ...drafts, [rule.id]: JSON.stringify(rule, null, 2) })}
                >
                  Reset
                </Button>
              </Row>
            </Stack>
          </Card>
        );
      })}
      {rules.length === 0 ? <Empty>No schedules defined</Empty> : null}
    </Stack>
  );
}

function SystemPanel() {
  const ready = useReady();
  const actions = useSystemActions();
  return (
    <Card variant="elevated">
      <Stack gap={16}>
        <Row gap={16} wrap>
          <Row gap={8}>
            <Switch
              checked={Boolean(ready.data?.dry_run)}
              label="Dry run"
              onChange={(next) => actions.dryRun.mutate(next)}
            />
            <span>Dry run (simulate actions without publishing)</span>
          </Row>
          <Button variant="tonal" icon="refresh" onClick={() => actions.reload.mutate()}>
            Reload configuration
          </Button>
          <a
            href={`${api.base}/metrics`}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--md-sys-color-primary)", fontWeight: 500 }}
          >
            Prometheus metrics
          </a>
          <a
            href={`${api.base}/docs`}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--md-sys-color-primary)", fontWeight: 500 }}
          >
            REST API Swagger Docs
          </a>
        </Row>
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
          <summary style={{ cursor: "pointer", fontWeight: 500 }}>System Health JSON Payload</summary>
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
