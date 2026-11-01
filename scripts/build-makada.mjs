/** Visual presentation trigger. Requires the project to be open in the workspace. */
export async function triggerMakadaBuild({ projectId, action = "start", baseUrl = "http://127.0.0.1:4310" } = {}) {
  if (!["start", "stop"].includes(action)) throw new Error("Action must be start or stop.");
  if (!projectId) {
    const response = await fetch(`${baseUrl}/api/projects`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("Workspace is unavailable.");
    const projects = await response.json();
    projectId = (projects.find(p => p.name === "Makada Demo") ?? projects.find(p => p.name === "Makada"))?.id;
  }
  if (!projectId) throw new Error("Open a Makada project first.");
  const response = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(projectId)}/presentation/build`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }), signal: AbortSignal.timeout(12000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? "The open view did not acknowledge the presentation.");
  return result;
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  try {
    const result = await triggerMakadaBuild({ action: process.argv.includes("--stop") ? "stop" : "start" });
    console.log(`Build Makada: ${result.status}. Presentation only; no hardware command sent.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
