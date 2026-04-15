/** Formatting utilities for display. */

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000_000)
    return `${(tokens / 1_000_000_000).toFixed(1)}B`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return tokens.toString();
}

export function formatCost(cost: number): string {
  if (cost >= 1000) return `$${cost.toFixed(0)}`;
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(4)}`;
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes >= 60) return `${(minutes / 60).toFixed(1)}h`;
  return `${minutes}m`;
}
