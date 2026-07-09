import { Home, Rocket } from "lucide-react";
import { NotFoundView } from "@/components/not-found-view";

/**
 * 404 for authenticated in-dashboard misses (e.g. a bad `notFound()` route).
 * Renders inside (dashboard)/layout.tsx's <main>, so it keeps the real sidebar
 * chrome — the wrapper fills that main area and dead-centers the 404 body.
 * Arbitrary unmatched URLs still hit the global app/not-found.tsx.
 */
export default function DashboardNotFound() {
  return (
    <div className="flex min-h-full items-center justify-center px-6 py-10">
      <NotFoundView
        title="Page not found"
        description="This page doesn't exist or may have moved. Check the URL, or head back to your dashboard."
        actions={[
          { href: "/", label: "Back to dashboard", icon: <Home className="size-4" /> },
          { href: "/deployments", label: "View deployments", icon: <Rocket className="size-4" />, variant: "secondary" },
        ]}
      />
    </div>
  );
}
