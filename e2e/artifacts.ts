import { join } from "node:path";

export const ARTIFACTS = process.env.ARTIFACTS_DIR ?? "test-results/artifacts";
export const SHOTS = join(ARTIFACTS, "screenshots");
