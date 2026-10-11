import * as stylex from "@stylexjs/stylex";
import { NavLink, Outlet } from "react-router";
import { useHome, useReady, useRules } from "@/api/queries";
import { tokens } from "@/theme/tokens.stylex";

const styles = stylex.create({
  shell: { minHeight: "100vh", display: "flex", flexDirection: "column" },
  body: {
    display: "flex",
    flexGrow: 1,
    flexDirection: "column",
    "@media (min-width: 1024px)": { flexDirection: "row" },
  },
  main: {
    flexGrow: 1,
    width: "100%",
    maxWidth: "1100px",
    marginInline: "auto",
    padding: tokens.space4,
    paddingBottom: "calc(84px + env(safe-area-inset-bottom))",
    "@media (min-width: 1024px)": { paddingBottom: tokens.space5 },
  },
  rail: {
    display: "none",
    "@media (min-width: 1024px)": {
      display: "flex",
      flexDirection: "column",
      gap: tokens.space1,
      width: "200px",
      flexShrink: 0,
      padding: tokens.space4,
      borderRightColor: tokens.border,
      borderRightStyle: "solid",
      borderRightWidth: 1,
    },
  },
  tabs: {
    position: "fixed",
    bottom: 0,
    left: 0,
    right: 0,
    display: "flex",
    backgroundColor: tokens.surface,
    borderTopColor: tokens.border,
    borderTopStyle: "solid",
    borderTopWidth: 1,
    paddingBottom: "env(safe-area-inset-bottom)",
    zIndex: 20,
    "@media (min-width: 1024px)": { display: "none" },
  },
  tab: {
    flexGrow: 1,
    textAlign: "center",
    paddingBlock: tokens.space3,
    fontSize: tokens.fontSm,
    textDecoration: "none",
    color: tokens.textMuted,
    fontWeight: 600,
  },
  tabActive: { color: tokens.accent },
  railLink: {
    textDecoration: "none",
    padding: tokens.space3,
    borderRadius: tokens.radiusSm,
    color: tokens.textMuted,
    fontWeight: 600,
    fontSize: tokens.fontMd,
  },
  railActive: { backgroundColor: tokens.accentSoft, color: tokens.accent },
});

const destinations = [
  { to: "/", label: "Home" },
  { to: "/schedules", label: "Schedules" },
  { to: "/activity", label: "Activity" },
  { to: "/advanced", label: "Advanced" },
];

export function AppShell() {
  useReady();
  useHome();
  useRules();

  return (
    <div {...stylex.props(styles.shell)}>
      <div {...stylex.props(styles.body)}>
        <nav {...stylex.props(styles.rail)}>
          {destinations.map((destination) => (
            <NavLink
              key={destination.to}
              to={destination.to}
              end={destination.to === "/"}
              className={({ isActive }) =>
                stylex.props(styles.railLink, isActive && styles.railActive).className ?? ""
              }
            >
              {destination.label}
            </NavLink>
          ))}
        </nav>
        <main {...stylex.props(styles.main)}>
          <Outlet />
        </main>
      </div>
      <nav {...stylex.props(styles.tabs)}>
        {destinations.map((destination) => (
          <NavLink
            key={destination.to}
            to={destination.to}
            end={destination.to === "/"}
            className={({ isActive }) =>
              stylex.props(styles.tab, isActive && styles.tabActive).className ?? ""
            }
          >
            {destination.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
