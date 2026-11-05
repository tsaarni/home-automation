import { useRef, useState } from "react";
import { Link } from "react-router";
import { useDeleteGroup, useDevices, useGroups, useNames, useSaveGroup } from "@/api/queries";
import type { Group } from "@/api/types";
import { Button, Card, Dialog, Empty, Muted, Row, Stack, TextField } from "@/components/primitives";
import { slugify } from "@/lib/schedule";
import { targetAttributes } from "@/lib/schedule-fields";
import { matches, useSearchQuery } from "@/lib/search";
import { useUnsavedChanges } from "@/lib/use-unsaved";
import "../devices/devices.css";

export function GroupsScreen() {
  const groups = useGroups();
  const names = useNames();
  const query = useSearchQuery();
  const [editing, setEditing] = useState<Group | null | undefined>();
  const visible = (groups.data ?? [])
    .filter((group) => matches(query, names.group(group.id), ...group.members.map(names.device)))
    .sort((a, b) => names.group(a.id).localeCompare(names.group(b.id)));
  return (
    <Stack gap={20}>
      <Row justify="space-between" wrap>
        <Muted>Groups let schedules control several devices together.</Muted>
        <Button icon="add" onClick={() => setEditing(null)}>
          New group
        </Button>
      </Row>
      {groups.isError ? (
        <Empty>
          Groups could not be loaded. <Button onClick={() => groups.refetch()}>Retry</Button>
        </Empty>
      ) : groups.isPending ? (
        <Empty>Loading groups…</Empty>
      ) : (
        <>
          {visible.map((group) => (
            <Card key={group.id}>
              <Stack gap={12}>
                <Row justify="space-between" wrap>
                  <strong>{names.group(group.id)}</strong>
                  <Button variant="tonal" onClick={() => setEditing(group)}>
                    Edit group
                  </Button>
                </Row>
                <Muted>
                  {group.members.length} devices: {group.members.map(names.device).join(", ")}
                </Muted>
                <Muted>
                  Used by {group.referenced_by.length}{" "}
                  {group.referenced_by.length === 1 ? "schedule" : "schedules"}
                </Muted>
              </Stack>
            </Card>
          ))}
          {!visible.length && (
            <Empty>
              {query
                ? "No groups match your search."
                : "No groups yet. Create a group to control devices together."}
            </Empty>
          )}
        </>
      )}
      {editing !== undefined && <GroupEditor group={editing} onClose={() => setEditing(undefined)} />}
    </Stack>
  );
}

function UnsavedGroupGuard({ dirty }: { dirty: boolean }) {
  useUnsavedChanges(dirty);
  return null;
}

