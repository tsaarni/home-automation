import * as stylex from "@stylexjs/stylex";
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
import { tokens } from "@/theme/tokens.stylex";

const styles = stylex.create({
  table: { width: "100%", borderCollapse: "collapse", fontSize: tokens.fontSm },
  cell: {
    textAlign: "left",
    padding: tokens.space2,
    borderBottomColor: tokens.border,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    verticalAlign: "top",
  },
  pre: {
    overflowX: "auto",
    fontSize: 12,
    backgroundColor: tokens.surfaceRaised,
    padding: tokens.space3,
    borderRadius: tokens.radiusSm,
  },
  area: {
    fontFamily: "ui-monospace, Menlo, monospace",
    fontSize: 12,
    width: "100%",
    minHeight: "300px",
    backgroundColor: tokens.surfaceRaised,
    color: tokens.text,
    borderColor: tokens.border,
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: tokens.radiusSm,
    padding: tokens.space3,
  },
});

type Tab = "readings" | "documents" | "schedules" | "system";

/** Plumbing, deliberately out of the way (§5.4). */
export function AdvancedScreen() {
  const [tab, setTab] = useState<Tab>("readings");
  return (
    <div>
      <StatusHeader />
      <Stack gap={4}>
        <Row gap={2} wrap>
          {(
            [
              ["readings", "All readings"],
              ["documents", "Things & groups"],
              ["schedules", "Schedules (raw)"],
              ["system", "System"],
            ] as const
          ).map(([key, label]) => (
            <Chip key={key} active={tab === key} onClick={() => setTab(key)}>
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
    <Card>
      <Stack gap={3}>
        <Row gap={2}>
          <TextField
            value={filter}
            onChange={setFilter}
            placeholder="filter by thing or attribute (linkquality, battery, …)"
          />
          <Muted>{rows.length} readings</Muted>
        </Row>
        <table {...stylex.props(styles.table)}>
          <thead>
            <tr>
              <th {...stylex.props(styles.cell)}>Thing</th>
              <th {...stylex.props(styles.cell)}>Reading</th>
              <th {...stylex.props(styles.cell)}>Value</th>
              <th {...stylex.props(styles.cell)}>Last change</th>
              <th {...stylex.props(styles.cell)}>Set</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.device}-${row.attr}`}>
                <td {...stylex.props(styles.cell)}>{names.device(row.device)}</td>
                <td {...stylex.props(styles.cell)}>
                  {names.attr(row.device, row.attr)} <Muted>{row.attr}</Muted>
                </td>
                <td {...stylex.props(styles.cell)}>
                  {row.state ? names.value(row.device, row.attr, row.state.value) : "—"}
                </td>
                <td {...stylex.props(styles.cell)}>
                  {row.state ? (
                    <>
                      <Badge tone="muted">{row.state.source}</Badge> <Muted>{time.rel(row.state.ts)}</Muted>
                    </>
                  ) : (
                    <Muted>never reported</Muted>
                  )}
                </td>
                <td {...stylex.props(styles.cell)}>
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
                    <Muted>sensor only</Muted>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
    <Card>
      <Stack gap={3}>
        <Select
          label="document"
          value={which}
          onChange={setWhich}
          options={[
            ...devices.map((device) => ({ value: `device:${device.id}`, label: `thing: ${device.id}` })),
            ...groups.map((group) => ({ value: `group:${group.id}`, label: `group: ${group.id}` })),
          ]}
        />
        <textarea
          {...stylex.props(styles.area)}
          value={text}
          onChange={(event) => setDocuments({ ...documents, [key]: event.target.value })}
        />
        {problems.map((problem) => (
          <div key={problem} style={{ color: tokens.bad }}>
            {problem}
          </div>
        ))}
        <Row gap={2}>
          <Button variant="primary" onClick={save}>
            save
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              setDocuments({
                ...documents,
                [key]: current ? JSON.stringify(stripLive(current), null, 2) : "",
              })
            }
          >
            reset
          </Button>
          <Muted>PUT replaces the document; the backend validates every reference and value</Muted>
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
    <Stack gap={3}>
      {rules.map((rule) => {
        const parsed = parseRule(rule);
        return (
          <Card key={rule.id}>
            <Stack gap={2}>
              <Row gap={2} wrap>
                <strong>{names.rule(rule.id)}</strong>
                <Badge tone="muted">{rule.id}</Badge>
                {!parsed.ok ? <Badge tone="warn">raw</Badge> : null}
                <Button size="small" variant="ghost" onClick={() => test.mutate(rule.id)}>
                  test
                </Button>
              </Row>
              {test.data?.rule === rule.id ? <Muted>{describeTestReport(test.data, names)}</Muted> : null}
              <textarea
                {...stylex.props(styles.area)}
                style={{ minHeight: "180px" }}
                value={drafts[rule.id] ?? JSON.stringify(rule, null, 2)}
                onChange={(event) => setDrafts({ ...drafts, [rule.id]: event.target.value })}
              />
              {problems[rule.id]?.map((problem) => (
                <div key={problem} style={{ color: tokens.bad }}>
                  {problem}
                </div>
              ))}
              <Row gap={2}>
                <Button variant="primary" onClick={() => saveOne(rule)}>
                  save
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setDrafts({ ...drafts, [rule.id]: JSON.stringify(rule, null, 2) })}
                >
                  reset
                </Button>
              </Row>
            </Stack>
          </Card>
        );
      })}
      {rules.length === 0 ? <Empty>no schedules</Empty> : null}
    </Stack>
  );
}

function SystemPanel() {
  const ready = useReady();
  const actions = useSystemActions();
  return (
    <Card>
      <Stack gap={3}>
        <Row gap={3} wrap>
          <Row gap={2}>
            <Switch
              checked={Boolean(ready.data?.dry_run)}
              label="dry run"
              onChange={(next) => actions.dryRun.mutate(next)}
            />
            <span>dry run (plan writes, publish nothing)</span>
          </Row>
          <Button onClick={() => actions.reload.mutate()}>reload configuration</Button>
          <a href={`${api.base}/metrics`} target="_blank" rel="noreferrer">
            metrics
          </a>
          <a href={`${api.base}/docs`} target="_blank" rel="noreferrer">
            API docs
          </a>
        </Row>
        {ready.data?.warnings.length ? (
          <Stack gap={1}>
            <strong>Warnings</strong>
            {ready.data.warnings.map((warning) => (
              <div key={warning}>{warning}</div>
            ))}
          </Stack>
        ) : null}
        <details>
          <summary>health payload</summary>
          <pre {...stylex.props(styles.pre)}>{JSON.stringify(ready.data, null, 2)}</pre>
        </details>
      </Stack>
    </Card>
  );
}
