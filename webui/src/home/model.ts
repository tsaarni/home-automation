/**
 * The house as the UI sees it: rooms, curated things and which attributes are noise.
 * The backend knows nothing about any of this; changing the mental model is a code change
 * here and nowhere else. Everything is optional — an unknown device still gets derived
 * sensibly (see derive.ts).
 */

export interface RoomMeta {
  id: string;
  name: string;
  order: number;
}

export const rooms: RoomMeta[] = [
  { id: "terrace", name: "Terrace", order: 1 },
  { id: "bathroom", name: "Bathroom", order: 2 },
  { id: "toilet", name: "Toilet", order: 3 },
  { id: "kitchen", name: "Kitchen", order: 4 },
  { id: "livingroom", name: "Living room", order: 5 },
  { id: "bedroom", name: "Bedroom", order: 6 },
  { id: "office", name: "Office", order: 7 },
  { id: "hall", name: "Hall", order: 8 },
  { id: "storage", name: "Storage", order: 9 },
  { id: "carport", name: "Carport", order: 10 },
  { id: "utilityroom", name: "Utility room", order: 11 },
  { id: "emptyroom", name: "Empty room", order: 12 },
  { id: "outside", name: "Outside", order: 13 },
  { id: "other", name: "Other", order: 99 },
];

export const roomById = new Map(rooms.map((room) => [room.id, room]));

/** id fragments that name a room, longest first so `storage-street` wins over nothing. */
const ROOM_TOKENS: Array<[string, string]> = [
  ["livingroom", "livingroom"],
  ["utilityroom", "utilityroom"],
  ["emptyroom", "emptyroom"],
  ["bathroom", "bathroom"],
  ["bedroom", "bedroom"],
  ["kitchen", "kitchen"],
  ["terrace", "terrace"],
  ["storage", "storage"],
  ["office", "office"],
  ["toilet", "toilet"],
  ["backyard", "outside"],
  ["front", "outside"],
  ["car", "carport"],
  ["hall", "hall"],
];

export type ControlKind = "switch" | "temperature" | "number" | "select" | "boolean" | "text";

export interface ControlSpec {
  attr: string;
  label: string;
  kind: ControlKind;
  step?: number;
  /** values for a switch (enum valued attributes) */
  on?: unknown;
  off?: unknown;
  /** quick "on for ..." choices, in the house's units */
  hold?: boolean;
}

export interface ThingMeta {
  room: string;
  name: string;
  /** ordered preference of the readings worth showing first */
  primary: string[];
  controls: ControlSpec[];
  /** custom attribute display labels for this specific device */
  labels?: Record<string, string>;
  /** attributes that are never shown for this thing, even under "all readings" */
  hide?: string[];
}

const plug = (room: string, name: string): ThingMeta => ({
  room,
  name,
  primary: ["state", "power"],
  controls: [{ attr: "state", label: "Power", kind: "switch", on: "ON", off: "OFF", hold: true }],
});

const thermostat = (room: string, name: string, setpoint = "setpoint"): ThingMeta => ({
  room,
  name,
  primary: ["temperature", setpoint],
  controls: [
    { attr: setpoint, label: "Target", kind: "temperature", step: 0.5 },
    { attr: "mode", label: "Mode", kind: "select" },
  ],
});

