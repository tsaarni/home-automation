import { NavLink, Outlet } from "react-router";
import { useHome, useReady, useRules } from "@/api/queries";
import { Icon } from "./primitives";

const destinations = [
  { to: "/", label: "Home", icon: "home" },
  { to: "/schedules", label: "Schedules", icon: "schedule" },
  { to: "/activity", label: "Activity", icon: "history" },
  { to: "/advanced", label: "Advanced", icon: "settings" },
];

export function AppShell() {
  useReady();
  useHome();
  useRules();

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      {/* Desktop Material 3 Navigation Rail */}
      <aside
        style={{
          width: "88px",
          backgroundColor: "var(--md-sys-color-surface-container-low)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "24px 0",
          borderRight: "1px solid var(--md-sys-color-outline-variant)",
          flexShrink: 0,
        }}
        className="hide-mobile"
      >
        <div style={{ marginBottom: "32px", display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" }}>
          <div
            style={{
              width: "44px",
              height: "44px",
              borderRadius: "16px",
              backgroundColor: "var(--md-sys-color-primary-container)",
              color: "var(--md-sys-color-on-primary-container)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="nest_thermostat" />
          </div>
          <span style={{ fontSize: "11px", fontWeight: 700, color: "var(--md-sys-color-on-surface-variant)", letterSpacing: "0.5px" }}>
            HOME
          </span>
        </div>

        <nav style={{ display: "flex", flexDirection: "column", gap: "16px", width: "100%", alignItems: "center" }}>
          {destinations.map((d) => (
            <NavLink
              key={d.to}
              to={d.to}
              end={d.to === "/"}
              style={({ isActive }) => ({
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "4px",
                width: "56px",
                textDecoration: "none",
                color: isActive ? "var(--md-sys-color-on-surface)" : "var(--md-sys-color-on-surface-variant)",
              })}
            >
              {({ isActive }) => (
                <>
                  <div
                    style={{
                      width: "56px",
                      height: "32px",
                      borderRadius: "9999px",
                      backgroundColor: isActive ? "var(--md-sys-color-secondary-container)" : "transparent",
                      color: isActive ? "var(--md-sys-color-on-secondary-container)" : "inherit",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      transition: "background-color 200ms ease",
                    }}
                  >
                    <Icon name={d.icon} />
                  </div>
                  <span style={{ fontSize: "12px", fontWeight: isActive ? 700 : 500 }}>{d.label}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* Main Container */}
      <main className="main-content">
        <Outlet />
      </main>

      {/* Mobile Material 3 Navigation Bar */}
      <nav
        className="show-mobile"
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          height: "calc(68px + env(safe-area-inset-bottom))",
          paddingBottom: "env(safe-area-inset-bottom)",
          backgroundColor: "var(--md-sys-color-surface-container)",
          borderTop: "1px solid var(--md-sys-color-outline-variant)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-around",
          zIndex: 30,
        }}
      >
        {destinations.map((d) => (
          <NavLink
            key={d.to}
            to={d.to}
            end={d.to === "/"}
            style={({ isActive }) => ({
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "4px",
              flex: 1,
              textDecoration: "none",
              color: isActive ? "var(--md-sys-color-on-surface)" : "var(--md-sys-color-on-surface-variant)",
            })}
          >
            {({ isActive }) => (
              <>
                <div
                  style={{
                    width: "56px",
                    height: "32px",
                    borderRadius: "9999px",
                    backgroundColor: isActive ? "var(--md-sys-color-secondary-container)" : "transparent",
                    color: isActive ? "var(--md-sys-color-on-secondary-container)" : "inherit",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon name={d.icon} />
                </div>
                <span style={{ fontSize: "12px", fontWeight: isActive ? 700 : 500 }}>{d.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
