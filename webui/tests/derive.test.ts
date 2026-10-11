import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Device, deviceSchema, type Rule, ruleSchema } from "@/api/types";
import { buildHome } from "@/home/derive";
import devicesFixture from "@/mocks/fixtures/devices.json";
import rulesFixture from "@/mocks/fixtures/rules.json";

const devices = z.array(deviceSchema).parse(devicesFixture) as Device[];
const rules = z.array(ruleSchema).parse(rulesFixture) as Rule[];

describe("derive and model reality checks", () => {
  it("does not render sirens on thermostats or plugs", () => {
    const home = buildHome(devices, rules, []);
    const thermostat = home.byDevice.get("thermostat-toilet");
    expect(thermostat).toBeDefined();

    // Controls should only be the curated ones: setpoint and mode
    const controlAttrs = thermostat!.controls.map((c) => c.attr);
    expect(controlAttrs).toEqual(["setpoint", "mode"]);
    expect(thermostat!.controls.some((c) => c.label.toLowerCase().includes("siren"))).toBe(false);

    // Car heater plug should only have Power control, no Siren
    const carPlug = home.byDevice.get("powerplug-car");
    expect(carPlug).toBeDefined();
    expect(carPlug!.controls.map((c) => c.attr)).toEqual(["state"]);
    expect(carPlug!.controls.some((c) => c.label.toLowerCase().includes("siren"))).toBe(false);
  });

  it("only exposes one Siren control on kitchen siren", () => {
    const home = buildHome(devices, rules, []);
    const siren = home.byDevice.get("siren-kitchen");
    expect(siren).toBeDefined();

    expect(siren!.controls).toHaveLength(1);
    expect(siren!.controls[0]?.attr).toBe("target-value");
    expect(siren!.controls[0]?.label).toBe("Siren");

    const reading = siren!.primary.find((r) => r.attr === "current-value");
    expect(reading).toBeDefined();
    expect(reading!.label).toBe("Siren");
  });

  it("does not expose hardware configuration controls on motion sensors or plugs", () => {
    const home = buildHome(devices, rules, []);
    const motion = home.byDevice.get("motion-philips-car");
    expect(motion).toBeDefined();
    expect(motion!.controls).toHaveLength(0);

    const kitchenPlug = home.byDevice.get("powerplug-1-kitchen");
    expect(kitchenPlug).toBeDefined();
    expect(kitchenPlug!.controls.map((c) => c.attr)).toEqual(["state"]);
  });

  it("exposes contact reading on front door and living room door", () => {
    const home = buildHome(devices, rules, []);
    const frontDoor = home.byDevice.get("door-front");
    expect(frontDoor).toBeDefined();
    const contactReading = frontDoor!.primary.find((r) => r.attr === "sensor-state-door-window");
    expect(contactReading).toBeDefined();
    expect(contactReading!.label).toBe("Contact");

    const livingRoomDoor = home.byDevice.get("door-livingroom");
    expect(livingRoomDoor).toBeDefined();
    const lrContact = livingRoomDoor!.primary.find((r) => r.attr === "sensor-state-door-window");
    expect(lrContact).toBeDefined();
    expect(lrContact!.label).toBe("Contact");
  });

  it("flags hold on plugs but not on standard switches", () => {
    const home = buildHome(devices, rules, []);
    const plug = home.byDevice.get("powerplug-1-kitchen");
    expect(plug!.controls[0]?.hold).toBe(true);

    const siren = home.byDevice.get("siren-kitchen");
    expect(siren!.controls[0]?.hold).toBeFalsy();
  });
});
