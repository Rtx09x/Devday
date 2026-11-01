import path from "node:path";
import { CutuError } from "@cutucircuits/core";
import { safeRelative } from "./validation.js";

/** Resolve URDF resource names within the project, including ROS package paths. */
export function robotAssetPath(urdfPath: string, resource: string): string {
  safeRelative(urdfPath);
  if (typeof resource !== "string" || !resource || /[?#\\\0]/.test(resource))
    throw new CutuError(
      "INVALID_ROBOT_ASSET",
      "Robot resources must be project-local file paths",
    );
  let decoded: string;
  try {
    decoded = decodeURIComponent(resource);
  } catch {
    throw new CutuError(
      "INVALID_ROBOT_ASSET",
      "Invalid encoded robot resource path",
    );
  }
  const packagePath = decoded.startsWith("package://");
  const resourcePath = packagePath
    ? decoded.slice("package://".length)
    : decoded;
  if (/^[a-z][a-z0-9+.-]*:/i.test(resourcePath) || resourcePath.startsWith("/"))
    throw new CutuError(
      "INVALID_ROBOT_ASSET",
      "Remote and absolute robot resource paths are not supported",
    );
  const relative = path.posix.normalize(
    packagePath
      ? resourcePath
      : path.posix.join(path.posix.dirname(urdfPath), resourcePath),
  );
  safeRelative(relative);
  return relative;
}
