export const STICKY_TASK_CONTEXT_MARKER = "Keep this task context across compaction.";

export function hasStickyTaskContextMarker(body) {
  if (typeof body !== "string") return false;
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines.at(-1).trim() === "") lines.pop();
  return lines.length > 0 && lines.at(-1) === STICKY_TASK_CONTEXT_MARKER;
}

export function appendStickyTaskContextMarker(body) {
  if (typeof body !== "string") throw new TypeError("Sticky task context body must be a string");
  if (hasStickyTaskContextMarker(body)) return body;
  const separator = body.endsWith("\n") ? "\n" : "\n\n";
  return `${body}${separator}${STICKY_TASK_CONTEXT_MARKER}\n`;
}