export function GroupEditor({
  group,
  onClose,
  embedded = false,
}: {
  group: Group | null;
  onClose: () => void;
  embedded?: boolean;
}) {
  const devices = useDevices();
  const groups = useGroups();
  const names = useNames();
  const save = useSaveGroup();
  const remove = useDeleteGroup();
  const [name, setName] = useState(group?.name ?? "");
  const [members, setMembers] = useState(group?.members ?? []);
  const [attempted, setAttempted] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const original = useRef(JSON.stringify([name, members]));
  const creationId = useRef<string | null>(null);
  const dirty = original.current !== JSON.stringify([name, members]);
  const busy = save.isPending || remove.isPending;
  const closeAllowed = () => !busy && (!dirty || window.confirm("Discard unsaved group changes?"));
  const unknown = members.filter((id) => !devices.data?.some((d) => d.id === id));
  const references =
    groups.data?.find((item) => item.id === group?.id)?.referenced_by ?? group?.referenced_by ?? [];
  const problem = !name.trim()
    ? "Enter a group name."
    : !members.length
      ? "Choose at least one device."
      : unknown.length
        ? "Remove unavailable devices before saving."
        : null;
  const shared = targetAttributes({ kind: "group", id: "draft" }, devices.data ?? [], [
    { id: "draft", members, referenced_by: [] },
  ]);
  const listed = [...(devices.data ?? []).map((d) => d.id), ...unknown]
    .filter((id) => (!selectedOnly || members.includes(id)) && matches(search, names.device(id), id))
    .sort((a, b) => names.device(a).localeCompare(names.device(b)));
  const submit = () => {
    setAttempted(true);
    if (problem || busy || !devices.data || !groups.data) return;
    if (!group?.id && !creationId.current) {
      const stem = slugify(name, "group");
      creationId.current = groups.data.some((g) => g.id === stem) ? `${stem}-${crypto.randomUUID()}` : stem;
    }
    const { referenced_by: _references, ...originalDoc } = group ?? {};
    save.mutate(
      { ...originalDoc, id: group?.id || creationId.current!, name: name.trim(), members, referenced_by: [] },
      { onSuccess: onClose },
    );
  };
  return (
    <Dialog
      wide
      title={group?.id ? "Edit group" : "New group"}
      onClose={onClose}
      beforeClose={closeAllowed}
      footer={
        <>
          <Button
            variant="text"
            disabled={busy}
            onClick={() => {
              if (closeAllowed()) onClose();
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={busy || devices.isPending || devices.isError || groups.isPending || groups.isError}
            onClick={submit}
          >
            {save.isPending ? "Saving…" : group?.id ? "Save changes" : "Save group"}
          </Button>
        </>
      }
    >
      {!embedded && <UnsavedGroupGuard dirty={dirty && !save.isSuccess && !remove.isSuccess} />}
      <Stack gap={16}>
        <TextField label="Group name" value={name} onChange={setName} />
        <section aria-label="Group members">
          <Stack gap={8}>
            <strong>Members ({members.length} selected)</strong>
            <TextField label="Find devices" value={search} onChange={setSearch} />
            <label className="group-member">
              <input
                type="checkbox"
                checked={selectedOnly}
                onChange={(event) => setSelectedOnly(event.target.checked)}
              />
              <span>Selected only</span>
            </label>
            {devices.isError && (
              <p role="alert">
                Devices could not be loaded. <Button onClick={() => devices.refetch()}>Retry</Button>
              </p>
            )}
            {groups.isError && (
              <p role="alert">
                Group usage could not be loaded. <Button onClick={() => groups.refetch()}>Retry</Button>
              </p>
            )}
            {devices.isPending ? (
              <Muted>Loading devices…</Muted>
            ) : (
              <div className="group-members" role="group" aria-label="Choose group members">
                {listed.map((id) => (
                  <label key={id} className="group-member">
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={members.includes(id)}
                      onChange={(event) =>
                        setMembers(
                          event.target.checked ? [...members, id] : members.filter((member) => member !== id),
                        )
                      }
                    />
                    <span>
                      {names.device(id)}
                      {unknown.includes(id) ? " (unavailable)" : ""}
                    </span>
                  </label>
                ))}
                {!listed.length && <Muted>No devices match.</Muted>}
              </div>
            )}
            <strong>Shared controls</strong>
            <Muted>
              {!members.length
                ? "Choose devices to see the controls they share."
                : Object.keys(shared).length
                  ? Object.keys(shared)
                      .map((attr) => names.attr("", attr))
                      .join(", ")
                  : "These devices have no shared writable controls. You can save the group, but schedules cannot target it yet."}
            </Muted>
          </Stack>
        </section>
        <section aria-label="Used by schedules">
          <Stack gap={8}>
            <strong>Used by schedules ({references.length})</strong>
            <Muted>
              {references.length
                ? `Membership changes affect ${references.length === 1 ? "this schedule" : `these ${references.length} schedules`}.`
                : "No saved schedules use this group."}
            </Muted>
            {references.map((id) =>
              embedded ? (
                <span key={id}>{names.rule(id)}</span>
              ) : (
                <Link key={id} className="text-link" to={`/schedules/${encodeURIComponent(id)}`}>
                  {names.rule(id)}
                </Link>
              ),
            )}
          </Stack>
        </section>
        {attempted && problem && (
          <p role="alert" className="form-error">
            {problem}
          </p>
        )}
        {save.error && (
          <p role="alert" className="form-error">
            Could not save: {save.error.message}
          </p>
        )}
        {group?.id && (
          <section aria-label="Delete group">
            {references.length ? (
              <Muted>Remove this group from its schedules before deleting it.</Muted>
            ) : null}
            {confirming ? (
              <Stack gap={8}>
                <strong>Delete “{group.name ?? group.id}”?</strong>
                <Muted>The devices in this group will be kept.</Muted>
                <Row wrap>
                  <Button variant="text" disabled={busy} onClick={() => setConfirming(false)}>
                    Keep group
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busy || !!references.length || groups.isError || groups.isPending}
                    onClick={() => remove.mutate(group.id, { onSuccess: onClose })}
                  >
                    Delete permanently
                  </Button>
                </Row>
              </Stack>
            ) : (
              <Button
                variant="text"
                icon="delete"
                disabled={busy || !!references.length || groups.isError || groups.isPending}
                onClick={() => setConfirming(true)}
              >
                Delete group
              </Button>
            )}
            {remove.error && (
              <p role="alert" className="form-error">
                Could not delete: {remove.error.message}
              </p>
            )}
          </section>
        )}
      </Stack>
    </Dialog>
  );
}
