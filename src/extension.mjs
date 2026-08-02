import { createServerCompactionController } from "./controller.mjs";

export default function registerServerCompaction(pi) {
  return createServerCompactionController(pi);
}
