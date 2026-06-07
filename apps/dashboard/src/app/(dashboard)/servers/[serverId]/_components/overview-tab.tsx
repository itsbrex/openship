import {
  Cpu,
  HardDrive,
  MemoryStick,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Activity,
} from "lucide-react";
import type { ComponentStatus, ServerStats } from "@/lib/api/system";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function formatUptime(seconds: string): string {
  const s = Math.floor(parseFloat(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * Usage bar. Neutral foreground tone by default - amber when the value
 * climbs past 70%, red past 90%. The colour is a function of the data,
 * not arbitrary per-metric branding.
 */
function UsageBar({ pct }: { pct: number }) {
  const tone =
    pct >= 90
      ? "bg-red-500"
      : pct >= 70
        ? "bg-amber-500"
        : "bg-foreground/60";
  return (
    <div className="h-1.5 bg-muted rounded-full overflow-hidden mt-3">
      <div
        className={`h-full rounded-full transition-all duration-700 ease-out ${tone}`}
        style={{ width: `${Math.min(pct, 100)}%` }}
      />
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  pct,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
  pct?: number;
}) {
  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="flex items-center gap-2 mb-3">
        <Icon
          className="size-4 text-muted-foreground"
          strokeWidth={2}
        />
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {label}
        </span>
      </div>
      <p className="text-2xl font-semibold text-foreground tracking-tight tabular-nums">
        {value}
      </p>
      {sub && (
        <p className="text-xs text-muted-foreground mt-1 tabular-nums">{sub}</p>
      )}
      {pct != null && <UsageBar pct={pct} />}
    </div>
  );
}

export function OverviewTab({
  stats,
  components,
  checking,
}: {
  stats: ServerStats | null;
  components: ComponentStatus[];
  checking: boolean;
  monitorConnected: boolean;
  monitorError: string | null;
  onReconnectMonitor: () => void;
}) {
  const healthyCount = components.filter((c) => c.healthy).length;
  const totalCount = components.length;
  const allHealthy = totalCount > 0 && healthyCount === totalCount;
  const unhealthyCount = totalCount - healthyCount;

  const memPct =
    stats && stats.memTotal > 0
      ? Math.round((stats.memUsed / stats.memTotal) * 100)
      : null;
  const diskPct =
    stats && stats.diskTotal > 0
      ? Math.round((stats.diskUsed / stats.diskTotal) * 100)
      : null;

  return (
    <div className="space-y-6">
      {/* Stat cards - neutral icons; the bar tone is the only thing that
          changes with the data, so resting state is calm and high usage
          stands out. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={Cpu}
          label="CPU"
          value={stats ? `${stats.cpu}%` : "-"}
          sub={
            stats
              ? `Load ${stats.load1} · ${stats.load5} · ${stats.load15}`
              : undefined
          }
          pct={stats?.cpu ?? undefined}
        />
        <StatCard
          icon={MemoryStick}
          label="Memory"
          value={stats ? `${memPct}%` : "-"}
          sub={
            stats
              ? `${formatBytes(stats.memUsed)} of ${formatBytes(stats.memTotal)}`
              : undefined
          }
          pct={memPct ?? undefined}
        />
        <StatCard
          icon={HardDrive}
          label="Disk"
          value={stats ? `${diskPct}%` : "-"}
          sub={
            stats
              ? `${formatBytes(stats.diskUsed)} of ${formatBytes(stats.diskTotal)}`
              : undefined
          }
          pct={diskPct ?? undefined}
        />
        <StatCard
          icon={Clock}
          label="Uptime"
          value={stats ? formatUptime(stats.uptime) : "-"}
          sub={stats ? "since last boot" : undefined}
        />
      </div>

      {/* Components - inline-header card pattern matching the rest of
          the dashboard. No icon-in-emerald-circle; just a small muted
          icon next to the heading. */}
      <div className="bg-card rounded-2xl border border-border/50 p-5">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2 min-w-0">
            <Activity
              className="size-4 text-muted-foreground shrink-0"
              strokeWidth={2}
            />
            <h2 className="font-semibold text-foreground text-sm">
              Components
            </h2>
          </div>
          <span className="text-xs text-muted-foreground tabular-nums shrink-0">
            {checking
              ? "Checking…"
              : allHealthy
                ? "All systems operational"
                : totalCount > 0
                  ? `${unhealthyCount} of ${totalCount} unhealthy`
                  : "No data"}
          </span>
        </div>

        {checking && totalCount === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : totalCount > 0 ? (
          <div className="divide-y divide-border/40 -mx-5">
            {components.map((comp) => (
              <div
                key={comp.name}
                className="flex items-center gap-3 px-5 py-3"
              >
                {comp.healthy ? (
                  <CheckCircle2
                    className="size-4 text-emerald-500 shrink-0"
                    strokeWidth={2}
                  />
                ) : (
                  <XCircle
                    className="size-4 text-red-500 shrink-0"
                    strokeWidth={2}
                  />
                )}
                <span className="text-sm text-foreground flex-1 truncate">
                  {comp.label || comp.name}
                </span>
                {comp.version && (
                  <span className="text-[11px] font-mono text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded">
                    v{comp.version}
                  </span>
                )}
                <span
                  className={`text-xs font-medium ${
                    comp.healthy
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-red-600 dark:text-red-400"
                  }`}
                >
                  {comp.healthy ? "Healthy" : "Unhealthy"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-6">
            No health data yet
          </p>
        )}
      </div>
    </div>
  );
}
