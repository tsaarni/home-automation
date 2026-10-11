# Verification record — 2026-10-11

All four Shelly identities matched the configured IDs. Gen2+ RPC status reads
returned normalized switch state and telemetry. Off switches preserved zero power
and current readings. Native settings were not changed.

MELCloud `User/ListDevices` and `Device/Get` identified device 210764 in building
141129 as DeviceType=0, using Celsius. Metadata reports heat 10–31°C and cool
16–31°C, in 0.5°C increments. Observed mode was heat; pending command was false and
EffectiveFlags was zero. Timestamp handling preserves UTC meaning.

Sanitized observations are in `tests/fixtures/inspection.json`. Generated bindings
validate against automator's Device schema. Secrets are environment references;
no credentials are included in fixtures, bindings or Kubernetes manifests.

Automated verification covers RPC errors within HTTP 200,
identity mismatch, zero/missing telemetry, combined mode/setpoint, preserved unrelated
settings and flags, expired execution, duplicate IDs, queued supersession, uncertain
write readback, bounded cloud follow-ups, offline worker isolation/recovery,
independent reported state, stale snapshots, override ownership and tracked reverts.
These are simulated behavior checks, not a complete broker-to-device integration
test or proof of live write delivery. The authentication setup and restart of an
in-flight gateway command are not covered by the retained tests.

Live writes, live override restoration, container build/push and Kubernetes rollout
have not been performed. A device/value must be explicitly agreed before the live
write check. Use the read-first, restore-previous-value procedure in README.md.
Full webui lint has existing errors in unrelated files; changed files pass their
check with the existing optional-chain warning in derive.ts.