/** Curated entries for everything you touch from the sofa; the rest are derived. */
export const things: Record<string, ThingMeta> = {
  "powerplug-terrace": plug("terrace", "Terrace lights"),
  "powerplug-1-kitchen": plug("kitchen", "Kitchen plug"),
  "powerplug-2": plug("other", "Plug 2"),
  "powerplug-3-pm": plug("other", "Plug 3"),
  "powerplug-car": plug("carport", "Car heater plug"),

  "thermostat-bathroom": thermostat("bathroom", "Bathroom thermostat"),
  "thermostat-toilet": thermostat("toilet", "Toilet thermostat"),
  "thermostat-bedroom": thermostat("bedroom", "Bedroom thermostat", "setpoint-1"),
  "thermostat-kitchen": thermostat("kitchen", "Kitchen thermostat", "setpoint-1"),
  "thermostat-livingroom": thermostat("livingroom", "Living room thermostat", "setpoint-1"),
  "thermostat-office": thermostat("office", "Office thermostat", "setpoint-1"),
  "thermostat-hall": thermostat("hall", "Hall thermostat", "setpoint-1"),
  "thermostat-emptyroom": thermostat("emptyroom", "Empty room thermostat", "setpoint-1"),

  "temperature-9-bathroom": {
    room: "bathroom",
    name: "Bathroom sensor",
    primary: ["temperature", "humidity"],
    controls: [],
  },
  "temperature-8-toilet": {
    room: "toilet",
    name: "Toilet sensor",
    primary: ["temperature", "humidity"],
    controls: [],
  },
  "temperature-7-bedroom": {
    room: "bedroom",
    name: "Bedroom sensor",
    primary: ["temperature", "humidity"],
    controls: [],
  },
  "temperature-backyard": {
    room: "outside",
    name: "Backyard temperature",
    primary: ["temperature"],
    controls: [],
  },
  "temperature-10-utilityroom": {
    room: "utilityroom",
    name: "Utility room sensor",
    primary: ["temperature", "humidity"],
    controls: [],
  },
  "temperature-11-office": {
    room: "office",
    name: "Office sensor",
    primary: ["temperature", "humidity"],
    controls: [],
  },
  "temperature-1-storage-street": {
    room: "storage",
    name: "Storage street sensor",
    primary: ["temperature"],
    controls: [],
  },
  "temperature-2-storage-car": {
    room: "storage",
    name: "Storage carport sensor",
    primary: ["temperature"],
    controls: [],
  },
  "temperature-3-emptyroom": {
    room: "emptyroom",
    name: "Empty room sensor",
    primary: ["temperature"],
    controls: [],
  },

  "temperature-4": {
    room: "other",
    name: "Sensor 4 (unplaced)",
    primary: ["temperature", "humidity"],
    controls: [],
  },
  "temperature-5": {
    room: "other",
    name: "Sensor 5 (unplaced)",
    primary: ["temperature", "humidity"],
    controls: [],
  },
  "temperature-6": {
    room: "other",
    name: "Sensor 6 (unplaced)",
    primary: ["temperature", "humidity"],
    controls: [],
  },
  "temperature-12": {
    room: "other",
    name: "Sensor 12 (unplaced)",
    primary: ["temperature", "humidity"],
    controls: [],
  },
  "temperature-13": {
    room: "other",
    name: "Sensor 13 (unplaced)",
    primary: ["temperature", "humidity"],
    controls: [],
  },
  "button-car": { room: "carport", name: "Carport button", primary: ["action"], controls: [] },
  "button-ikea": { room: "other", name: "Ikea button", primary: ["action"], controls: [] },

  "motion-agara-terrace": {
    room: "terrace",
    name: "Terrace motion",
    primary: ["occupancy", "illuminance"],
    controls: [],
  },
  "motion-agara-front": {
    room: "outside",
    name: "Front motion",
    primary: ["occupancy", "illuminance"],
    controls: [],
  },
  "motion-philips-car": { room: "carport", name: "Carport motion", primary: ["occupancy"], controls: [] },
  "motion-sonoff": { room: "other", name: "Motion sensor", primary: ["occupancy"], controls: [] },

  "door-front": {
    room: "outside",
    name: "Front door",
    primary: ["sensor-state-door-window", "illuminance"],
    controls: [],
  },
  "door-terrace": { room: "terrace", name: "Terrace door", primary: ["contact"], controls: [] },
  "door-livingroom": {
    room: "livingroom",
    name: "Living room door",
    primary: ["sensor-state-door-window", "illuminance"],
    controls: [],
  },
  "door-1-storage-street": {
    room: "storage",
    name: "Storage street door",
    primary: ["contact"],
    controls: [],
  },
  "door-2-storage-car": { room: "storage", name: "Storage carport door", primary: ["contact"], controls: [] },

  "siren-kitchen": {
    room: "kitchen",
    name: "Kitchen siren",
    primary: ["current-value"],
    controls: [{ attr: "target-value", label: "Siren", kind: "boolean" }],
    labels: { "current-value": "Siren" },
  },
};

