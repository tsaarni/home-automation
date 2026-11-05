import { createBrowserRouter, Navigate } from "react-router";
import { AppShell } from "./components/AppShell";
import { ActivityScreen } from "./features/activity/ActivityScreen";
import { AdvancedScreen } from "./features/advanced/AdvancedScreen";
import { DevicesLayout, DevicesScreen } from "./features/devices/DevicesScreen";
import { GroupsScreen } from "./features/groups/GroupsScreen";
import { HomeScreen } from "./features/home/HomeScreen";
import { ScheduleDetailScreen } from "./features/schedules/ScheduleDetail";
import { ScheduleListScreen } from "./features/schedules/ScheduleList";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <HomeScreen /> },
      { path: "groups", element: <Navigate to="/devices/groups" replace /> },
      {
        path: "devices",
        element: <DevicesLayout />,
        children: [
          { index: true, element: <DevicesScreen /> },
          { path: "groups", element: <GroupsScreen /> },
        ],
      },
      { path: "schedules", element: <ScheduleListScreen /> },
      { path: "schedules/:id", element: <ScheduleDetailScreen /> },
      { path: "activity", element: <ActivityScreen /> },
      { path: "advanced", element: <AdvancedScreen /> },
    ],
  },
]);
