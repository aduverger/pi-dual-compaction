import { createDualCompactionController } from "./controller.mjs";

export default function registerDualCompaction(pi) {
  return createDualCompactionController(pi);
}
