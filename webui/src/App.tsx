import { createBrowserRouter } from "react-router";
import { AppShell } from "./components/AppShell";
import { ActivityScreen } from "./features/activity/ActivityScreen";
import { AdvancedScreen } from "./features/advanced/AdvancedScreen";
import { HomeScreen } from "./features/home/HomeScreen";
import { ScheduleDetailScreen } from "./features/schedules/ScheduleDetail";
import { ScheduleListScreen } from "./features/schedules/ScheduleList";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <HomeScreen /> },
      { path: "schedules", element: <ScheduleListScreen /> },
      { path: "schedules/:id", element: <ScheduleDetailScreen /> },
      { path: "activity", element: <ActivityScreen /> },
      { path: "advanced", element: <AdvancedScreen /> },
    ],
  },
]);
