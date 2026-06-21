"use client";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from "recharts";

interface UsageChartProps {
  buckets: Array<{
    timestamp: string;
    cpu_time_minutes: number;
    memory_gb_minutes: number;
    disk_io_gb: number;
    network_gb: number;
    credits: number;       // Oblien's authoritative per-bucket credits
  }>;
  granularity: "day" | "week";
}

const SERIES = [
  { key: "cpu_time_minutes", label: "CPU", color: "#3b82f6" },
  { key: "memory_gb_minutes", label: "Memory", color: "#8b5cf6" },
  { key: "disk_io_gb", label: "Disk IO", color: "#f59e0b" },
  { key: "network_gb", label: "Network", color: "#10b981" },
] as const;

export function UsageChart({ buckets, granularity }: UsageChartProps) {
  return (
    <ResponsiveContainer width="100%" height={320}>
      <AreaChart data={buckets}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="timestamp" tickFormatter={(v) => formatTick(v, granularity)} />
        <YAxis />
        <Tooltip />
        <Legend />
        {SERIES.map((s) => (
          <Area key={s.key} type="monotone" dataKey={s.key} stackId="usage" stroke={s.color} fill={s.color} fillOpacity={0.4} name={s.label} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

function formatTick(iso: string, granularity: "day" | "week"): string {
  const d = new Date(iso);
  return granularity === "week"
    ? `Wk ${getWeekNumber(d)}`
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function getWeekNumber(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - start.getTime()) / 86400000 + start.getDay() + 1) / 7);
}
