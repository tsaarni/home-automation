# legacy

Files from the applications that this repository replaced. They are kept for reference only.

* `homeautomator-config.yaml` - the ConfigMap `homeautomator-config` of the old
  mqtttimer / thermostat implementation. The new application keeps the same behaviour as rules
  in `~/hobby/home-automator/seed/rules.json` and stores its documents on the PVC
  `homeautomator-data`.
