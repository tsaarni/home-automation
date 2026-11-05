import { Link, NavLink, Outlet } from "react-router";
import { useDevices, useGroups, useNames } from "@/api/queries";
import { Button, Card, Empty, Muted, Row, Stack } from "@/components/primitives";
import { StatusHeader } from "@/components/StatusHeader";
import { matches, useSearchQuery } from "@/lib/search";
import "./devices.css";

export function DevicesLayout() {
  return (
    <div>
      <StatusHeader title="Devices" />
      <Stack gap={20}>
        <nav className="device-navigation" aria-label="Device management">
          <NavLink to="/devices" end>
            Devices
          </NavLink>
          <NavLink to="/devices/groups">Groups</NavLink>
        </nav>
        <Outlet />
      </Stack>
    </div>
  );
}

export function DevicesScreen() {
  const devices = useDevices();
  const groups = useGroups().data ?? [];
  const names = useNames();
  const query = useSearchQuery();
  const visible = (devices.data ?? [])
    .filter((device) => matches(query, names.device(device.id), device.id))
    .sort((a, b) => names.device(a.id).localeCompare(names.device(b.id)));
  return (
    <Stack gap={16}>
      <Muted>Browse devices and their group membership. Open controls to use a device from Home.</Muted>
      {devices.isPending ? (
        <Empty>Loading devices…</Empty>
      ) : devices.isError ? (
        <Empty>
          Devices could not be loaded. <Button onClick={() => devices.refetch()}>Retry</Button>
        </Empty>
      ) : (
        <Muted>{visible.length} devices</Muted>
      )}
      {visible.map((device) => {
        const memberships = groups.filter((group) => group.members.includes(device.id));
        return (
          <Card key={device.id}>
            <Stack gap={8}>
              <Row justify="space-between" wrap>
                <strong>{names.device(device.id)}</strong>
                <Link className="text-link" to={`/#device-${encodeURIComponent(device.id)}`}>
                  Open controls
                </Link>
              </Row>
              <Muted>
                {memberships.length
                  ? `Groups: ${memberships.map((group) => names.group(group.id)).join(", ")}`
                  : "No group membership"}
              </Muted>
            </Stack>
          </Card>
        );
      })}
      {!devices.isPending && !devices.isError && !visible.length && <Empty>No devices match.</Empty>}
    </Stack>
  );
}
