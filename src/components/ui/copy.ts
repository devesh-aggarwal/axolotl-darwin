// Wording that depends on the product story (Option A or B), from the server's AXOLOTL_MODE.
import { MODE_COPY, type ModeCopy } from "@/config/mode";
import { useAxolotl } from "@/components/store";

export function useCopy(): ModeCopy {
  const { state } = useAxolotl();
  return MODE_COPY[state.boot?.mode ?? "workflow"];
}