/** Reading order when a device has no curated `primary` list. */
export const PRIMARY_PREFERENCE = [
  "temperature",
  "state",
  "setpoint",
  "setpoint-1",
  "contact",
  "sensor-state-door-window",
  "occupancy",
  "humidity",
  "illuminance",
  "power",
];

/** Telemetry that is never interesting in a default view. */
export const NOISY_ATTRIBUTES = new Set([
  "linkquality",
  "voltage",
  "battery",
  "battery-level",
  "battery-low",
  "low-battery-level",
  "power-outage-count",
  "power-outage-memory",
  "trigger-count",
  "device-temperature",
  "status",
  "indicator-mode",
  "child-lock",
  "countdown",
  "electric-consumption-kwh",
  "electric-consumption-w",
  "electric-consumption-v",
  "electric-power-w",
  "electric-voltage-v",
  "electric-kwh",
  "electric-kwh-65539",
  "electric-v",
  "electric-w",
  "electric-w-66051",
  "air-temperature-ep2",
  "temperature-celsius",
  "air-temperature",
  "exhaust-temperature",
  "exhaust-temperature-ep2",
  "illuminance-ep2",
  "setpoint-11",
  "setpoint-11-ep0",
  "setpoint-2",
  "mode-ep0",
  "action",
  "current-value",
  "target-value",
  "sensor-state-tamper",
  "tamper",
  "sensor-state-unknown-0x22",
  "alarm-level",
  "alarm-type",
  "cover-status",
  "notification-mode",
  "supports-v1-alarm",
  "general-purpose",
  "water-consumption-usgallons",
  "led-indication",
  "motion-sensitivity",
  "occupancy-timeout",
  "any",
]);

export const ATTR_LABELS: Record<string, string> = {
  temperature: "Temperature",
  humidity: "Humidity",
  setpoint: "Target",
  "setpoint-1": "Target (heat)",
  "setpoint-2": "Target (cool)",
  "setpoint-11": "Target (auto)",
  mode: "Mode",
  state: "Power",
  contact: "Contact",
  "sensor-state-door-window": "Contact",
  occupancy: "Motion",
  illuminance: "Light",
  "illuminance-lux": "Light",
  battery: "Battery",
  "battery-level": "Battery",
  linkquality: "Link quality",
  voltage: "Voltage",
  action: "Button",
  "current-value": "State",
  "target-value": "Target",
  power: "Power draw",
  "device-temperature": "Device temperature",
  "power-outage-count": "Power outages",
  "electric-power-w": "Power",
  "electric-consumption-kwh": "Energy",
  pressure: "Pressure",
  "barometric-pressure": "Pressure",
  "carbon-dioxide-co-level": "CO₂",
  "particulate-matter-2.5": "PM2.5",
};

export function roomOf(deviceId: string): string {
  const lower = deviceId.toLowerCase();
  for (const [token, room] of ROOM_TOKENS) {
    if (lower.includes(token)) return room;
  }
  return "other";
}

export type ThingKind =
  | "light"
  | "plug"
  | "thermostat"
  | "sensor"
  | "motion"
  | "contact"
  | "button"
  | "siren"
  | "other";

export function kindOf(deviceId: string): ThingKind {
  const prefix = deviceId.split("-")[0];
  switch (prefix) {
    case "powerplug":
      return "plug";
    case "thermostat":
      return "thermostat";
    case "temperature":
      return "sensor";
    case "humidity":
      return "sensor";
    case "motion":
      return "motion";
    case "door":
      return "contact";
    case "button":
      return "button";
    case "siren":
      return "siren";
    default:
      return "other";
  }
}

/** "kitchen-plug" / "setpoint-1" -> "Setpoint 1" */
export function humanize(id: string): string {
  const text = id.replace(/[-_]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
